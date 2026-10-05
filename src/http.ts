/**
 * The ONLY way this program talks to Darwin.
 *
 *   🔴 https, to a REALM host only (realms.ts) — the URL is built here from a realm and an absolute
 *      path, never taken from a response;
 *   🔴 redirects are never followed (`redirect: "manual"`; any 3xx is refused);
 *   🔴 a request that may have reached Darwin is reported as such (`maybeSent`), so a write is never
 *      re-sent and never reported as "not sent" when it might have been;
 *   no retries here at all — a caller that may retry (a read, on 429) does so itself.
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { origin, type Realm } from "./realms.js";
import { scrub } from "./redact.js";
import { VERSION } from "./version.js";

export interface HttpResult {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null when the body was not JSON. */
  json: unknown;
  contentType: string;
}

export class NetworkError extends Error {
  /** True when the request may have reached Darwin (timeout / reset after connecting). */
  constructor(message: string, public readonly maybeSent: boolean) {
    super(message);
  }
}

const MAX_BODY = 8 * 1024 * 1024;
const NOT_SENT_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|CERT_|ERR_TLS_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_SSL|UND_ERR_CONNECT_TIMEOUT)/;

function vendor(env: Ctx["env"]): string {
  if (env.CLAUDECODE) return "claude";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return "codex";
  if (Object.keys(env).some((k) => k.startsWith("CURSOR_"))) return "cursor";
  if (env.GEMINI_CLI) return "gemini";
  return "custom_script";
}

export function clientHeaders(ctx: Ctx): Record<string, string> {
  return {
    "user-agent": `darwin-cli/${VERSION} (${ctx.platform}-${process.arch}; node ${process.version})`,
    "x-darwin-client": `${vendor(ctx.env)}; harness=darwin-cli; version=${VERSION}`,
    "x-darwin-cli": VERSION,
  };
}

export const PATH_RE = /^\/(?:api\/agent\/|agents\/cli\/)[A-Za-z0-9/_.~%-]*(?:\?[A-Za-z0-9_.~%:,=&+-]*)?$/;

export async function request(
  ctx: Ctx,
  realm: Realm,
  method: "GET" | "POST",
  path: string,
  opts: { key?: string; agent?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  if (!PATH_RE.test(path) || path.includes("..")) throw new CliError(EXIT.usage, "Not a Darwin agent API path.", "invalid_path");
  const url = `${origin(realm)}${path}`;
  const headers: Record<string, string> = { accept: "application/json", ...clientHeaders(ctx), ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.agent) headers["x-darwin-agent"] = opts.agent;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await ctx.fetch(url, { method, headers, body, redirect: "manual", signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    const cause = (e as { cause?: { code?: string } })?.cause;
    const code = String(cause?.code ?? (e as { code?: string })?.code ?? "");
    const aborted = (e as Error)?.name === "AbortError" || ac.signal.aborted;
    const notSent = !aborted && NOT_SENT_CODES.test(code);
    throw new NetworkError(scrub(aborted ? `No answer from ${realm} in time.` : `Could not reach ${realm} (${code || (e as Error)?.name || "error"}).`), !notSent);
  }
  try {
    if (res.status >= 300 && res.status < 400 || res.type === "opaqueredirect") {
      throw new CliError(EXIT.refused, `${realm} answered with a redirect; the Darwin CLI never follows one.`, "redirect_refused");
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await readCapped(res);
    let json: unknown = null;
    if (mediaType(contentType) === "application/json") {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, headers: res.headers, json, contentType };
  } catch (e) {
    if (e instanceof CliError || e instanceof NetworkError) throw e;
    throw new NetworkError(`The connection to ${realm} dropped.`, true);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { await reader.cancel(); throw new NetworkError("Darwin's answer was unexpectedly large and was not read.", true); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `application/json; charset=utf-8` → `application/json` (exact media type, lower-cased). */
export function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}
