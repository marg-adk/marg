# The model must never read "yes"

*The launch post for Marg 0.2, the first release on npm. The long form first; the Show HN
comment, the r/LLMDevs post and the thread follow. Publish all four the day the packages land.*

---

We built a conversational agent that creates real records for real users: support tickets,
listings, bookings, the kind of thing that goes out under a person's name. Along the way we
measured a few things about letting the model run the conversation. The numbers changed the
design, and the design became an open-source kit called Marg. This post is about the one number
that mattered most.

## 235 out of 521

Every agent that completes a transaction has a moment where it asks "shall I create this?" and
reads the answer. The obvious way to read it is to let the model do it, or to check whether the
reply starts with a yes-word. We did the second, as a guard behind the model, and it felt safe.

Then we took a blind corpus of 521 typed replies from real conversations, the messages people
actually send when a card is on screen: instructions, facts, questions, corrections, and some
plain yeses. A leading-word reader mis-read **235** of them as a bare yes or no.

"Yes but change the title to login fails" starts with yes. "Keep this private please" starts
with a word in the confirm list for one dialect. "No, create it later" is a refusal that starts
with no and ends with an instruction. Every one of these would have settled a value or, at the
confirmation, performed a write.

Reading the whole message instead mis-read **0** of the 521. The rule is short: a reply is a
plain yes only when **every** word in it is a confirm word, politeness, filler, or a noun of
the question. Anything else is content. Content goes to the model, which answers it, and the
runtime draws its question again underneath.

The cost is asymmetric, which is why the rule can be this strict. A false "that's content" costs
the user one repeated tap. A false yes costs a write under their name.

## So the runtime owns the moments that must be right

That reader is one instance of a pattern. The model owns the conversation. The runtime owns the
moments where a wrong answer costs something: a required question, a value published under the
user's name, the confirmation, the write.

We got here by measuring the alternative. With the model asking the questions, under a prompt
rule that said to ask them, required questions were skipped on **25 to 50 percent** of turns
depending on the model. In **1 chat in 64** the model attested a list item the user never said,
with a note in the prompt covering that exact case. A better prompt lowers the rate. It does
not reach zero, and different models slip in different places.

So in Marg a step is a thing the runtime does, not a thing the model is asked to do:

```ts
chipsStep({
  key: "priority",
  label: "Priority",
  slot: "priority",
  lead: "How urgent is this?",
  options: async (ctx) => {
    const r = ctx.json(await ctx.call("reference_data", { kind: "priorities" }));
    const list: string[] = Array.isArray(r?.options) ? r.options : ["low", "medium", "high", "urgent"];
    return list.map((v) => ({ label: v.charAt(0).toUpperCase() + v.slice(1), value: v }));
  },
  say: "Priority set to {v}.",
  asksLike: /\b(priority|urgent|urgency|how urgent)\b/i,
  dependsOn: ["details"],
})
```

The runtime draws the chips, reads the tap or the typed reply by its whole content, writes the
value to the draft, carries it into every later tool call so the model's own version of that
key never stands, and tells the model one fact: "Priority set to High." The `asksLike` pattern
is the model's own sentence that gets cut if it tries to ask the question anyway. `dependsOn`
re-opens the step if the details it depends on change. A settle flows straight into the next
owed step in the same reply, with no model call, and when every step has ended and the draft
validates, into the confirmation summary. Forms, pickers, and the review ("change something" is
a runtime section picker, not a prompt) work the same way.

## The write gate, three times

The write is where the asymmetry is largest, so it is guarded three times and none of the
layers may be weakened:

1. **The skill rule.** The prompt says never to call create before the user confirms the summary.
2. **The tool schema.** `create_*` refuses without `confirmed: true` and without the environment
   write flag being the literal string `"true"`. Evals and CI run with it off.
3. **The runtime guard.** The summary must have been shown for *this* draft, fingerprinted, and
   the user's last message must be a plain go-ahead by its whole content.

The first backend we probed accepted a create with every field stripped. Agent-side validation
may be the only validation there is, so the probe is part of the build order: create one
known-good record on the dev backend, then strip one field at a time and record what the server
really enforces.

## A gate that runs with no key

The part that keeps all of this true after the next change is the eval suite. A scenario is a
scripted conversation replayed against a gateway with writes off, with deterministic checks per
turn: which block was drawn, which tool was or was not called, what the draft holds, whether a
reload redraws the open question. The example domain ships a scripted mock model that plays the
model's part of the journey as a state machine, so the whole suite, and the whole platform, runs
in CI with no API key and no network. Every red is classified before anything is fixed: a brittle
check, a model flake, pre-existing, transport, or a regression. The distinction is what makes the
suite trustworthy.

Marg is TypeScript on Node 22, MCP for tools, any model behind an OpenAI-compatible endpoint or
Anthropic, Apache-2.0. `npx create-marg-app my-agent` gives you the example domain and the
playground in two minutes.

- Repository: https://github.com/marg-adk/marg
- The readers, with the rule and how to extend the vocabulary without opening a hole:
  https://github.com/marg-adk/marg/blob/main/docs/guides/readers.md
- The example domain to copy from: https://github.com/marg-adk/marg/tree/main/examples/support-intake

---

## Show HN

**Title:** Show HN: Marg – an agent kit where the runtime, not the model, reads "yes"

**Comment:**

Marg is an open-source Agent Development Kit (TypeScript, MCP, any model) for agents that
complete a job against a real backend: a ticket raised, a booking made, a listing published.

The design came from one measurement. On a blind corpus of 521 typed replies, a reader that
looked at the leading word mis-read 235 as a bare yes or no ("yes but change the title…", "no,
create it later"). Reading the whole message mis-read none. So in Marg the model owns the
conversation and the runtime owns the moments that cost when wrong: forms, pickers, option chips,
the confirmation summary, and the write, which is gated three times (skill rule, tool schema,
runtime guard) and never weakens.

Everything runs offline: the example domain ships a scripted mock model, so the eval suite and
CI need no key. `npx create-marg-app my-agent` opens the playground.

The write-up with the numbers and a twenty-line step: https://marg-adk.github.io/marg/community/posts/the-model-must-never-read-yes. Happy to answer
questions about the readers, the step engine, or what we got wrong first.

---

## r/LLMDevs

**Title:** We measured how often an LLM-led agent mis-reads "yes". 235 out of 521. Here's the fix, open source.

We built a production agent that creates real records for users and measured a few things
about letting the model run the conversation:

- A leading-word reader mis-read **235 of 521** real typed replies as a bare yes/no. Reading the
  whole message: **0**. Rule: a reply is a plain yes only when *every* word is a confirm word,
  politeness, filler or a noun of the question. Anything else is content for the model.
- With the model asking required questions under a prompt rule, it skipped them on **25–50%**
  of turns, depending on the model.
- It attested a list item the user never said in **1 chat in 64**, with a prompt note covering
  that case.

The design that fell out: the model owns the conversation, the runtime owns the moments that
must be right. A step draws its ask (chips, a form, a picker), reads the reply in code, writes
the draft, carries the value into every tool call, and tells the model one fact. The write is
gated three times. The whole thing runs offline on a scripted mock model, so the eval suite is
the CI gate with no key.

It's open source as Marg (TypeScript, MCP, Apache-2.0): https://github.com/marg-adk/marg
Post with the code: https://marg-adk.github.io/marg/community/posts/the-model-must-never-read-yes. Curious whether others have measured their yes-readers.

---

## The thread (X or LinkedIn)

1/ We measured what happens when an LLM agent reads "yes". On 521 real typed replies, a
leading-word reader mis-read 235 as a bare yes or no. Reading the whole message: 0. That one
number became an open-source agent kit. 🧵

2/ "Yes but change the title to login fails." "No, create it later." "Keep this private
please." Each starts with a yes/no word. Each would have settled a value or performed a write
under the user's name.

3/ The rule that reads 0 of 521 wrong: a reply is a plain yes only when EVERY word is a confirm
word, politeness, filler, or a noun of the question. Anything else is content. Content goes to
the model; the runtime redraws its question underneath.

4/ Why so strict? The cost is asymmetric. A false "that's content" costs one repeated tap. A
false yes costs a real write.

5/ It generalises. With the model asking required questions under a prompt rule, it skipped
them on 25–50% of turns. It attested list items the user never said in 1 chat in 64. Prompts
lower the rate. They don't reach zero.

6/ So: the model owns the conversation, the runtime owns the moments that must be right. Forms,
pickers, chips, the summary, the write. A step is ~15 lines of code, not a prompt paragraph.

7/ The write is gated three times (skill rule, tool schema, runtime guard) and never weakens.
The first backend we probed accepted a create with every field stripped. Your validation may be
the only validation.

8/ Everything runs offline: the example ships a scripted mock model, so the eval suite is a CI
gate with no API key. Marg, TypeScript + MCP + any model, Apache-2.0:
https://github.com/marg-adk/marg — `npx create-marg-app my-agent`. The write-up: https://marg-adk.github.io/marg/community/posts/the-model-must-never-read-yes
