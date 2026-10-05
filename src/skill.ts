/**
 * `darwin login --from-skill` (plan §0A Q10b): move the key the official skill's `darwin.py` saved
 * into the CLI. darwin.py keeps an index (keys.json, 0600) in its state directory and the key itself
 * in the OS store under service `finance.darwin.agent-skill`, account `<host>:<agent id>` — or, with
 * no store, in a RAM-backed file. We read it from the backend the index names (`stored_in`), save it
 * in the CLI's own store, read it back, and prove it with whoami (importKey) before anything else.
 *
 * The skill's copy is deleted ONLY with --delete-skill-copy, and only under darwin.py's own lock
 * (`<state>/.lock`, flock), after re-reading it: if it no longer holds the exact key we imported
 * (the helper re-paired meanwhile), it is left alone (C.71).
 */
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { readPrivate, removeQuietly, writePrivate } from "./fsx.js";
import { acceptKey, type KeyKind } from "./keystore.js";
import { say, warn } from "./output.js";
import { loadConfig } from "./config.js";
import { storeLabel } from "./keystore.js";
import type { Realm } from "./realms.js";

export const SKILL_SERVICE = "finance.darwin.agent-skill";
const SKILL_REALM: Record<string, Realm> = { prod: "darwin.finance", beta: "beta.darwin.finance" };
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function skillStateDir(ctx: Ctx): string {
  const o = ctx.env.DARWIN_SKILL_STATE_DIR;
  if (o) return o;
  const home = ctx.env.HOME || homedir();
  if (ctx.platform === "darwin") return join(home, "Library", "Application Support", "darwin-agent-skill");
  if (ctx.platform === "win32") return join(ctx.env.LOCALAPPDATA || join(home, "AppData", "Local"), "darwin-agent-skill");
  return join(ctx.env.XDG_STATE_HOME || join(home, ".local", "state"), "darwin-agent-skill");
}

interface Entry { realm: string; agent_id: string; agent?: string; stored_in?: string }

function readIndex(ctx: Ctx): Entry[] {
  const text = readPrivate(join(skillStateDir(ctx), "keys.json"), 65536);
  if (text === null) return [];
  let idx: { keys?: unknown };
  try { idx = JSON.parse(text); } catch { throw new CliError(EXIT.unexpected, "The Darwin skill's key index is malformed.", "skill_index_corrupt"); }
  if (!Array.isArray(idx.keys)) throw new CliError(EXIT.unexpected, "The Darwin skill's key index is malformed.", "skill_index_corrupt");
  return idx.keys.filter((e): e is Entry => !!e && typeof e === "object" && (e as Entry).realm in SKILL_REALM && AGENT_ID_RE.test(String((e as Entry).agent_id ?? "")));
}

const account = (e: Entry) => `${SKILL_REALM[e.realm]}:${e.agent_id}`;

/** Only a ROOT-owned secret-tool at a fixed path — never one found through PATH. */
function secretTool(): string | null {
  for (const c of ["/usr/bin/secret-tool", "/bin/secret-tool", "/usr/local/bin/secret-tool"]) {
    try {
      const st = statSync(c);
      if (st.isFile() && st.uid === 0 && !(st.mode & 0o022)) return c;
    } catch { /* next */ }
  }
  return null;
}

function ramFile(ctx: Ctx, e: Entry): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  for (const base of [ctx.env.XDG_RUNTIME_DIR, "/dev/shm"]) {
    if (!base) continue;
    const dir = join(base, `darwin-agent-skill-${uid}`);
    try { if (lstatSync(dir).isDirectory()) return join(dir, `${Buffer.from(account(e)).toString("base64url")}.key`); } catch { /* next */ }
  }
  return null;
}

/** The secret darwin.py stored for this entry, from the backend its index names. */
export function readSkillSecret(ctx: Ctx, e: Entry): string | null {
  const acct = account(e);
  switch (e.stored_in) {
    case "macos-keychain": return ctx.keychain.get(SKILL_SERVICE, acct);
    case "windows-credential-manager": return ctx.keychain.get(SKILL_SERVICE, acct, `${SKILL_SERVICE}:${acct}`);
    case "linux-secret-service": {
      const tool = secretTool();
      if (!tool) return null;
      const r = spawnSync(tool, ["lookup", "service", SKILL_SERVICE, "account", acct], { encoding: "utf8", timeout: 15_000 });
      return r.status === 0 && r.stdout ? r.stdout.replace(/\r?\n$/, "") : null;
    }
    case "memory-only": {
      const f = ramFile(ctx, e);
      const t = f ? readPrivate(f, 4096) : null;
      try { const j = t ? (JSON.parse(t) as { secret?: unknown }) : null; return typeof j?.secret === "string" ? j.secret : null; } catch { return null; }
    }
    default: return null;
  }
}

function deleteSkillSecret(ctx: Ctx, e: Entry): void {
  const acct = account(e);
  switch (e.stored_in) {
    case "macos-keychain": ctx.keychain.delete(SKILL_SERVICE, acct); return;
    case "windows-credential-manager": ctx.keychain.delete(SKILL_SERVICE, acct, `${SKILL_SERVICE}:${acct}`); return;
    case "linux-secret-service": { const tool = secretTool(); if (tool) spawnSync(tool, ["clear", "service", SKILL_SERVICE, "account", acct], { timeout: 15_000 }); return; }
    case "memory-only": { const f = ramFile(ctx, e); if (f) removeQuietly(f); return; }
  }
}

/**
 * Hold darwin.py's own lock (an flock on `<state>/.lock`) while `fn` runs. Node has no flock, so a
 * tiny python3 child takes it — python3 is what darwin.py itself runs on. No python3 / busy → null.
 */
export async function withSkillLock<T>(ctx: Ctx, fn: () => T): Promise<T | null> {
  const lockPath = join(skillStateDir(ctx), ".lock");
  const script = [
    "import os,sys",
    "p=sys.argv[1]",
    "fd=os.open(p, os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0), 0o600)",
    "if os.name=='nt':",
    "  import msvcrt; msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)",
    "else:",
    "  import fcntl; fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)",
    "sys.stdout.write('locked\\n'); sys.stdout.flush()",
    "sys.stdin.read()",
  ].join("\n");
  const py = ctx.platform === "win32" ? "python" : "/usr/bin/python3";
  const child = spawn(py, ["-c", script, lockPath], { stdio: ["pipe", "pipe", "ignore"] });
  const locked = await new Promise<boolean>((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(false), 10_000);
    child.stdout.on("data", (d: Buffer) => { buf += d.toString(); if (buf.includes("locked")) { clearTimeout(t); resolve(true); } });
    child.on("error", () => { clearTimeout(t); resolve(false); });
    child.on("exit", () => { clearTimeout(t); resolve(false); });
  });
  try {
    return locked ? fn() : null;
  } finally {
    try { child.stdin.end(); } catch { /* gone */ }
    if (!locked) child.kill();
  }
}

export async function importFromSkill(ctx: Ctx, o: {
  realm: Realm | null; agentId?: string; deleteCopy: boolean;
  save: (key: string, kind: KeyKind, realm: Realm, expectAgent: string) => Promise<number>;
}): Promise<number> {
  let entries = readIndex(ctx);
  if (o.realm) entries = entries.filter((e) => SKILL_REALM[e.realm] === o.realm);
  if (o.agentId) entries = entries.filter((e) => e.agent_id === o.agentId);
  if (entries.length === 0) throw new CliError(EXIT.usage, "The Darwin skill has no saved key that matches. (It keeps its keys in its own state folder; nothing to import.)", "no_skill_key");
  if (entries.length > 1) {
    throw new CliError(EXIT.usage, `The Darwin skill saved several keys; pick one with --agent-id (and --beta / --prod): ${entries.map((e) => `${e.agent_id} (${SKILL_REALM[e.realm]})`).join(", ")}`, "ambiguous_skill_key");
  }
  const e = entries[0]!;
  const realm = SKILL_REALM[e.realm]!;
  let secret: string | null;
  try { secret = readSkillSecret(ctx, e); } catch { secret = null; }
  if (!secret) throw new CliError(EXIT.auth, "Couldn't read the key the Darwin skill saved (its secret store may be locked, or a memory-only key was lost at reboot).", "skill_key_unreadable");
  const { key, kind } = acceptKey(secret);
  const code = await o.save(key, kind, realm, e.agent_id);
  if (code !== EXIT.ok) return code;
  const cfg = loadConfig(ctx);
  const profile = cfg.default;
  const p = cfg.profiles[profile]!;
  let deleteCopy = o.deleteCopy;
  if (!deleteCopy) {
    say(ctx, copy.skillImported(p.agent_name || e.agent_id, storeLabel(ctx, p.store, p.realm, profile), profile));
    if (ctx.io.isTTY.stdin && ctx.io.isTTY.stdout) {
      // Key housekeeping, not a write (owner Q6 does not apply).
      const a = (await ctx.io.prompt("Delete the skill's copy now? [y/N] ", false)).trim().toLowerCase();
      deleteCopy = a === "y" || a === "yes";
    }
    if (!deleteCopy) return EXIT.ok;
  } else {
    say(ctx, `Imported the API key for ${p.agent_name || e.agent_id} that the Darwin skill saved. It's now in ${storeLabel(ctx, p.store, p.realm, profile)} as profile "${profile}".`);
  }
  const outcome = await withSkillLock(ctx, () => {
    const again = readIndex(ctx).find((x) => x.realm === e.realm && x.agent_id === e.agent_id);
    let now: string | null = null;
    try { now = again ? readSkillSecret(ctx, again) : null; } catch { now = null; }
    if (!again || now !== key) return "changed" as const;
    deleteSkillSecret(ctx, again);
    // Verify it is really gone before the index forgets it.
    let left: string | null = null;
    try { left = readSkillSecret(ctx, again); } catch { left = "unknown"; }
    if (left !== null) return "not_deleted" as const;
    // Rewrite the index from its RAW entries, dropping only this one (fields we don't know are kept).
    const raw = JSON.parse(readPrivate(join(skillStateDir(ctx), "keys.json"), 65536) ?? "{\"keys\":[]}") as { keys: unknown[] };
    const rest = raw.keys.filter((x) => !(x && typeof x === "object" && (x as Entry).realm === e.realm && (x as Entry).agent_id === e.agent_id));
    writePrivate(join(skillStateDir(ctx), "keys.json"), JSON.stringify({ ...raw, v: 1, keys: rest }));
    return "deleted" as const;
  });
  if (outcome === "deleted") say(ctx, "Deleted the Darwin skill's copy of the key.");
  else if (outcome === "changed") warn(ctx, copy.skillChanged);
  else if (outcome === "not_deleted") warn(ctx, "Couldn't delete the Darwin skill's copy of the key (its secret store refused); it was left as it was. Remove it with darwin.py's `forget`.");
  else warn(ctx, "Couldn't lock the Darwin skill's saved keys (is a darwin.py command running?), so its copy was left alone. Try again later.");
  return EXIT.ok;
}
