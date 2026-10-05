/**
 * `darwin market-status` (copy C.72): is the US stock market open right now? The endpoint is PUBLIC
 * (`GET /api/agent/v1/market-status/us-equities`), so this needs no key and no profile and sends no
 * Authorization header — it never reads the keychain or a profile at all. The realm is --beta /
 * DARWIN_REALM, else darwin.finance; the host allowlist applies as for every request.
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { has, one, onlyFlags, type Parsed } from "./args.js";
import { NetworkError, request } from "./http.js";
import { cell, printJson, say, wantsJson } from "./output.js";
import { parseRealm, type Realm } from "./realms.js";
import { when } from "./human.js";

export const MARKET_STATUS_PATH = "/api/agent/v1/market-status/us-equities";
export const MARKET_STATUS_TOOL = "get_us_market_status";
/** C.72 — the command's help line. */
export const MARKET_STATUS_HELP = "Is the US stock market open right now? Shows the session, why it's closed (weekend, holiday, early close), the next open and close in your local time, and whether Darwin accepts agent stock orders now. Tokenized stocks trade 24/7, but liquidity is much lower when the US market is closed. No API key needed.";

/** An ISO instant → the user's local wall-clock time (12-hour, with the zone). */
export function localTime(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  return when(iso, { weekday: true }) || null;
}

const SESSION: Record<string, string> = { pre_market: "pre-market", regular: "open (regular session)", after_hours: "after hours", closed: "closed" };
/** What the next session change is, by the session in progress. */
const SESSION_ENDS: Record<string, string> = { pre_market: "Regular session opens", regular: "Regular session closes", after_hours: "After hours ends", closed: "Pre-market opens" };
/** A closed-reason that only repeats the session adds nothing ("after hours (after hours)"). */
const REASON_REPEATS: Record<string, string> = { pre_market: "pre_market", after_hours: "after_hours" };

/** "US stock market: closed (holiday: Thanksgiving Day)" — the reason only when it adds something. */
export function marketHeadline(s: Record<string, unknown>): string {
  const session = SESSION[String(s.session)] ?? cell(s.session).replace(/_/g, " ");
  const reason = typeof s.reason === "string" ? s.reason : "";
  let why = "";
  if (reason && s.session !== "regular" && REASON_REPEATS[reason] !== s.session) {
    const holiday = reason === "holiday" && typeof s.holidayName === "string" && s.holidayName ? `: ${cell(s.holidayName)}` : "";
    why = ` (${cell(reason).replace(/_/g, " ")}${holiday})`;
  }
  const early = s.earlyClose === true && reason !== "early_close" ? " — early close today" : "";
  return `US stock market: ${session}${why}${early}`;
}

export async function cmdMarketStatus(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["beta", "prod", "json", "format", "quiet", "no-color", "help"], "market-status");
  if (p.positionals.length > 1) throw new CliError(EXIT.usage, "`darwin market-status` takes no arguments.", "usage");
  let realm: Realm = "darwin.finance";
  if (has(p, "beta")) realm = "beta.darwin.finance";
  else if (!has(p, "prod") && ctx.env.DARWIN_REALM) {
    const r = parseRealm(ctx.env.DARWIN_REALM);
    if (!r) throw new CliError(EXIT.usage, "DARWIN_REALM must be prod or beta.", "usage");
    realm = r;
  }
  let res;
  try {
    res = await request(ctx, realm, "GET", MARKET_STATUS_PATH, { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, e.message, "network_error");
    throw e;
  }
  const s = res.json as Record<string, unknown> | null;
  if (res.status === 429) throw new CliError(EXIT.rateLimited, "Too many requests right now; try again in a minute.", "rate_limited");
  if (res.status !== 200 || !s || typeof s.open !== "boolean") throw new CliError(EXIT.unexpected, `${realm} didn't answer the market status (HTTP ${res.status}).`, "bad_response");
  if (wantsJson(ctx, { json: has(p, "json"), format: one(p, "format") })) { printJson(ctx, s); return EXIT.ok; }
  say(ctx, marketHeadline(s));
  const line = (label: string, v: unknown) => { const t = localTime(v); if (t) say(ctx, `${label}: ${t}`); };
  line(SESSION_ENDS[String(s.session)] ?? "Session changes", s.sessionEndsAt);
  line("Next open", s.nextOpenAt);
  line("Next close", s.nextCloseAt);
  const a = (s.agentStockOrders ?? {}) as Record<string, unknown>;
  if (a.accepted === true) say(ctx, `Darwin agent stock orders: accepted${localTime(a.closesAt) ? ` until ${localTime(a.closesAt)}` : ""}`);
  else if (a.accepted === false) say(ctx, `Darwin agent stock orders: not accepted now${localTime(a.opensAt) ? `; next accepted ${localTime(a.opensAt)}` : ""}`);
  say(ctx, "Tokenized stocks trade 24/7, but liquidity is much lower when the US market is closed.");
  return EXIT.ok;
}
