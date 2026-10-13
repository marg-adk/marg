/**
 * security.ts — the gateway's security toolbox.
 *
 * CORS allowlist, the shared gateway key (embed-level gating — the key ships inside host pages,
 * so it stops casual abuse, it is not authentication), security headers, the message-length
 * cap, the compulsory-login gate, VERIFIED identity, owner checks, the admin gate, and the safe
 * error formatter that keeps internal detail out of client responses.
 *
 * Everything hardening is opt-in via env so dev stays zero-config; a deployment sets all of it
 * (docs/PRODUCTION-CHECKLIST.md). What is NOT opt-in: login is required by default, a session
 * id is never a credential, admin routes fail closed when no admin key is configured in a keyed
 * deployment, and identity is verified against your auth service when AGENT_AUTH_VERIFY_URL is
 * set (no fallback to the token's own claims — the first vertical's production review found any
 * bearer string could read any chat).
 */
import { createHash, randomUUID } from "node:crypto";
import type express from "express";
import { envList, envNum, log, userIdFromToken, type Session } from "@marg/core";
import { verifyAgentToken } from "./auth.js";

export const securityConfig = {
  corsOrigins: envList("AGENT_CORS_ORIGINS"),
  gatewayKeys: new Set(envList("AGENT_GATEWAY_KEYS")),
  /** Compulsory user login. ON BY DEFAULT. Set AGENT_REQUIRE_LOGIN=false ONLY for local dev, evals and probes. */
  requireLogin: process.env.AGENT_REQUIRE_LOGIN !== "false",
  maxMessageChars: envNum("AGENT_MAX_MESSAGE_CHARS", 4000),
  adminKey: process.env.AGENT_ADMIN_KEY ?? "",
  /** Strict identity verification: GET this URL with the user's bearer; a 2xx JSON body with sub/id/user_id is the identity. */
  verifyUrl: (process.env.AGENT_AUTH_VERIFY_URL ?? "").replace(/\/+$/, ""),
};

/** The user's bearer on a request: `Authorization: Bearer …` first, else `token` in the JSON body. */
export function bearerFrom(req: express.Request): string | undefined {
  const h = req.header("authorization") ?? req.header("Authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const t = (req.body as { token?: unknown } | undefined)?.token;
  return typeof t === "string" && t ? t : undefined;
}

// ---- verified identity ---------------------------------------------------------------
export interface Identity {
  sub: string;
  name?: string;
  firm_id?: string;
  /** "agent" = a Marg agent token; "verified" = your auth service said so; "unverified" = a bare decode (dev only). */
  source: "agent" | "verified" | "unverified";
}
const identityCache = new Map<string, { until: number; id?: Identity; status: number }>();
const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 24);

/**
 * Who is this bearer? An agent token (docs/SDK-AUTH.md) is verified locally; a raw upstream token
 * is verified against AGENT_AUTH_VERIFY_URL (cached 60 s by token hash) and FAILS CLOSED — 401 on
 * a rejection, 503 when the service is unreachable. Without a verify URL the token's `sub` is an
 * unverified decode, acceptable only where login is off (dev) — a deployment sets the URL.
 */
export async function identify(bearer: string): Promise<{ status: number; identity?: Identity }> {
  const agent = verifyAgentToken(bearer);
  if (agent) return { status: 200, identity: { sub: agent.sub, name: agent.name, firm_id: agent.firm_id, source: "agent" } };
  if (!securityConfig.verifyUrl) {
    const sub = userIdFromToken(bearer);
    return sub ? { status: 200, identity: { sub, source: "unverified" } } : { status: 401 };
  }
  const key = hash(bearer);
  const cached = identityCache.get(key);
  if (cached && cached.until > Date.now()) return { status: cached.status, identity: cached.id };
  try {
    const res = await fetch(securityConfig.verifyUrl, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (res.status === 401 || res.status === 403) {
      identityCache.set(key, { until: Date.now() + 60_000, status: 401 });
      return { status: 401 };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const sub = String(data.sub ?? data.id ?? data._id ?? data.user_id ?? "");
    if (!sub) throw new Error("no subject in identity response");
    const identity: Identity = { sub, name: typeof data.name === "string" ? data.name : undefined, firm_id: typeof data.firm_id === "string" ? data.firm_id : undefined, source: "verified" };
    identityCache.set(key, { until: Date.now() + 60_000, status: 200, id: identity });
    return { status: 200, identity };
  } catch (e) {
    log.warn("identity verification unavailable — failing closed", { error: (e as Error).message });
    return { status: 503 };
  }
}

const LOGIN_EXEMPT = new Set(["/api/health", "/api/auth/exchange", "/api/metrics", "/api/usage", "/api/sessions", "/api/skills", "/api/system-prompt", "/api/decide"]);

/** Compulsory-login gate for user endpoints: 401 + code "login_required" without a verified identity. Must run AFTER express.json. */
export async function requireUserLogin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  if (!req.path.startsWith("/api/") || LOGIN_EXEMPT.has(req.path)) return next();
  if (securityConfig.adminKey && req.header("x-agent-admin-key") === securityConfig.adminKey) return next();
  const bearer = bearerFrom(req);
  if (!bearer) {
    if (!securityConfig.requireLogin) return next();
    log.warn("login required", { path: req.path });
    res.status(401).json({ error: "Log in to continue — this gateway requires a user login.", code: "login_required" });
    return;
  }
  const { status, identity } = await identify(bearer);
  if (status === 200 && identity) {
    (req as express.Request & { identity?: Identity }).identity = identity;
    return next();
  }
  if (!securityConfig.requireLogin && status === 401) return next(); // dev: a bad token is just no token
  res.status(status === 503 ? 503 : 401).json({ error: status === 503 ? "The sign-in service is unavailable — try again shortly." : "Your session has expired — log in again.", code: status === 503 ? "auth_unavailable" : "token_expired" });
}

export function identityOf(req: express.Request): Identity | undefined {
  return (req as express.Request & { identity?: Identity }).identity;
}

/** A session is its owner's. With login on, a mismatch answers 404 (never 403 — ids must not be enumerable). Admin key overrides. */
export function ownsSession(req: express.Request, session: Session): boolean {
  if (securityConfig.adminKey && req.header("x-agent-admin-key") === securityConfig.adminKey) return true;
  if (!securityConfig.requireLogin) return true;
  const id = identityOf(req);
  if (!id) return false;
  if (!session.userId) {
    session.userId = id.sub; // a session created before login is claimed by its first verified user
    return true;
  }
  return session.userId === id.sub;
}

export function corsOptions(): { origin: boolean | string[] } {
  return { origin: securityConfig.corsOrigins.length ? securityConfig.corsOrigins : true };
}

export function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!req.path.startsWith("/api/") && req.path !== "/widget.js") res.setHeader("X-Frame-Options", "DENY");
  next();
}

/** Shared-key gate for /api/* (except /api/health) — active only when keys are configured. */
export function requireGatewayKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!securityConfig.gatewayKeys.size || !req.path.startsWith("/api/") || req.path === "/api/health") return next();
  const key = req.header("x-agent-key");
  if (key && securityConfig.gatewayKeys.has(key)) return next();
  log.warn("gateway key rejected", { path: req.path, key_present: Boolean(key) });
  res.status(401).json({ error: "Missing or invalid gateway key (X-Agent-Key)." });
}

/**
 * Admin-only endpoints: AGENT_ADMIN_KEY set → the request must carry it; no admin key but the
 * gateway is keyed or login is required → DISABLED (fail closed); nothing configured (pure dev) → open.
 */
export function adminGate(req: express.Request, res: express.Response): boolean {
  if (securityConfig.adminKey) {
    if (req.header("x-agent-admin-key") !== securityConfig.adminKey) {
      res.status(401).json({ error: "Admin key required (X-Agent-Admin-Key)." });
      return false;
    }
    return true;
  }
  if (securityConfig.gatewayKeys.size || securityConfig.requireLogin) {
    res.status(403).json({ error: "Administration is disabled — set AGENT_ADMIN_KEY to enable it." });
    return false;
  }
  return true;
}

/** Client-safe error responder: expected conditions keep their message; anything else is a generic body + error_id (detail in the logs). */
export function safeError(path: string, e: unknown): { status: number; body: Record<string, unknown> } {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unknown session/i.test(msg)) return { status: 410, body: { error: msg } };
  if ((e as { userSafe?: boolean })?.userSafe) {
    log.warn("service degraded", { path, error: msg });
    return { status: (e as { status?: number })?.status ?? 503, body: { error: msg, degraded: true } };
  }
  const error_id = randomUUID().slice(0, 8);
  log.error("request failed", { path, error_id, error: msg, stack: (e as Error)?.stack?.split("\n").slice(0, 4).join(" | ") });
  return { status: 500, body: { error: "Something went wrong on our side — please try again.", error_id } };
}
