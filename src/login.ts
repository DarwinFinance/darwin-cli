/**
 * `darwin login` (plan §3.1–3.2, §0A Q10b). Every path ends in ONE place — saveKey — and every path
 * proves the key works with Darwin (whoami) or got it from Darwin itself (pairing) before saving.
 *
 *   (pairing)         RFC 8628 device flow; creates a new agent (or `--reconnect`: a new key for one
 *                     the owner already has). The secret store is checked BEFORE the code is asked
 *                     for — Darwin shows a key only once.
 *   --start / --wait  the same, split for harnesses whose tool calls time out.
 *   --with-key        an existing key from stdin or a hidden prompt — never from argv.
 *   --key-file <f>    the Manage tab's key file; its realm must match.
 *   --from-skill      the key the official skill's darwin.py saved (skill.ts).
 */
import { linkSync, lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CliError, EXIT, type Ctx } from "./context.js";
import { has, one, onlyFlags, type Parsed } from "./args.js";
import { copy } from "./copy.js";
import { isAgentId, loadConfig, type StoreKind } from "./config.js";
import { assertInstalled } from "./guard.js";
import { NetworkError, request } from "./http.js";
import { acceptKey, credentialFile, probeFileStore, probeKeychain, SERVICE, type KeyKind } from "./keystore.js";
import { printJson, say, warn, wantsJson } from "./output.js";
import { chooseProfileName, connectedLine, lostKeyLine, saveKey, type NewKey } from "./profiles.js";
import { manageUrl, parseRealm, type Realm } from "./realms.js";
import { clean, rememberSecret } from "./redact.js";
import { profileName } from "./session.js";
import { importFromSkill } from "./skill.js";
import { readPrivate, removeQuietly, writePrivate } from "./fsx.js";

const DEVICE_CODE_RE = /^darwinAI_pair_[A-Za-z0-9_-]{40,114}$/;
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const CLIENT_NAME_ALLOWED = /^[A-Za-z0-9 .\-_()'+/:#@,]+$/;
const MAX_WAIT_S = 25 * 60;

const LOGIN_FLAGS = ["beta", "prod", "profile", "store", "client-name", "reconnect", "start", "wait", "with-key", "key-file", "delete-file",
  "from-skill", "agent-id", "delete-skill-copy", "no-browser", "json", "format", "quiet", "no-color", "help"];

/** The server's own brand-skeleton rule, mirrored: a client name never claims to be Darwin. */
export function brandSkeleton(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[l1|!]/g, "i").replace(/[^a-z]/g, "");
}

export function validClientName(raw: string): string {
  const cleaned = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const capped = Array.from(cleaned).slice(0, 60).join("").trim();
  if (!capped || !CLIENT_NAME_ALLOWED.test(capped.normalize("NFKD").replace(/[̀-ͯ]/g, ""))) {
    throw new CliError(EXIT.usage, "--client-name may use letters, digits, spaces and . - _ ( ) ' + / : # @ , (up to 60).", "usage");
  }
  if (brandSkeleton(capped).includes("darwin")) throw new CliError(EXIT.usage, "--client-name can't contain \"Darwin\" — name the app or agent you are (e.g. \"Claude Code\").", "usage");
  return capped;
}

/** The coding agent we're running inside, by its environment — never a Darwin name. */
export function detectClientName(env: Ctx["env"]): string {
  if (env.CLAUDECODE) return "Claude Code";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return "Codex";
  if (Object.keys(env).some((k) => k.startsWith("CURSOR_"))) return "Cursor";
  if (env.GEMINI_CLI) return "Gemini CLI";
  if (env.OPENCLAW || env.OPENCLAW_HOME) return "OpenClaw";
  return "Command line";
}

function targetRealm(ctx: Ctx, p: Parsed): Realm | null {
  if (has(p, "beta") && has(p, "prod")) throw new CliError(EXIT.usage, "Pass --beta or --prod, not both.", "usage");
  if (has(p, "beta")) return "beta.darwin.finance";
  if (has(p, "prod")) return "darwin.finance";
  const env = ctx.env.DARWIN_REALM;
  if (env) {
    const r = parseRealm(env);
    if (!r) throw new CliError(EXIT.usage, "DARWIN_REALM must be prod or beta.", "usage");
    return r;
  }
  return null;
}

function chooseStore(ctx: Ctx, p: Parsed): StoreKind {
  const s = one(p, "store");
  if (s !== undefined && s !== "keychain" && s !== "file") throw new CliError(EXIT.usage, "--store is keychain or file.", "usage");
  if (s === "file") {
    // Probed like the keychain, BEFORE any pairing: Darwin shows a key only once.
    if (!probeFileStore(ctx)) throw new CliError(EXIT.auth, `Nothing was started: the Darwin CLI can't keep a private file in ${join(ctx.configDir, "credentials")} (it must be yours and chmod 700).`, "no_secret_store");
    warn(ctx, copy.fileStoreWarning(join(ctx.configDir, "credentials", "<realm>__<profile>")));
    return "file";
  }
  if (!probeKeychain(ctx)) throw new CliError(EXIT.auth, copy.noSecretStore, "no_secret_store");
  return "keychain";
}

export async function cmdLogin(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, LOGIN_FLAGS, "login");
  assertInstalled(ctx);
  if (ctx.env.DARWIN_API_KEY || ctx.env.DARWIN_API_KEY_FILE) throw new CliError(EXIT.usage, copy.envKeySet, "env_key_set");
  const modes = ["with-key", "from-skill", "start", "wait"].filter((m) => has(p, m)).concat(one(p, "key-file") !== undefined ? ["key-file"] : []);
  if (modes.length > 1) throw new CliError(EXIT.usage, `Pick one of --${modes.join(", --")}.`, "usage");
  const wanted = profileName(ctx, one(p, "profile"));
  let realm = targetRealm(ctx, p);
  if (wanted) {
    const existing = loadConfig(ctx).profiles[wanted];
    if (existing) {
      if (realm && realm !== existing.realm) throw new CliError(EXIT.usage, `Profile "${wanted}" is for ${existing.realm}. Beta and production never share a profile; pick another --profile.`, "realm_mismatch");
      realm = existing.realm;
    }
  }
  const json = wantsJson(ctx, { json: has(p, "json"), format: one(p, "format") });
  if (has(p, "wait")) return waitForPairing(ctx, p, realm, wanted, json);
  const store = chooseStore(ctx, p);
  if (has(p, "with-key")) {
    const raw = ctx.io.isTTY.stdin ? await ctx.io.prompt(copy.pastePrompt, true) : (await ctx.io.readStdin()).split(/\r?\n/)[0] ?? "";
    const { key, kind } = acceptKey(raw);
    return importKey(ctx, { key, kind, realm: realm ?? "darwin.finance", store, wanted, json, expectAgent: null });
  }
  const keyFile = one(p, "key-file");
  if (keyFile !== undefined) {
    // With --delete-file, the file is first MOVED aside (same directory, atomic) and only that staged
    // file is read, imported and deleted — so a file swapped in meanwhile is never the one deleted.
    const del = has(p, "delete-file");
    const source = del ? stageKeyFile(keyFile) : keyFile;
    let code: number = EXIT.unexpected;
    try {
      const kf = readKeyFile(source);
      if (realm && realm !== kf.realm) throw new CliError(EXIT.usage, copy.keyFileRealm(kf.realm, realm), "realm_mismatch");
      const { key, kind } = acceptKey(kf.key);
      code = await importKey(ctx, { key, kind, realm: kf.realm, store, wanted, json, expectAgent: kf.agentId });
      return code;
    } finally {
      if (del) {
        if (code === EXIT.ok) {
          try { unlinkSync(source); warn(ctx, "Deleted the key file."); } catch { warn(ctx, `Couldn't delete ${source}; delete it yourself.`); }
        } else {
          // Put it back WITHOUT clobbering a file that arrived meanwhile: link() refuses an existing name.
          try { linkSync(source, keyFile); unlinkSync(source); } catch { warn(ctx, `The key file is now at ${source}.`); }
        }
      }
    }
  }
  if (has(p, "from-skill")) {
    return importFromSkill(ctx, {
      realm, agentId: one(p, "agent-id"), deleteCopy: has(p, "delete-skill-copy"),
      save: (key, kind, r, expectAgent) => importKey(ctx, { key, kind, realm: r, store, wanted, json, expectAgent, source: "skill" }),
    });
  }
  const clientRaw = one(p, "client-name");
  const clientName = validClientName(clientRaw ?? detectClientName(ctx.env));
  return pair(ctx, { realm: realm ?? "darwin.finance", store, wanted, json, clientName, reconnect: has(p, "reconnect"), startOnly: has(p, "start"), noBrowser: has(p, "no-browser") });
}

// ─── key file ───────────────────────────────────────────────────────────────

function stageKeyFile(path: string): string {
  const staged = `${path}.darwin-import-${randomBytes(6).toString("hex")}`;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("not a file");
    renameSync(path, staged);
  } catch {
    throw new CliError(EXIT.usage, `Can't read ${path}.`, "usage");
  }
  return staged;
}

function readKeyFile(path: string): { realm: Realm; agentId: string; key: string } {
  let st;
  try { st = lstatSync(path); } catch { throw new CliError(EXIT.usage, `Can't read ${path}.`, "usage"); }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 4096) throw new CliError(EXIT.usage, `${path} isn't a Darwin key file.`, "usage");
  let j: Record<string, unknown>;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch { throw new CliError(EXIT.usage, `${path} isn't a Darwin key file.`, "usage"); }
  const realm = parseRealm(typeof j.realm === "string" ? j.realm : "");
  if (j.type !== "darwin-agent-key" || j.version !== 1 || !realm || (j.realm !== "darwin.finance" && j.realm !== "beta.darwin.finance") || typeof j.key !== "string" || typeof j.agent_id !== "string" || !isAgentId(j.agent_id)) {
    throw new CliError(EXIT.usage, `${path} isn't a Darwin key file (v1).`, "usage");
  }
  rememberSecret(j.key);
  return { realm, agentId: j.agent_id, key: j.key };
}

// ─── importing an existing key: prove it, then save it ──────────────────────

interface Identity { kind: KeyKind | null; agentId: string; agentName: string; keyName: string | null }

const unwrap = (v: unknown): string => (v && typeof v === "object" && "untrusted" in (v as object) ? String((v as { untrusted: unknown }).untrusted ?? "") : typeof v === "string" ? v : "");

/** Ask Darwin who this key is (whoami; the agents list on an older server). Null = refused. */
export async function identify(ctx: Ctx, realm: Realm, key: string, kind: KeyKind): Promise<Identity | null> {
  let res;
  try {
    res = await request(ctx, realm, "GET", "/api/agent/v1/tools/whoami", { key, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, `${e.message} Nothing was saved.`, "network_error");
    throw e;
  }
  if (res.status === 401) return null;
  if (res.status === 429) throw new CliError(EXIT.rateLimited, "Too many requests with this API key right now. Wait a minute and try again. Nothing was saved.", "rate_limited");
  const w = res.json as Record<string, unknown> | null;
  if (res.status === 200 && w && isAgentId(w.homeAgentId)) {
    return { kind: w.kind === "agents" ? "agents" : w.kind === "agent" ? "agent" : null, agentId: w.homeAgentId, agentName: clean(unwrap(w.homeAgentName)).slice(0, 120), keyName: typeof w.name === "string" ? clean(w.name).slice(0, 120) : null };
  }
  if (res.status !== 404) throw new CliError(EXIT.unexpected, `Couldn't check this key with ${realm} (HTTP ${res.status}). Nothing was saved.`, "bad_response");
  // An older server (no whoami → 404): the agents list.
  const a = await request(ctx, realm, "GET", "/api/agent/v1/agents", { key, timeoutMs: 20_000 }).catch((e) => {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, `${e.message} Nothing was saved.`, "network_error");
    throw e;
  });
  if (a.status === 401) return null;
  if (a.status === 429) throw new CliError(EXIT.rateLimited, "Too many requests with this API key right now. Wait a minute and try again. Nothing was saved.", "rate_limited");
  const list = (a.json as { agents?: unknown } | null)?.agents;
  if (a.status !== 200 || !Array.isArray(list) || list.length === 0) throw new CliError(EXIT.unexpected, `Couldn't check this key with ${realm} (HTTP ${a.status}). Nothing was saved.`, "bad_response");
  const first = list[0] as Record<string, unknown>;
  if (!isAgentId(first.id)) throw new CliError(EXIT.unexpected, "Darwin's answer was not what the CLI expected. Nothing was saved.", "bad_response");
  return { kind, agentId: first.id, agentName: clean(unwrap(first.name)).slice(0, 120), keyName: null };
}

export async function importKey(ctx: Ctx, o: { key: string; kind: KeyKind; realm: Realm; store: StoreKind; wanted?: string; json: boolean; expectAgent: string | null; source?: "skill" }): Promise<number> {
  const who = await identify(ctx, o.realm, o.key, o.kind);
  if (!who) {
    const extra = o.kind === "agents" ? ` ${copy.allAgentsOff}` : "";
    throw new CliError(EXIT.auth, `${o.realm} refused this API key (revoked, expired, or for the other site). Nothing was saved.${extra}`, "unauthorized");
  }
  if (o.expectAgent && who.agentId !== o.expectAgent && o.kind === "agent") {
    throw new CliError(EXIT.auth, "This key belongs to a different agent than its key file says. Nothing was saved.", "agent_mismatch");
  }
  const profile = chooseProfileName(ctx, o.wanted, o.realm, who.agentName, who.agentId);
  const k: NewKey = { realm: o.realm, kind: o.kind, key: o.key, agentId: who.agentId, agentName: who.agentName, keyName: who.keyName, store: o.store, profile };
  if (!saveKey(ctx, k)) throw new CliError(EXIT.unexpected, `Couldn't save the API key in ${o.store === "keychain" ? ctx.keychain.description : "its file"}. Nothing was saved; the key still works wherever it came from.`, "store_failed");
  if (o.source === "skill") return EXIT.ok; // skill.ts prints its own line (C.69)
  if (o.json) printJson(ctx, { status: "connected", profile, realm: o.realm, kind: o.kind, agentId: who.agentId, agent: who.agentName, store: o.store });
  else say(ctx, connectedLine(ctx, k));
  return EXIT.ok;
}

// ─── pairing ────────────────────────────────────────────────────────────────

interface Pending { v: 1; realm: Realm; device_code: string; interval: number; expires_at: number; mode: "new" | "reconnect"; store: StoreKind; profile: string }

// Its OWN namespace: profile accounts are `<realm>:<profile>`, so `pairing:<realm>` can never be one.
const pendingAccount = (realm: Realm) => `pairing:${realm}`;
const pendingFile = (ctx: Ctx, realm: Realm) => join(ctx.configDir, "pairing", realm);

function savePending(ctx: Ctx, p: Pending): void {
  rememberSecret(p.device_code);
  const text = JSON.stringify(p);
  if (p.store === "keychain") ctx.keychain.set(SERVICE, pendingAccount(p.realm), text);
  else writePrivate(pendingFile(ctx, p.realm), text, { strictDir: true });
}

function loadPending(ctx: Ctx, realm: Realm | null): Pending | null {
  for (const r of realm ? [realm] : (["darwin.finance", "beta.darwin.finance"] as Realm[])) {
    let text: string | null = null;
    try { text = ctx.keychain.get(SERVICE, pendingAccount(r)); } catch { /* no keychain */ }
    if (!text) { try { text = readPrivate(pendingFile(ctx, r), 4096); } catch { text = null; } }
    if (!text) continue;
    try {
      const p = JSON.parse(text) as Pending;
      if (p.v === 1 && p.realm === r && DEVICE_CODE_RE.test(p.device_code)) { rememberSecret(p.device_code); return p; }
    } catch { /* corrupt → ignore */ }
  }
  return null;
}

function clearPending(ctx: Ctx, realm: Realm): void {
  try { ctx.keychain.delete(SERVICE, pendingAccount(realm)); } catch { /* none */ }
  removeQuietly(pendingFile(ctx, realm));
}

async function pair(ctx: Ctx, o: { realm: Realm; store: StoreKind; wanted?: string; json: boolean; clientName: string; reconnect: boolean; startOnly: boolean; noBrowser: boolean }): Promise<number> {
  let res;
  try {
    res = await request(ctx, o.realm, "POST", "/api/agent/v1/pair", { body: { client_name: o.clientName, ...(o.reconnect ? { mode: "reconnect" } : {}) }, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof NetworkError) throw new CliError(EXIT.network, `${e.message} Nothing was started.`, "network_error");
    throw e;
  }
  const j = (res.json ?? {}) as Record<string, unknown>;
  if (res.status === 429) throw new CliError(EXIT.rateLimited, "Too many pairings started from here right now. Wait a few minutes.", "rate_limited");
  if (res.status !== 200) throw new CliError(EXIT.refused, `${o.realm} couldn't start a pairing (${clean(String(j.error ?? `HTTP ${res.status}`)).slice(0, 60)}).`, "pair_refused");
  const deviceCode = String(j.device_code ?? "");
  const userCode = String(j.user_code ?? "");
  const url = String(j.verification_uri_complete ?? "");
  const expiresIn = Math.min(Number(j.expires_in) || 600, MAX_WAIT_S);
  const interval = Math.max(Number(j.interval) || 5, 2);
  if (!DEVICE_CODE_RE.test(deviceCode) || !USER_CODE_RE.test(userCode)) throw new CliError(EXIT.unexpected, "Darwin's pairing answer was not what the CLI expected.", "bad_response");
  rememberSecret(deviceCode);
  // 🔴 The link shown and opened is BUILT HERE from the realm and the validated user code — never
  // taken from the response — so nothing in it can carry the device code, an escape, or another host.
  void url;
  const link = `https://${o.realm}/agents/connect?code=${encodeURIComponent(userCode)}`;
  if (o.reconnect && j.mode !== "reconnect") throw new CliError(EXIT.unexpected, "This Darwin site didn't accept a reconnect pairing. Nothing was started.", "reconnect_unsupported");
  const pending: Pending = { v: 1, realm: o.realm, device_code: deviceCode, interval, expires_at: ctx.now() + expiresIn * 1000, mode: o.reconnect ? "reconnect" : "new", store: o.store, profile: o.wanted ?? "" };
  if (o.startOnly) {
    savePending(ctx, pending);
    printJson(ctx, { status: "waiting_for_approval", verification_uri_complete: link, user_code: userCode, expires_in: expiresIn, next: "darwin login --wait" });
    return EXIT.ok;
  }
  warn(ctx, copy.pairingPrompt(link, userCode, Math.round(expiresIn / 60)));
  if (!o.noBrowser && ctx.io.isTTY.stdout && ctx.io.isTTY.stdin) { try { ctx.openUrl(link); } catch { /* the link is printed */ } }
  return poll(ctx, pending, o.json);
}

async function waitForPairing(ctx: Ctx, _p: Parsed, realm: Realm | null, wanted: string | undefined, json: boolean): Promise<number> {
  const pending = loadPending(ctx, realm);
  if (!pending) throw new CliError(EXIT.usage, "No pairing is waiting. Start one with `darwin login --start`.", "no_pending");
  if (wanted) pending.profile = wanted;
  return poll(ctx, pending, json);
}

async function poll(ctx: Ctx, p: Pending, json: boolean): Promise<number> {
  let interval = p.interval;
  let failures = 0;
  while (ctx.now() < p.expires_at) {
    await ctx.sleep(interval * 1000);
    let res;
    try {
      res = await request(ctx, p.realm, "POST", "/api/agent/v1/pair/token", { body: { device_code: p.device_code }, timeoutMs: 30_000 });
    } catch (e) {
      if (e instanceof NetworkError && ++failures < 10) continue;
      throw e instanceof NetworkError ? new CliError(EXIT.network, `${e.message} Run \`darwin login --wait\` to keep waiting.`, "network_error") : e;
    }
    failures = 0;
    const j = (res.json ?? {}) as Record<string, unknown>;
    if (res.status === 200) {
      clearPending(ctx, p.realm);
      return finishPickup(ctx, p, j, json);
    }
    const err = String(j.error ?? "");
    if (err === "authorization_pending") continue;
    if (err === "slow_down") { interval += 5; continue; }
    if (res.status === 429 || err === "rate_limited") { interval += 5; continue; }
    clearPending(ctx, p.realm);
    if (err === "access_denied") throw new CliError(EXIT.refused, "The pairing was declined (or that agent can't take a key). Nothing was saved.", "access_denied");
    if (err === "expired_token") throw new CliError(EXIT.refused, "The pairing code expired or was already used. Run `darwin login` again.", "expired_token");
    throw new CliError(EXIT.unexpected, `Darwin answered the pairing poll with HTTP ${res.status}. Run \`darwin login\` again.`, "bad_response");
  }
  clearPending(ctx, p.realm);
  throw new CliError(EXIT.refused, "The pairing code expired. Run `darwin login` again.", "expired_token");
}

async function finishPickup(ctx: Ctx, p: Pending, j: Record<string, unknown>, json: boolean): Promise<number> {
  const raw = typeof j.access_token === "string" ? j.access_token : "";
  rememberSecret(raw);
  const agent = (j.agent ?? {}) as Record<string, unknown>;
  const agentId = isAgentId(agent.id) ? agent.id : "";
  const agentName = clean(unwrap(agent.name)).slice(0, 120);
  const keyName = typeof j.key_name === "string" ? clean(j.key_name).slice(0, 120) : null;
  if (!agentId) throw new CliError(EXIT.unexpected, "Darwin's pairing answer had no agent id. Revoke the newest key on the agent's Manage tab and pair again.", "bad_response");
  const { key, kind } = acceptKey(raw);
  if ((j.all_agents === true) !== (kind === "agents")) {
    warn(ctx, `Darwin said this key is ${j.all_agents === true ? "for all your agents" : "for one agent"}, but its prefix says otherwise; it is saved as ${kind === "agents" ? "a key for all your active agents" : "a key for one agent"}.`);
  }
  if (p.mode === "reconnect" && j.mode !== undefined && j.mode !== "reconnect") warn(ctx, "Darwin made a new agent instead of reconnecting one.");
  const profile = chooseProfileName(ctx, p.profile || undefined, p.realm, agentName, agentId);
  let k: NewKey = { realm: p.realm, kind, key, agentId, agentName, keyName, store: p.store, profile };
  let saved = saveKey(ctx, k);
  if (!saved && p.store === "keychain" && ctx.io.isTTY.stdin) {
    // Key housekeeping, not a trade: offer the explicit file store once (plan §3.2).
    const answer = (await ctx.io.prompt(`Couldn't save the key in ${ctx.keychain.description}. Save it in a plain file only you can read instead? [y/N] `, false)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      warn(ctx, copy.fileStoreWarning(credentialFile(ctx, p.realm, profile)));
      k = { ...k, store: "file" };
      saved = saveKey(ctx, k);
    }
  }
  if (!saved) throw new CliError(EXIT.unexpected, lostKeyLine(k), "store_failed", { agentId, manageUrl: manageUrl(p.realm, agentId) });
  // The first hello, as this key (its welcome is meant for the user).
  let welcome: string | null = null;
  try {
    const h = await request(ctx, p.realm, "GET", "/api/agent/v1/hello", { key, agent: kind === "agents" ? agentId : undefined, timeoutMs: 20_000 });
    const w = (h.json as { welcome?: unknown } | null)?.welcome;
    if (h.status === 200 && typeof w === "string") welcome = clean(w).slice(0, 8000);
  } catch { /* the welcome is a nicety */ }
  if (json) printJson(ctx, { status: "connected", profile, realm: p.realm, kind, agentId, agent: agentName, keyName, store: k.store, permissions: kind === "agents" ? "Read: all agents · Trade: all active agents" : "Read: this agent · Trade: this agent", welcome });
  else {
    if (welcome) say(ctx, welcome);
    say(ctx, connectedLine(ctx, k));
  }
  return EXIT.ok;
}
