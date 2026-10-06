/**
 * Snapshot drift check (plan §2.7): the embedded snapshot vs the catalogue each realm publishes at
 * /agents/cli/catalog.json.
 *
 *   - 404 (the CLI is not switched on there yet) or a redirect (an older build's invite gate) →
 *     skipped. Anything else that isn't a valid catalogue FAILS.
 *   - PRODUCTION: the snapshot must equal the published catalogue (every field but `realm` and the
 *     realm-dependent `catalogVersion`). `--write` refreshes snapshot/agent.json from it instead.
 *   - BETA runs ahead of production by design, and ships its own snapshot (snapshot/v11-agent.json —
 *     the CLI's built-in command list for beta): an ADDITION there is informational, but a command,
 *     path, flag or positional in that snapshot that beta no longer publishes FAILS — installed CLIs
 *     would offer it offline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { validateCatalogue, type Catalogue } from "../src/catalogue.js";

const SNAPSHOT = "snapshot/agent.json";
const SNAPSHOTS: Record<string, string> = { "darwin.finance": SNAPSHOT, "beta.darwin.finance": "snapshot/v11-agent.json" };
const write = process.argv.includes("--write");

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const contract = (c: Catalogue) => canonical({ ...c, realm: undefined, catalogVersion: undefined });

/** Every published surface an installed CLI depends on, as strings. */
const surface = (c: Catalogue) => c.tools.flatMap((t) => [
  `tool ${t.name} ${t.write ? "write" : "read"}`,
  ...[t.cli.path, ...t.cli.aliases].map((p) => `path ${t.name} ${p.join(" ")}`),
  ...Object.entries(t.cli.args).map(([p, a]) => `flag ${t.name} ${p} --${a.flag}`),
  `positional ${t.name} ${t.cli.positional.join(",")}`,
]);

let failed = false;
for (const realm of ["darwin.finance", "beta.darwin.finance"]) {
  const snap = JSON.parse(readFileSync(SNAPSHOTS[realm]!, "utf8")) as Catalogue;
  let res: Response;
  try {
    res = await fetch(`https://${realm}/agents/cli/catalog.json`, { redirect: "manual", headers: { "user-agent": "darwin-cli-ci (drift check)" } });
  } catch (e) {
    console.error(`${realm}: unreachable (${(e as Error).message})`);
    failed = true;
    continue;
  }
  if (res.status === 404 || (res.status >= 300 && res.status < 400)) { console.log(`${realm}: the CLI isn't published there yet (HTTP ${res.status}) — skipped`); continue; }
  const ct = res.headers.get("content-type") ?? "";
  if (res.status !== 200 || !ct.startsWith("application/json")) { console.error(`${realm}: unexpected HTTP ${res.status} ${ct}`); failed = true; continue; }
  const c = (await res.json()) as Catalogue;
  const problems = validateCatalogue(c);
  if (problems.length) { console.error(`${realm}: published catalogue is INVALID: ${problems.slice(0, 5).join("; ")}`); failed = true; continue; }
  if (c.credential !== "agent") { console.error(`${realm}: published catalogue is not the one-agent projection`); failed = true; continue; }
  if (contract(c) === contract(snap)) { console.log(`${realm}: snapshot matches (${c.tools.length} commands)`); continue; }
  const a = surface(snap), b = surface(c);
  const added = b.filter((x) => !a.includes(x)), removed = a.filter((x) => !b.includes(x));
  console.log(`${realm}: differs from the snapshot\n  published, not in snapshot:\n    ${added.join("\n    ") || "-"}\n  in snapshot, not published:\n    ${removed.join("\n    ") || "-"}`);
  if (realm === "darwin.finance") {
    if (write) {
      writeFileSync(SNAPSHOT, `${JSON.stringify({ ...c, realm: "darwin.finance" }, null, 2)}\n`);
      console.log(`updated ${SNAPSHOT} from production`);
    } else failed = true;
  } else if (removed.length) {
    console.error("  beta no longer publishes something installed CLIs use");
    failed = true;
  } else console.log("  (beta runs ahead of production — additions are informational)");
}
process.exit(failed ? 1 : 0);
