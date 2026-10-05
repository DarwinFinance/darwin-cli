/**
 * A light lint (no dependency): rules that matter for this program's security model.
 *   - no `console.log` in src/ (output goes through output.ts, which scrubs keys);
 *   - no `redirect: "follow"` anywhere; every fetch is in http.ts;
 *   - no child process except the browser opener (bin.ts) and the skill helpers (skill.ts);
 *   - no `eval` / `new Function`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const problems: string[] = [];
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
for (const f of walk("src")) {
  const s = readFileSync(f, "utf8");
  if (/console\.(log|error|warn)\(/.test(s)) problems.push(`${f}: console.* — print through output.ts`);
  if (/redirect:\s*["']follow["']/.test(s)) problems.push(`${f}: a fetch that follows redirects`);
  if (/\bfetch\(/.test(s) && !f.endsWith("http.ts")) problems.push(`${f}: fetch outside http.ts`);
  if (/child_process/.test(s) && !/(bin|skill)\.ts$/.test(f)) problems.push(`${f}: child_process outside bin.ts / skill.ts`);
  if (/\beval\(|new Function\(/.test(s)) problems.push(`${f}: eval`);
  if (/\t/.test(s)) problems.push(`${f}: tab character`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("lint ok");
