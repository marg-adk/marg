# Working on this repository with a coding agent

- `CLAUDE.md` is the standing context: what Marg is, the gate, the conventions, where things are.
- `skills/build-a-domain/SKILL.md` is the method for building a domain end to end (the worksheet,
  the build order, the gate, the classification rule). Claude Code loads it from
  `.claude/skills/build-a-domain`; any other coding agent should read it before touching a domain.
- Run the gate before and after a change; classify every red before fixing it (`docs/PLAYBOOK.md` §5).
