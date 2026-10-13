/**
 * metering-sink.ts — the gateway's hand-off to a metering service (docs/METERING.md).
 *
 * PASS-THROUGH PRINCIPLE: bill only what vendors bill you. Each turn produces vendor cost
 * lines (llm tokens by bucket per model, speech-to-text seconds, paid lookups); work served
 * from your own infrastructure (a cache hit, a runtime-answered turn) costs nothing and is
 * recorded as such. Events carry opaque ids only — never content, never PII — because a
 * ledger is retained for years.
 *
 * The sink is fail-open and non-blocking: a metering outage drops events after a bounded
 * buffer and logs, it never fails a turn. Configure AGENT_METERING_URL (+ _API_KEY) to POST
 * batches to an HTTP collector (the @marg/metering client shape); unset ⇒ the JSONL ledger
 * written by @marg/core is the record.
 */
import { MeteringClient, type MeteringEvent } from "@marg/metering";
import { log } from "@marg/core";

export interface TurnCost {
  account_id: string;
  session_id: string;
  turn: number;
  domain: string;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  cost_usd: number;
  provider?: string;
  model?: string;
  runtime: boolean;
}

const client = process.env.AGENT_METERING_URL
  ? new MeteringClient({ baseUrl: process.env.AGENT_METERING_URL, apiKey: process.env.AGENT_METERING_API_KEY ?? "", product: process.env.AGENT_METERING_PRODUCT ?? "agent", onDrop: (events, reason) => log.error("metering events dropped", { n: events.length, reason }) })
  : undefined;

export const meteringSink = {
  enabled: Boolean(client),
  turn(t: TurnCost): void {
    if (!client) return;
    if (t.runtime || (!t.tokens.input && !t.tokens.output && !t.tokens.cache_read)) return; // our own infrastructure: nothing to bill
    const ev: MeteringEvent = {
      account_id: t.account_id,
      sku: "agent.llm.tokens",
      quantity: t.tokens.input + t.tokens.output + t.tokens.cache_read + t.tokens.cache_write,
      dimensions: { provider: t.provider ?? "unknown", model: t.model ?? "unknown", domain: t.domain },
      vendor_cost: { amount_micros: Math.round(t.cost_usd * 1e6), currency: "USD" },
      event_id: `${t.session_id}:${t.turn}:llm`,
    };
    client.record(ev);
  },
  stt(account_id: string, session_id: string, turn: number, seconds: number, costUsd: number, provider: string, model: string): void {
    if (!client || !seconds) return;
    client.record({ account_id, sku: "agent.stt.audio_seconds", quantity: seconds, dimensions: { provider, model }, vendor_cost: { amount_micros: Math.round(costUsd * 1e6), currency: "USD" }, event_id: `${session_id}:${turn}:stt` });
  },
  async check(account_id: string): Promise<boolean> {
    if (!client) return true;
    return (await client.check(account_id)).allowed;
  },
  async close(): Promise<void> {
    await client?.close();
  },
};
