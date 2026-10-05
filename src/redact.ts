/**
 * 🔴 NOTHING THIS PROGRAM PRINTS MAY CONTAIN A KEY OR DEVICE CODE (plan §4.3). Every string bound
 * for stdout or stderr goes through `scrub`: any known secret (the key in use, a device code) and
 * anything SHAPED like a Darwin credential is replaced. Server-provided text is additionally
 * stripped of ANSI escapes and control characters (`clean`) — terminal escape injection.
 */
const SECRET_SHAPE = /(darwinAI_(?:agents|agent|pair|api|mcp|mcpagent)_|agt_|mbt_|mcpt_)[A-Za-z0-9_-]{8,}/g;
const known = new Set<string>();

/** True when a string IS or CONTAINS anything shaped like a Darwin credential (or a known secret). */
export function looksSecret(s: string): boolean {
  SECRET_SHAPE.lastIndex = 0;
  if (SECRET_SHAPE.test(s)) { SECRET_SHAPE.lastIndex = 0; return true; }
  for (const k of known) if (s.includes(k)) return true;
  return false;
}

export function rememberSecret(s: string | null | undefined): void {
  if (typeof s === "string" && s.length >= 8) known.add(s);
}

export function scrub(text: string): string {
  let t = text;
  for (const s of known) if (t.includes(s)) t = t.split(s).join("[REDACTED]");
  return t.replace(SECRET_SHAPE, (_m, p: string) => `${p}[REDACTED]`);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Server / third-party text → safe for a terminal (newlines and tabs kept). */
export function clean(text: string): string {
  return scrub(text.replace(ANSI, "").replace(CONTROL, ""));
}

/** Deep: every string value and key through `scrub` (JSON output). */
export function scrubDeep(v: unknown): unknown {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const lk = k.toLowerCase();
      out[scrub(k)] = lk === "access_token" || lk === "device_code" || lk === "authorization" ? "[REDACTED]" : scrubDeep(x);
    }
    return out;
  }
  return v;
}

/** For tests only. */
export function _forgetSecrets(): void {
  known.clear();
}
