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
import { isAgentId } from "./config.js";
import { clean } from "./redact.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AgentRow { id: string; name: string; solanaAddress?: string; status?: string }

const unwrap = (v: unknown): string => (v && typeof v === "object" && "untrusted" in (v as object) ? String((v as { untrusted: unknown }).untrusted) : typeof v === "string" ? v : "");

export async function listAgents(ctx: Ctx, s: Session, opts: { fresh?: boolean } = {}): Promise<AgentRow[]> {
  // Keyed by a hash of the KEY (not the profile name), so a different key never reuses another's list.
  const file = join(ctx.configDir, "cache", `agents-${s.realm}-${createHash("sha256").update(s.key).digest("hex").slice(0, 16)}.json`);
  if (!opts.fresh) {
    try {
      const t = readPrivate(file, 256 * 1024, { requirePrivateMode: false });
      if (t) {
        const c = JSON.parse(t) as { at: number; agents: AgentRow[] };
        if (ctx.now() - c.at < 60_000 && Array.isArray(c.agents)) return c.agents;
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
  if (res.status === 401) throw new CliError(EXIT.auth, "Darwin refused this API key. It may have been revoked; run `darwin login` or ask the owner.", "unauthorized");
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
  try { writePrivate(file, JSON.stringify({ at: ctx.now(), agents })); } catch { /* cache only */ }
  return agents;
}

/** The agent id to send as X-Darwin-Agent, or null for a one-agent key. */
export async function resolveAgent(ctx: Ctx, s: Session, flag: string | undefined): Promise<string | null> {
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
