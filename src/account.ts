/**
 * `darwin account <what>` (1.3.0): the OWNER's whole-account reads, for an account-level key only —
 * portfolio, perps, earn, agents, watchlists, alerts. Each is ONE `POST /api/agent/v1/data/{tool}`
 * (owner.ts ACCOUNT_READS); watchlists and alerts always send `action: "list"`, the only action Darwin
 * runs there for a key. An agent's key can't read the owner's account, so it is refused locally.
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { has, one, onlyFlags, type Parsed } from "./args.js";
import { copy } from "./copy.js";
import { NetworkError, request } from "./http.js";
import { genericLines } from "./human.js";
import { printJson, say, wantsJson } from "./output.js";
import { ACCOUNT_READS, dataPath } from "./owner.js";
import { openSession } from "./session.js";

export const ACCOUNT_USAGE = `darwin account ${Object.keys(ACCOUNT_READS).join("|")} [--json]`;

export async function cmdAccount(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", "json", "format", "quiet", "no-color", "help"], "account");
  const what = p.positionals[1];
  const read = what !== undefined && Object.hasOwn(ACCOUNT_READS, what) ? ACCOUNT_READS[what]! : null;
  if (!read || p.positionals.length > 2) throw new CliError(EXIT.usage, `\`darwin account\` takes ${Object.keys(ACCOUNT_READS).join(", ")}.`, "usage");
  const s = openSession(ctx, { profile: one(p, "profile") });
  if (s.kind !== "owner") throw new CliError(EXIT.usage, copy.accountNeedsOwnerKey, "owner_key_required");
  const json = wantsJson(ctx, { json: has(p, "json"), format: one(p, "format") });
  let res;
  try {
    res = await request(ctx, s.realm, "POST", dataPath(read.tool), { key: s.key, body: read.body, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, `${e.message} Nothing was done; try again.`, "network_error");
    throw e;
  }
  if (res.status === 401) throw new CliError(EXIT.auth, `${copy.ownerKeyRefused} Nothing was done.`, "unauthorized");
  if (res.status === 429) throw new CliError(EXIT.rateLimited, "Too many requests with this API key right now. Wait a minute and try again.", "rate_limited");
  if (res.status !== 200 || res.json === null) {
    const detail = (res.json as { error?: unknown } | null)?.error;
    throw new CliError(res.status >= 500 ? EXIT.unexpected : EXIT.refused, `Darwin couldn't answer that (${typeof detail === "string" && /^[a-z_]{1,40}$/.test(detail) ? detail.replace(/_/g, " ") : `HTTP ${res.status}`}). Nothing was done.`, "refused");
  }
  if (json) printJson(ctx, { status: 200, data: res.json });
  else {
    say(ctx, `${read.title} (${s.realm})`);
    const lines = genericLines(res.json);
    for (const l of lines.length ? lines : ["Nothing to show."]) say(ctx, l);
  }
  return EXIT.ok;
}
