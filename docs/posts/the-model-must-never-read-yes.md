# The model must never read "yes"

*The launch post for Marg, first published with 0.2 and current for 0.3.0. Questions and pushback
are welcome in [Discussion #30](https://github.com/marg-adk/marg/discussions/30).*

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

The corpus was the traffic that agent actually saw, Hinglish and English, read with that
register's vocabulary loaded. The rule does not depend on the language; the vocabulary does, so
in the kit the core is English, a register is an opt-in lexicon, and the guide says to measure a
new one on a blind corpus before shipping it. Every word added to the yes list is a hole at the
gate until it is measured.

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
reload redraws the open question. The example domains ship a scripted mock model that plays the
model's part of the journey as a state machine, so the whole suite, and the whole platform, runs
in CI with no API key and no network. Every red is classified before anything is fixed: a brittle
check, a model flake, pre-existing, transport, or a regression. The distinction is what makes the
suite trustworthy.

Marg is TypeScript on Node 22, MCP for tools (the tool server can be TypeScript or Python), any
model behind an OpenAI-compatible endpoint or Anthropic, Apache-2.0. 0.3.0 is on npm.
`npx create-marg-app my-agent` gives you the example domain and the playground in two minutes;
the hosted playground gives you the same thing in none.

- The hosted playground, the example on the mock model with writes off: https://marg-playground.onrender.com
- Repository: https://github.com/marg-adk/marg
- The docs site: https://marg-adk.github.io/marg
- The readers, with the rule, the registers, and how to extend the vocabulary without opening a
  hole: https://marg-adk.github.io/marg/build/readers
- The two example domains to copy from:
  https://github.com/marg-adk/marg/tree/main/examples/support-intake and
  https://github.com/marg-adk/marg/tree/main/examples/bookings
- Where Marg sits beside Google ADK, the OpenAI Agents SDK, LangGraph and Pydantic AI:
  https://marg-adk.github.io/marg/get-started/compare

