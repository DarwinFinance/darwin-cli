/**
 * Bundle the CLI into ONE file (dist/darwin.js) with no JS runtime dependencies — the only runtime
 * dependency is @napi-rs/keyring (external; pinned exact, frozen by npm-shrinkwrap.json).
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const out = await Bun.build({
  entrypoints: ["src/bin.ts"],
  outdir: "dist",
  naming: "darwin.js",
  target: "node",
  format: "esm",
  minify: false,
  external: ["@napi-rs/keyring"],
  define: { __DARWIN_CLI_VERSION__: JSON.stringify(pkg.version) },
});
if (!out.success) {
  for (const l of out.logs) console.error(l);
  process.exit(1);
}
const file = "dist/darwin.js";
let text = readFileSync(file, "utf8");
text = `#!/usr/bin/env node\n${text.replace(/^#!.*\n/, "")}`;
writeFileSync(file, text);
chmodSync(file, 0o755);
// The bundle must not reach for any package but the keyring.
const imports = [...text.matchAll(/(?:from\s+|import\(|require\()["']([^"'./][^"']*)["']/g)].map((m) => m[1]!).filter((m) => !m.startsWith("node:"));
const bad = [...new Set(imports)].filter((m) => m !== "@napi-rs/keyring");
if (bad.length) {
  console.error(`dist/darwin.js imports packages it must not: ${bad.join(", ")}`);
  process.exit(1);
}
console.log(`built ${file} (${(text.length / 1024).toFixed(0)} KiB), version ${pkg.version}`);
