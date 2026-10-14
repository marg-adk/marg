/**
 * scripts/set-version.mjs — one version for every package, in lockstep, including the pins the
 * packages hold on each other (a plain `npm version` leaves those at the old number, which would
 * publish a package depending on a version that never existed).
 *   node scripts/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(2);
}
const files = ["package.json"];
for (const root of ["packages", "examples"]) for (const d of readdirSync(root)) if (existsSync(join(root, d, "package.json"))) files.push(join(root, d, "package.json"));
const ours = new Set(files.map((f) => JSON.parse(readFileSync(f, "utf8")).name));
let pins = 0;
for (const f of files) {
  const pkg = JSON.parse(readFileSync(f, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) if (ours.has(name) && !/^(file:|workspace:)/.test(pkg[field][name])) { pkg[field][name] = version; pins++; }
  }
  writeFileSync(f, JSON.stringify(pkg, null, 2) + "\n");
}
console.log(`set-version: ${files.length} manifests at ${version}, ${pins} internal pins updated — run npm install to refresh the lockfile`);
