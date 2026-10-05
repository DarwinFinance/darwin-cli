/**
 * `darwin mcp` (plan §6, lean v1): a local stdio MCP server for an agent API key. `tools/list` is the
 * catalogue's tools verbatim (+ an `agent` argument for a key that trades for all agents);
 * `tools/call` goes through the same `POST /api/agent/v1/tools/call/{name}` as every command — no
 * local tool logic, so there is no second tool set. The host's own tool-approval prompt is the
 * confirmation; a write is never retried; an uncertain write tells the model to check, not re-issue.
 *
 * `--print-config <client>` prints a registration that points at THIS installed copy by absolute
 * path (never npx) — and refuses to run from npx or a project's node_modules (C.55).
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { one, onlyFlags, type Parsed } from "./args.js";
import { copy } from "./copy.js";
import { loadCatalogue, type Catalogue, type CatalogueTool } from "./catalogue.js";
import { installProblem, isGlobalInstall } from "./guard.js";
import { loadConfig } from "./config.js";
import { openSession, profileName, type Session } from "./session.js";
import { callTool } from "./tool.js";
import { isPreparedWrite, preparedRead, recoveryFlags, runPrepared } from "./prepared.js";
import { recoveryAgent, resolveAgent } from "./agents.js";
import { looksSecret, scrubDeep } from "./redact.js";
import { warn } from "./output.js";
import { VERSION } from "./version.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function printConfig(ctx: Ctx, client: string, profile: string): string {
  if (installProblem(ctx) || !isGlobalInstall(ctx.scriptPath)) throw new CliError(EXIT.usage, copy.printConfigNpx, "install_first");
  const args = [ctx.scriptPath, "mcp", "--profile", profile];
  if (client === "claude") return `claude mcp add darwin -- ${[ctx.execPath, ...args].map(shq).join(" ")}\n`;
  if (client === "cursor" || client === "gemini") return `${JSON.stringify({ mcpServers: { darwin: { command: ctx.execPath, args } } }, null, 2)}\n`;
  throw new CliError(EXIT.usage, "--print-config takes claude, cursor or gemini.", "usage");
}

/** The two local tools for prepared writes (R16-2): a READ-ONLY check, and a separate write-annotated cancel. */
export const PREPARED_TOOL_DEFS = [
  {
    name: "check_prepared", title: "What happened to a write",
    description: "READ-ONLY. What happened to a write whose result was uncertain, by the preparedId the write returned: it went through, is still pending, failed, or was never sent. Never sends anything; call it instead of repeating a write.",
    inputSchema: { type: "object", properties: { preparedId: { type: "string", pattern: "^prp_[0-9A-Za-z]{24}$" } }, required: ["preparedId"], additionalProperties: false },
    annotations: { title: "What happened to a write", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "cancel_prepared", title: "Make sure a write never runs",
    description: "Make sure a prepared write that has not started never runs (by its preparedId). A write that already started can't be cancelled; the answer says what happened instead.",
    inputSchema: { type: "object", properties: { preparedId: { type: "string", pattern: "^prp_[0-9A-Za-z]{24}$" } }, required: ["preparedId"], additionalProperties: false },
    annotations: { title: "Make sure a write never runs", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

export function toolDefs(c: Catalogue): Array<Record<string, unknown>> {
  return [...catalogueToolDefs(c), ...PREPARED_TOOL_DEFS.map((d) => ({
    ...d, inputSchema: c.globals.agentParam ? { ...d.inputSchema, properties: { ...d.inputSchema.properties, agent: AGENT_PROP } } : d.inputSchema,
  }))];
}

function catalogueToolDefs(c: Catalogue): Array<Record<string, unknown>> {
  return c.tools.map((t) => {
    // Verbatim, except the `agent` argument a key for all agents needs (added to a CLONE).
    let schema: Record<string, unknown> = t.inputSchema;
    if (c.globals.agentParam && t.name !== "list_agents") {
      schema = { ...t.inputSchema, properties: { ...(t.inputSchema.properties ?? {}), agent: AGENT_PROP } };
    }
    return { name: t.name, title: t.title, description: t.description, inputSchema: schema, annotations: t.annotations };
  });
}

const AGENT_PROP = { type: "string", minLength: 1, maxLength: 120, description: "Which of your agents to act on: its id from list_agents (preferred) or its exact name. Optional when the profile has a default agent." };

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export async function cmdMcp(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", "print-config", "help"], "mcp");
  const client = one(p, "print-config");
  if (client !== undefined) {
    if (installProblem(ctx) || !isGlobalInstall(ctx.scriptPath)) throw new CliError(EXIT.usage, copy.printConfigNpx, "install_first");
    const prof = profileName(ctx, one(p, "profile")) ?? loadConfig(ctx).default;
    if (!prof) throw new CliError(EXIT.auth, "Log in first (`darwin login`), then print the config.", "no_key");
    ctx.io.stdout(printConfig(ctx, client, prof));
    return EXIT.ok;
  }
  // 🔴 stdout carries JSON-RPC only: a startup failure is reported on stderr, never stdout.
  let session: Session;
  try {
    session = openSession(ctx, { profile: one(p, "profile") });
  } catch (e) {
    if (e instanceof CliError) {
      const auth = e.code === "mcp_page_key" || e.code === "no_key" || e.code === "not_a_key";
      warn(ctx, auth ? copy.mcpNeedsKey : e.message);
      return auth ? EXIT.auth : e.exit;
    }
    throw e;
  }
  let catalogue = (await loadCatalogue(ctx, session.realm, session.kind, { key: session.key, refresh: "if-stale" })).catalogue;
  // Every message is scrubbed at the output boundary (no key, whatever was echoed).
  const write = (m: unknown) => ctx.io.stdout(`${JSON.stringify(scrubDeep(m))}\n`);
  const reply = (id: Msg["id"], result: unknown) => write({ jsonrpc: "2.0", id: id ?? null, result });
  const fail = (id: Msg["id"], code: number, message: string) => write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const refresh = async () => {
    const next = (await loadCatalogue(ctx, session.realm, session.kind, { key: session.key, refresh: "force" })).catalogue;
    if (next.catalogVersion !== catalogue.catalogVersion) {
      catalogue = next;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  };
  for await (const line of ctx.io.stdinLines()) {
    if (!line.trim()) continue;
    let m: Msg;
    try { m = JSON.parse(line) as Msg; } catch { fail(null, -32700, "Parse error"); continue; }
    if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") { fail(null, -32600, "Invalid request"); continue; }
    if (m.id === undefined) continue; // a notification
    if ((typeof m.id !== "string" && typeof m.id !== "number") || (typeof m.id === "string" && (m.id.length > 200 || looksSecret(m.id)))) { fail(null, -32600, "Invalid request id"); continue; }
    if (m.params !== undefined && (m.params === null || typeof m.params !== "object" || Array.isArray(m.params))) { fail(m.id, -32602, "Invalid params"); continue; }
    try {
      switch (m.method) {
        case "initialize": {
          const asked = String(m.params?.protocolVersion ?? "");
          reply(m.id, {
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "darwin-cli", version: VERSION },
            instructions: catalogue.instructions,
          });
          break;
        }
        case "ping": reply(m.id, {}); break;
        case "tools/list": reply(m.id, { tools: toolDefs(catalogue) }); break;
        case "tools/call": reply(m.id, await mcpCall(ctx, session, catalogue, m.params ?? {}, refresh)); break;
        default: fail(m.id, -32601, "Method not found");
      }
    } catch (e) {
      const msg = e instanceof CliError ? e.message : "Internal error";
      reply(m.id, toolResult({ error: e instanceof CliError ? e.code : "internal_error", detail: msg }, true));
    }
  }
  return EXIT.ok;
}

function toolResult(value: unknown, isError: boolean): Record<string, unknown> {
  const v = scrubDeep(value);
  return { content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v, isError };
}

export async function mcpCall(ctx: Ctx, session: Session, catalogue: Catalogue, params: Record<string, unknown>, refresh: () => Promise<void>): Promise<Record<string, unknown>> {
  if (params.name === "check_prepared" || params.name === "cancel_prepared") {
    const raw = (params.arguments ?? {}) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.preparedId !== "string") return toolResult({ error: "invalid_arguments", detail: "preparedId is required." }, true);
    let agentArg: string | undefined;
    if (raw.agent !== undefined) {
      if (typeof raw.agent !== "string" || !raw.agent.trim()) return toolResult({ error: "invalid_arguments", detail: "`agent` must be an agent id or name." }, true);
      agentArg = raw.agent.trim();
    }
    const agentId = await recoveryAgent(ctx, session, agentArg);
    const r = await preparedRead({ ctx, session, agentId }, raw.preparedId, params.name === "cancel_prepared");
    return toolResult(r.body, !r.ok);
  }
  const tool: CatalogueTool | undefined = catalogue.tools.find((t) => t.name === params.name);
  if (!tool) return toolResult({ error: "unknown_tool", detail: "No such tool; list the tools again.", sent: false }, true);
  const raw = params.arguments;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return toolResult({ error: "invalid_arguments", detail: "Arguments must be an object.", sent: false }, true);
  const args: Record<string, unknown> = { ...((raw ?? {}) as Record<string, unknown>) };
  delete args._meta;
  // 🔴 An `agent` that is given must be a real choice: a wrong type or a blank is refused — never
  // silently replaced by the default agent.
  let agentArg: string | undefined;
  if (Object.hasOwn(args, "agent")) {
    const v = args.agent;
    if (typeof v !== "string" || !v.trim() || v.length > 120) return toolResult({ error: "invalid_arguments", detail: "`agent` must be an agent id or name.", sent: false }, true);
    agentArg = v.trim();
    delete args.agent;
  }
  const agentId = tool.name === "list_agents" ? null : await resolveAgent(ctx, session, agentArg);
  if (isPreparedWrite(tool)) {
    // v1.1: prepare → execute (never re-sent). An uncertain one points at check_prepared.
    const r = await runPrepared({ ctx, session, catalogue, tool, args, agentId, json: true, dryRun: false, quietForMcp: true, recovery: recoveryFlags(session, agentId) });
    if (r.kind === "done") {
      if (r.exit === EXIT.ok) return toolResult(r.doc, false);
      if (r.exit === EXIT.uncertain && r.preparedId) {
        return toolResult({ ...r.doc, error: "outcome_unknown", sent: "maybe", preparedId: r.preparedId,
          ...(agentId ? { agent: agentId } : {}),
          detail: `Darwin may have received this write, but its result didn't come back. Do NOT call this tool again — call check_prepared with preparedId "${r.preparedId}"${agentId ? ` and agent "${agentId}"` : ""} to see what happened.` }, true);
      }
      return toolResult(r.doc, true);
    }
  }
  const out = await callTool({ ctx, session, catalogue, tool, args, flags: { json: true, dryRun: false, quiet: true }, onStaleCatalogue: refresh }, agentId);
  const result = (out.body?.result ?? null) as Record<string, unknown> | null;
  if (out.exit === EXIT.uncertain) {
    return toolResult({ ...(result ?? {}), error: result?.error ?? "outcome_unknown", sent: "maybe", nonce: out.nonce, detail: "Darwin may have received this order, but the answer didn't arrive. Do NOT call this tool again — call list_spot_orders to see whether it went through." }, true);
  }
  if (!result) return toolResult({ error: out.body?.error ?? "failed", detail: out.message, ...(out.nonce ? { nonce: out.nonce } : {}) }, true);
  return toolResult({ ...result, ...(out.nonce ? { nonce: out.nonce } : {}) }, out.exit !== EXIT.ok);
}
