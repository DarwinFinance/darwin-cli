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

export const MARKET_STATUS_PATH = "/api/agent/v1/market-status/us-equities";
export const MARKET_STATUS_TOOL = "get_us_market_status";
/** C.72 — the command's help line. */
export const MARKET_STATUS_HELP = "Is the US stock market open right now? Shows the session, why it's closed (weekend, holiday, early close), the next open and close in your local time, and whether Darwin accepts agent stock orders now. Tokenized stocks trade 24/7, but liquidity is much lower when the US market is closed. No API key needed.";

/** An ISO instant → the user's local wall-clock time (12-hour, with the zone). */
export function localTime(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

const SESSION: Record<string, string> = { pre_market: "pre-market", regular: "open (regular session)", after_hours: "after hours", closed: "closed" };

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
  const session = SESSION[String(s.session)] ?? cell(s.session);
  const why = typeof s.reason === "string" && s.reason ? ` (${cell(s.reason).replace(/_/g, " ")}${typeof s.holidayName === "string" && s.holidayName ? `: ${cell(s.holidayName)}` : ""})` : "";
  say(ctx, `US stock market: ${session}${why}${s.earlyClose === true ? " — early close today" : ""}`);
  const line = (label: string, v: unknown) => { const t = localTime(v); if (t) say(ctx, `${label}: ${t}`); };
  line("Session changes", s.sessionEndsAt);
  line("Next open", s.nextOpenAt);
  line("Next close", s.nextCloseAt);
  const a = (s.agentStockOrders ?? {}) as Record<string, unknown>;
  if (a.accepted === true) say(ctx, `Darwin agent stock orders: accepted${localTime(a.closesAt) ? ` until ${localTime(a.closesAt)}` : ""}`);
  else if (a.accepted === false) say(ctx, `Darwin agent stock orders: not accepted now${localTime(a.opensAt) ? `; next accepted ${localTime(a.opensAt)}` : ""}`);
  say(ctx, "Tokenized stocks trade 24/7, but liquidity is much lower when the US market is closed.");
  return EXIT.ok;
}
