#!/usr/bin/env node
/**
 * marg-gateway — start the Marg gateway from an installed @marg-adk/gateway.
 *
 * WHAT COMES IN: the environment (.env in the working directory, docs/ENVIRONMENT.md).
 * WHAT COMES OUT: the HTTP/SSE server on GATEWAY_PORT (8787), domains discovered under the
 *   working directory's domains/ and examples/.
 * WHO TALKS TO IT: `npm run gateway` in a project made by create-marg-app, or `npx marg-gateway`.
 *
 * Domains are TypeScript (steps/index.ts, mock/policy.ts) imported at boot, so the tsx loader is
 * registered first; the server itself is the compiled dist/server.js.
 */
import { register } from "tsx/esm/api";

register();
await import("../dist/server.js");
