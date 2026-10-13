# marg

The one command for a [Marg](https://marg-adk.github.io/marg/) project.

```bash
marg web                       # the gateway and the playground — http://localhost:8787
marg new bookings --entity booking   # a domain from the templates
marg check                     # the gate: typecheck, then every eval suite with writes off
marg evals --gateway http://localhost:8788
marg verdict "My payment failed twice" --choice department=billing,technical,sales
```

`npx create-marg-app my-agent` wires these into a new project's scripts. Settings are the
environment: [docs/ENVIRONMENT.md](https://marg-adk.github.io/marg/run/environment).
