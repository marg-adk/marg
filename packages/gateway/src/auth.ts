/**
 * auth.ts — the agent-token exchange (docs/SDK-AUTH.md).
 *
 * Your app authenticates the user against YOUR auth service. It never hands that broad token to
 * a web view or a widget: it exchanges it here for a short-lived AGENT TOKEN that only this
 * gateway accepts. The exchange verifies the upstream token strictly (AGENT_AUTH_VERIFY_URL,
 * fails closed), checks an entitlement when configured (seats/caps), vaults the upstream token
 * server-side so tool calls can act as the user, and mints an HS256 JWT:
 *   { sub, name, firm_id, tenant, jti, iat, exp }   signed with AGENT_TOKEN_SECRET.
 *
 * Every /api/* call then carries the agent token; `verifyAgentToken` checks signature, expiry
 * and revocation. Logout revokes the jti and drops the vaulted token. Without AGENT_TOKEN_SECRET
 * the exchange is disabled (501) — the widget then sends the upstream token directly, verified by
 * the same strict check (security.ts).
 *
 * The vault is in-process memory here; a multi-node deployment swaps it for Redis (one function).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type express from "express";
import { envNum, log } from "@marg-adk/core";

const SECRET = process.env.AGENT_TOKEN_SECRET ?? "";
const TTL_S = envNum("AGENT_TOKEN_TTL_S", 900);
const TENANTS = new Map<string, string>(); // app key → tenant name
for (const pair of (process.env.AGENT_APP_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const [key, tenant] = pair.split(":");
  if (key) TENANTS.set(key, tenant ?? "default");
}

export interface AgentClaims {
  sub: string;
  name?: string;
  firm_id?: string;
  tenant: string;
  seat?: string;
  jti: string;
  iat: number;
  exp: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function sign(payload: AgentClaims): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "agent" }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const revoked = new Map<string, number>(); // jti → exp
const vault = new Map<string, { token: string; exp: number }>(); // jti → upstream token

/** Verify an agent token: signature, expiry, revocation. Undefined for anything else (a raw upstream token, garbage). */
export function verifyAgentToken(token: string): AgentClaims | undefined {
  if (!SECRET) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (head?.kid !== "agent") return undefined;
    const expected = createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AgentClaims;
    if (!claims.sub || !claims.jti || claims.exp * 1000 < Date.now()) return undefined;
    if (revoked.has(claims.jti)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** The upstream token vaulted for an agent token (what tool calls use to act as the user). */
export function vaultedToken(claims: AgentClaims): string | undefined {
  const v = vault.get(claims.jti);
  return v && v.exp > Date.now() ? v.token : undefined;
}

export interface Entitlement {
  seat: "active" | "none" | "suspended";
  plan?: string;
  cap?: { credits: number; period: "month" | "day"; resets_at?: string };
  firm_status?: "active" | "past_due";
}

/** Entitlement lookup (seats, caps): GET AGENT_ENTITLEMENT_URL/{firm_id}/{sub} with a service key. Unset ⇒ everyone is seated. */
async function entitlementFor(sub: string, firm?: string): Promise<Entitlement> {
  const base = (process.env.AGENT_ENTITLEMENT_URL ?? "").replace(/\/+$/, "");
  if (!base) return { seat: "active" };
  try {
    const res = await fetch(`${base}/${encodeURIComponent(firm ?? "-")}/${encodeURIComponent(sub)}`, { headers: { Authorization: `Bearer ${process.env.AGENT_ENTITLEMENT_KEY ?? ""}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Entitlement;
  } catch (e) {
    log.warn("entitlement lookup failed — refusing the exchange", { error: (e as Error).message });
    throw Object.assign(new Error("Entitlement service unavailable"), { status: 503, userSafe: true });
  }
}

export const exchangeEnabled = (): boolean => Boolean(SECRET);

/**
 * POST /api/auth/exchange — headers: X-Agent-App-Key (when AGENT_APP_KEYS is set), Authorization: Bearer <upstream token>.
 * `identify` is the strict verifier from security.ts (passed in to avoid a cycle).
 */
export async function handleExchange(req: express.Request, res: express.Response, identify: (bearer: string) => Promise<{ status: number; identity?: { sub: string; name?: string; firm_id?: string; source: string } }>): Promise<void> {
  if (!SECRET) {
    res.status(501).json({ error: "Token exchange is not configured (AGENT_TOKEN_SECRET)." });
    return;
  }
  let tenant = "default";
  if (TENANTS.size) {
    const appKey = req.header("x-agent-app-key") ?? "";
    const t = TENANTS.get(appKey);
    if (!t) {
      res.status(401).json({ error: "Unknown app key.", code: "invalid_app_key" });
      return;
    }
    tenant = t;
  }
  const upstream = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!upstream) {
    res.status(401).json({ error: "Send the user's token as Authorization: Bearer.", code: "invalid_token" });
    return;
  }
  const { status, identity } = await identify(upstream);
  if (status !== 200 || !identity || identity.source === "unverified") {
    res.status(status === 503 ? 503 : 401).json({ error: status === 503 ? "The sign-in service is unavailable." : "The token was not accepted.", code: status === 503 ? "auth_unavailable" : "invalid_token" });
    return;
  }
  let ent: Entitlement;
  try {
    ent = await entitlementFor(identity.sub, identity.firm_id);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message, code: "entitlement_unavailable" });
    return;
  }
  if (ent.firm_status === "past_due") {
    res.status(403).json({ error: "Your organisation's account is inactive.", code: "firm_inactive" });
    return;
  }
  if (ent.seat !== "active") {
    res.status(403).json({ error: "You don't have a seat yet — ask your admin for one.", code: "no_seat", seat: ent.seat });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const claims: AgentClaims = { sub: identity.sub, name: identity.name, firm_id: identity.firm_id, tenant, seat: ent.plan, jti: randomUUID(), iat: now, exp: now + TTL_S };
  vault.set(claims.jti, { token: upstream, exp: claims.exp * 1000 + 60_000 });
  log.info("agent token issued", { sub: identity.sub, tenant, ttl_s: TTL_S });
  res.json({ agent_token: sign(claims), expires_in: TTL_S, user: { id: identity.sub, name: identity.name }, firm: identity.firm_id ? { id: identity.firm_id } : undefined, seat: { status: ent.seat, plan: ent.plan }, cap: ent.cap });
}

/** POST /api/auth/logout — revoke the agent token and drop the vaulted upstream token. */
export function handleLogout(req: express.Request, res: express.Response): void {
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const claims = verifyAgentToken(token);
  if (claims) {
    revoked.set(claims.jti, claims.exp);
    vault.delete(claims.jti);
  }
  res.json({ ok: true });
}

/** Server-to-server revoke (admin key): revoke every live token of a user. */
export function revokeUser(sub: string): number {
  let n = 0;
  for (const [jti, v] of vault) {
    void v;
    const claims = { jti };
    void claims;
    n++;
  }
  // Tokens are opaque here; a deployment keeps a sub → jti index in Redis. In-process we drop the whole vault for simplicity.
  for (const jti of [...vault.keys()]) revoked.set(jti, Math.floor(Date.now() / 1000) + TTL_S);
  vault.clear();
  log.warn("tokens revoked (in-process vault cleared)", { sub, dropped: n });
  return n;
}

// housekeeping: forget expired revocations and vault entries hourly
setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of revoked) if (exp * 1000 < now) revoked.delete(jti);
  for (const [jti, v] of vault) if (v.exp < now) vault.delete(jti);
}, 3_600_000).unref();
