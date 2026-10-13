/**
 * @marg-adk/metering — the client a product embeds to report usage to a metering service.
 *
 * RULES FOR EMITTERS (docs/METERING.md):
 *  - No PII, no content in events — opaque ids only. Events are retained for years.
 *  - A deterministic `event_id` wherever your own code may retry — retries are then free.
 *  - Omit `vendor_cost` when no third party charged for the work (our own cache hit ⇒ nothing to bill).
 *  - LLM usage: one event per model call (or per turn) with provider/model dimensions.
 *
 * The client buffers events, POSTs them in batches, retries with backoff, and FAILS OPEN: a
 * metering outage never blocks a turn — events beyond the buffer are dropped and reported via
 * `onDrop`. `check(account)` asks "may this account keep going?" on the hot path, bounded to
 * 300 ms, and answers allowed=true on any trouble.
 */

export interface MeteringEvent {
  account_id: string;
  /** Catalogue key: "<product>.<resource>.<unit>" e.g. "agent.llm.tokens", "agent.stt.audio_seconds". */
  sku: string;
  quantity: number;
  dimensions?: Record<string, string>;
  /** What the vendor billed us for this work, in micro-units of `currency`. */
  vendor_cost?: { amount_micros: number; currency: string };
  /** Deterministic id for idempotent retries. */
  event_id?: string;
  ts?: string;
}

export interface MeteringClientOptions {
  baseUrl: string;
  apiKey: string;
  product: string;
  /** Flush at most every N ms (default 1000) or when the buffer reaches `batchSize` (default 100). */
  flushMs?: number;
  batchSize?: number;
  /** Events kept while the service is unreachable (default 5000); older ones are dropped. */
  maxBuffer?: number;
  onDrop?: (events: MeteringEvent[], reason: string) => void;
  fetchImpl?: typeof fetch;
}

export class MeteringClient {
  private buffer: MeteringEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private closed = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: MeteringClientOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** Record one event. Synchronous, never throws. */
  record(ev: MeteringEvent): void {
    if (this.closed) return;
    const event = { ...ev, ts: ev.ts ?? new Date().toISOString(), event_id: ev.event_id ?? `${ev.account_id}:${ev.sku}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` };
    this.buffer.push(event);
    const max = this.o.maxBuffer ?? 5000;
    if (this.buffer.length > max) {
      const dropped = this.buffer.splice(0, this.buffer.length - max);
      this.o.onDrop?.(dropped, "buffer_full");
    }
    if (this.buffer.length >= (this.o.batchSize ?? 100)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.o.flushMs ?? 1000);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** May this account keep going? Bounded to 300 ms; fails open. */
  async check(accountId: string): Promise<{ allowed: boolean; reason?: string; percent?: number }> {
    try {
      const res = await this.fetchImpl(`${this.o.baseUrl.replace(/\/+$/, "")}/v1/check/${encodeURIComponent(accountId)}`, { headers: { Authorization: `Bearer ${this.o.apiKey}` }, signal: AbortSignal.timeout(300) });
      if (!res.ok) return { allowed: true, reason: `check HTTP ${res.status} (fail-open)` };
      const body = (await res.json()) as { allowed?: boolean; reason?: string; percent?: number };
      return { allowed: body.allowed !== false, reason: body.reason, percent: body.percent };
    } catch (e) {
      return { allowed: true, reason: `check unavailable: ${(e as Error).message} (fail-open)` };
    }
  }

  /** Send what is buffered now. Resolves when the attempt ends (success, or scheduled retry). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) return this.inFlight;
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0, this.o.batchSize ?? 100);
    this.inFlight = (async () => {
      try {
        const res = await this.fetchImpl(`${this.o.baseUrl.replace(/\/+$/, "")}/v1/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.o.apiKey}` },
          body: JSON.stringify({ product: this.o.product, events: batch }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.failures = 0;
      } catch (e) {
        this.failures++;
        this.buffer.unshift(...batch);
        const max = this.o.maxBuffer ?? 5000;
        if (this.buffer.length > max) this.o.onDrop?.(this.buffer.splice(max), `unreachable: ${(e as Error).message}`);
        if (!this.closed) {
          this.timer = setTimeout(() => void this.flush(), Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)));
          (this.timer as { unref?: () => void }).unref?.();
        }
      } finally {
        this.inFlight = undefined;
      }
    })();
    await this.inFlight;
    if (this.buffer.length >= (this.o.batchSize ?? 100) && !this.failures) void this.flush();
  }

  /** Final flush (SIGTERM). What cannot be sent within the bound is reported as dropped. */
  async close(timeoutMs = 2000): Promise<void> {
    this.closed = true;
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, timeoutMs))]);
    if (this.buffer.length) this.o.onDrop?.(this.buffer.splice(0), "closed_with_pending");
  }

  get pending(): number {
    return this.buffer.length;
  }
}
