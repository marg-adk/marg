/**
 * media.ts — files a user attaches in chat (photos, documents).
 *
 * UPLOAD ≠ ATTACH. A user usually attaches files BEFORE the entity exists — mid-conversation.
 * The widget sends one file per request as a raw body; the gateway hands the bytes to the media
 * domain's `internal_upload_media` tool (a temp file, never base64 over stdio), remembers the
 * returned storage key on the session, and attaches the keys to the entity the moment the write
 * returns an id (`flushPendingMedia` after every turn). Files added after the create attach at
 * once. Attach is idempotent; a media hiccup never blocks the turn that carries the completion.
 *
 * Which domain owns media: AGENT_MEDIA_DOMAIN, else the first domain that advertises the
 * `internal_upload_media` tool. Without one the endpoints answer 501.
 *
 * Tools the media domain implements (all `internal_*`, hidden from the model):
 *   internal_upload_media  {kind, file_path, filename, content_type}      → {key, url?}
 *   internal_attach_media  {entity_id, items:[{key,label?,cover?}], video?} → {attached:[keys]}
 *   internal_detach_media  {entity_id, key}                                 → {}
 *   internal_arrange_media {entity_id, order?, labels?, cover?}  (optional) → {}
 */
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import { behaviour, callDomainTool, envNum, isInternalTool, log, saveSession, withSpan, type Session } from "@marg-adk/core";
import { discoverDomains } from "./domains.js";

export const mediaConfig = {
  maxImageBytes: envNum("AGENT_MEDIA_MAX_IMAGE_MB", 15) * 1024 * 1024,
  maxFileBytes: envNum("AGENT_MEDIA_MAX_FILE_MB", 25) * 1024 * 1024,
  maxVideoBytes: envNum("AGENT_MEDIA_MAX_VIDEO_MB", 128) * 1024 * 1024,
  maxItems: envNum("AGENT_MEDIA_MAX_ITEMS", 30),
  /** Where an uploaded file is SERVED from: `<file_base>/<key>`; clients compose image sources that way. */
  fileBase: (process.env.AGENT_FILE_BASE ?? "").replace(/\/+$/, ""),
  imageTypes: new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"]),
  videoTypes: new Set(["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-m4v", "video/mpeg"]),
  fileTypes: new Set(["application/pdf", "text/plain", "text/csv", "application/json", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
};

export interface MediaItem {
  key: string;
  kind: "image" | "video" | "file";
  url?: string;
  filename: string;
  content_type: string;
  label?: string;
  cover?: boolean;
  attached: boolean;
  at: number;
}

interface SessionMedia {
  items: MediaItem[];
}

function mediaOf(session: Session): SessionMedia {
  const existing = session.shared.media as SessionMedia | undefined;
  if (existing) {
    existing.items ??= [];
    return existing;
  }
  const fresh: SessionMedia = { items: [] };
  session.shared.media = fresh;
  return fresh;
}

export function mediaDomain(): string | undefined {
  const env = process.env.AGENT_MEDIA_DOMAIN;
  if (env) return env;
  for (const d of discoverDomains()) if (isInternalTool(d.name, "internal_upload_media")) return d.name;
  return undefined;
}

/** Public snapshot for the client (GET /api/media and after every change). */
export function mediaState(session: Session) {
  const m = mediaOf(session);
  return {
    file_base: mediaConfig.fileBase,
    items: m.items.map((i) => ({ key: i.key, kind: i.kind, url: i.url, filename: i.filename, label: i.label, cover: Boolean(i.cover), attached: i.attached })),
    attached_to: session.completion?.entity_id,
    max_items: mediaConfig.maxItems,
  };
}

/** Counts for the prompt tail: the model is told what the chat holds, never asked to collect it. */
export function mediaSummary(session: Session): { images: number; files: number; video: number; attached: boolean } {
  const items = mediaOf(session).items;
  const images = items.filter((i) => i.kind === "image").length;
  const video = items.filter((i) => i.kind === "video").length;
  const files = items.length - images - video;
  return { images, files, video, attached: items.length > 0 && items.every((i) => i.attached) };
}

export function mediaPromptNote(session: Session): string {
  const { images, files, video } = mediaSummary(session);
  if (!images && !files && !video) return "";
  const parts = [images ? `${images} photo${images === 1 ? "" : "s"}` : "", video ? `${video} video${video === 1 ? "" : "s"}` : "", files ? `${files} file${files === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  return `\n\n---\n\nATTACHED IN THIS CHAT (runtime fact): the user has already uploaded ${parts} through the chat's attach button. They are written onto the record automatically the moment it is created — never ask the user to add files, never list them as missing. Acknowledge them once where it fits.`;
}

function kindOf(contentType: string): MediaItem["kind"] | null {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mediaConfig.imageTypes.has(mime)) return "image";
  if (mediaConfig.videoTypes.has(mime)) return "video";
  if (mediaConfig.fileTypes.has(mime)) return "file";
  return null;
}

function safeName(raw: string | undefined, fallback: string): string {
  let decoded = raw ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* use as-is */
  }
  const base = decoded.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\w.\- ]+/g, "").trim().slice(0, 120);
  return clean || fallback;
}

async function callMediaTool(domain: string, name: string, args: Record<string, unknown>, session: Session): Promise<any> {
  const text = await callDomainTool(domain, name, args, session.authToken, session.id);
  if (text.startsWith("ERROR")) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unreadable result from ${name}: ${text.slice(0, 200)}`);
  }
}

export async function handleMediaUpload(req: express.Request, res: express.Response, session: Session): Promise<void> {
  const domain = mediaDomain();
  if (!domain) {
    res.status(501).json({ error: "No media domain is configured on this gateway." });
    return;
  }
  const contentType = req.header("content-type") ?? "";
  const kind = kindOf(contentType);
  if (!kind) {
    res.status(415).json({ error: "Unsupported file type." });
    return;
  }
  const bytes = req.body as Buffer;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    res.status(400).json({ error: "Empty upload." });
    return;
  }
  const limit = kind === "image" ? mediaConfig.maxImageBytes : kind === "video" ? mediaConfig.maxVideoBytes : mediaConfig.maxFileBytes;
  if (bytes.length > limit) {
    res.status(413).json({ error: `That ${kind} is too large (max ${Math.round(limit / 1024 / 1024)} MB).` });
    return;
  }
  const media = mediaOf(session);
  if (media.items.length >= mediaConfig.maxItems) {
    res.status(409).json({ error: `That's the maximum of ${mediaConfig.maxItems} files for one chat.` });
    return;
  }
  const filename = safeName(req.header("x-agent-filename"), kind === "image" ? "photo.jpg" : kind === "video" ? "video.mp4" : "file");
  const path = join(tmpdir(), `agent-upload-${randomUUID()}`);
  try {
    await writeFile(path, bytes);
    const up = await withSpan("media.upload", { attrs: { "agent.media.kind": kind, "agent.media.bytes": bytes.length } }, () => callMediaTool(domain, "internal_upload_media", { kind, file_path: path, filename, content_type: contentType.split(";")[0].trim() }, session));
    const item: MediaItem = { key: String(up.key), kind, url: up.url || undefined, filename, content_type: String(up.content_type ?? contentType), attached: false, at: Date.now(), cover: kind === "image" && !media.items.some((i) => i.kind === "image") };
    media.items.push(item);
    saveSession(session);
    if (session.completion?.entity_id) await flushPendingMedia(session);
    behaviour("media_uploaded", { type: kind });
    log.info("media uploaded", { kind, bytes: bytes.length, session: session.id, attached: Boolean(session.completion) });
    res.json({ uploaded: true, kind, key: item.key, pending: !item.attached, ...mediaState(session) });
  } catch (e) {
    log.error("media upload failed", { kind, session: session.id, error: e instanceof Error ? e.message : String(e) });
    res.status(502).json({ error: `Could not upload that ${kind}. Please try again.` });
  } finally {
    await unlink(path).catch(() => {});
  }
}

export async function handleMediaDelete(req: express.Request, res: express.Response, session: Session): Promise<void> {
  const key = String(req.query.key ?? "").trim();
  const media = mediaOf(session);
  const item = media.items.find((i) => i.key === key);
  if (!key || !item) {
    res.status(404).json({ error: "No such file on this chat." });
    return;
  }
  try {
    const domain = mediaDomain();
    if (item.attached && session.completion?.entity_id && domain) await callMediaTool(domain, "internal_detach_media", { entity_id: session.completion.entity_id, key }, session);
    media.items = media.items.filter((i) => i.key !== key);
    if (item.cover) {
      const first = media.items.find((i) => i.kind === "image");
      if (first) first.cover = true;
    }
    saveSession(session);
    res.json({ deleted: true, ...mediaState(session) });
  } catch (e) {
    log.error("media delete failed", { key, session: session.id, error: e instanceof Error ? e.message : String(e) });
    res.status(502).json({ error: "Could not remove that file — please try again." });
  }
}

/** PATCH /api/media {order?: [keys], labels?: {key: label}, cover?: key} — labels and order the user sets on the media card. */
export async function handleMediaArrange(req: express.Request, res: express.Response, session: Session): Promise<void> {
  const body = (req.body ?? {}) as { order?: unknown; labels?: unknown; cover?: unknown };
  const media = mediaOf(session);
  let changed = 0;
  if (Array.isArray(body.order)) {
    const by = new Map(media.items.map((i) => [i.key, i]));
    const named = body.order.filter((k): k is string => typeof k === "string" && by.has(k));
    if (named.length) {
      media.items = [...named.map((k) => by.get(k)!), ...media.items.filter((i) => !named.includes(i.key))];
      changed++;
    }
  }
  if (body.labels && typeof body.labels === "object") {
    for (const [k, v] of Object.entries(body.labels as Record<string, unknown>)) {
      const i = media.items.find((x) => x.key === k);
      if (!i) continue;
      i.label = typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : undefined;
      changed++;
    }
  }
  if (typeof body.cover === "string" && media.items.some((i) => i.key === body.cover)) {
    for (const i of media.items) i.cover = i.key === body.cover;
    changed++;
  }
  if (!changed) {
    res.json(mediaState(session));
    return;
  }
  saveSession(session);
  const domain = mediaDomain();
  const entity = session.completion?.entity_id;
  if (entity && domain && isInternalTool(domain, "internal_arrange_media")) {
    try {
      await callMediaTool(domain, "internal_arrange_media", { entity_id: entity, order: media.items.map((i) => i.key), labels: Object.fromEntries(media.items.map((i) => [i.key, i.label ?? ""])), cover: media.items.find((i) => i.cover)?.key }, session);
    } catch (e) {
      log.warn("media arrange write-through failed", { session: session.id, error: (e as Error).message });
    }
  }
  behaviour("media_arranged", { type: entity ? "written" : "session" });
  res.json(mediaState(session));
}

/** Attach every not-yet-attached key to the session's entity. Safe to call any time; failures are logged, never thrown. */
export async function flushPendingMedia(session: Session): Promise<void> {
  const entity = session.completion?.entity_id;
  const domain = mediaDomain();
  if (!entity || !domain) return;
  const media = mediaOf(session);
  const pending = media.items.filter((i) => !i.attached);
  if (!pending.length) return;
  try {
    await callMediaTool(domain, "internal_attach_media", { entity_id: entity, items: pending.map((i) => ({ key: i.key, kind: i.kind, label: i.label, cover: Boolean(i.cover), filename: i.filename })) }, session);
    pending.forEach((i) => (i.attached = true));
    saveSession(session);
    behaviour("media_attached", { domain });
    log.info("media attached", { session: session.id, entity_id: entity, items: pending.length });
  } catch (e) {
    log.error("media attach failed", { session: session.id, entity_id: entity, error: e instanceof Error ? e.message : String(e) });
  }
}
