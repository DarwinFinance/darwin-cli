/** The program: argv → one command → an exit code (plan §5.5). Pure apart from `ctx`. */
import { join } from "node:path";
import { BOOLEAN_FLAGS, has, one, parseArgs, type Parsed } from "./args.js";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { commandIndex, loadCatalogue, snapshotFor, STATIC_COMMANDS, type Catalogue, type CatalogueTool } from "./catalogue.js";
import { cmdApi, cmdDoctor, cmdLogout, cmdProfile, cmdWhoami } from "./commands.js";
import { cmdLogin } from "./login.js";
import { printCommandHelp, printOverview, printStaticHelp, STATIC_HELP } from "./help.js";
import { printJson, warn, wantsJson } from "./output.js";
import { openSession, type Session } from "./session.js";
import { buildArguments, runTool } from "./tool.js";
import { compareVersions, VERSION } from "./version.js";
import { readPrivate, writePrivate } from "./fsx.js";
import { installProblem } from "./guard.js";
import { scrub } from "./redact.js";

const GLOBALS = new Set(["json", "format", "profile", "agent", "dry-run", "quiet", "no-color", "help", "version"]);

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  let p: Parsed | null = null;
  try {
    p = parseArgs(argv, BOOLEAN_FLAGS);
    return await dispatch(p, ctx);
  } catch (e) {
    const json = p ? wantsJson(ctx, { json: has(p, "json"), format: p.flags.get("format")?.[0] }) : !ctx.io.isTTY.stdout;
    if (e instanceof CliError) {
      if (json) printJson(ctx, { error: e.code, detail: e.message, ...e.extra });
      warn(ctx, e.message);
      return e.exit;
    }
    warn(ctx, `Unexpected error: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    return EXIT.unexpected;
  }
}

async function dispatch(p: Parsed, ctx: Ctx): Promise<number> {
  const json = wantsJson(ctx, { json: has(p, "json"), format: one(p, "format") });
  const first = p.positionals[0];
  if (has(p, "version") && !first) { ctx.io.stdout(`${VERSION}\n`); return EXIT.ok; }
  if (first === "version") { ctx.io.stdout(`${VERSION}\n`); return EXIT.ok; }
  if (!first || first === "help") {
    const rest = p.positionals.slice(1);
    const c = await catalogueForHelp(ctx, p);
    if (rest.length === 0) { printOverview(ctx, c, json); return EXIT.ok; }
    if (STATIC_HELP[rest[0]!]) { printStaticHelp(ctx, rest[0]!, json); return EXIT.ok; }
    const t = resolve(c, rest)?.tool;
    if (!t) throw new CliError(EXIT.usage, `No command "${rest.join(" ").slice(0, 60)}". \`darwin help\` lists them.`, "unknown_command");
    printCommandHelp(ctx, t, json);
    return EXIT.ok;
  }
  if (STATIC_HELP[first] && has(p, "help")) { printStaticHelp(ctx, first, json); return EXIT.ok; }
  switch (first) {
    case "login": return cmdLogin(ctx, p);
    case "logout": return cmdLogout(ctx, p);
    case "whoami": return cmdWhoami(ctx, p);
    case "doctor": return cmdDoctor(ctx, p);
    case "profile": return cmdProfile(ctx, p);
    case "api": return cmdApi(ctx, p);
  }
  if (STATIC_COMMANDS.includes(first)) throw new CliError(EXIT.usage, `\`darwin ${first}\` isn't in this version of the Darwin CLI.`, "unknown_command");
  if (has(p, "help")) {
    const c = await catalogueForHelp(ctx, p);
    const t = resolve(c, p.positionals)?.tool;
    if (!t) throw new CliError(EXIT.usage, `No command "${p.positionals.join(" ").slice(0, 60)}". \`darwin help\` lists them.`, "unknown_command");
    printCommandHelp(ctx, t, json);
    return EXIT.ok;
  }
  return runCatalogueCommand(ctx, p, json);
}

/** Longest command path (3, 2, 1 words) that names a tool. */
export function resolve(c: Catalogue, words: string[]): { tool: CatalogueTool; rest: string[] } | null {
  const idx = commandIndex(c);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const t = idx.get(words.slice(0, n).join(" "));
    if (t) return { tool: t, rest: words.slice(n) };
  }
  return null;
}

async function catalogueForHelp(ctx: Ctx, p: Parsed): Promise<Catalogue> {
  // Help never needs a key: with a usable profile it shows that key's projection; otherwise the
  // public one. Through npx / a workspace copy, saved keys are not read at all.
  if (!installProblem(ctx)) {
    try {
      const s = openSession(ctx, { profile: one(p, "profile") });
      return (await loadCatalogue(ctx, s.realm, s.kind, { key: s.key, refresh: "if-stale" })).catalogue;
    } catch { /* no profile yet */ }
  }
  try {
    return (await loadCatalogue(ctx, "darwin.finance", "agent", { key: null, refresh: "if-stale" })).catalogue;
  } catch {
    return snapshotFor("agent");
  }
}

async function runCatalogueCommand(ctx: Ctx, p: Parsed, json: boolean): Promise<number> {
  const session: Session = openSession(ctx, { profile: one(p, "profile") });
  const dryRun = has(p, "dry-run");
  // --dry-run sends NOTHING — not even an authenticated catalogue fetch.
  let { catalogue } = await loadCatalogue(ctx, session.realm, session.kind, { key: session.key, refresh: dryRun ? "offline" : "never" });
  let hit = resolve(catalogue, p.positionals);
  if (!hit && !dryRun) {
    // One refresh before "unknown command" — the command may be newer than our cache (§2.2).
    catalogue = (await loadCatalogue(ctx, session.realm, session.kind, { key: session.key, refresh: "force" })).catalogue;
    hit = resolve(catalogue, p.positionals);
  }
  if (!hit) throw new CliError(EXIT.usage, `No command "${p.positionals.join(" ").slice(0, 60)}". \`darwin help\` lists them.`, "unknown_command");
  if (compareVersions(VERSION, catalogue.minCli) < 0) throw new CliError(EXIT.upgrade, copy.updateRequired(catalogue.minCli), "cli_upgrade_required");
  const args = buildArguments(hit.tool, hit.rest, p, GLOBALS);
  if (hit.tool.deprecated) warn(ctx, `\`darwin ${hit.tool.cli.path.join(" ")}\` is deprecated and goes away after ${hit.tool.deprecated.removeAfter}.`);
  const code = await runTool({
    ctx, session, catalogue, tool: hit.tool, args, json,
    flags: { json, dryRun, agent: one(p, "agent"), quiet: has(p, "quiet") },
    onStaleCatalogue: async () => { await loadCatalogue(ctx, session.realm, session.kind, { key: session.key, refresh: "force" }); },
    onUnknownTool: async () => { await loadCatalogue(ctx, session.realm, session.kind, { key: session.key, refresh: "force" }); },
  });
  updateNotice(ctx, catalogue);
  return code;
}

/** C.40 — at most daily, on an interactive stderr, never in CI or when switched off. */
export function updateNotice(ctx: Ctx, c: Catalogue): void {
  if (ctx.env.CI || ctx.env.DARWIN_NO_UPDATE_NOTIFIER === "1" || !ctx.io.isTTY.stderr) return;
  if (compareVersions(VERSION, c.latestCli) >= 0) return;
  const stamp = join(ctx.configDir, "cache", "update-notice");
  try {
    const last = Number(readPrivate(stamp, 64, { requirePrivateMode: false }) ?? "0");
    if (ctx.now() - last < 24 * 3600_000) return;
    writePrivate(stamp, String(ctx.now()));
  } catch { return; }
  warn(ctx, copy.updateAvailable(c.latestCli, VERSION));
}
