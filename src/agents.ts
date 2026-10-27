/**
 * Naming an agent (plan §3.4). An all-agents key names its agent on every command (`--agent`,
 * DARWIN_AGENT, or the profile's default); a name resolves through `GET /api/agent/v1/agents`
 * (cached 60 s) — exact id first, then an exact case-insensitive name, ambiguity refused with the
 * candidates. The header always carries the ID.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { readPrivate, writePrivate } from "./fsx.js";
import { NetworkError, request } from "./http.js";
import type { Session } from "./session.js";
import { isAgentId, type OwnerScope } from "./config.js";
import { clean } from "./redact.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AgentRow { id: string; name: string; solanaAddress?: string; status?: string }

const unwrap = (v: unknown): string => (v && typeof v === "object" && "untrusted" in (v as object) ? String((v as { untrusted: unknown }).untrusted) : typeof v === "string" ? v : "");

/** `GET /api/agent/v1/agents`: the agents this key may name, and Darwin's own words for what the key may do. */
export interface AgentsAnswer { agents: AgentRow[]; permissions: string }

export async function listAgents(ctx: Ctx, s: Session, opts: { fresh?: boolean } = {}): Promise<AgentRow[]> {
  return (await agentsAnswer(ctx, s, opts)).agents;
}

export async function agentsAnswer(ctx: Ctx, s: Session, opts: { fresh?: boolean } = {}): Promise<AgentsAnswer> {
  // Keyed by a hash of the KEY (not the profile name), so a different key never reuses another's list.
  const file = join(ctx.configDir, "cache", `agents-${s.realm}-${createHash("sha256").update(s.key).digest("hex").slice(0, 16)}.json`);
  if (!opts.fresh) {
    try {
      const t = readPrivate(file, 256 * 1024, { requirePrivateMode: false });
      if (t) {
        const c = JSON.parse(t) as { at: number; agents: AgentRow[]; permissions?: unknown };
        if (ctx.now() - c.at < 60_000 && Array.isArray(c.agents)) return { agents: c.agents, permissions: typeof c.permissions === "string" ? c.permissions : "" };
      }
    } catch { /* refetch */ }
  }
  let res;
  try {
    res = await request(ctx, s.realm, "GET", "/api/agent/v1/agents", { key: s.key, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, e.message, "network_error");
    throw e;
  }
  if (res.status === 401) throw new CliError(EXIT.auth, s.kind === "owner" ? copy.ownerKeyRefused : "Darwin refused this API key. It may have been revoked; run `darwin login` or ask the owner.", "unauthorized");
  if (res.status === 429) throw new CliError(EXIT.rateLimited, "Too many requests with this API key right now. Wait a minute and try again.", "rate_limited");
  const list = (res.json as { agents?: unknown } | null)?.agents;
  if (res.status !== 200 || !Array.isArray(list)) throw new CliError(EXIT.unexpected, `Couldn't list your agents (HTTP ${res.status}).`, "bad_response");
  const agents: AgentRow[] = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      id: String(a.id ?? ""), name: clean(unwrap(a.name)).slice(0, 120),
      // Only the shapes we expect are kept (and cached): a base58 address, a known status.
      solanaAddress: typeof a.solanaAddress === "string" && BASE58.test(a.solanaAddress) ? a.solanaAddress : undefined,
      status: a.status === "active" || a.status === "paused" ? a.status : undefined,
    }))
    .filter((a) => isAgentId(a.id));
  const p = unwrap((res.json as { permissions?: unknown }).permissions);
  const permissions = clean(p).slice(0, 200);
  try { writePrivate(file, JSON.stringify({ at: ctx.now(), agents, permissions })); } catch { /* cache only */ }
  return { agents, permissions };
}

/**
 * What an account-level key may trade, from Darwin's own permission line on `GET /agents` (the same
 * reading the Darwin skill uses). null = a line this CLI doesn't know (refuse to guess).
 */
export function ownerScopeFromPermissions(permissions: string): OwnerScope | null {
  if (permissions.endsWith(" · Trade: none")) return "none";
  if (permissions.endsWith(" · Trade: one agent")) return "agent";
  if (permissions.endsWith(" · Trade: all active agents")) return "all_active";
  return null;
}

/**
 * The agent an ACCOUNT-LEVEL key names (X-Darwin-Agent), or null to name none. `need`:
 *   - "required": an agent's own account (balances, orders, …) — a one-agent owner key may omit it
 *     (Darwin uses its one agent); any other owner key must name one;
 *   - "optional": `hello` / `darwin api` — named only when the user named one.
 * A name resolves through Darwin's list of the agents THIS key may name; Darwin re-checks every call.
 */
export async function resolveOwnerAgent(ctx: Ctx, s: Session, flag: string | undefined, need: "required" | "optional"): Promise<string | null> {
  const raw = (flag ?? ctx.env.DARWIN_AGENT ?? "").trim() || (s.profile?.default_agent ?? "");
  if (!raw) {
    if (need === "optional") return null;
    let scope = s.ownerScope;
    if (scope === null) scope = ownerScopeFromPermissions((await agentsAnswer(ctx, s)).permissions);
    if (scope === "agent") return null;
    throw new CliError(EXIT.usage, copy.needAgentOwner, "agent_required");
  }
  const agents = await listAgents(ctx, s);
  const byId = agents.find((a) => a.id === raw);
  if (byId) return byId.id;
  const byName = agents.filter((a) => a.name.trim().toLowerCase() === raw.toLowerCase());
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new CliError(EXIT.usage, `More than one of your agents is called that; pass its id with --agent: ${byName.map((a) => a.id).join(", ")}`, "agent_ambiguous", { candidates: byName });
  }
  throw new CliError(EXIT.usage, "No active agent this API key may name matches that (a paused, stopped or archived agent isn't listed). Your agents: `darwin agents`.", "agent_not_found", { candidates: agents.map((a) => ({ id: a.id, name: a.name })) });
}

/** The agent id to send as X-Darwin-Agent, or null for a one-agent key. */
export async function resolveAgent(ctx: Ctx, s: Session, flag: string | undefined): Promise<string | null> {
  if (s.kind === "owner") return resolveOwnerAgent(ctx, s, flag, "required");
  const raw = (flag ?? ctx.env.DARWIN_AGENT ?? "").trim();
  if (s.kind === "agent") {
    if (!raw) return null;
    // A one-agent key acts on its own agent only; --agent may name it, nothing else.
    if (s.profile && (raw === s.profile.agent_id || raw.toLowerCase() === s.profile.agent_name.toLowerCase())) return null;
    const own = await listAgents(ctx, s);
    if (own.some((a) => a.id === raw || a.name.toLowerCase() === raw.toLowerCase())) return null;
    throw new CliError(EXIT.usage, "This API key acts for one agent only; it can't act on that one.", "agent_not_permitted");
  }
  const want = raw || s.profile?.default_agent || "";
  if (!want) throw new CliError(EXIT.usage, copy.needAgent, "agent_required");
  const agents = await listAgents(ctx, s);
  const byId = agents.find((a) => a.id === want);
  if (byId) return byId.id;
  const byName = agents.filter((a) => a.name.trim().toLowerCase() === want.toLowerCase());
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new CliError(EXIT.usage, `More than one of your agents is called that; pass its id with --agent: ${byName.map((a) => a.id).join(", ")}`, "agent_ambiguous", { candidates: byName });
  }
  throw new CliError(EXIT.usage, "No active agent of yours matches that (a paused, stopped or archived agent isn't listed). Your agents: `darwin agents`.", "agent_not_found", { candidates: agents.map((a) => ({ id: a.id, name: a.name })) });
}

/**
 * The agent for a RECOVERY call (`darwin retry` / `darwin cancel`, MCP check_prepared /
 * cancel_prepared): an exact agent id is sent as it is — the agent may have been paused or stopped
 * since the order, and is then no longer listed, but its order can still be looked up (the server
 * authorizes it). A name still resolves as usual.
 */
export async function recoveryAgent(ctx: Ctx, s: Session, flag: string | undefined): Promise<string | null> {
  // The same precedence as resolveAgent: --agent, DARWIN_AGENT, the profile's default agent.
  const raw = ((flag ?? ctx.env.DARWIN_AGENT ?? "").trim() || (s.kind === "agents" ? s.profile?.default_agent ?? "" : "")).trim();
  try {
    return await resolveAgent(ctx, s, flag);
  } catch (e) {
    // Not listed any more, but an exact agent id (the one the recovery command printed): send it.
    if (s.kind === "agents" && e instanceof CliError && e.code === "agent_not_found" && /^agr_[A-Za-z0-9_-]{1,64}$/.test(raw) && isAgentId(raw)) return raw;
    throw e;
  }
}
