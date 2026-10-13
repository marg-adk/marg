/**
 * transcribe.ts — speech-to-text for voice notes, behind the gateway so no key reaches a client.
 *
 * Providers (AGENT_STT_PROVIDER): "deepgram" (DEEPGRAM_API_KEY; language auto-detect, keyword
 * boost for your vocabulary via AGENT_STT_KEYWORDS) or "openai" — any OpenAI-compatible
 * /audio/transcriptions endpoint, which is also how a self-hosted Whisper serves (AGENT_STT_BASE,
 * AGENT_STT_API_KEY, AGENT_STT_MODEL). Unset ⇒ voice endpoints answer 501 and the widget hides the mic.
 *
 * The voice note IS the message: the stream opens with a `transcript` event, then the normal turn.
 * Audio duration is metered (bill what the vendor bills you).
 */
import type express from "express";
import { counter, log, withSpan } from "@marg/core";

export const sttConfig = (() => {
  const provider = (process.env.AGENT_STT_PROVIDER ?? (process.env.DEEPGRAM_API_KEY ? "deepgram" : process.env.AGENT_STT_BASE ? "openai" : "")).toLowerCase();
  return {
    provider: provider as "deepgram" | "openai" | "",
    deepgramKey: process.env.DEEPGRAM_API_KEY ?? "",
    model: process.env.AGENT_STT_MODEL ?? (provider === "openai" ? "whisper-1" : "nova-3"),
    language: process.env.AGENT_STT_LANGUAGE ?? "",
    keywords: (process.env.AGENT_STT_KEYWORDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    base: (process.env.AGENT_STT_BASE ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.AGENT_STT_API_KEY ?? process.env.LLM_OPENAI_API_KEY ?? "",
    /** USD per audio minute for the ledger (0 = unknown). */
    pricePerMinute: Number(process.env.AGENT_STT_PRICE_PER_MIN ?? 0) || 0,
  };
})();

export const sttEnabled = (): boolean => sttConfig.provider === "deepgram" ? Boolean(sttConfig.deepgramKey) : sttConfig.provider === "openai" ? Boolean(sttConfig.base) : false;

export interface Transcription {
  transcript: string;
  language?: string;
  confidence?: number;
  duration_s?: number;
  provider: string;
  model: string;
}

export class SttError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const FAILED = "Transcription failed — please try again or type your message.";

async function deepgram(audio: Buffer, contentType: string | undefined): Promise<Transcription> {
  const params = new URLSearchParams({ model: sttConfig.model, smart_format: "true" });
  if (sttConfig.language) params.set("language", sttConfig.language);
  else params.set("detect_language", "true");
  for (const k of sttConfig.keywords) params.append("keywords", k);
  const dg = await fetch(`https://api.deepgram.com/v1/listen?${params}`, { method: "POST", headers: { Authorization: `Token ${sttConfig.deepgramKey}`, "Content-Type": contentType ?? "application/octet-stream" }, body: new Uint8Array(audio), signal: AbortSignal.timeout(30_000) });
  const body: any = await dg.json().catch(() => null);
  if (!dg.ok) {
    log.error("deepgram error", { status: dg.status, detail: JSON.stringify(body)?.slice(0, 300) });
    throw new SttError(502, FAILED);
  }
  const alt = body?.results?.channels?.[0]?.alternatives?.[0];
  return { transcript: (alt?.transcript ?? "").trim(), language: body?.results?.channels?.[0]?.detected_language, confidence: alt?.confidence, duration_s: body?.metadata?.duration, provider: "deepgram", model: sttConfig.model };
}

async function openaiCompatible(audio: Buffer, contentType: string | undefined): Promise<Transcription> {
  const form = new FormData();
  const ext = (contentType ?? "").includes("webm") ? "webm" : (contentType ?? "").includes("wav") ? "wav" : (contentType ?? "").includes("mp4") || (contentType ?? "").includes("m4a") ? "m4a" : "ogg";
  form.append("file", new Blob([new Uint8Array(audio)], { type: contentType ?? "application/octet-stream" }), `note.${ext}`);
  form.append("model", sttConfig.model);
  form.append("response_format", "verbose_json");
  if (sttConfig.language) form.append("language", sttConfig.language);
  if (sttConfig.keywords.length) form.append("prompt", sttConfig.keywords.join(", "));
  const res = await fetch(`${sttConfig.base}/audio/transcriptions`, { method: "POST", headers: sttConfig.apiKey ? { Authorization: `Bearer ${sttConfig.apiKey}` } : {}, body: form, signal: AbortSignal.timeout(60_000) });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    log.error("stt endpoint error", { status: res.status, detail: JSON.stringify(body)?.slice(0, 300) });
    throw new SttError(502, FAILED);
  }
  return { transcript: String(body?.text ?? "").trim(), language: body?.language, duration_s: typeof body?.duration === "number" ? body.duration : undefined, provider: "openai-compatible", model: sttConfig.model };
}

/** Core STT call. Throws SttError with a client-safe message. */
export async function transcribeAudio(audio: Buffer, contentType: string | undefined): Promise<Transcription> {
  if (!sttEnabled()) throw new SttError(501, "Voice notes are not configured on this gateway.");
  if (!Buffer.isBuffer(audio) || audio.length < 100) throw new SttError(400, "Expected raw audio bytes in the request body.");
  return withSpan("stt.transcribe", { attrs: { "agent.stt.provider": sttConfig.provider, "agent.stt.bytes": audio.length } }, async (span) => {
    const t0 = Date.now();
    let tx: Transcription;
    try {
      tx = sttConfig.provider === "deepgram" ? await deepgram(audio, contentType) : await openaiCompatible(audio, contentType);
    } catch (e) {
      if (e instanceof SttError) throw e;
      log.error("transcribe failed", { error: (e as Error).message });
      throw new SttError(502, FAILED);
    }
    counter("stt_requests_total", { description: "Voice notes transcribed" }).add(1, { provider: tx.provider, ok: Boolean(tx.transcript) });
    counter("stt_seconds_total", { description: "Audio seconds transcribed (what the vendor bills)", unit: "s" }).add(tx.duration_s ?? 0, { provider: tx.provider });
    span.setAttributes({ "agent.stt.ms": Date.now() - t0, "agent.stt.duration_s": tx.duration_s ?? 0, "agent.stt.chars": tx.transcript.length });
    log.info("transcribed", { ms: Date.now() - t0, bytes: audio.length, duration_s: tx.duration_s, language: tx.language, chars: tx.transcript.length });
    if (!tx.transcript) throw new SttError(422, "Couldn't make out any speech in that note — try again a bit closer to the mic.");
    return tx;
  });
}

export async function handleTranscribe(req: express.Request, res: express.Response): Promise<void> {
  try {
    res.json(await transcribeAudio(req.body as Buffer, req.header("content-type")));
  } catch (e) {
    if (e instanceof SttError) res.status(e.status).json({ error: e.message });
    else res.status(502).json({ error: FAILED });
  }
}
