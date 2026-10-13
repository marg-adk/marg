# Per-model notes

Each model slips in its own places. A file here named after the model id slug
(`gpt-5-6-luna.md`, `claude-sonnet-5.md`, `llama3-3.md`) is appended to the system prompt ONLY
when that model serves the call — one model's corrective notes are noise (or harm) to another.
Notes are constant per endpoint, so each provider's prompt-cache prefix stays stable.

Override per endpoint with `LLM_<NAME>_NOTES=path` (or `none`). The routing hop never gets notes.

What belongs here: resolutions of rule tensions this model gets wrong ("the draft holds only
user-established values — never guess a magnitude"), a worked example of one question per turn,
formatting slips observed in evals. What does not: workflow (that is the domain skill), and
anything the runtime already enforces in code.

**Prompt text is not free.** Measure a note's effect with the eval suite (compare failing SETS over
several runs, never one run): on a real journey, three review paragraphs raised one scenario's
flake rate from 0 to 4 of 8.
