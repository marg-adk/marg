# Releasing

One version for every package, in lockstep. A release is a tag; CI publishes.

## Cadence

Every two to three weeks while 0.x, or sooner for a security fix. Patch releases (`0.2.1`) carry
fixes only; minor releases (`0.3.0`) may change behaviour and say so in the changelog.

## Before tagging

1. `main` is green on CI (the gate on Node 22 and 24, the packages job, CodeQL, security).
2. `CHANGELOG.md`: move the **Unreleased** lines under a new `## <version> — <date>` heading. Each
   line names the package it touches in bold and says what changed for a user, not what moved.
3. Bump the version everywhere — the packages pin each other, so the script sets the pins too —
   in one commit named `Release: <version>`, on a branch (`main` takes pull requests only):

   ```bash
   node scripts/set-version.mjs <version> && npm install
   git add package.json package-lock.json packages/*/package.json examples/*/package.json CHANGELOG.md
   git commit -m "Release: <version>"
   ```

   The release workflow refuses a tag whose version differs from any `package.json`.
4. Locally: `npm run check:pack && npm run check:create` (the packages build, pack and install
   into a fresh project from the tarballs).

## Tag and publish

```bash
# after the release PR is merged:
git checkout main && git pull
git tag -a v<version> -m "Marg <version>" && git push origin v<version>
```

`.github/workflows/release.yml` runs the full gate again, then `npm publish --provenance` for
`@marg-adk/types`, `@marg-adk/core`, `@marg-adk/verdict`, `@marg-adk/evals`, `@marg-adk/metering`, `@marg-adk/widget`,
`@marg-adk/gateway` and `create-marg-app`, in that order. It needs one repository secret,
`NPM_TOKEN`: an npm **automation** token (granular, publish rights on the `@marg` scope and
`create-marg-app`, no 2FA prompt). Provenance ties each package to the commit and the workflow run.

After the run is green:

- Create the GitHub release from the tag with the changelog section as its body.
- Check `npx create-marg-app@latest demo` from an empty folder once; it is the first thing a
  newcomer runs.

## If it goes wrong

- A failed publish mid-list: fix, bump the patch version, tag again. npm never re-publishes a
  version, so a half-published release is finished by the next one, not retried.
- A bad release: `npm deprecate @marg-adk/<pkg>@<version> "<reason, link>"` on every published
  package, then release the fix. Do not unpublish.
- A security fix: follow `SECURITY.md`; publish the advisory with the release.
