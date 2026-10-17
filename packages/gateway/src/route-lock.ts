/**
 * route-lock.ts — when the router must NOT classify a turn (ADR-0001: sticky means "never re-route
 * mid-journey or after completion", not "after the first turn").
 *
 * What comes in:  the session's completion, its draft and whether a routing link ever DECIDED its
 *                 domain (keywords, a decision model, the LLM), as against the no-hit fallback to the
 *                 first domain.
 * What goes out:  whether the active domain keeps the turn without a classification.
 * Who talks to it: router.ts (routeTurn), and its test.
 *
 * Incident: a chat that began with "hello there" (no keyword hit, so the first domain answered) was
 * locked to that domain for good, because the step engine creates an empty draft (`steps: {}`) on the
 * first turn of every domain and the lock read "a draft exists". The next message, a ticket opener,
 * never reached the router.
 */
import type { PreviewState } from "@marg-adk/types";

/** The route links that did not decide anything: a no-hit fallback, the lock itself, a lone domain. */
const NOT_A_DECISION = new Set(["fallback", "sticky", "single"]);

/** A routing link picked this domain (a rule, a decision model or the LLM), as against a fallback. */
export const wasDecided = (by: string): boolean => !NOT_A_DECISION.has(by);

/** The domain agent has begun the job: something is gathered, a step has state, the summary or a review is up. An empty draft is not a journey. */
export function journeyStarted(preview: PreviewState | undefined): boolean {
  if (!preview) return false;
  return Object.keys(preview.slots ?? {}).length > 0 || Object.keys(preview.steps ?? {}).length > 0 || preview.state !== "gathering" || Boolean(preview.summary_shown) || Boolean(preview.edit);
}

/** The active domain keeps the turn: the chat finished, a link decided its domain, or its journey has begun. */
export function holdsTheChat(session: { completion?: unknown; domainDecided?: boolean; preview?: PreviewState }): boolean {
  return Boolean(session.completion) || session.domainDecided === true || journeyStarted(session.preview);
}
