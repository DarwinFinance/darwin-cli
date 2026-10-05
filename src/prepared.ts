/**
 * v1.1 — PREPARED WRITES (plan §4.10, §5.3). Every write but the self-pause is two calls:
 *
 *   prepare  POST /api/agent/v1/tools/call/{name}/prepare  — Darwin converts and CHECKS the order
 *            (the agent can trade, perps is set up, the quote / position / collateral is there) and
 *            stores the exact request. Nothing is sent. `--dry-run` stops here (`dryRun: true`,
 *            nothing stored).
 *   execute  POST /api/agent/v1/tools/execute             — runs THAT stored request, once.
 *   status   POST /api/agent/v1/tools/status              — READ-ONLY: what happened (`darwin retry`).
 *   cancel   POST /api/agent/v1/tools/cancel              — make sure one that hasn't started never runs.
 *
 *   🔴 Nothing here ever re-sends a write. After execute, only `status` (a read) is polled — to say
 *      whether a sent order landed, or what became of one whose answer was lost.
 *   🔴 The order's nonce is Darwin's and stays secret while the order is unresolved; this file never
 *      generates or sends one on the prepared path (a caller's --nonce is refused by Darwin).
 *   The words a person reads come from the server's `cli.lines` (owner amendment 2), cleaned.
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { NetworkError, request, type HttpResult } from "./http.js";
import { printJson, say, warn } from "./output.js";
import { clean } from "./redact.js";
import { copy } from "./copy.js";
import type { Catalogue, CatalogueTool } from "./catalogue.js";
import type { Session } from "./session.js";

export const PREPARED_ID = /^prp_[0-9A-Za-z]{24}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Writes that go through prepare → execute: every write except the self-pause. */
export function isPreparedWrite(tool: Pick<CatalogueTool, "name" | "write">): boolean {
  return tool.write && tool.name !== "pause_agent";
}

export type Verdict = "sent" | "landed" | "pending" | "failed" | "refused" | "replayed" | "uncertain" | "never_sent" | "not_started";
const VERDICTS: ReadonlySet<string> = new Set(["sent", "landed", "pending", "failed", "refused", "replayed", "uncertain", "never_sent", "not_started"]);

/** Wait budget after a sent write, and after an uncertain one (status reads only). */
export const LAND_WAIT_MS = 8_000;
export const POLL_MS = 2_000;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const unwrap = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) && "untrusted" in (v as object) ? (v as { untrusted: unknown }).untrusted : v);

/** The server's own words for a person (`cli.lines` / `cli.notes`), cleaned; never anything else. */
export function cliLines(body: unknown, key: "lines" | "notes" = "lines"): string[] {
  const l = obj(obj(body).cli)[key];
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string").map((x) => clean(x).slice(0, 600)).filter(Boolean).slice(0, 12) : [];
}

export function verdictOf(body: unknown): Verdict | null {
  const v = obj(body).verdict;
  return typeof v === "string" && VERDICTS.has(v) ? (v as Verdict) : null;
}

/** The refusal code a prepare / execute answer carries (`grant_paused` → exit 10). */
function refusalCode(body: unknown): string {
  const r = obj(obj(body).result);
  const d = obj(r.data);
  // A status view nests the execution's answer under `outcome` (codex CLI r3 #3).
  const or = obj(obj(obj(body).outcome).result);
  const od = obj(or.data);
  for (const c of [r.error, d.refusal, d.error, or.error, od.refusal, od.error, obj(body).error]) {
    const s = unwrap(c);
    if (typeof s === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(s)) return s;
  }
  return "";
}

/** The exit code for a verdict (plan §5.5): done → 0, did not happen → 4, unresolved → 6. */
export function exitForVerdict(v: Verdict | null, body?: unknown): number {
  switch (v) {
    case "sent": case "landed": case "replayed": return EXIT.ok;
    case "refused": case "failed": case "never_sent": return refusalCode(body) === "grant_paused" ? EXIT.paused : EXIT.refused;
    default: return EXIT.uncertain;
  }
}

/** The one ID a person sees (owner amendment 4): Darwin's order id, else the transaction, shortened. */
export function orderIdOf(body: unknown): string | null {
  const r = obj(obj(body).result);
  const data = obj(r.data);
  const summary = obj(r.summary);
  const id = unwrap(data.orderId) ?? unwrap(summary.orderId);
  if (typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id)) return id;
  const sig = unwrap(data.txSignature) ?? unwrap(summary.txSignature);
  if (typeof sig === "string" && SIG.test(sig)) return `${sig.slice(0, 4)}…${sig.slice(-4)}`;
  return null;
}

/**
 * The recovery command, with the profile and agent this order used (codex CLI r1 #5) so it can be
 * copied as it is. Profile names and agent ids are plain [A-Za-z0-9_-], so no quoting is needed.
 */
export function retryCommand(preparedId: string, ctxFlags: string[] = [], verb: "retry" | "cancel" = "retry"): string {
  return ["darwin", verb, preparedId, ...ctxFlags].join(" ");
}
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * `--profile <p>` for a profile-backed key — always, since a bare command could pick another key
 * (DARWIN_API_KEY, DARWIN_PROFILE, a changed default) — and `--agent <id>` when one was named.
 */
export function recoveryFlags(session: Session, agentId: string | null): string[] {
  const out: string[] = [];
  if (session.profile && SAFE.test(session.profileName)) out.push("--profile", session.profileName);
  if (agentId && SAFE.test(agentId)) out.push("--agent", agentId);
  return out;
}

export interface PreparedOpts {
  ctx: Ctx;
  session: Session;
  catalogue: Catalogue;
  tool: CatalogueTool;
  args: Record<string, unknown>;
  agentId: string | null;
  json: boolean;
  dryRun: boolean;
  /** `darwin mcp`: no printing, no waiting — the caller renders the outcome. */
  quietForMcp?: boolean;
  /** Flags the printed `darwin retry` / `darwin cancel` commands carry (profile, agent). */
  recovery?: string[];
}

export type PreparedResult =
  | { kind: "fallback" } // the realm has no prepared writes: the caller uses the v1 direct path
  | { kind: "done"; exit: number; preparedId: string | null; doc: Record<string, unknown> };

async function post(o: Pick<PreparedOpts, "ctx" | "session" | "agentId">, path: string, body: unknown, timeoutMs: number): Promise<HttpResult> {
  return request(o.ctx, o.session.realm, "POST", path, { key: o.session.key, agent: o.agentId ?? undefined, body, timeoutMs });
}

/** What a non-200 from any prepared route proves NOTHING ran. `null` = not one of those. */
function plainRefusal(res: HttpResult, catalogue: Catalogue, command: string, realm: string): { exit: number; message: string } | null {
  const err = typeof obj(res.json).error === "string" ? String(obj(res.json).error) : "";
  if (res.status === 401) return { exit: EXIT.auth, message: "Darwin refused this API key (or the agent it named). It may have been revoked or the agent paused; run `darwin whoami`, or ask the owner. Nothing was done." };
  if (res.status === 426) {
    const min = typeof obj(res.json).minCli === "string" && /^\d+\.\d+\.\d+$/.test(String(obj(res.json).minCli)) ? String(obj(res.json).minCli) : catalogue.minCli;
    return { exit: EXIT.upgrade, message: copy.updateRequired(min) };
  }
  if (res.status === 429) return { exit: EXIT.rateLimited, message: "Too many requests with this API key right now. Wait a minute and try again. Nothing was done." };
  if (res.status === 404 && err === "cli_unavailable") return { exit: EXIT.refused, message: "The Darwin CLI isn't available on this site yet. Nothing was done." };
  if (res.status === 404 && err === "unknown_tool") return { exit: EXIT.usage, message: `\`${command}\` isn't available on ${realm} right now. Nothing was done. Run \`darwin help\` for the current list.` };
  if (res.status === 400 && err === "invalid_request") return { exit: EXIT.usage, message: "Darwin couldn't read that request. Nothing was done." };
  return null;
}

/** prepare (+ execute, + the short read-only wait). Never re-sends anything. */
export async function runPrepared(o: PreparedOpts): Promise<PreparedResult> {
  const { tool } = o;
  const path = `/api/agent/v1/tools/call/${encodeURIComponent(tool.name)}/prepare`;
  let res: HttpResult;
  try {
    res = await post(o, path, { arguments: o.args, ...(o.dryRun ? { dryRun: true } : {}) }, 30_000);
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    // A prepare sends no order: whatever it may have stored expires unexecuted.
    return done(o, EXIT.network, null, { error: "network_error", detail: `${e.message} Nothing was sent; try again.`, sent: false }, [`${clean(e.message)} Nothing was sent; try again.`]);
  }
  const pj = obj(res.json);
  // 404 = nothing stored or sent: the realm has no prepared writes (switched off, or an older
  // build without the route). The v1 direct path is the only way there.
  if (res.status === 404 && pj.error !== "unknown_tool" && pj.error !== "cli_unavailable") {
    if (!o.dryRun) return { kind: "fallback" };
    const line = `Darwin can't check orders ahead of time on ${o.session.realm} yet, so nothing was checked or sent.`;
    return done(o, EXIT.ok, null, { dryRun: true, sent: false, checked: false, detail: line }, [line]);
  }
  const plain = plainRefusal(res, o.catalogue, `darwin ${tool.cli.path.join(" ")}`, o.session.realm);
  if (plain) return done(o, plain.exit, null, { error: pj.error ?? "refused", detail: plain.message, sent: false, status: res.status }, [plain.message]);
  const result = obj(pj.result);
  if (res.status !== 200 || typeof pj.isError !== "boolean") {
    return done(o, EXIT.unexpected, null, { error: "bad_response", status: res.status, sent: false }, [`Darwin answered HTTP ${res.status}. Nothing was sent.`]);
  }
  if (pj.isError) {
    const code = refusalCode(pj);
    const exit = code === "grant_paused" ? EXIT.paused : code === "invalid_arguments" || code === "nonce_not_accepted" ? EXIT.usage : code === "rate_limited" ? EXIT.rateLimited : EXIT.refused;
    return done(o, exit, null, { ...pj }, cliLines(pj).length ? cliLines(pj) : [`Darwin refused this${code ? ` (${code})` : ""}. Nothing was sent.`]);
  }
  if (o.dryRun) {
    const lines = cliLines(pj);
    if (tool.costsTx) lines.push("Running it for real counts against today's transaction budget.");
    return done(o, EXIT.ok, null, { ...pj }, lines.length ? lines : ["Dry run: Darwin checked it, and nothing was sent."]);
  }
  const preparedId = typeof result.preparedId === "string" && PREPARED_ID.test(result.preparedId) ? result.preparedId : null;
  if (!preparedId) return done(o, EXIT.unexpected, null, { error: "bad_response", sent: false }, ["Darwin's answer didn't name the prepared order. Nothing was sent."]);
  return execute(o, preparedId, pj);
}

async function execute(o: PreparedOpts, preparedId: string, prepareBody: Record<string, unknown>): Promise<PreparedResult> {

  let res: HttpResult | null = null;
  let lostAnswer = false;
  try {
    res = await post(o, "/api/agent/v1/tools/execute", { preparedId }, 70_000);
  } catch (e) {
    if (e instanceof CliError && e.code === "redirect_refused") {
      lostAnswer = true;
    } else if (!(e instanceof NetworkError)) {
      throw e;
    } else if (!e.maybeSent) {
      // Never delivered: the prepared order did not run, and expires in 10 minutes unexecuted.
      return done(o, EXIT.network, preparedId, { error: "network_error", preparedId, sent: false, detail: `${e.message} Nothing was sent.` },
        [`${clean(e.message)} Nothing was sent. (It can't run later by itself; \`${retryCommand(preparedId, o.recovery, "cancel")}\` makes sure.)`]);
    } else {
      lostAnswer = true;
    }
  }
  // (A redirect after sending — `request` refuses to follow it — proves nothing either way: uncertain.)
  const ej = obj(res?.json);
  if (res && !lostAnswer) {
    // 409: nothing ran (already started / cancelled / expired) — the status view says what is there.
    if (res.status === 409 && ej.executed === false) return finish(o, preparedId, prepareBody, ej, null);
    if (res.status === 401) {
      return done(o, EXIT.auth, preparedId, { error: "unauthorized", preparedId, sent: false }, ["Darwin refused this API key (or the agent it named), so the order was not sent. Run `darwin whoami`, or ask the owner."]);
    }
    // Refused at the door, before anything ran (codex CLI r1 #2): rate limit, version gate, a body
    // Darwin couldn't read, a site or record that isn't there.
    const plain = plainRefusal(res, o.catalogue, `darwin ${o.tool.cli.path.join(" ")}`, o.session.realm);
    if (plain) return done(o, plain.exit, preparedId, { error: ej.error ?? "refused", preparedId, sent: false, status: res.status }, [plain.message.replace("Nothing was done.", "The order was not sent.")]);
    if (res.status === 404) {
      return done(o, EXIT.refused, preparedId, { error: ej.error ?? "not_found", preparedId, sent: false, status: 404 }, ["Darwin couldn't find this checked order to send, so nothing was sent. Run the command again."]);
    }
    if (res.status === 200 && verdictOf(ej)) {
      const v = verdictOf(ej)!;
      if (v !== "uncertain") return finish(o, preparedId, prepareBody, ej, null);
    }
  }
  // 🔴 UNCERTAIN: the order may have been sent. Read (never re-send) what happened, a few times.
  const lines = res && verdictOf(ej) === "uncertain" ? cliLines(ej) : [];
  const status = await pollStatus(o, preparedId, (v) => v !== "pending" && v !== "uncertain" && v !== "not_started", LAND_WAIT_MS);
  return finish(o, preparedId, prepareBody, Object.keys(ej).length ? ej : { preparedId, state: "unknown", verdict: "uncertain" }, status, lines);
}

/** Poll the read-only status route until `stop(verdict)` or the budget runs out. */
async function pollStatus(o: PreparedOpts, preparedId: string, stop: (v: Verdict) => boolean, budgetMs: number): Promise<Record<string, unknown> | null> {
  if (o.quietForMcp) budgetMs = Math.min(budgetMs, 4_000);
  const deadline = o.ctx.now() + budgetMs;
  let last: Record<string, unknown> | null = null;
  while (o.ctx.now() + POLL_MS <= deadline) {
    await o.ctx.sleep(POLL_MS);
    try {
      const r = await post(o, "/api/agent/v1/tools/status", { preparedId }, Math.max(1_000, Math.min(5_000, deadline - o.ctx.now())));
      if (r.status === 200 && verdictOf(r.json)) {
        last = obj(r.json);
        if (stop(verdictOf(last)!)) return last;
      }
    } catch { /* a read; try again within the budget */ }
  }
  return last;
}

/** Print (or not) and build the --json document for an executed order. */
async function finish(o: PreparedOpts, preparedId: string, prepareBody: Record<string, unknown>, executeBody: Record<string, unknown>, status: Record<string, unknown> | null, firstLines: string[] = []): Promise<PreparedResult> {
  let st = status;
  let v: Verdict | null = verdictOf(executeBody) ?? "uncertain";
  const lines: string[] = [...(firstLines.length ? firstLines : cliLines(executeBody))];
  // A sent order: wait a few seconds (reads only) to say whether it landed.
  if (!st && v === "sent") st = await pollStatus(o, preparedId, (x) => x === "landed" || x === "failed" || x === "refused", LAND_WAIT_MS);
  const sv = verdictOf(st);
  if (st && sv) {
    // Still only "sent": keep the execute's own words and say it isn't confirmed yet (below).
    const stillWaiting = v === "sent" && (sv === "sent" || sv === "pending");
    if (!stillWaiting) {
      for (const l of cliLines(st)) if (!lines.includes(l)) lines.push(l);
      v = sv;
    }
  }
  if (lines.length === 0 && v === "uncertain") lines.push(copy.uncertainWritePrepared);
  const exit = exitForVerdict(v, st ?? executeBody);
  const orderId = orderIdOf(executeBody) ?? orderIdOf(st);
  if (orderId && (v === "sent" || v === "landed" || v === "replayed")) lines.push(`Order ID: ${orderId}`);
  if (v === "sent") lines.push(`Not confirmed yet. Check it with: ${retryCommand(preparedId, o.recovery)}`);
  if (exit === EXIT.uncertain) lines.push(`Don't run the command again. Check it with: ${retryCommand(preparedId, o.recovery)}`);
  const doc = {
    preparedId, tool: o.tool.name, verdict: v ?? "uncertain",
    prepare: obj(prepareBody.result),
    execute: executeBody,
    ...(st && st !== executeBody ? { status: st } : {}),
    ...(exit === EXIT.uncertain || v === "sent" ? { next: { command: retryCommand(preparedId, o.recovery) } } : {}),
  };
  return done(o, exit, preparedId, doc, lines);
}

function done(o: PreparedOpts, exit: number, preparedId: string | null, doc: Record<string, unknown>, lines: string[], toStderr = exit !== EXIT.ok): PreparedResult {
  if (!o.quietForMcp) {
    if (o.json) {
      printJson(o.ctx, doc);
      if (exit !== EXIT.ok) for (const l of lines) warn(o.ctx, l);
    } else {
      for (const l of lines) (toStderr ? warn : say)(o.ctx, l);
    }
  }
  return { kind: "done", exit, preparedId, doc: { ...doc, lines } };
}

// ─── darwin retry / darwin cancel ───────────────────────────────────────────

/** `darwin retry <id>` (status, read-only) or `darwin cancel <id>`. Returns the exit code. */
export async function checkPrepared(o: { ctx: Ctx; session: Session; agentId: string | null; json: boolean; preparedId: string; cancel: boolean }): Promise<number> {
  const { ctx, preparedId } = o;
  const flags = recoveryFlags(o.session, o.agentId);
  const again = retryCommand(preparedId, flags);
  let res: HttpResult;
  try {
    res = await post(o, o.cancel ? "/api/agent/v1/tools/cancel" : "/api/agent/v1/tools/status", { preparedId }, 20_000);
  } catch (e) {
    if (e instanceof CliError && e.code === "redirect_refused") {
      // A redirect after sending proves nothing either way (a cancel may have happened): unknown.
      const msg = `${clean(e.message)} ${o.cancel ? "Whether it was cancelled is unknown" : "Its outcome is still unknown"}; check again in a moment with \`${again}\`.`;
      if (o.json) printJson(ctx, { error: "redirect_refused", preparedId, detail: msg });
      warn(ctx, msg);
      return EXIT.uncertain;
    }
    if (!(e instanceof NetworkError)) throw e;
    // A cancel that may have arrived may have changed things (codex CLI r1 #4): unknown, not "not sent".
    const reached = e.maybeSent;
    const msg = o.cancel && !reached
      ? `${clean(e.message)} The cancel didn't reach Darwin; try again.`
      : `${clean(e.message)} ${o.cancel ? "Whether it was cancelled is unknown" : "Its outcome is still unknown"}; check again in a moment with \`${again}\`.`;
    if (o.json) printJson(ctx, { error: "network_error", preparedId, detail: msg });
    warn(ctx, msg);
    return o.cancel && !reached ? EXIT.network : EXIT.uncertain;
  }
  const j = obj(res.json);
  const err = typeof j.error === "string" ? j.error : "";
  if (res.status === 401) {
    // C.62: an opaque refusal proves nothing about the order.
    const msg = "Can't check this order with this API key and agent right now. Its outcome is still unknown, not failed. A paused agent is one possible cause. Check the agent's History on Darwin.";
    if (o.json) printJson(ctx, { error: "unauthorized", preparedId, detail: msg });
    warn(ctx, msg);
    return EXIT.uncertain;
  }
  if (res.status === 404 && (err === "not_found" || err === "prepared_unavailable" || err === "cli_unavailable")) {
    const msg = err === "not_found"
      ? "Darwin has no order with that ID for this API key and agent. (Use the ID this terminal printed, with the same profile and --agent.)"
      : `This site doesn't keep checked orders yet, so there's nothing to look up. Check \`darwin orders\` instead.`;
    if (o.json) printJson(ctx, { error: err, preparedId, detail: msg });
    warn(ctx, msg);
    return EXIT.refused;
  }
  if (res.status === 426) {
    const min = typeof j.minCli === "string" && /^\d+\.\d+\.\d+$/.test(j.minCli) ? j.minCli : "the latest version";
    const msg = copy.updateRequired(min);
    if (o.json) printJson(ctx, { error: "cli_upgrade_required", status: 426, preparedId, minCli: min, detail: msg });
    warn(ctx, msg);
    return EXIT.upgrade;
  }
  if (res.status === 429) {
    const msg = "Too many requests with this API key right now. Wait a minute and try again.";
    if (o.json) printJson(ctx, { error: "rate_limited", status: 429, preparedId, detail: msg });
    warn(ctx, msg);
    return EXIT.rateLimited;
  }
  const v = verdictOf(j);
  if (res.status !== 200 || !v) {
    if (o.json) printJson(ctx, { error: "bad_response", status: res.status, preparedId });
    warn(ctx, `Darwin answered HTTP ${res.status}. The order's outcome is still unknown; try again in a moment.`);
    return EXIT.uncertain;
  }
  const lines = cliLines(j);
  if (o.cancel && j.cancelled === false) lines.push("It had already started, so it couldn't be cancelled.");
  const exit = o.cancel ? (j.cancelled === true ? EXIT.ok : exitForVerdict(v, j)) : exitForVerdict(v, j);
  const orderId = orderIdOf(obj(j.outcome));
  if (orderId && (v === "landed" || v === "sent")) lines.push(`Order ID: ${orderId}`);
  if (v === "pending" || v === "uncertain") lines.push(`Don't place it again. Check again in a minute: ${again}`);
  if (v === "not_started" && !o.cancel) lines.push(`To make sure it never runs: ${retryCommand(preparedId, flags, "cancel")}`);
  if (o.json) printJson(ctx, j);
  else for (const l of lines) say(ctx, l);
  return exit;
}

/** `darwin mcp`'s check_prepared / cancel_prepared: the raw status or cancel answer. */
export async function preparedRead(o: { ctx: Ctx; session: Session; agentId: string | null }, preparedId: string, cancel: boolean): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  if (!PREPARED_ID.test(preparedId)) return { ok: false, body: { error: "invalid_arguments", detail: "preparedId is the prp_… id a write returned." } };
  try {
    const r = await post(o, cancel ? "/api/agent/v1/tools/cancel" : "/api/agent/v1/tools/status", { preparedId }, 20_000);
    const j = obj(r.json);
    if (r.status === 200 && verdictOf(j)) return { ok: true, body: j };
    if (r.status === 401) return { ok: false, body: { error: "unauthorized", preparedId, outcome: "unknown", detail: "Can't check this order with this API key and agent right now. Its outcome is still unknown, not failed. A paused agent is one possible cause." } };
    return { ok: false, body: { error: typeof j.error === "string" ? j.error : "bad_response", status: r.status, preparedId, detail: typeof j.detail === "string" ? j.detail : "Darwin couldn't answer that just now." } };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    return { ok: false, body: { error: "network_error", preparedId, outcome: "unknown", detail: `${e.message} Its outcome is still unknown.` } };
  }
}
