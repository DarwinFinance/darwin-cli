/**
 * ~/.config/darwin/config.toml — profiles. 🔴 NEVER contains a key (plan §3.3).
 *
 * A deliberately tiny TOML subset (no dependency): `default = "<name>"` and `[profiles.<name>]`
 * tables of string values. Profile names are `[a-z0-9][a-z0-9_-]{0,39}`, so they are bare keys.
 */
import { join } from "node:path";
import { CliError, EXIT, type Ctx } from "./context.js";
import { closeSync, constants, openSync, statSync, unlinkSync } from "node:fs";
import { ensurePrivateDir, readPrivate, writePrivate } from "./fsx.js";
import { isRealm, type Realm } from "./realms.js";
import { looksSecret } from "./redact.js";

export type KeyKind = "agent" | "agents";
export type StoreKind = "keychain" | "file";

export interface Profile {
  realm: Realm;
  kind: KeyKind;
  /** The key's agent (the HOME agent for an all-agents key). */
  agent_id: string;
  agent_name: string;
  /** kind = agents: which agent commands act on when --agent is absent. */
  default_agent: string;
  store: StoreKind;
}

export interface Config {
  default: string;
  profiles: Record<string, Profile>;
}

export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** An agent id we may persist and send: the id shape, and never anything shaped like a key. */
export function isAgentId(v: unknown): v is string {
  return typeof v === "string" && AGENT_ID_RE.test(v) && !looksSecret(v);
}

export function configPath(ctx: Ctx): string {
  return join(ctx.configDir, "config.toml");
}

const str = (s: string) => JSON.stringify(s);

export function serialize(c: Config): string {
  const lines = ["# Darwin CLI profiles. This file never holds an API key.", `default = ${str(c.default)}`];
  for (const [name, p] of Object.entries(c.profiles)) {
    lines.push("", `[profiles.${name}]`);
    for (const k of ["realm", "kind", "agent_id", "agent_name", "default_agent", "store"] as const) lines.push(`${k} = ${str(p[k])}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parse(text: string): Config {
  const c: Config = { default: "", profiles: {} };
  let cur: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sec = /^\[profiles\.([a-z0-9][a-z0-9_-]{0,39})\]$/.exec(line);
    if (sec) {
      cur = {};
      (c.profiles as Record<string, unknown>)[sec[1]!] = cur;
      continue;
    }
    const kv = /^([a-z_]+)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!kv) throw new CliError(EXIT.unexpected, `The Darwin CLI config (config.toml) has a line it can't read: ${JSON.stringify(line.slice(0, 60))}`, "config_corrupt");
    const value = JSON.parse(kv[2]!) as string;
    if (cur) cur[kv[1]!] = value;
    else if (kv[1] === "default") c.default = value;
  }
  for (const [name, p] of Object.entries(c.profiles)) {
    const q = p as unknown as Record<string, string>;
    if (!isRealm(q.realm) || (q.kind !== "agent" && q.kind !== "agents") || (q.store !== "keychain" && q.store !== "file") || !isAgentId(q.agent_id ?? "")) {
      throw new CliError(EXIT.unexpected, `Profile "${name}" in config.toml is incomplete. Remove it with \`darwin profile remove ${name}\` and log in again.`, "config_corrupt");
    }
    q.agent_name = q.agent_name ?? "";
    q.default_agent = q.default_agent ?? "";
  }
  return c;
}

export function loadConfig(ctx: Ctx): Config {
  const text = readPrivate(configPath(ctx), 256 * 1024, { requirePrivateMode: false });
  return text === null ? { default: "", profiles: {} } : parse(text);
}

/**
 * Change the config under a lock, on the LATEST copy (re-read inside the lock), so two commands
 * running at once can't lose each other's profiles. The lock is an exclusively-created file; one
 * older than 30 s is a crashed holder's and is taken over.
 */
export function updateConfig<T>(ctx: Ctx, fn: (c: Config) => T): T {
  ensurePrivateDir(ctx.configDir);
  const lock = join(ctx.configDir, "config.lock");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      closeSync(openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new CliError(EXIT.unexpected, "Another darwin command is changing your profiles; try again in a moment.", "config_busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const c = loadConfig(ctx);
    const out = fn(c);
    saveConfig(ctx, c);
    return out;
  } finally {
    try { unlinkSync(lock); } catch { /* gone */ }
  }
}

export function saveConfig(ctx: Ctx, c: Config): void {
  if (c.default && !c.profiles[c.default]) c.default = Object.keys(c.profiles)[0] ?? "";
  writePrivate(configPath(ctx), serialize(c));
}
