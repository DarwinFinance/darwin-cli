/**
 * Running a catalogue command (plan §0A, contract §3): argv → the tool's friendly arguments →
 * `POST /api/agent/v1/tools/call/{name}`. The server converts, executes and serializes exactly as
 * the `/agent` connector does; this file never builds a REST body or path from the catalogue.
 *
 *   🔴 A write is NEVER retried — not on a timeout, not on a 5xx, not on a dropped connection. An
 *      uncertain write exits 6 with C.36 ("don't run it again — check `darwin orders`").
 *   🔴 No confirmation prompt (owner Q6). `--dry-run` shows what would be sent and sends nothing;
 *      after a write is sent, its summary and order ID are printed (C.46).
 *   A write that takes an idempotency key gets one generated here (`cli_` + 22 base62) and printed.
 */
import { randomBytes } from "node:crypto";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { CATALOGUE_HEADER, type Catalogue, type CatalogueTool, type SchemaProp } from "./catalogue.js";
import { NetworkError, request, type HttpResult } from "./http.js";
import { cell, printJson, renderText, say, warn } from "./output.js";
import type { Parsed } from "./args.js";
import type { Session } from "./session.js";
import { resolveAgent } from "./agents.js";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function newNonce(): string {
  let s = "cli_";
  while (s.length < 26) {
    for (const b of randomBytes(32)) {
      if (b >= 248) continue; // rejection sampling: 248 = 4 × 62, so every symbol is equally likely
      s += B62[b % 62];
      if (s.length === 26) break;
    }
  }
  return s;
}

const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROP_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export interface ToolFlags { json: boolean; dryRun: boolean; agent?: string; quiet: boolean }

function typeOf(p: SchemaProp | undefined): string {
  const t = p?.type;
  return Array.isArray(t) ? (t.includes("string") ? "string" : String(t[0])) : (t ?? "string");
}

/** argv (after the command path) → the tool's friendly arguments. Usage errors exit 2. */
export function buildArguments(tool: CatalogueTool, positionals: string[], p: Parsed, globals: ReadonlySet<string>): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {};
  const open = tool.inputSchema.additionalProperties !== false && tool.inputSchema.additionalProperties !== undefined;
  const args: Record<string, unknown> = {};
  const cmd = tool.cli.path.join(" ");
  if (positionals.length > tool.cli.positional.length) {
    throw new CliError(EXIT.usage, `Too many words for \`darwin ${cmd}\`: "${cell(positionals[tool.cli.positional.length])}". See \`darwin ${cmd} --help\`.`, "usage");
  }
  tool.cli.positional.forEach((prop, i) => { if (positionals[i] !== undefined) args[prop] = positionals[i]; });
  const byFlag = new Map(Object.entries(tool.cli.args).map(([prop, a]) => [a.flag, prop]));
  const coerce = (prop: string, raw: string): unknown => {
    const t = typeOf(props[prop]);
    if (t === "number" || t === "integer") {
      if (!NUMBER.test(raw)) throw new CliError(EXIT.usage, `--${tool.cli.args[prop]?.flag ?? prop} must be a number.`, "usage");
      return Number(raw);
    }
    if (t === "boolean") {
      if (raw !== "true" && raw !== "false") throw new CliError(EXIT.usage, `--${tool.cli.args[prop]?.flag ?? prop} is true or false.`, "usage");
      return raw === "true";
    }
    if (t === "object") {
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
        return v;
      } catch {
        throw new CliError(EXIT.usage, `--${tool.cli.args[prop]?.flag ?? prop} takes a JSON object.`, "usage");
      }
    }
    return raw;
  };
  for (const [flag, values] of p.flags) {
    if (globals.has(flag)) continue;
    if (flag === "field") {
      if (!open) throw new CliError(EXIT.usage, `\`darwin ${cmd}\` takes no --field; see \`darwin ${cmd} --help\`.`, "usage");
      for (const v of values) {
        const eq = v.indexOf("=");
        const k = eq > 0 ? v.slice(0, eq) : "";
        if (!PROP_KEY.test(k)) throw new CliError(EXIT.usage, "--field takes name=value.", "usage");
        if (Object.hasOwn(args, k)) throw new CliError(EXIT.usage, `${k} was given twice.`, "usage");
        args[k] = v.slice(eq + 1);
      }
      continue;
    }
    const prop = byFlag.get(flag);
    if (!prop) throw new CliError(EXIT.usage, `\`darwin ${cmd}\` doesn't take --${flag}.${open ? " For other API fields use --field name=value." : ""} See \`darwin ${cmd} --help\`.`, "usage");
    if (values.length > 1) throw new CliError(EXIT.usage, `--${flag} was given more than once.`, "usage");
    args[prop] = coerce(prop, values[0]!);
  }
  for (const flag of p.bools) {
    if (globals.has(flag)) continue;
    const prop = byFlag.get(flag);
    if (!prop || typeOf(props[prop]) !== "boolean") throw new CliError(EXIT.usage, `--${flag} needs a value. See \`darwin ${cmd} --help\`.`, "usage");
    args[prop] = true;
  }
  const required = (tool.inputSchema.required ?? []).filter((r) => r !== tool.idempotency?.field);
  const missing = required.filter((r) => args[r] === undefined || args[r] === "");
  if (missing.length) {
    const names = missing.map((r) => (tool.cli.positional.includes(r) ? `<${r}>` : `--${tool.cli.args[r]?.flag ?? r}`));
    throw new CliError(EXIT.usage, `\`darwin ${cmd}\` needs ${names.join(", ")}. See \`darwin ${cmd} --help\`.`, "usage");
  }
  const idem = tool.idempotency?.field;
  if (idem && args[idem] !== undefined && (typeof args[idem] !== "string" || !NONCE_RE.test(args[idem] as string))) {
    throw new CliError(EXIT.usage, "--nonce is 1–64 of A-Z a-z 0-9 _ -.", "usage");
  }
  return args;
}

const unwrap = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) && "untrusted" in (v as object) ? (v as { untrusted: unknown }).untrusted : v);
const isPaused = (r: Record<string, unknown>) => {
  const data = (r.data ?? {}) as Record<string, unknown>;
  return [r.error, data.error, data.refusal].some((x) => unwrap(x) === "grant_paused");
};

/** The exit code for a tool call's 200 body (contract §3). */
export function exitFor(tool: CatalogueTool, body: { isError?: unknown; result?: unknown }): number {
  if (body.isError !== true) return EXIT.ok;
  const r = (body.result ?? {}) as Record<string, unknown>;
  const status = typeof r.status === "number" ? r.status : null;
  if (isPaused(r)) return EXIT.paused;
  if (r.error === "darwin_unavailable" || (status !== null && status >= 500)) return tool.write ? EXIT.uncertain : EXIT.unexpected;
  if (status === 429 || r.error === "rate_limited") return EXIT.rateLimited;
  if (status === 401) return EXIT.auth;
  if (r.sent === false && (r.error === "invalid_arguments" || r.error === "invalid_section")) return EXIT.usage;
  return EXIT.refused;
}

export interface RunOpts {
  ctx: Ctx;
  session: Session;
  catalogue: Catalogue;
  tool: CatalogueTool;
  args: Record<string, unknown>;
  flags: ToolFlags;
  /** Called when a response carries a different catalogue version. */
  onStaleCatalogue?: () => Promise<void>;
  /** The server doesn't know this tool (a newer/older colour): refresh the command list. Nothing ran. */
  onUnknownTool?: () => Promise<void>;
  /** JSON output (for `darwin <cmd>`), or none (for `darwin mcp`, which renders itself). */
  json: boolean;
}

export interface CallOutcome { exit: number; body: Record<string, unknown> | null; nonce: string | null; agentId: string | null; message?: string }

/** Send one tool call. Never retries a write. Used by the commands and by `darwin mcp`. */
export async function callTool(o: Omit<RunOpts, "json">, agentId: string | null): Promise<CallOutcome> {
  const { ctx, session, tool } = o;
  const args = { ...o.args };
  let nonce: string | null = null;
  if (tool.idempotency) {
    const f = tool.idempotency.field;
    if (args[f] === undefined) args[f] = newNonce();
    nonce = String(args[f]);
  }
  const path = `/api/agent/v1/tools/call/${encodeURIComponent(tool.name)}`;
  const send = () => request(ctx, session.realm, "POST", path, {
    key: session.key, agent: agentId ?? undefined, body: { arguments: args }, timeoutMs: tool.write ? 30_000 : 20_000,
  });
  let res: HttpResult;
  try {
    res = await send();
    // A READ may wait out one short rate limit; a write never repeats.
    if (!tool.write && res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? "NaN");
      if (Number.isFinite(ra) && ra >= 0 && ra <= 10) {
        await ctx.sleep(ra * 1000);
        res = await send();
      }
    }
  } catch (e) {
    if (e instanceof NetworkError) {
      if (tool.write && e.maybeSent) return { exit: EXIT.uncertain, body: null, nonce, agentId, message: `${e.message} ${copy.uncertainWrite}` };
      return { exit: EXIT.network, body: null, nonce, agentId, message: `${e.message} Nothing was done; try again.` };
    }
    throw e;
  }
  const version = res.headers.get(CATALOGUE_HEADER);
  if (version && version !== o.catalogue.catalogVersion && o.onStaleCatalogue) await o.onStaleCatalogue().catch(() => {});
  const body = (res.json && typeof res.json === "object" && !Array.isArray(res.json) ? res.json : null) as Record<string, unknown> | null;
  const err = typeof body?.error === "string" ? body.error : "";
  // A tool result: exactly the envelope { tool, isError: boolean, result: object }.
  if (res.status === 200 && body && typeof body.isError === "boolean" && body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
    let exit = exitFor(tool, body);
    const r = body.result as Record<string, unknown>;
    const data = (r.data ?? {}) as Record<string, unknown>;
    let message: string | undefined;
    if (exit === EXIT.uncertain) message = copy.uncertainWrite;
    else if (exit === EXIT.paused) message = copy.paused;
    else if (unwrap(data.refusal) === "duplicate" && unwrap(data.detail) === "nonce_used_by_a_different_order") { message = copy.nonceConflict; exit = EXIT.refused; }
    return { exit, body, nonce, agentId, message };
  }
  // The answers that prove NOTHING ran (the door, the switch, the version gate, the parser — all
  // before any work). Matched exactly; anything else after sending a write is uncertain.
  if (res.status === 401) return { exit: EXIT.auth, body, nonce, agentId, message: "Darwin refused this API key (or the agent it named). It may have been revoked or the agent paused; run `darwin whoami`, or ask the owner. Nothing was done." };
  if (res.status === 426) {
    const min = typeof body?.minCli === "string" && /^\d+\.\d+\.\d+$/.test(body.minCli) ? body.minCli : o.catalogue.minCli;
    return { exit: EXIT.upgrade, body, nonce, agentId, message: copy.updateRequired(min) };
  }
  if (res.status === 429) return { exit: EXIT.rateLimited, body, nonce, agentId, message: "Too many requests with this API key right now. Wait a minute and try again. Nothing was done." };
  if (res.status === 404 && err === "cli_unavailable") return { exit: EXIT.refused, body, nonce, agentId, message: "The Darwin CLI isn't available on this site yet. Nothing was done." };
  if (res.status === 404 && err === "unknown_tool") return { exit: EXIT.usage, body, nonce, agentId, message: "unknown_tool" };
  if (res.status === 400 && err === "invalid_request") return { exit: EXIT.usage, body, nonce, agentId, message: "Darwin couldn't read that request. Nothing was done." };
  if (tool.write) return { exit: EXIT.uncertain, body, nonce, agentId, message: copy.uncertainWrite };
  return { exit: EXIT.unexpected, body, nonce, agentId, message: `Darwin answered HTTP ${res.status}.` };
}

/** `darwin <catalogue command>`: send, then print. Returns the exit code. */
export async function runTool(o: RunOpts): Promise<number> {
  const { ctx, session, tool, flags } = o;
  if (flags.dryRun) {
    // Offline: the agent as named, not resolved (resolving would be a request).
    const named = (flags.agent ?? ctx.env.DARWIN_AGENT ?? "").trim() || (session.kind === "agents" ? session.profile?.default_agent ?? "" : "");
    if (session.kind === "agents" && tool.name !== "list_agents" && !named) throw new CliError(EXIT.usage, copy.needAgent, "agent_required");
    const agentId = named || null;
    const preview = {
      dryRun: true, sent: false, command: `darwin ${tool.cli.path.join(" ")}`, tool: tool.name, write: tool.write,
      costsTx: tool.costsTx, realm: session.realm, agent: agentId, arguments: o.args,
      note: tool.idempotency ? "An order ID (nonce) is generated when the command really runs." : undefined,
    };
    if (o.json) printJson(ctx, preview);
    else for (const l of renderText(preview)) say(ctx, l);
    return EXIT.ok;
  }
  const agentId = tool.name === "list_agents" ? null : await resolveAgent(ctx, session, flags.agent);
  const out = await callTool(o, agentId);
  if (out.message === "unknown_tool") {
    if (o.onUnknownTool) await o.onUnknownTool().catch(() => {});
    out.message = `\`darwin ${tool.cli.path.join(" ")}\` isn't available on ${session.realm} right now. Nothing was done. The command list was refreshed — see \`darwin help\`.`;
  }
  const result = (out.body?.result ?? null) as Record<string, unknown> | null;
  if (o.json) {
    printJson(ctx, result ? { ...result, ...(out.nonce ? { nonce: out.nonce } : {}) } : { error: out.body?.error ?? "failed", detail: out.message, ...(out.nonce ? { nonce: out.nonce } : {}) });
    if (out.message) warn(ctx, out.message);
  } else {
    if (result && !(out.exit !== EXIT.ok && !result.data && !result.summary)) {
      if (typeof result.text === "string") say(ctx, cell(result.text));
      else {
        const { summary, data, welcome, ...rest } = result;
        // `hello`'s welcome is for the user, verbatim (escapes stripped).
        if (typeof welcome === "string") say(ctx, cell(welcome));
        if (summary !== undefined) for (const l of renderText(summary)) say(ctx, l);
        if (data !== undefined) for (const l of renderText(data)) say(ctx, l);
        for (const l of renderText(Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "status")))) if (l.trim()) say(ctx, l);
      }
    } else if (result) {
      warn(ctx, `${cell(result.detail ?? result.error ?? "Refused.")}${typeof result.error === "string" ? ` (${cell(result.error)})` : ""}`);
    }
    if (out.message) warn(ctx, out.message);
  }
  if (out.exit === EXIT.ok) afterSuccess(o, out, result);
  else if (out.nonce && tool.write) warn(ctx, `Order ID: ${out.nonce}`);
  return out.exit;
}

function afterSuccess(o: RunOpts, out: CallOutcome, result: Record<string, unknown> | null): void {
  const { ctx, tool, args } = o;
  const summary = (result?.summary ?? {}) as Record<string, unknown>;
  const data = (result?.data ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => cell(unwrap(v));
  if (tool.name === "get_spot_quote") {
    const quoteId = typeof data.quoteId === "string" ? data.quoteId : typeof summary.quoteId === "string" ? summary.quoteId : null;
    const exp = typeof data.expiresAtMs === "number" ? data.expiresAtMs : null;
    const sellAmount = (summary.sell as { amount?: unknown } | undefined)?.amount;
    if (quoteId && /^[A-Za-z0-9_-]{1,80}$/.test(quoteId)) {
      const secs = exp === null ? (tool.quoteTtlSeconds ?? 30) : Math.max(0, Math.ceil((exp - ctx.now()) / 1000));
      warn(ctx, copy.quoteFooter(quoteId, secs, text(args.sell), typeof sellAmount === "string" ? text(sellAmount) : text(args.amount), text(args.for)));
    }
  }
  if ((tool.name === "place_spot_order" || tool.name === "spot_order_now") && out.nonce) {
    const agent = o.session.kind === "agents" ? (o.flags.agent || o.session.profile?.default_agent || out.agentId || "this agent") : (o.session.profile?.agent_name || "this agent");
    const line = copy.spotSent(text(args.amount), text(args.sell), text(args.for), agent, out.nonce);
    if (o.json) warn(ctx, line);
    else say(ctx, line);
  }
}
