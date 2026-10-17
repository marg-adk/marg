/** route-lock.test.ts — when the active domain keeps a turn without a classification, pinned. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreviewState } from "@marg-adk/types";
import { holdsTheChat, journeyStarted, wasDecided } from "./route-lock.js";

const draft = (over: Partial<PreviewState> = {}): PreviewState => ({ tool: "", state: "gathering", slots: {}, missing: [], ...over });

test("the empty draft the step engine creates on a first turn is not a journey", () => {
  assert.equal(journeyStarted(undefined), false);
  assert.equal(journeyStarted(draft()), false);
  assert.equal(journeyStarted(draft({ steps: {} })), false, "steps: {} exists after any first turn");
});

test("a journey has begun once something is gathered, a step has state, or a card is up", () => {
  assert.equal(journeyStarted(draft({ slots: { title: "login fails" } })), true);
  assert.equal(journeyStarted(draft({ steps: { details: { status: "asked", asked: 1 } } })), true);
  assert.equal(journeyStarted(draft({ state: "validated" })), true);
  assert.equal(journeyStarted(draft({ summary_shown: true })), true);
  assert.equal(journeyStarted(draft({ edit: { status: "picking", asked: 1, via: "chip" } })), true);
});

test("only a link that decided counts as a decision, not a fallback, the lock or a lone domain", () => {
  for (const by of ["keywords", "systemone", "llm"]) assert.equal(wasDecided(by), true, by);
  for (const by of ["fallback", "sticky", "single"]) assert.equal(wasDecided(by), false, by);
});

test("the active domain keeps the chat when it finished, was decided, or its journey began", () => {
  assert.equal(holdsTheChat({}), false, "a chat that only fell back to the first domain is classified again");
  assert.equal(holdsTheChat({ preview: draft({ steps: {} }) }), false);
  assert.equal(holdsTheChat({ domainDecided: true }), true);
  assert.equal(holdsTheChat({ completion: { entity_id: "X-1" } }), true);
  assert.equal(holdsTheChat({ preview: draft({ slots: { title: "x" } }) }), true);
});
