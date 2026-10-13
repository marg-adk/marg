# Security policy

## Reporting a vulnerability
Please report security problems privately to the maintainers (open a GitHub security
advisory on this repository, or email the address in the repository profile). Do not open a
public issue. We aim to acknowledge within 3 working days and to ship a fix or a mitigation
before any public disclosure.

## Scope
The gateway, the core runtime, the Verdict package, the widget, the example domain, and the
deploy files in this repository. Your own domains, backends and model providers are yours.

## What we consider in scope
- Reading or acting on another user's session (owner checks, identity verification).
- Any path by which a model-emitted value reaches a client as HTML or an unlisted URL scheme.
- Any write that bypasses the confirm gate.
- Secrets or private user text reaching logs, spans or ledgers.
- Denial of service through the rate-limit or cap paths.

See `docs/SECURITY.md` for the design and `docs/PRODUCTION-CHECKLIST.md` for the deploy gate.
