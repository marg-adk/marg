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

## Extending the vocabulary
`extendLexicon({ confirm: [...], refuse: [...], neutral: [...] })` adds your users' register.
Add only words that cannot carry content on their own — every widening is a hole at the gate.
Measure on a blind corpus: have someone write 100 realistic messages that are NOT a bare yes
(instructions, facts, questions, corrections) and count how many the reader swallows. The
shipped lexicon swallowed 0 of 267.
