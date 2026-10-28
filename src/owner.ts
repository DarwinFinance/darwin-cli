/**
 * ACCOUNT-LEVEL (OWNER) KEYS (1.3.0). An owner key (`darwinAI_mcp_…`: a Read-Only API Key, or one that
 * trades for one / all agents) NEVER reaches the tool runner (`/api/agent/v1/tools/*`) — Darwin refuses
 * it there, by design.
 *
 *   - READS: this module, to the owner REST door chat apps use — a GET to one of the fixed paths below,
 *     or a POST to `/api/agent/v1/data/{tool}` (Darwin's read-only data door). Paths are this file's
 *     constants, never taken from the catalogue or a response.
 *   - TRADES (a key that trades for one / all agents): the SAME server-side runner as an agent key's,
 *     behind Darwin's owner CLI door `/api/agent/v1/owner-cli/*` (tool.ts / prepared.ts `runnerPath`) —
 *     the friendly conversion, Darwin's check-then-send and `retry` / `cancel` all stay on the server.
 *   🔴 A READ-ONLY key's trade is refused HERE, before any request ("This Darwin connection is
 *      read-only…"). Darwin refuses it too; this is the user's clean answer, not the fence.
 *   - An agent's own reads (balances, orders, …) name the agent in X-Darwin-Agent; Darwin checks that
 *     this key may name it (a one-agent key: only its own) on every call.
 *   - The answer is the route's own JSON. It is wrapped as the tool runner's result shape
 *     (`{status, data}`; `hello` flat) so `--json` and the renderers stay the same.
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import type { CatalogueTool } from "./catalogue.js";
import { NetworkError, request, type HttpResult } from "./http.js";
import type { Session } from "./session.js";
import type { CallOutcome } from "./tool.js";

type AgentNeed = "required" | "optional" | "none";
interface OwnerRoute { path: string; agent: AgentNeed }

/**
 * The agent API's READS an owner key may make, by tool → route. A local, fixed table (codex plan r1:
 * every one is on Darwin's owner door, `OWNER_KEY_ROUTES` / the holder door).
 */
export const OWNER_GET_ROUTES: Readonly<Record<string, OwnerRoute>> = Object.freeze({
  hello: { path: "/api/agent/v1/hello", agent: "optional" },
  list_agents: { path: "/api/agent/v1/agents", agent: "none" },
  get_grant: { path: "/api/agent/v1/grant", agent: "required" },
  get_us_market_status: { path: "/api/agent/v1/market-status/us-equities", agent: "none" },
  list_perp_markets: { path: "/api/agent/v1/markets", agent: "none" },
  get_perp_quote: { path: "/api/agent/v1/markets/{symbol}/quote", agent: "none" },
  get_perp_capabilities: { path: "/api/agent/v1/perps/capabilities", agent: "required" },
  get_perp_account: { path: "/api/agent/v1/perps/account", agent: "required" },
  list_perp_positions: { path: "/api/agent/v1/perps/positions", agent: "required" },
  list_perp_orders: { path: "/api/agent/v1/perps/orders", agent: "required" },
  list_perp_protections: { path: "/api/agent/v1/perps/protections", agent: "required" },
  get_tx_status: { path: "/api/agent/v1/tx/{signature}", agent: "required" },
  list_spot_markets: { path: "/api/agent/v2/markets", agent: "none" },
  get_balances: { path: "/api/agent/v2/balances", agent: "required" },
  list_spot_orders: { path: "/api/agent/v2/orders", agent: "required" },
  get_indicators: { path: "/api/agent/v2/indicators", agent: "none" },
  inspect_unlisted_token: { path: "/api/agent/v2/unlisted/{mint}", agent: "required" },
  list_trades: { path: "/api/agent/v2/trades", agent: "required" },
  get_pnl: { path: "/api/agent/v2/pnl", agent: "required" },
  list_lots: { path: "/api/agent/v2/lots", agent: "required" },
});

/** The API reference: the public Markdown page, sectioned here (as the tool runner does). */
export const DOCS_TOOL = "get_api_reference";
export const DOCS_PATH = "/agents/docs/llms.txt";

/** POSTs that only PRICE a trade: Darwin classes them as trading (a read-only key is refused them). */
const TRADING_QUOTES: ReadonlySet<string> = new Set(["get_spot_quote", "quote_unlisted_token"]);

/** `darwin account <what>` → the owner's account read on the data door. */
export const ACCOUNT_READS: Readonly<Record<string, { tool: string; body: Record<string, unknown>; title: string }>> = Object.freeze({
  portfolio: { tool: "get_portfolio", body: {}, title: "Your whole portfolio: holdings, perps, earn and agent accounts" },
  perps: { tool: "get_perps", body: {}, title: "Your perps positions, on every account" },
  earn: { tool: "get_earn", body: {}, title: "Your earn positions" },
  agents: { tool: "get_agent", body: {}, title: "Your agents: what each may trade, its limits, paused or not" },
  watchlists: { tool: "manage_watchlist", body: { action: "list" }, title: "Your watchlists" },
  alerts: { tool: "manage_alert", body: { action: "list" }, title: "Your price alerts" },
});

/** The data door's path for one tool (a tool NAME only — never a path piece). */
export function dataPath(tool: string): string {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool)) throw new CliError(EXIT.usage, "Not a Darwin data tool.", "invalid_path");
  return `/api/agent/v1/data/${tool}`;
}

export type OwnerVerdict = { ok: true } | { ok: false; message: string; code: string };

/** Does this catalogue command TRADE (a write, or a quote Darwin classes as trading)? Pure. */
export function isOwnerTrade(tool: Pick<CatalogueTool, "name" | "write">): boolean {
  return tool.write || TRADING_QUOTES.has(tool.name);
}

/**
 * May an owner key run this command? A READ-ONLY key never trades. A key that trades for one / all
 * agents (or whose scope isn't known here — Darwin decides) may. Pure.
 */
export function ownerMayRun(s: Pick<Session, "ownerScope">, tool: Pick<CatalogueTool, "name" | "write">): OwnerVerdict {
  if (isOwnerTrade(tool) && s.ownerScope === "none") return { ok: false, message: copy.readOnlyRefusal, code: "read_only" };
  return { ok: true };
}

/**
 * Throw the clean refusal (exit 4) for a read-only key's trade — call BEFORE the trade is sent. An
 * environment key's scope is learned first from Darwin's agents list (a read; never the trade).
 */
export async function assertOwnerMayRun(ctx: Ctx, s: Session, tool: Pick<CatalogueTool, "name" | "write">): Promise<void> {
  if (s.kind !== "owner" || !isOwnerTrade(tool)) return;
  if (s.ownerScope === null) {
    const { agentsAnswer, ownerScopeFromPermissions } = await import("./agents.js");
    s.ownerScope = ownerScopeFromPermissions((await agentsAnswer(ctx, s)).permissions);
    if (s.ownerScope === null) throw new CliError(EXIT.unexpected, copy.ownerScopeUnknown, "bad_response");
  }
  const v = ownerMayRun(s, tool);
  if (!v.ok) throw new CliError(EXIT.refused, v.message, v.code);
}

/** Which agent rule a tool has for an owner key. Market data (the data door) names none. */
export function ownerAgentNeed(tool: Pick<CatalogueTool, "name" | "write">): AgentNeed {
  if (tool.name === DOCS_TOOL) return "none";
  // A trade acts on ONE sub-account (a one-agent key: its own, so it may leave it out).
  if (isOwnerTrade(tool)) return "required";
  return OWNER_GET_ROUTES[tool.name]?.agent ?? "none";
}

/** A query/path value made safe for the CLI's own path check (RFC 3986 unreserved + %XX only). */
function enc(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The request for one read: method, path (with query), body. Throws a usage error on a bad argument. */
export function ownerRequest(tool: Pick<CatalogueTool, "name">, args: Record<string, unknown>): { method: "GET" | "POST"; path: string; body?: Record<string, unknown> } {
  const a: Record<string, unknown> = { ...args };
  delete a._meta;
  const route = OWNER_GET_ROUTES[tool.name];
  if (!route) return { method: "POST", path: dataPath(tool.name), body: a };
  let path = route.path;
  for (const m of route.path.matchAll(/\{([a-z]+)\}/g)) {
    const v = a[m[1]!];
    if (typeof v !== "string" || v === "" || v.length > 128) throw new CliError(EXIT.usage, `<${m[1]}> is required.`, "usage");
    path = path.replace(m[0], enc(v));
    delete a[m[1]!];
  }
  const q: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) || !(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      throw new CliError(EXIT.usage, `${k.slice(0, 40)} must be a text, number or true/false value.`, "usage");
    }
    q.push(`${k}=${enc(String(v))}`);
  }
  return { method: "GET", path: q.length ? `${path}?${q.join("&")}` : path };
}

/** The API reference's table of contents, or one section (the tool runner's own rule). */
export function referenceSection(markdown: string, section: string | undefined): string {
  const heads = [...markdown.matchAll(/^## ([0-9]{1,2}[a-z]?)\. .*$/gm)];
  if (!section) return ["Sections (pass a section number: darwin docs <n>):", ...heads.map((h) => `- ${h[0].slice(3)}`)].join("\n");
  const i = heads.findIndex((h) => h[1] === section);
  if (i < 0) return `No section "${section}". Run \`darwin docs\` for the list.`;
  const start = heads[i]!.index!;
  const end = i + 1 < heads.length ? heads[i + 1]!.index! : markdown.length;
  return markdown.slice(start, end).slice(0, 40_000);
}

const AUTH_MESSAGE = `${copy.ownerKeyRefused} Nothing was done.`;

/**
 * One READ with an owner key, as a CallOutcome (the tool runner's envelope). Never a write: a trade
 * returns the refusal WITHOUT sending (defence in depth behind the command layer's own check).
 */
export async function callOwnerRead(o: { ctx: Ctx; session: Session; tool: CatalogueTool; args: Record<string, unknown> }, agentId: string | null, limits: { timeoutMs?: number; noRetry?: boolean } = {}): Promise<CallOutcome> {
  const { ctx, session, tool } = o;
  // 🔴 This module sends READS only: a trade never comes here (tool.ts sends it to the owner CLI door).
  if (isOwnerTrade(tool)) {
    const v = ownerMayRun(session, tool);
    return { exit: EXIT.refused, body: null, nonce: null, agentId, message: v.ok ? copy.ownerTradingUnavailable : v.message };
  }
  if (tool.name === DOCS_TOOL) return docs(o, agentId);
  const need = ownerAgentNeed(tool);
  if (need === "required" && agentId === null && session.ownerScope !== "agent") {
    // Only a one-agent owner key may leave the agent out (Darwin then uses its one agent).
    const { resolveOwnerAgent } = await import("./agents.js");
    agentId = await resolveOwnerAgent(ctx, session, undefined, "required");
  }
  const req = ownerRequest(tool, o.args);
  const send = () => request(ctx, session.realm, req.method, req.path, {
    key: session.key, agent: need === "none" ? undefined : agentId ?? undefined, body: req.body, timeoutMs: limits.timeoutMs ?? 20_000,
  });
  let res: HttpResult;
  try {
    res = await send();
    // A read may wait out one short rate limit, as every read does.
    if (!limits.noRetry && res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? "NaN");
      if (Number.isFinite(ra) && ra >= 0 && ra <= 10) {
        await ctx.sleep(ra * 1000);
        res = await send();
      }
    }
  } catch (e) {
    if (e instanceof NetworkError) return { exit: EXIT.network, body: null, nonce: null, agentId, message: `${e.message} Nothing was done; try again.` };
    throw e;
  }
  const json = res.json;
  if (res.status === 200 && json !== null && typeof json === "object" && !Array.isArray(json)) {
    // `hello` is flat (the renderer reads its fields); everything else is {status, data}.
    const result = tool.name === "hello" ? { ...(json as Record<string, unknown>) } : { status: 200, data: json };
    return { exit: EXIT.ok, body: { tool: tool.name, isError: false, result }, nonce: null, agentId };
  }
  if (res.status === 200 && json !== null) return { exit: EXIT.ok, body: { tool: tool.name, isError: false, result: { status: 200, data: json } }, nonce: null, agentId };
  if (res.status === 401) return { exit: EXIT.auth, body: null, nonce: null, agentId, message: AUTH_MESSAGE };
  if (res.status === 429) return { exit: EXIT.rateLimited, body: null, nonce: null, agentId, message: "Too many requests with this API key right now. Wait a minute and try again. Nothing was done." };
  const err = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  if (res.status === 404 && err?.error === "unknown_tool") {
    return { exit: EXIT.usage, body: null, nonce: null, agentId, message: `\`darwin ${tool.cli.path.join(" ")}\` isn't available with an account-level API key on ${session.realm}. Nothing was done.` };
  }
  if (err && res.status >= 400 && res.status < 500) {
    // Darwin's own refusal (a paused agent, a bad argument, …): shown by the usual refusal lines.
    return { exit: EXIT.refused, body: { tool: tool.name, isError: true, result: { status: res.status, data: err } }, nonce: null, agentId };
  }
  return { exit: EXIT.unexpected, body: null, nonce: null, agentId, message: `Darwin answered HTTP ${res.status}. Nothing was done.` };
}

async function docs(o: { ctx: Ctx; session: Session; args: Record<string, unknown> }, agentId: string | null): Promise<CallOutcome> {
  const section = o.args.section;
  if (section !== undefined && (typeof section !== "string" || !/^[0-9]{1,2}[a-z]?$/.test(section))) {
    return { exit: EXIT.usage, body: null, nonce: null, agentId, message: "A section is a number from `darwin docs` (e.g. 12 or 12b)." };
  }
  let res: HttpResult;
  try {
    // Public: no key is sent for the API reference.
    res = await request(o.ctx, o.session.realm, "GET", DOCS_PATH, { timeoutMs: 20_000, headers: { accept: "text/markdown, text/plain" } });
  } catch (e) {
    if (e instanceof NetworkError) return { exit: EXIT.network, body: null, nonce: null, agentId, message: `${e.message} Nothing was done; try again.` };
    throw e;
  }
  if (res.status !== 200 || !res.text.includes("\n## ")) return { exit: EXIT.unexpected, body: null, nonce: null, agentId, message: `Couldn't read the API reference (HTTP ${res.status}).` };
  return { exit: EXIT.ok, body: { tool: DOCS_TOOL, isError: false, result: { text: referenceSection(res.text, section as string | undefined) } }, nonce: null, agentId };
}
