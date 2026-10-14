# Guide: readers — reading a reply in code

`@marg-adk/core` exports the readers the runtime uses; use the same ones in your steps and your
eval checks so the rule never drifts.

| Reader | Reads | Returns |
|---|---|---|
| `readYesNo(text, extraYes?, {strict})` | a plain yes / no / skip by the whole message | `"yes" \| "no" \| "skip" \| "words"` |
| `isPlainYes`, `isPlainNo`, `isPlainSkip`, `isQuestionShaped` | the primitives behind it | boolean |
| `isCreateYes(text)` | the create gate's stricter reading (soft acknowledgements never count) | boolean |
| `readChoice(text, options, {picking})` | an option's value or label, or distinctive words of exactly one option | `pick \| none \| words` |
| `readNumber(text)` | a lone number (with a unit word) | number or undefined |
| `readAmount(text, {units})` | the first money-like figure with a magnitude word and a basis | `{amount, unit, basis, raw}` |
| `parseFormReply(text, rows)`, `looksLikeFormReply` | the form wire format `Label [key]: value; …` | `{key: value}` |
| `readEdit(text, sections, picking)` | the review picker: a section, the menu, none, other, words | `EditRead` |
| `allWordsIn(text, allowed)` | the generic "every word accounted for" check | boolean |

## The rule
A reply is a plain X only when EVERY word is an X word, politeness, filler, or a noun of the
question. Anything else is content → `words` → the model answers and the runtime redraws its
ask. The cost is asymmetric: a false `words` costs one repeated tap; a false yes settles a
value or performs a write.

## Registers: the English core and opt-in lexicons
The core vocabulary is English. A **lexicon** is a register — a language, a dialect, a team's
vocabulary — as words plus rewrite rules plus question markers, loaded for the process:

```bash
AGENT_LEXICONS=hinglish            # the gateway loads it at boot (comma-separated)
```

```ts
import { loadLexicons, extendLexicon } from "@marg-adk/core";
loadLexicons(["hinglish"]);                                   // a shipped register, in code
extendLexicon({ confirm: ["oui"], refuse: ["non"], rewrites: [[/\bd'accord\b/g, " ok "]] });   // your own
```

`hinglish` is the register the numbers were measured with: the blind corpus of 521 replies (235
mis-read by a leading-word reader, 0 by the whole-content reader) and the 267 non-yes messages
the lexicon swallowed 0 of were Hinglish-and-English production traffic with it loaded. The
example domains are English and load nothing.

An extension may add `neutral`, `confirm`, `refuse`, `refuseNeutral`, `softAck`, `noChangeNext`,
`rewrites` (a phrase of the register → the English token it means: ok, change, later, proceed,
maybe, no), `questionOpeners`, `questionLeads`, `cutOffs`, `unfinishedTails`,
`questionExceptions`, `skipPhrases`. Add only words that cannot carry content on their own —
every widening is a hole at the gate. Measure on a blind corpus before shipping a register: have
someone write 100 realistic messages that are NOT a bare yes (instructions, facts, questions,
corrections) and count how many the reader swallows.
