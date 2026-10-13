/** widget.test.ts — the real widget under Node: every block's tap sends the right message, forms gate and echo, resume replays, uploads land, a lost session recovers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { file, makeWorld } from "./widget-harness.js";

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
