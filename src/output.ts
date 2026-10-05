/**
 * Rendering. stdout is a TTY → readable text; otherwise → one JSON document (agents get JSON without
 * asking); `--json` / `--format json` / DARWIN_OUTPUT=json force JSON. Diagnostics go to stderr.
 *
 * 🔴 Every server string is third-party-influenced: in text mode it is stripped of escapes and
 * control characters (`clean`). A value the server wrapped `{"untrusted": "…"}` is shown as its
 * plain (cleaned) text: that wrapper protects an AI reading `--json`; for a person at a terminal the
 * safety measure is `clean` — no escape sequence, control or bidi character survives. Everything
 * printed passes `scrub` (no key, ever).
 */
import type { Ctx } from "./context.js";
import { clean, scrubDeep } from "./redact.js";

export function wantsJson(ctx: Ctx, flags: { json: boolean; format?: string }): boolean {
  if (flags.json || flags.format === "json" || ctx.env.DARWIN_OUTPUT === "json") return true;
  if (flags.format === "table") return false;
  return !ctx.io.isTTY.stdout;
}

export function printJson(ctx: Ctx, v: unknown): void {
  ctx.io.stdout(`${JSON.stringify(scrubDeep(v), null, 2)}\n`);
}

/** Every line for a terminal is scrubbed of secrets AND of escapes / control characters. */
export function say(ctx: Ctx, line: string): void {
  ctx.io.stdout(`${clean(line)}\n`);
}

export function warn(ctx: Ctx, line: string): void {
  ctx.io.stderr(`${clean(line)}\n`);
}

export const isUntrusted = (v: unknown): v is { untrusted: unknown } =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "untrusted" in v;

/** One value as text. */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (isUntrusted(v)) return cell(v.untrusted);
  if (typeof v === "string") return clean(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return clean(JSON.stringify(v));
}

const scalarish = (v: unknown) => v === null || typeof v !== "object" || isUntrusted(v);

/** A readable rendering of a result object (summary first, then data). */
export function renderText(v: unknown, indent = ""): string[] {
  const lines: string[] = [];
  if (scalarish(v)) return [`${indent}${cell(v)}`];
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${indent}(none)`];
    if (v.every((r) => r && typeof r === "object" && !Array.isArray(r) && !isUntrusted(r))) return table(v as Record<string, unknown>[], indent);
    for (const x of v) lines.push(...renderText(x, `${indent}- `));
    return lines;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (scalarish(x)) lines.push(`${indent}${clean(k)}: ${cell(x)}`);
    else {
      lines.push(`${indent}${clean(k)}:`);
      lines.push(...renderText(x, `${indent}  `));
    }
  }
  return lines;
}

function table(rows: Record<string, unknown>[], indent: string): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const [k, x] of Object.entries(r)) if (scalarish(x) && !cols.includes(k) && cols.length < 8) cols.push(k);
  const cells = rows.map((r) => cols.map((c) => cell(r[c]).replace(/\s+/g, " ").slice(0, 60)));
  const widths = cols.map((c, i) => Math.max(clean(c).length, ...cells.map((r) => r[i]!.length)));
  const line = (vals: string[]) => `${indent}${vals.map((x, i) => x.padEnd(widths[i]!)).join("  ").trimEnd()}`;
  return [line(cols.map(clean)), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)];
}
