/** The small static commands: logout, whoami, doctor, profile, api, version. */
import { CliError, EXIT, type Ctx } from "./context.js";
import { has, one, onlyFlags, type Parsed } from "./args.js";
import { copy } from "./copy.js";
import { loadConfig, PROFILE_RE, updateConfig, type Profile } from "./config.js";
import { assertInstalled, installProblem } from "./guard.js";
import { mediaType, NetworkError, request } from "./http.js";
import { deleteKey, getKey, probeKeychain, putKey, storeLabel } from "./keystore.js";
import { printJson, say, warn, wantsJson } from "./output.js";
import { genericLines } from "./human.js";
import { columns } from "./render.js";
import { manageUrl } from "./realms.js";
import { clean } from "./redact.js";
import { openSession, profileName } from "./session.js";
import { readCache, snapshotFor, validateCatalogue } from "./catalogue.js";
import { listAgents } from "./agents.js";
import { VERSION } from "./version.js";

const OUT_FLAGS = ["json", "format", "quiet", "no-color", "help"];
const jsonOut = (ctx: Ctx, p: Parsed) => wantsJson(ctx, { json: has(p, "json"), format: one(p, "format") });
const unwrap = (v: unknown): string => (v && typeof v === "object" && "untrusted" in (v as object) ? String((v as { untrusted: unknown }).untrusted ?? "") : typeof v === "string" ? v : "");

// ─── logout ─────────────────────────────────────────────────────────────────

export async function cmdLogout(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", "all", "revoke", "force-local", ...OUT_FLAGS], "logout");
  assertInstalled(ctx);
  if (has(p, "all")) {
    if (has(p, "revoke")) throw new CliError(EXIT.usage, "--revoke works on one profile at a time.", "usage");
    let failed = 0;
    for (const [name, prof] of Object.entries(loadConfig(ctx).profiles)) failed += forgetProfile(ctx, name, prof) ? 0 : 1;
    return failed ? EXIT.unexpected : EXIT.ok;
  }
  const cfg = loadConfig(ctx);
  const name = profileName(ctx, one(p, "profile")) ?? cfg.default;
  const prof = name ? cfg.profiles[name] : undefined;
  if (!name || !prof) throw new CliError(EXIT.usage, "No profile to log out of. `darwin profile list` shows them.", "no_profile");
  const url = manageUrl(prof.realm, prof.agent_id);
  if (!has(p, "revoke")) {
    let key: string | null = null;
    try { key = getKey(ctx, prof.store, prof.realm, name); } catch { key = null; }
    return forgetProfile(ctx, name, prof, { expectedKey: key }) ? EXIT.ok : EXIT.unexpected;
  }
  const s = openSession(ctx, { profile: name });
  if (s.kind === "agents") warn(ctx, copy.revokeAllWarning);
  // The key's NAME for the message, read while the key still works.
  let keyName = "this API key";
  try {
    const w = await request(ctx, s.realm, "GET", "/api/agent/v1/tools/whoami", { key: s.key, timeoutMs: 15_000 });
    const n = (w.json as { name?: unknown } | null)?.name;
    if (w.status === 200 && typeof n === "string" && n) keyName = clean(n).slice(0, 120);
  } catch { /* the name is a nicety */ }
  let confirmed = false;
  let networkFailed = false;
  try {
    const res = await request(ctx, s.realm, "POST", "/api/agent/v1/key/revoke", { key: s.key, body: {}, timeoutMs: 20_000 });
    const j = res.json as Record<string, unknown> | null;
    // 🔴 ONE exact answer counts (plan §3.5): anything else is "not confirmed" and the key stays.
    confirmed = res.status === 200 && mediaType(res.contentType) === "application/json" && !!j && j.revoked === true
      && typeof j.keyId === "string" && typeof j.changed === "boolean" && Object.keys(j).length === 3;
  } catch (e) {
    if (!(e instanceof NetworkError) && !(e instanceof CliError)) throw e;
    networkFailed = e instanceof NetworkError;
  }
  const agent = prof.agent_name || prof.agent_id;
  if (confirmed) {
    if (!forgetProfile(ctx, name, prof, { expectedKey: s.key, quiet: true })) return EXIT.unexpected;
    say(ctx, copy.revoked(keyName, agent));
    return EXIT.ok;
  }
  // The plan's one exception (§3.5): on a NETWORK failure, --force-local removes the local copy anyway
  // — and says plainly that the key still works until it is revoked.
  if (networkFailed && has(p, "force-local")) {
    forgetProfile(ctx, name, prof, { expectedKey: s.key, quiet: true });
    warn(ctx, copy.revokeNotConfirmed(agent, url).replace(" and it's still saved here", ""));
    return EXIT.refused;
  }
  warn(ctx, copy.revokeNotConfirmed(agent, url));
  return EXIT.refused;
}

/**
 * Remove a profile's key and then its profile, under the config lock and against the LATEST state:
 * if the profile was replaced meanwhile (another login), or holds a different key than the one this
 * command acted on, it is left alone. The profile stays if its key would be left behind.
 */
function forgetProfile(ctx: Ctx, name: string, prof: Profile, opts: { expectedKey?: string | null; quiet?: boolean } = {}): boolean {
  const outcome = updateConfig(ctx, (c) => {
    const now = c.profiles[name];
    if (!now || now.realm !== prof.realm || now.store !== prof.store || now.agent_id !== prof.agent_id) return "changed" as const;
    if (opts.expectedKey !== undefined) {
      let current: string | null;
      try { current = getKey(ctx, now.store, now.realm, name); } catch { return "unreadable" as const; }
      if (current !== null && current !== opts.expectedKey) return "changed" as const;
    }
    if (!deleteKey(ctx, now.store, now.realm, name)) return "stuck" as const;
    delete c.profiles[name];
    if (c.default === name) c.default = Object.keys(c.profiles)[0] ?? "";
    return "ok" as const;
  });
  if (outcome === "changed") { warn(ctx, `Profile "${name}" changed while this ran (another login?), so it was left as it is.`); return false; }
  if (outcome !== "ok") {
    warn(ctx, `Couldn't remove the API key for "${name}" from ${prof.store === "keychain" ? ctx.keychain.description : "its file"}, so the profile was kept. Unlock it and try again.`);
    return false;
  }
  if (!opts.quiet) say(ctx, copy.loggedOut(name, manageUrl(prof.realm, prof.agent_id)));
  return true;
}

// ─── whoami ─────────────────────────────────────────────────────────────────

export async function cmdWhoami(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", ...OUT_FLAGS], "whoami");
  const s = openSession(ctx, { profile: one(p, "profile") });
  let who: Record<string, unknown> | null = null;
  let note: string | null = null;
  let exit: number = EXIT.ok;
  try {
    const res = await request(ctx, s.realm, "GET", "/api/agent/v1/tools/whoami", { key: s.key, timeoutMs: 15_000 });
    if (res.status === 200 && res.json && typeof res.json === "object") who = res.json as Record<string, unknown>;
    else if (res.status === 401) { note = "Darwin refused this API key — it may have been revoked."; exit = EXIT.auth; }
    else if (res.status === 429) { note = "Too many requests with this API key right now."; exit = EXIT.rateLimited; }
    else if (res.status === 426) { note = copy.updateRequired(typeof (res.json as { minCli?: unknown } | null)?.minCli === "string" ? String((res.json as { minCli: string }).minCli) : "the latest version"); exit = EXIT.upgrade; }
    else if (res.status === 404) { /* an older server without whoami — "name unavailable", not a failure */ }
    else if (res.status === 403) { note = "Darwin refused this request."; exit = EXIT.refused; }
    else { note = `Darwin answered HTTP ${res.status}.`; exit = EXIT.unexpected; }
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    note = e.message;
    exit = EXIT.network;
  }
  const keyName = who && typeof who.name === "string" ? clean(who.name) : "name unavailable";
  const agent = clean(unwrap(who?.homeAgentName) || s.profile?.agent_name || s.profile?.agent_id || "unknown agent");
  const permissions = s.kind === "agents" ? "Read: all agents · Trade: all active agents" : "Read: this agent · Trade: this agent";
  const store = s.profile ? storeLabel(ctx, s.profile.store, s.realm, s.profileName) : "DARWIN_API_KEY (environment)";
  if (jsonOut(ctx, p)) printJson(ctx, { profile: s.profileName, realm: s.realm, kind: s.kind, agent, agentId: (who?.homeAgentId as string) ?? s.profile?.agent_id ?? null, permissions, keyName: who?.name ?? null, store: s.profile?.store ?? "env", ...(note ? { note } : {}) });
  else say(ctx, copy.whoami(s.profileName, s.realm, agent, permissions, keyName, store));
  if (note) warn(ctx, note);
  if (s.profile?.store === "file") warn(ctx, `Reminder: this API key is in a plain file (${storeLabel(ctx, "file", s.realm, s.profileName).slice(8, -1)}).`);
  return exit;
}

// ─── doctor ─────────────────────────────────────────────────────────────────

const DOCTOR_LABEL: Record<string, string> = {
  version: "Darwin CLI", node: "Node", platform: "Platform", install: "Install", secretStore: "Secret store", config: "Config",
  profiles: "Profiles", defaultProfile: "Default profile", key: "API key", catalogue: "Command list",
};

export async function cmdDoctor(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", ...OUT_FLAGS], "doctor");
  const checks: Record<string, unknown> = { version: VERSION, node: process.version, platform: `${ctx.platform}-${process.arch}` };
  const problem = installProblem(ctx);
  checks.install = problem === null ? "ok" : problem === "runner" ? "running through npx / a package runner — saved keys are not used" : "running from a project's node_modules — saved keys are not used";
  // 🔴 From npx / a project's node_modules, doctor touches neither the keychain nor the profiles.
  if (problem === null) checks.secretStore = probeKeychain(ctx) ? `ok (${ctx.keychain.description})` : `unavailable (${ctx.keychain.description}) — use DARWIN_API_KEY or --store file`;
  const cfg = problem !== null ? null : (() => { try { return loadConfig(ctx); } catch (e) { return e as Error; } })();
  if (cfg instanceof Error) checks.config = cfg.message;
  else if (cfg) {
    checks.profiles = Object.keys(cfg.profiles).length;
    checks.defaultProfile = cfg.default || null;
    const prof = cfg.profiles[profileName(ctx, one(p, "profile")) ?? cfg.default];
    if (prof) {
      const name = profileName(ctx, one(p, "profile")) ?? cfg.default;
      let has = false;
      try { has = !!getKey(ctx, prof.store, prof.realm, name); } catch { has = false; }
      checks.key = has ? `present in ${storeLabel(ctx, prof.store, prof.realm, name)}` : "missing — run `darwin login`";
      const cached = readCache(ctx, prof.realm, prof.kind);
      checks.catalogue = cached ? `cached ${Math.round((ctx.now() - cached.fetchedAt) / 60000)} min ago (${cached.catalogue.tools.length} commands)` : `built-in snapshot (${snapshotFor(prof.kind).tools.length} commands)`;
    }
  }
  for (const realm of ["darwin.finance", "beta.darwin.finance"] as const) {
    try {
      const res = await request(ctx, realm, "GET", "/agents/cli/catalog.json", { timeoutMs: 10_000 });
      checks[realm] = res.status === 200 && validateCatalogue(res.json).length === 0 ? "reachable; CLI available" : res.status === 404 ? "reachable; the CLI isn't switched on there yet" : `reachable (HTTP ${res.status})`;
    } catch (e) {
      checks[realm] = e instanceof NetworkError || e instanceof CliError ? `unreachable (${e.message})` : "error";
    }
  }
  if (jsonOut(ctx, p)) printJson(ctx, checks);
  else {
    const width = Math.max(...Object.keys(checks).map((k) => (DOCTOR_LABEL[k] ?? k).length));
    for (const [k, v] of Object.entries(checks)) say(ctx, `${(DOCTOR_LABEL[k] ?? k).padEnd(width)}  ${v === null ? "none" : String(v)}`);
  }
  return EXIT.ok;
}

// ─── profile ────────────────────────────────────────────────────────────────

export async function cmdProfile(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", ...OUT_FLAGS], "profile");
  const [, sub, a, b] = p.positionals;
  assertInstalled(ctx);
  const cfg = loadConfig(ctx);
  const need = (n: string | undefined) => {
    if (!n || !cfg.profiles[n]) throw new CliError(EXIT.usage, `There's no profile "${n ?? ""}". \`darwin profile list\` shows them.`, "no_profile");
    return n;
  };
  switch (sub ?? "list") {
    case "list": {
      const rows = Object.entries(cfg.profiles).map(([name, x]) => ({ profile: name, default: name === cfg.default, realm: x.realm, kind: x.kind, agent: x.agent_name || x.agent_id, defaultAgent: x.default_agent || null, store: x.store }));
      if (jsonOut(ctx, p)) printJson(ctx, { profiles: rows });
      else if (rows.length === 0) say(ctx, "No profiles yet. Run `darwin login`.");
      else {
        const table = columns(["Profile", "Site", "Agent", "API key for", "Stored in"], rows.map((r) => [
          `${r.default ? "* " : "  "}${r.profile}`, r.realm, clean(r.agent).slice(0, 40),
          r.kind === "agents" ? `all agents${r.defaultAgent ? " (default set)" : ""}` : "this agent",
          r.store === "keychain" ? ctx.keychain.description : "a plain file",
        ]));
        for (const l of table) say(ctx, l);
        say(ctx, "* = the profile commands use. Change it: darwin profile use <name>");
      }
      return EXIT.ok;
    }
    case "use":
      need(a);
      updateConfig(ctx, (c) => { if (c.profiles[a!]) c.default = a!; });
      say(ctx, `Commands now use profile "${a}".`);
      return EXIT.ok;
    case "rename": {
      const from = need(a);
      if (!b || !PROFILE_RE.test(b) || cfg.profiles[b]) throw new CliError(EXIT.usage, "Give a new, unused profile name (a–z, 0–9, _ and -).", "usage");
      // Copy + commit under the lock, on the latest state.
      const moved = updateConfig(ctx, (c) => {
        const prof = c.profiles[from];
        if (!prof || c.profiles[b]) return null;
        const key = getKey(ctx, prof.store, prof.realm, from);
        if (!key) throw new CliError(EXIT.auth, `The API key for "${from}" is missing; log in again instead.`, "no_key");
        putKey(ctx, prof.store, prof.realm, b, key);
        c.profiles[b] = prof;
        delete c.profiles[from];
        if (c.default === from) c.default = b;
        return { prof, key };
      });
      if (!moved) throw new CliError(EXIT.usage, "The profiles changed while this ran; nothing was renamed.", "usage");
      // Then remove the old entry — only if no profile reclaimed that name and it still holds this key.
      const cleaned = updateConfig(ctx, (c) => {
        if (c.profiles[from]) return true;
        let cur: string | null;
        try { cur = getKey(ctx, moved.prof.store, moved.prof.realm, from); } catch { return false; }
        return cur === null || cur !== moved.key ? true : deleteKey(ctx, moved.prof.store, moved.prof.realm, from);
      });
      if (!cleaned) warn(ctx, `Renamed, but the old copy under "${from}" couldn't be removed from ${moved.prof.store === "keychain" ? ctx.keychain.description : "its file"}; remove it by hand.`);
      say(ctx, `Renamed profile "${from}" to "${b}".`);
      return EXIT.ok;
    }
    case "remove": {
      const n = need(a);
      return forgetProfile(ctx, n, cfg.profiles[n]!) ? EXIT.ok : EXIT.unexpected;
    }
    case "set-agent": {
      const s = openSession(ctx, { profile: one(p, "profile") });
      if (s.kind !== "agents" || !s.profile) throw new CliError(EXIT.usage, "Only a profile with an API key for all your agents has a default agent.", "usage");
      if (!a) throw new CliError(EXIT.usage, "Name the agent: `darwin profile set-agent <name or id>`.", "usage");
      const agents = await listAgents(ctx, s, { fresh: true });
      const hit = agents.find((x) => x.id === a) ?? (() => {
        const m = agents.filter((x) => x.name.toLowerCase() === a.toLowerCase());
        if (m.length > 1) throw new CliError(EXIT.usage, `More than one agent is called that; use its id: ${m.map((x) => x.id).join(", ")}`, "agent_ambiguous");
        return m[0];
      })();
      if (!hit) throw new CliError(EXIT.usage, "No active agent of yours matches that. Your agents: `darwin agents`.", "agent_not_found");
      updateConfig(ctx, (c) => { if (c.profiles[s.profileName]) c.profiles[s.profileName]!.default_agent = hit.id; });
      say(ctx, `Commands on "${s.profileName}" now act on ${clean(hit.name) || hit.id} unless you pass --agent.`);
      return EXIT.ok;
    }
    default:
      throw new CliError(EXIT.usage, "`darwin profile` takes list, use, rename, remove or set-agent.", "usage");
  }
}

// ─── api (GET only) ─────────────────────────────────────────────────────────

const API_PATH = /^\/api\/agent\/[A-Za-z0-9/_.~-]*(?:\?[A-Za-z0-9_.~%:,=&+-]*)?$/;

export async function cmdApi(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["profile", "agent", ...OUT_FLAGS], "api");
  const [, method, path] = p.positionals;
  if ((method ?? "").toUpperCase() !== "GET") throw new CliError(EXIT.usage, "`darwin api` only reads: `darwin api GET /api/agent/…`. Changes go through their own commands.", "usage");
  if (!path || !API_PATH.test(path) || path.includes("..") || p.positionals.length > 3) throw new CliError(EXIT.usage, "Give a path that starts with /api/agent/.", "usage");
  const s = openSession(ctx, { profile: one(p, "profile") });
  const { resolveAgent } = await import("./agents.js");
  const agent = path.startsWith("/api/agent/v1/agents") ? null : await resolveAgent(ctx, s, one(p, "agent"));
  let res;
  try {
    res = await request(ctx, s.realm, "GET", path, { key: s.key, agent: agent ?? undefined, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, e.message, "network_error");
    throw e;
  }
  const body = res.json ?? { status: res.status, contentType: res.contentType };
  if (jsonOut(ctx, p)) printJson(ctx, body);
  else for (const l of genericLines(body)) say(ctx, l);
  return res.status === 200 ? EXIT.ok : res.status === 401 ? EXIT.auth : res.status === 429 ? EXIT.rateLimited : EXIT.refused;
}
