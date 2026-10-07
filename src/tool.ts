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
import { updateCommand } from "./pinned.js";
import { CATALOGUE_HEADER, type Catalogue, type CatalogueTool, type SchemaProp } from "./catalogue.js";
import { NetworkError, request, type HttpResult } from "./http.js";
import { cell, printJson, say, warn } from "./output.js";
import { clean } from "./redact.js";
import { formatAtoms, refusalLines, renderResult, WSOL_MINT, type RenderCtx } from "./render.js";
import type { Parsed } from "./args.js";
import type { Session } from "./session.js";
import { resolveAgent } from "./agents.js";
import { cliLines, isPreparedWrite, recoveryFlags, runPrepared } from "./prepared.js";

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
export async function callTool(o: Omit<RunOpts, "json">, agentId: string | null, limits: { timeoutMs?: number; noRetry?: boolean } = {}): Promise<CallOutcome> {
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
    key: session.key, agent: agentId ?? undefined, body: { arguments: args }, timeoutMs: limits.timeoutMs ?? (tool.write ? 30_000 : 20_000),
  });
  let res: HttpResult;
  try {
    res = await send();
    // A READ may wait out one short rate limit; a write never repeats.
    if (!tool.write && !limits.noRetry && res.status === 429) {
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
    return { exit: EXIT.upgrade, body, nonce, agentId, message: copy.updateRequired(min, updateCommand(o.ctx)) };
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
  // v1.1: a write is checked by Darwin, then sent once (prepared.ts). `--dry-run` is that check.
  if (isPreparedWrite(tool)) {
    const agentId = await resolveAgent(ctx, session, flags.agent);
    const r = await runPrepared({ ctx, session, catalogue: o.catalogue, tool, args: o.args, agentId, json: o.json, dryRun: flags.dryRun, recovery: recoveryFlags(session, agentId) });
    if (r.kind === "done") {
      if (r.doc.error === "unknown_tool" && o.onUnknownTool) await o.onUnknownTool().catch(() => {});
      return r.exit;
    }
    // The realm has no prepared writes yet: the v1 direct path, exactly as 1.0.
    if (flags.dryRun) return EXIT.ok;
    return runDirect(o, agentId);
  }
  if (flags.dryRun) return dryRun(o);
  const agentId = tool.name === "list_agents" ? null : await resolveAgent(ctx, session, flags.agent);
  return runDirect(o, agentId);
}

/** The v1 path: `POST /api/agent/v1/tools/call/{name}`, then print. */
async function runDirect(o: RunOpts, agentId: string | null): Promise<number> {
  const { ctx, session, tool } = o;
  const out = await callTool(o, agentId);
  if (out.message === "unknown_tool") {
    if (o.onUnknownTool) await o.onUnknownTool().catch(() => {});
    out.message = `\`darwin ${tool.cli.path.join(" ")}\` isn't available on ${session.realm} right now. Nothing was done. The command list was refreshed — see \`darwin help\`.`;
  }
  const result = (out.body?.result ?? null) as Record<string, unknown> | null;
  if (o.json) {
    printJson(ctx, result ? { ...result, ...(out.nonce ? { nonce: out.nonce } : {}) } : { error: out.body?.error ?? "failed", detail: out.message, ...(out.nonce ? { nonce: out.nonce } : {}) });
    if (out.message) warn(ctx, out.message);
    for (const l of cliLines(out.body, "notes")) warn(ctx, l);
    if (out.exit === EXIT.ok) jsonFooter(o, out, result);
    else if (out.nonce && tool.write) warn(ctx, `Order nonce: ${out.nonce}`);
    return out.exit;
  }
  // ── a terminal ──
  const x = await renderCtx(o, out, agentId);
  if (out.exit === EXIT.ok && result) {
    for (const l of renderResult(tool.name, session.kind, result, x)) say(ctx, l);
    // Darwin's own notes for a person (e.g. a perps quote on a US-stock market outside the session).
    for (const l of cliLines(out.body, "notes")) say(ctx, l);
    // The follow-ups only decorate a result already shown; one that breaks never changes the outcome
    // — except a transaction KNOWN to have failed on chain, which exits 4.
    try {
      if ((await afterHumanSuccess(o, result, agentId)) === "failed") return EXIT.refused;
    } catch { /* decoration only */ }
  } else {
    // The caller's own message covers a pause, an uncertain write and a nonce conflict in full.
    const covered = out.exit === EXIT.paused || out.exit === EXIT.uncertain || out.message === copy.nonceConflict;
    if (result && !covered) for (const l of refusalLines(result, o.catalogue, tool.write)) warn(ctx, l);
    if (out.message) warn(ctx, out.message);
    if (out.nonce && tool.write) warn(ctx, `Order nonce: ${out.nonce}`);
  }
  return out.exit;
}

const QUOTE_TOOLS = new Set(["get_spot_quote"]);
/** A follow-up read's own limit, and the whole confirmation wait after a write. */
const EXTRA_READ_MS = 5_000;
const CONFIRM_BUDGET_MS = 12_000;
const SPOT_WRITES = new Set(["place_spot_order", "spot_order_now"]);

/** One extra READ for a human rendering (markets, balances, tx status, grant). Never throws; null on anything but success. */
async function readTool(o: RunOpts, name: string, args: Record<string, unknown>, agentId: string | null, deadline?: number): Promise<Record<string, unknown> | null> {
  const t = o.catalogue.tools.find((x) => x.name === name);
  if (!t || t.write) return null;
  // Every follow-up read is short and never waits out a rate limit: it only decorates the answer.
  const left = deadline === undefined ? EXTRA_READ_MS : Math.min(EXTRA_READ_MS, deadline - o.ctx.now());
  if (left < 500) return null;
  try {
    const r = await callTool({ ctx: o.ctx, session: o.session, catalogue: o.catalogue, tool: t, args, flags: o.flags }, agentId, { timeoutMs: left, noRetry: true });
    return r.exit === EXIT.ok && r.body?.result && typeof r.body.result === "object" ? r.body.result as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function renderCtx(o: RunOpts, out: CallOutcome, agentId: string | null): Promise<RenderCtx> {
  const { ctx, session, tool } = o;
  const agentLabel = session.kind === "agents"
    ? clean(o.flags.agent || (agentId && agentId === session.profile?.agent_id ? session.profile.agent_name : "") || agentId || "this agent")
    : clean(session.profile?.agent_name || "this agent");
  const x: RenderCtx = { realm: session.realm, now: ctx.now(), args: o.args, catalogue: o.catalogue, agentLabel, nonce: out.nonce };
  // Orders and trades name tokens by mint and count in atoms: the spot markets turn both into words.
  if (out.exit === EXIT.ok && (tool.name === "list_spot_orders" || tool.name === "list_trades")) {
    const m = await readTool(o, "list_spot_markets", {}, agentId);
    if (m) { try { x.markets = marketsByMint(m); } catch { /* names stay mints */ } }
  }
  return x;
}

function marketsByMint(result: Record<string, unknown>): Map<string, { symbol: string; decimals: number | null }> {
  const map = new Map<string, { symbol: string; decimals: number | null }>();
  const list = ((result.data as { instruments?: unknown } | undefined)?.instruments ?? []) as unknown[];
  if (!Array.isArray(list)) return map;
  for (const i of list) {
    if (!i || typeof i !== "object" || Array.isArray(i)) continue;
    const r = i as Record<string, unknown>;
    const mint = typeof r.mint === "string" ? r.mint : "";
    if (!mint || r.instrumentType === "perp") continue;
    map.set(mint, { symbol: cell(r.symbol).slice(0, 24) || mint.slice(0, 4), decimals: typeof r.decimals === "number" ? r.decimals : null });
  }
  return map;
}

/** After a successful command, in a terminal: the follow-ups that make the result complete. */
async function afterHumanSuccess(o: RunOpts, result: Record<string, unknown>, agentId: string | null): Promise<"failed" | void> {
  const { ctx, tool } = o;
  const data = (result.data ?? {}) as Record<string, unknown>;
  if (QUOTE_TOOLS.has(tool.name)) {
    // A quote doesn't check the balance; say so now rather than at the order.
    const inMint = typeof data.inputMint === "string" ? data.inputMint : null;
    const inAtoms = typeof data.inAtoms === "string" && /^[0-9]{1,40}$/.test(data.inAtoms) ? BigInt(data.inAtoms) : null;
    if (inMint && inAtoms !== null && inMint !== WSOL_MINT) {
      const b = await readTool(o, "get_balances", {}, agentId);
      const bd = (b?.data ?? null) as Record<string, unknown> | null;
      const rows = Array.isArray(bd?.balances) ? bd.balances as Record<string, unknown>[] : null;
      if (rows && bd?.partial !== true) {
        const row = rows.find((r) => r?.mint === inMint);
        const held = row && typeof row.atoms === "string" && /^[0-9]{1,40}$/.test(row.atoms) ? BigInt(row.atoms) : 0n;
        if (held < inAtoms) {
          const sym = cell(((result.summary as Record<string, unknown> | undefined)?.sell as Record<string, unknown> | undefined)?.symbol ?? "") || "of this token";
          const amt = row ? (typeof row.amount === "string" ? cell(row.amount) : formatAtoms(row.atoms, typeof row.decimals === "number" ? row.decimals : null)) : "0";
          warn(ctx, `⚠ This agent holds ${amt || "less than that"} ${sym}, so an order for this quote would fail.`);
        }
      }
    }
    return;
  }
  if (!SPOT_WRITES.has(tool.name)) return;
  const summary = (result.summary ?? {}) as Record<string, unknown>;
  const sig = typeof summary.txSignature === "string" ? summary.txSignature : typeof data.txSignature === "string" ? data.txSignature : null;
  const status = typeof summary.status === "string" ? summary.status : data.status;
  if (status === "failed") {
    warn(ctx, `The order failed, so nothing was traded.${sig ? ` Details: darwin tx ${sig}` : ""}`);
    return "failed";
  }
  if (sig && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig) && status !== "confirmed") {
    // Wait a few seconds (bounded: one wall-clock budget for every poll) for it to land; otherwise
    // the command that checks it.
    const deadline = ctx.now() + CONFIRM_BUDGET_MS;
    let landed: string | null = null;
    for (let i = 0; i < CONFIRM_POLLS && !landed && ctx.now() + CONFIRM_INTERVAL_MS < deadline; i++) {
      await ctx.sleep(CONFIRM_INTERVAL_MS);
      const t = await readTool(o, "get_tx_status", { signature: sig }, agentId, deadline);
      const st = (t?.data as { status?: unknown } | undefined)?.status;
      if (st === "confirmed" || st === "failed") landed = st;
    }
    if (landed === "confirmed") {
      const got = await receivedFor(o, data.orderId ?? summary.orderId, agentId, ctx.now() + EXTRA_READ_MS);
      say(ctx, got ? `Confirmed on chain: received ${got}.` : "Confirmed on chain.");
    } else if (landed === "failed") {
      warn(ctx, `The transaction failed on chain, so nothing was traded. Details: darwin tx ${sig}`);
      return "failed";
    } else {
      say(ctx, `Not confirmed yet. Check it with: darwin tx ${sig}`);
    }
  }
  // Only worth saying when the owner set a daily trade count.
  const g = await readTool(o, "get_grant", {}, agentId);
  const left = ((g?.data as Record<string, unknown> | undefined)?.today as Record<string, unknown> | undefined)?.remaining as Record<string, unknown> | undefined;
  if (left && typeof left.txCount === "number") say(ctx, `Trades left today: ${left.txCount}`);
}

const CONFIRM_POLLS = 4;
const CONFIRM_INTERVAL_MS = 2_000;

/** What a confirmed spot order received, from the orders list ("0.008238 SOL"), or null. */
async function receivedFor(o: RunOpts, orderId: unknown, agentId: string | null, deadline: number): Promise<string | null> {
  if (typeof orderId !== "string" || !orderId) return null;
  const [list, markets] = await Promise.all([readTool(o, "list_spot_orders", {}, agentId, deadline), readTool(o, "list_spot_markets", {}, agentId, deadline)]);
  const rows = ((list?.data as { orders?: unknown } | undefined)?.orders ?? []) as Record<string, unknown>[];
  const row = Array.isArray(rows) ? rows.find((r) => r?.orderId === orderId) : undefined;
  if (!row || typeof row.outputAtoms !== "string") return null;
  const m = markets ? marketsByMint(markets).get(String(row.outputMint)) : undefined;
  const amt = m ? formatAtoms(row.outputAtoms, m.decimals) : "";
  return amt ? `${amt} ${m!.symbol}` : null;
}

/** `--json`: stdout is the result alone; the human pointers go to stderr (C.39 / the sent line). */
function jsonFooter(o: RunOpts, out: CallOutcome, result: Record<string, unknown> | null): void {
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
  if (SPOT_WRITES.has(tool.name) && out.nonce) {
    const orderId = typeof data.orderId === "string" ? data.orderId : typeof summary.orderId === "string" ? summary.orderId : null;
    warn(ctx, copy.spotSent(text(args.amount), text(args.sell), text(args.for), agentFor(o, out), orderId ? cell(orderId) : null, out.nonce));
  }
}

const agentFor = (o: RunOpts, out: CallOutcome) => (o.session.kind === "agents" ? (o.flags.agent || o.session.profile?.default_agent || out.agentId || "this agent") : (o.session.profile?.agent_name || "this agent"));

/**
 * `--dry-run` of a READ (or the self-pause): what would be sent, offline. A prepared write's dry run
 * is Darwin's own check instead (prepared.ts).
 */
function dryRun(o: RunOpts): number {
  const { ctx, session, tool } = o;
  // Offline: the agent as named, not resolved (resolving would be a request).
  const named = (o.flags.agent ?? ctx.env.DARWIN_AGENT ?? "").trim() || (session.kind === "agents" ? session.profile?.default_agent ?? "" : "");
  if (session.kind === "agents" && tool.name !== "list_agents" && !named) throw new CliError(EXIT.usage, copy.needAgent, "agent_required");
  const agentId = named || null;
  const preview = {
    dryRun: true, sent: false, command: `darwin ${tool.cli.path.join(" ")}`, tool: tool.name, write: tool.write,
    costsTx: tool.costsTx, realm: session.realm, agent: agentId, arguments: o.args,
  };
  if (o.json) printJson(ctx, preview);
  else {
    say(ctx, `Dry run — nothing was sent. Would run: darwin ${tool.cli.path.join(" ")} on ${session.realm}${agentId ? ` for agent ${clean(agentId)}` : ""}`);
    for (const [k, v] of Object.entries(o.args)) {
      const flag = tool.cli.args[k]?.flag;
      say(ctx, flag ? `  --${flag} ${cell(v)}` : tool.cli.positional.includes(k) ? `  <${clean(k)}> ${cell(v)}` : `  --field ${clean(k)}=${cell(v)}`);
    }
  }
  return EXIT.ok;
}
