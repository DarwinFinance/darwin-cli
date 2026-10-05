/**
 * HUMAN rendering (a terminal, no `--json`). Every function here returns lines for `say`, which
 * cleans them again; nothing here is used for JSON output, which stays the server's object exactly.
 *
 *   - A value the server wrapped `{"untrusted": "…"}` is shown as its plain text, after `clean`
 *     (no ANSI / OSC sequence, control or bidi character survives) — that is the terminal's safety
 *     measure. The wrapper itself protects an AI reading `--json`, so it stays there.
 *   - Text the server writes FOR AN AI CLIENT (`next`, `instructions`, `tellYourUser`, the MCP tool
 *     names in it) is never printed: each command prints its own CLI hint instead.
 *   - Times are the user's local wall-clock time.
 */
import { clean } from "./redact.js";
import { isUntrusted, renderText } from "./output.js";

/** One server value as plain terminal text ("" for nothing). Unwraps `{untrusted}`. */
export function txt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (isUntrusted(v)) return txt(v.untrusted);
  if (typeof v === "string") return clean(v).replace(/\s+/g, " ").trim();
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

/** Like `txt`, but bounded — for names and symbols (an owner's or a token creator's free text). */
export function label(v: unknown, max = 60): string {
  const t = txt(v);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) && !isUntrusted(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Deep: every `{untrusted: x}` → x (for the generic renderer; `clean` still runs on every string). */
export function unwrapDeep(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (isUntrusted(v)) return unwrapDeep(v.untrusted, depth + 1);
  if (Array.isArray(v)) return v.map((x) => unwrapDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = unwrapDeep(x, depth + 1);
    return out;
  }
  return v;
}

// ─── times ──────────────────────────────────────────────────────────────────

/** An epoch (ms or s) / ISO string → a Date, or null. Seconds below 1e11 (that's 1973 in ms). */
export function toDate(v: unknown): Date | null {
  let d: Date | null = null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) d = new Date(v < 1e11 ? v * 1000 : v);
  else if (typeof v === "string" && /^[0-9]{9,13}$/.test(v)) return toDate(Number(v));
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) d = new Date(v);
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 2000 && y < 2100 ? d : null;
}

/** "2:06:23 PM" — a time later today, to the second (quote expiry). */
export function clock(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** "Oct 5, 2:06 PM CDT" — local wall-clock time with its zone (same shape on every ICU build). */
export function when(v: unknown, opts: { weekday?: boolean } = {}): string {
  const d = toDate(v);
  if (!d) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${opts.weekday ? `${parts.weekday}, ` : ""}${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

// ─── numbers ────────────────────────────────────────────────────────────────

/** A decimal string or number → shown as given (trailing zeros trimmed), never re-rounded. */
export function num(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const t = txt(v);
  if (!/^-?\d+(\.\d+)?$/.test(t)) return t;
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
}

/**
 * "$1,234.56" for a USD value (number or decimal string); "" if not a number. Below $1 it keeps four
 * significant digits ("$0.00000123") — a token price or a tick must never round to $0.00.
 */
export function usd(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  const dollars = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let s: string;
  if (abs === 0 || abs >= 0.995) s = dollars(abs);
  else if (abs < 1e-12) s = abs.toExponential(3);
  else {
    const places = Math.max(2, 3 - Math.floor(Math.log10(abs)));
    s = abs.toFixed(places).replace(/0+$/, "");
    const [, frac = ""] = s.split(".");
    if (frac.length < 2) s = `${s.split(".")[0]}.${frac.padEnd(2, "0")}`;
  }
  return `${n < 0 ? "−" : ""}$${s}`;
}

// ─── the generic renderer ───────────────────────────────────────────────────

/** Keys never shown to a person: AI-client guidance, and plumbing the person can't act on. */
const HIDDEN_KEYS = new Set(["welcome", "next", "instructions", "instruction", "tellYourUser", "retrySafe", "retryable", "refusal", "ok", "untrustedNote"]);
const TIME_KEY = /^(?:asOf(?:Ms|Secs?)?|[a-z][A-Za-z0-9]*(?:At|AtMs|AtSecs|AtSec|AsOf|AsOfMs|AsOfSecs|Ts|Time|Timestamp))$/;

/** `solanaAddress` → "solana address"; `max_slippage_bps` → "max slippage bps". */
export function words(key: string): string {
  return clean(key).replace(/Iso$/, "").replace(/(Ms|Secs?)$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

/**
 * A server object made readable for a person: untrusted unwrapped, AI guidance dropped, an atoms
 * field dropped when its whole-token twin is there, epoch times shown once in local time.
 */
export function tidy(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (isUntrusted(v)) return tidy(v.untrusted, depth + 1);
  if (Array.isArray(v)) return v.map((x) => tidy(x, depth + 1));
  if (!v || typeof v !== "object") return v;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(src)) {
    if (HIDDEN_KEYS.has(k)) continue;
    // An atoms field is dropped only when its whole-token twin actually carries a value.
    const has = (twin: string) => src[twin] !== null && src[twin] !== undefined && src[twin] !== "";
    if (/Atoms$/.test(k) && k !== "atoms" && (has(k.slice(0, -5)) || has(`${k.slice(0, -5)}Amount`))) continue;
    if (k === "atoms" && (has("amount") || has("uiAmount"))) continue;
    // An `…Iso` sibling the server added: show the instant ONCE, as local time, under the base name.
    if (/Iso$/.test(k) && typeof x === "string") {
      const base = k.slice(0, -3);
      const label = [base, `${base}Ms`, `${base}Sec`, `${base}Secs`].find((b) => b in src) ?? base;
      if (!(label in out)) out[label] = when(x) || x;
      continue;
    }
    if (TIME_KEY.test(k) && toDate(x)) {
      out[k] = when(x);
      continue;
    }
    out[k] = tidy(x, depth + 1);
  }
  return out;
}

/** Lines for any result this file has no dedicated renderer for. */
export function genericLines(v: unknown): string[] {
  return renderText(humanKeys(tidy(v)));
}

function humanKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(humanKeys);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [words(k), humanKeys(x)]));
}
