/** `darwin help` — generated from the catalogue plus the static commands' own table. */
import type { Ctx } from "./context.js";
import type { Catalogue, CatalogueTool } from "./catalogue.js";
import { clean } from "./redact.js";
import { printJson, say } from "./output.js";
import { VERSION } from "./version.js";
import { INSTALL_LINE } from "./copy.js";
import { MARKET_STATUS_HELP, MARKET_STATUS_TOOL } from "./market.js";

/** Local help lines that replace a catalogue description (C.72: market-status needs no key). */
const LOCAL_DESCRIPTION: Record<string, string> = { [MARKET_STATUS_TOOL]: MARKET_STATUS_HELP };
const describe = (t: CatalogueTool) => LOCAL_DESCRIPTION[t.name] ?? clean(t.description);

export interface StaticHelp { usage: string; summary: string; flags: Record<string, string> }

export const STATIC_HELP: Record<string, StaticHelp> = {
  login: {
    usage: "darwin login [--beta] [--client-name <name>] [--reconnect] [--start | --wait | --with-key | --key-file <file> | --from-skill] [--profile <name>] [--store keychain|file]",
    summary: "Connect this terminal to a Darwin agent and keep its API key in your system's secret store.",
    flags: {
      beta: "Use beta.darwin.finance instead of darwin.finance.",
      "client-name": "What Darwin shows your owner as the app asking (never \"Darwin\"). Default: the coding agent you're in, else \"Command line\".",
      reconnect: "Get a new API key for an agent you already have, instead of creating a new agent.",
      start: "Start pairing and print the link and code, then exit (for tools whose calls time out).",
      wait: "Wait for a pairing started with --start, and save the key.",
      "with-key": "Import an API key from stdin, or paste it at a hidden prompt.",
      "key-file": "Import the key file downloaded from the agent's Manage tab (add --delete-file to delete it after).",
      "from-skill": "Import the key the official Darwin skill (darwin.py) saved (add --delete-skill-copy to remove its copy).",
      "agent-id": "With --from-skill: which saved key, when there are several.",
      profile: "Profile name for this key (default: from the agent's name).",
      store: "keychain (default) or file — a plain file only your user can read.",
      "no-browser": "Don't open the link in a browser.",
    },
  },
  logout: {
    usage: "darwin logout [--profile <name> | --all] [--revoke [--force-local]]",
    summary: "Remove the API key from this computer. With --revoke, Darwin revokes the key first.",
    flags: { revoke: "Ask Darwin to revoke this key everywhere, then remove it here.", all: "Every profile.", "force-local": "With --revoke: remove the local copy even if Darwin couldn't be reached." },
  },
  whoami: { usage: "darwin whoami [--profile <name>]", summary: "Which agent, site and API key this terminal uses (never any key characters).", flags: {} },
  profile: {
    usage: "darwin profile list | use <name> | rename <old> <new> | remove <name> | set-agent <name or id>",
    summary: "Manage profiles (one per API key). set-agent: the default agent for a key that trades for all your agents.",
    flags: {},
  },
  doctor: { usage: "darwin doctor", summary: "Check the install, the secret store, your profile and both Darwin sites.", flags: {} },
  api: { usage: "darwin api GET /api/agent/<path>", summary: "Read any agent API endpoint directly (GET only).", flags: {} },
  mcp: {
    usage: "darwin mcp [--profile <name>] | darwin mcp --print-config claude|cursor|gemini",
    summary: "Run Darwin as a local MCP server (stdio) for a desktop AI client, with the API key kept in your secret store.",
    flags: { "print-config": "Print the registration for a client, pointing at this installed copy." },
  },
  help: { usage: "darwin help [command] [--json]", summary: "This help. --json lists every command with its flags.", flags: {} },
  version: { usage: "darwin version", summary: "Print the Darwin CLI version.", flags: {} },
};

export const GLOBAL_HELP: Record<string, string> = {
  json: "Print JSON (the default when output isn't a terminal).",
  profile: "Use this profile.",
  agent: "For an API key that trades for all your agents: which agent (name or id).",
  "dry-run": "Show what a command would send, and send nothing.",
  field: "For API fields without their own flag: --field name=value (repeatable).",
  quiet: "Less output.",
};

/** The flags of one catalogue command, with their help. */
export function toolFlags(t: CatalogueTool): Array<{ flag: string; property: string; required: boolean; type: string; description: string }> {
  const req = new Set((t.inputSchema.required ?? []).filter((r) => r !== t.idempotency?.field));
  return Object.entries(t.cli.args).map(([prop, a]) => {
    const p = t.inputSchema.properties?.[prop] ?? {};
    const type = Array.isArray(p.type) ? p.type.join("|") : (p.type ?? "string");
    return { flag: `--${a.flag}`, property: prop, required: req.has(prop), type, description: clean(p.description ?? "") };
  });
}

export function usageOf(t: CatalogueTool): string {
  const pos = t.cli.positional.map((x) => `<${x}>`);
  const flags = toolFlags(t).map((f) => (f.required ? `${f.flag} <${f.property}>` : `[${f.flag} <${f.property}>]`));
  const open = t.inputSchema.additionalProperties !== false && t.inputSchema.additionalProperties !== undefined;
  return ["darwin", ...t.cli.path, ...pos, ...flags, ...(open ? ["[--field name=value]"] : [])].join(" ");
}

export function helpJson(c: Catalogue): unknown {
  return {
    version: VERSION, realm: c.realm, credential: c.credential, catalogVersion: c.catalogVersion,
    static: Object.entries(STATIC_HELP).map(([command, h]) => ({ command, usage: h.usage, summary: h.summary, flags: h.flags })),
    globalFlags: GLOBAL_HELP,
    commands: c.tools.map((t) => ({
      command: t.cli.path.join(" "), aliases: t.cli.aliases.map((a) => a.join(" ")), tool: t.name, title: clean(t.title),
      write: t.write, costsTx: t.costsTx, usage: usageOf(t), positional: t.cli.positional, flags: toolFlags(t),
      description: describe(t), ...(t.deprecated ? { deprecated: t.deprecated } : {}),
    })),
  };
}

export function printOverview(ctx: Ctx, c: Catalogue, json: boolean): void {
  if (json) { printJson(ctx, helpJson(c)); return; }
  say(ctx, `Darwin CLI ${VERSION} — trade and check your Darwin agent from a terminal.`);
  say(ctx, "");
  say(ctx, "Darwin commands (from Darwin's catalogue; W = changes something):");
  const width = Math.max(...c.tools.map((t) => t.cli.path.join(" ").length)) + 2;
  for (const t of c.tools) say(ctx, `  ${t.cli.path.join(" ").padEnd(width)}${t.write ? "W " : "  "}${clean(t.title)}`);
  say(ctx, "");
  say(ctx, "This CLI's own commands:");
  for (const [k, h] of Object.entries(STATIC_HELP)) say(ctx, `  ${k.padEnd(width)}  ${h.summary}`);
  say(ctx, "");
  say(ctx, "Global flags: --json  --profile <name>  --agent <name or id>  --dry-run  --field name=value");
  say(ctx, "`darwin <command> --help` for a command's flags; `darwin help --json` for all of it.");
  say(ctx, "");
  for (const l of clean(c.instructions).split("\n")) say(ctx, l);
}

export function printCommandHelp(ctx: Ctx, t: CatalogueTool, json: boolean): void {
  if (json) { printJson(ctx, (helpJson({ tools: [t] } as unknown as Catalogue) as { commands: unknown[] }).commands[0]); return; }
  say(ctx, `${usageOf(t)}`);
  say(ctx, "");
  say(ctx, `${clean(t.title)}${t.write ? " — changes something" : ""}${t.costsTx ? "; counts against today's transaction budget" : ""}.`);
  say(ctx, describe(t));
  const flags = toolFlags(t);
  if (flags.length || t.cli.positional.length) say(ctx, "");
  for (const p of t.cli.positional) say(ctx, `  <${p}>  ${clean(t.inputSchema.properties?.[p]?.description ?? "")}`);
  for (const f of flags) say(ctx, `  ${f.flag} <${f.type}>${f.required ? " (required)" : ""}  ${f.description}`);
  if (t.write) say(ctx, "\nThere is no confirmation prompt: the command runs when you press enter. Use --dry-run to see what it would send.");
  if (t.deprecated) say(ctx, `\nDeprecated since ${t.deprecated.since}; removed after ${t.deprecated.removeAfter}.`);
}

export function printStaticHelp(ctx: Ctx, name: string, json: boolean): void {
  const h = STATIC_HELP[name]!;
  if (json) { printJson(ctx, { command: name, ...h }); return; }
  say(ctx, h.usage);
  say(ctx, "");
  say(ctx, h.summary);
  for (const [f, d] of Object.entries(h.flags)) say(ctx, `  --${f}  ${d}`);
}

export const INSTALL_HINT = INSTALL_LINE;
