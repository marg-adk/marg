# Working on this project with a coding agent

- `skills/build-a-domain/SKILL.md` is the method for building a Marg domain end to end: the worksheet,
  the build order (tools → probe → schema → skill → steps → mock → evals), the gate, the classification
  rule. Claude Code loads it from `.claude/skills/build-a-domain`; read it before touching a domain.
- `examples/support-intake/` is the reference for every part of a domain.
- `npx marg check` is the gate; run it before and after a change and classify every red before fixing it.
- Docs: https://marg-adk.github.io/marg/
