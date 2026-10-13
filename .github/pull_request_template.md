## What and why

<!-- One paragraph: the change, and the failure or cost it answers. Link the issue (#tag). -->

## The gate

<!-- Paste the last line of each. Every red is classified before it is fixed (docs/PLAYBOOK.md §5):
     check brittleness · model flake · pre-existing · transport · regression -->

- [ ] `npm run lint` and `npm run typecheck` — clean
- [ ] `npm test` — … pass, 0 fail
- [ ] `npm run check:otel` — all otel cases pass
- [ ] `npm run check:scaffold` — GATE: 3/3
- [ ] `npm run check:e2e` — e2e create OK, proof record removed
- [ ] `npm run gateway:evals & npm run evals` — GATE: 7/7
- [ ] `npm run check:pack` / `npm run check:create` — if a `package.json`, a build config or the templates changed

Reds and their classification:

## Checklist

- [ ] A change to a reader, a guard or a step: the mutation pass ran (break the rule in a scratch copy; the suite went red) and the scenario that would have caught the bug is added
- [ ] A new request-side code path: a span, a logged failure with the trace id, a counter or behaviour event, `check:otel` green
- [ ] Nothing product-, brand- or backend-specific in `packages/`, `docs/` or `templates/`
- [ ] The write gate, the owner checks, the fail-closed identity check and the link allowlist are not weakened
- [ ] Docs updated where behaviour changed; `CHANGELOG.md` has a line under Unreleased
