# Roadmap

## 0.1 — here
The runtime, Verdict, the gateway, the widget, the eval runner, the metering client, the
support-intake example, templates and a scaffolder, docs with six ADRs, deploy and observability
as code, and the gate: unit tests, the widget under a fake DOM, the OpenTelemetry check, the
scaffold check, the real-write e2e, the example suite. All of it runs offline with no key.

Known gaps in 0.1:
- The OpenObserve bootstrap, dashboards and alerts are ported from a production setup and have
  not yet been re-verified against a live instance from this repository.
- Laya's calibration numbers (temperature, ECE) ship as maths and a CLI, not as a published
  calibration set; bring a labelled set from your domain.
- One example domain. The scaffolder and templates are proven by `check:scaffold`, but a second
  example in a different shape (a booking with dates and availability) would teach more.

## 0.2 — next
- Publish `@marg/core`, `@marg/gateway`, `@marg/verdict`, `@marg/evals`, `@marg/widget` and
  `@marg/metering` to npm; turn this repository's `templates/` + example into a small starter
  that depends on them (`create-marg-app`), so a new project begins from about twenty files.
- Verify the observability stack live in CI with an OpenObserve service container.
- A second example domain, with a date picker step and an availability check against a mock API.
- Mobile SDK notes: embedding the widget in a WebView with the agent-token exchange, measured on
  a low-end Android device.

## Later
- A Python tool-server template (the MCP triad in Python) so backends on that side plug in
  without a Node shim.
- A calibration workbench for Verdict: label, fit, plot reliability, choose the abstention threshold.
- Alternative clients: a React component and a terminal client speaking the client protocol.

Proposals welcome as issues; decisions that change the pattern go through an ADR
(`docs/adr/TEMPLATE.md`).
