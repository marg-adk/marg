/** widget.test.ts — the real widget under Node: every block's tap sends the right message, forms gate and echo, resume replays, uploads land, a lost session recovers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { file, makeWorld, type Json } from "./widget-harness.js";

const chips = { type: "chips", options: [{ label: "Billing", value: "billing" }, { label: "Technical", value: "technical" }] };

test("chips: a tap sends the option's VALUE; the answered row is retired", async () => {
  const world = await makeWorld();
  world.draw(chips);
  world.btn("Technical").click();
  await world.settle();
  assert.deepEqual(world.chat, ["technical"]);
  assert.ok(world.q(".chips")!.classList.contains("used"), "the answered row is marked used (the CSS greys it and drops pointer events)");
});

test("list: a tap sends the item's value (or its title)", async () => {
  const world = await makeWorld();
  world.draw({ type: "list", items: [{ title: "Northwind Traders", subtitle: "Enterprise · Berlin", value: "cust-1" }, { title: "Northwind Health" }] });
  world.qa(".list .li")[1].click();
  world.qa(".list .li")[0].click();
  await world.settle();
  assert.deepEqual(world.chat, ["Northwind Health"], "the second tap lands on a retired row");
});

test("form: required rows gate the submit; the wire format and the echo are what forms.ts expects", async () => {
  const world = await makeWorld();
  world.draw({
    type: "form", title: "Details", submit: "Done", echo: "Details confirmed",
    rows: [
      { key: "environment", label: "Environment", kind: "pick", required: true, options: [{ label: "Production", value: "production" }, { label: "Staging", value: "staging" }], say: "{v}" },
      { key: "steps", label: "Steps to reproduce", kind: "text", required: true, say: "" },
      { key: "affected_users", label: "Affected users", kind: "num", say: { one: "1 user affected", many: "{v} users affected" } },
    ],
  });
  const done = world.btn("Done");
  assert.equal(done.disabled, true);
  assert.equal(done.textContent, "Done (2 to fill)");
  world.btn("Production", world.q(".form")!).click();
  assert.equal(done.textContent, "Done (1 to fill)");
  world.type(world.qa(".form input.fi")[0], "Open the app; tap login");
  assert.equal(done.disabled, false);
  done.click();
  await world.settle();
  assert.equal(world.turns[0].message, "Environment [environment]: production; Steps to reproduce [steps]: Open the app, tap login");
  assert.equal(world.turns[0].display, "Details confirmed: Production");
  assert.deepEqual(world.texts(".msg.user"), ["Details confirmed: Production"], "the user's bubble shows the echo, not the wire format");
});

test("multichips: a minimum gates Done; own entries join the picks; Skip sends the skip value", async () => {
  const world = await makeWorld();
  world.draw({ type: "multichips", min: 2, submit: "Done", options: [{ label: "A" }, { label: "B" }, { label: "C" }], own: { max: 20 }, skip: { label: "Skip", value: "skip features" } });
  const done = world.btn("Done");
  assert.equal(done.disabled, true);
  world.btn("A").click();
  assert.equal(done.disabled, true);
  world.btn("B").click();
  assert.equal(done.disabled, false);
  world.type(world.q(".own input")!, "Mine");
  world.btn("Add").click();
  done.click();
  await world.settle();
  assert.deepEqual(world.chat, ["A, B, Mine"]);
  world.draw({ type: "multichips", min: 1, options: [{ label: "X" }], skip: { label: "Skip", value: "skip features" } });
  world.btn("Skip", world.qa(".chips.multi").at(-1)!).click();
  await world.settle();
  assert.deepEqual(world.chat, ["A, B, Mine", "skip features"]);
});

test("card: a section chip sends 'Edit <label>'; an action sends its value", async () => {
  const world = await makeWorld();
  const card = { type: "card", title: "Summary", fields: [{ label: "Title", value: "x" }, { label: "Channel", value: "email (default)", source: "default" }], sections: [{ key: "priority", label: "Priority", value: "Edit Priority" }], actions: [{ label: "Confirm & create ticket", value: "yes, create it" }, { label: "Change something", value: "I want to change something" }] };
  world.draw(card);
  world.btn("✎ Priority").click();
  await world.settle();
  world.draw(card);
  world.btn("Confirm & create ticket").click();
  await world.settle();
  assert.deepEqual(world.chat, ["Edit Priority", "yes, create it"]);
  assert.ok(world.texts(".card .src").includes("default"), "a default is tagged on the card");
});

test("link: only http(s) and allow-listed schemes are rendered", async () => {
  const world = await makeWorld({ init: { linkSchemes: ["myapp"] } });
  world.draw({ type: "link", label: "Bad", url: "javascript:alert(1)" }, { type: "link", label: "Open", url: "https://app.test/t/1" }, { type: "link", label: "App", url: "myapp://ticket/1" });
  const links = world.qa("a");
  assert.deepEqual(links.map((a) => a.textContent), ["Open", "App"]);
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
});

test("toggles: Done sends the on-set with the wire prefix, or the 'none' phrase", async () => {
  const world = await makeWorld();
  world.draw({ type: "toggles", options: [{ label: "Price", value: "price" }, { label: "Phone", value: "phone", on: true }], submit: "Done" });
  world.btn("Done").click();
  await world.settle();
  world.draw({ type: "toggles", options: [{ label: "Price", value: "price" }], submit: "Done", wire: { prefix: "Hide: ", none: "Keep everything visible" } });
  world.btn("Done", world.qa(".toggles").at(-1)!).click();
  await world.settle();
  assert.deepEqual(world.chat, ["Hide: phone", "Keep everything visible"]);
});

test("streaming turn: deltas fill the bubble, the done event draws the blocks, the preview reaches the host", async () => {
  const world = await makeWorld({ stream: true, previews: true });
  world.chatReply = { reply: "Hello **there**", ui: [chips], usage: null, preview: { state: "gathering", slots: { title: "x" }, missing: ["category"] } };
  world.w._send("hi");
  await world.settle(8);
  assert.deepEqual(world.turns.map((t) => t.message), ["hi"]);
  assert.ok(world.texts(".msg.bot").some((t) => t.includes("Hello there")), world.texts(".msg.bot").join(" | "));
  assert.equal(world.qa(".chips button.chip").length, 2);
  assert.equal(world.previews.length, 1);
  assert.equal(world.previews[0]?.slots.title, "x");
});

test("resume: a stored session id replays the transcript and keeps the last ask tappable", async () => {
  const world = await makeWorld({
    session: false,
    store: { "marg:sid:http://gw.test": "sess-9" },
  });
  world.history = { entries: [{ role: "user", text: "ticket for Northwind" }, { role: "bot", text: "Which one?", ui: [chips] }], completed: false, nudge: { enabled: false }, usage: null };
  // the widget resumed during init with the default (empty) history; start it again with the transcript
  world.w._replayHistory(world.history);
  await world.settle();
  assert.equal(world.w.sessionId, "sess-9");
  assert.ok(world.calls.some((c) => c.method === "GET" && c.path === "/api/session/sess-9/history"));
  assert.ok(world.texts(".msg.user").includes("ticket for Northwind"));
  const live = world.qa(".chips button.chip").filter((c) => !c.disabled);
  assert.equal(live.length, 2, "the last ask is still tappable");
  live[0].click();
  await world.settle();
  assert.deepEqual(world.chat, ["billing"]);
});

test("resume of a finished chat enters the completed state", async () => {
  const world = await makeWorld({ session: false, store: { "marg:sid:http://gw.test": "sess-done" } });
  world.w._replayHistory({ entries: [{ role: "bot", text: "Created." }], completed: true, completion: { entity_id: "TCK-1", label: "Ticket TCK-1" }, nudge: { enabled: false }, usage: null });
  await world.settle();
  assert.equal(world.w.completed, true);
});

test("upload: a picked file POSTs to /api/media with the session and filename headers, lands as a tile with a note, and ✕ removes it", async () => {
  const world = await makeWorld();
  world.pick([file("kitchen.jpg")]);
  await world.settle(6);
  const post = world.calls.find((c) => c.method === "POST" && c.path === "/api/media");
  assert.ok(post, "the upload request");
  assert.equal(post.headers["X-Agent-Session"], "sess-1");
  assert.equal(post.headers["X-Agent-Filename"], "kitchen.jpg");
  assert.equal(world.qa(".media .thumb").length, 1);
  assert.equal(world.q(".mnote")?.textContent, "1 file ready — attached when you confirm.");
  assert.equal(world.blobs.created.length, 1, "a local preview object URL, nothing fetched back");
  world.btn("✕", world.q(".media .thumb")!).click();
  await world.settle(6);
  assert.ok(world.calls.some((c) => c.method === "DELETE" && c.path === "/api/media" && c.query.get("key") === "key1"));
  assert.equal(world.qa(".media .thumb").length, 0);
});

test("a lost session recovers once: a new session is minted and the message is re-sent", async () => {
  const world = await makeWorld();
  let n = 0;
  world.handlers.push((req, next) => (req.path === "/api/chat" && n++ === 0 ? { status: 400, body: { error: "unknown session" } } : next()));
  world.w._send("hello");
  await world.settle(10);
  assert.equal(world.calls.filter((c) => c.method === "POST" && c.path === "/api/session").length, 2);
  assert.deepEqual(world.turns.map((t) => t.message), ["hello"]);
  assert.ok(world.texts(".msg.bot").some((t) => /Reconnected/.test(t)));
});

test("onTurn: the host receives the finished turn's facts on both transports; header:false mounts no title bar", async () => {
  for (const stream of [true, false]) {
    const turns: Json[] = [];
    const world = await makeWorld({ stream, previews: true, init: { header: false, onTurn: (t: Json) => turns.push(t) } });
    world.chatReply = { reply: "Priority set to High.", ui: [], usage: { input_tokens: 10, output_tokens: 4 }, domain: "support-intake", kind: "priority", tool_trace: [{ tool: "validate_ticket_slots", ms: 3 }] };
    world.w._send("high");
    await world.settle(8);
    assert.equal(turns.length, 1, `stream=${stream}`);
    assert.equal(turns[0].user, "high");
    assert.equal(turns[0].domain, "support-intake");
    assert.equal(turns[0].kind, "priority");
    assert.deepEqual(JSON.parse(JSON.stringify(turns[0].tool_trace)), [{ tool: "validate_ticket_slots", ms: 3 }]);
    assert.equal(turns[0].usage.output_tokens, 4);
    assert.equal(typeof turns[0].ms, "number");
    assert.equal(world.qa(".head").length, 0, "no title bar when header:false");
    assert.ok(world.qa(".foot textarea").length === 1, "the composer is still there");
  }
});

const devTrace: Json = {
  turn: 1,
  route: { domain: "support-intake", by: "keywords", confidence: 0.53 },
  steps: [{ step: "details", event: "late_draw", via: "late" }],
  tools: [{ name: "search_customers", args: { query: "Northwind" }, result: '{"customers":[{"name":"Northwind Traders"},{"name":"Northwind Health"}]}', ms: 3, ok: true }],
  llm: [{ round: 0, endpoint: "mock", model: "mock", ms: 5, input: 100, output: 7, finish: "tool_calls" }],
};

test("onTurn carries the gateway's dev trace on both transports, and null when the gateway sends none", async () => {
  for (const stream of [true, false]) {
    const turns: Json[] = [];
    const world = await makeWorld({ stream, init: { header: false, onTurn: (t: Json) => turns.push(t) } });
    world.chatReply = { reply: "Which one?", ui: [], usage: null, domain: "support-intake", trace: devTrace };
    world.w._send("ticket for Northwind");
    await world.settle(8);
    world.chatReply = { reply: "Noted.", ui: [], usage: null, domain: "support-intake" };
    world.w._send("thanks");
    await world.settle(8);
    assert.equal(turns.length, 2, `stream=${stream}`);
    const t = JSON.parse(JSON.stringify(turns[0].trace));
    assert.deepEqual(t.route, { domain: "support-intake", by: "keywords", confidence: 0.53 }, `stream=${stream}`);
    assert.deepEqual(t.steps, [{ step: "details", event: "late_draw", via: "late" }]);
    assert.equal(t.tools[0].name, "search_customers");
    assert.deepEqual(t.tools[0].args, { query: "Northwind" });
    assert.match(t.tools[0].result, /Northwind Traders.*Northwind Health/);
    assert.equal(t.llm[0].finish, "tool_calls");
    assert.equal(turns[0].reply, "Which one?", "the existing fields keep their place");
    assert.equal(turns[1].trace, null, "no dev trace from the gateway: null, never undefined");
  }
});

test("onHistory: a resumed or opened chat hands the host the whole history response, before the replay; a host that throws breaks nothing", async () => {
  const seen: Json[] = [];
  const world = await makeWorld({ session: false, store: { "marg:sid:http://gw.test": "sess-9" }, init: { onHistory: (j: Json) => seen.push(j) } });
  await world.settle();
  const history: Json = {
    entries: [{ role: "user", text: "ticket for Northwind" }, { role: "assistant", text: "Which one?", ui: [chips] }],
    completed: false,
    nudge: { enabled: false },
    usage: null,
    preview: { state: "gathering", slots: { customer_name: "Northwind Traders" }, missing: ["category"] },
    turns: [{ turn: 1, user: "ticket for Northwind", ms: 40, domain: "support-intake", tool_trace: [], trace: devTrace }],
  };
  world.history = history;
  world.w.openSession("sess-2");
  await world.settle();
  const got = seen.at(-1)!;
  assert.equal(got.preview.slots.customer_name, "Northwind Traders", "the draft the host rebuilds its pane from");
  assert.equal(got.turns[0].trace.route.by, "keywords", "the per-turn facts the host rebuilds its trace pane from");
  assert.ok(world.texts(".msg.user").includes("ticket for Northwind"), "and the transcript still replays");

  // a completed chat is handed over too (its final draft and its trace are what the host shows)
  world.history = { ...history, completed: true, completion: { entity_id: "TCK-1", label: "TCK-1" }, preview: { state: "created", slots: {}, missing: [] } };
  world.w.openSession("sess-3");
  await world.settle();
  assert.equal(seen.at(-1)!.completion.entity_id, "TCK-1");

  // a host hook that throws does not stop the replay
  const bad = await makeWorld({ session: false, store: { "marg:sid:http://gw.test": "sess-9" }, init: { onHistory: () => { throw new Error("host bug"); } } });
  bad.history = history;
  bad.w.openSession("sess-4");
  await bad.settle();
  assert.ok(bad.texts(".msg.user").includes("ticket for Northwind"));
});

test("form: a date row is a native date input and its value travels as YYYY-MM-DD", async () => {
  const world = await makeWorld();
  world.draw({ type: "form", title: "Booking details", submit: "Done", rows: [{ key: "date", label: "Date", kind: "date", required: true }, { key: "party_size", label: "Party size", kind: "num", required: true }] });
  const date = world.qa("input.fi")[0];
  assert.equal(date.getAttribute("type"), "date");
  world.type(date, "2026-11-06");
  world.type(world.qa("input.fi")[1], "4");
  world.btn("Done").click();
  await world.settle();
  assert.equal(world.chat.at(-1), "Date [date]: 2026-11-06; Party size [party_size]: 4");
});
