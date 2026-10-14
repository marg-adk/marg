# Claude Code, Codex and other coding agents

The method for building a domain ships as a skill a coding agent follows: the worksheet, the build order, the gate, the classification rule. `create-marg-app` installs it in every new project. [Build with a coding agent](../../skills/build-a-domain/SKILL.md).

```bash
# .claude/skills/build-a-domain  — loaded by Claude Code
# AGENTS.md — points every other agent at skills/build-a-domain/SKILL.md
```

The site publishes an index for coding agents at https://marg-adk.github.io/marg/llms.txt (every
page with its title, by section; each page is also a markdown file in the repository), so an agent
can read the docs without the nav.

Docs: https://docs.anthropic.com/en/docs/claude-code/skills
