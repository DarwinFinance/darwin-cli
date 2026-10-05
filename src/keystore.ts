/**
 * Where keys live (plan §3.2):
 *   1. the OS secret store (default) — service `finance.darwin.cli`, account `<realm>:<profile>`;
 *   2. `DARWIN_API_KEY` / `DARWIN_API_KEY_FILE` — SOURCES, read and never written;
 *   3. `--store file` — explicit only: <config>/credentials/<realm>__<profile>, 0600, parent 0700.
 * Never a silent plaintext fallback.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CliError, EXIT, type Ctx } from "./context.js";
import { readPrivate, removeQuietly, writePrivate } from "./fsx.js";
import { copy } from "./copy.js";
import { rememberSecret } from "./redact.js";
import type { StoreKind } from "./config.js";
import type { Realm } from "./realms.js";

export const SERVICE = "finance.darwin.cli";

/** A Darwin agent API key, by kind. `darwinAI_agents_` is checked before `darwinAI_agent_`. */
export const KEY_RE = /^(darwinAI_agents_|darwinAI_agent_|agt_)[A-Za-z0-9_-]{20,200}$/;
export const MCP_KEY_RE = /^darwinAI_mcp_/;

export type KeyKind = "agent" | "agents";

export function keyKind(key: string): KeyKind | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return m[1] === "darwinAI_agents_" ? "agents" : "agent";
}

/** A pasted / read value → a key, or the right refusal. */
export function acceptKey(raw: string): { key: string; kind: KeyKind } {
  const key = raw.trim();
  if (MCP_KEY_RE.test(key)) throw new CliError(EXIT.auth, copy.mcpPageKey, "mcp_page_key");
  const kind = keyKind(key);
  if (!kind) throw new CliError(EXIT.usage, "That isn't a Darwin agent API key (it should start with darwinAI_agent_ or darwinAI_agents_). Nothing was saved.", "not_a_key");
  rememberSecret(key);
  return { key, kind };
}

const account = (realm: Realm, profile: string) => `${realm}:${profile}`;

export function credentialFile(ctx: Ctx, realm: Realm, profile: string): string {
  return join(ctx.configDir, "credentials", `${realm}__${profile}`);
}

export function storeLabel(ctx: Ctx, store: StoreKind, realm: Realm, profile: string): string {
  return store === "keychain" ? ctx.keychain.description : `a file (${credentialFile(ctx, realm, profile)})`;
}

/** Write / read back / delete a throwaway entry. True when the OS secret store works here. */
export function probeKeychain(ctx: Ctx): boolean {
  const acct = `probe:${randomBytes(6).toString("hex")}`;
  const v = randomBytes(12).toString("hex");
  try {
    ctx.keychain.set(SERVICE, acct, v);
    const ok = ctx.keychain.get(SERVICE, acct) === v;
    ctx.keychain.delete(SERVICE, acct);
    return ok;
  } catch {
    try { ctx.keychain.delete(SERVICE, acct); } catch { /* ignore */ }
    return false;
  }
}

/** --store file: can we create, read back and delete an owner-only file in the credentials dir? */
export function probeFileStore(ctx: Ctx): boolean {
  const p = join(ctx.configDir, "credentials", `.probe-${randomBytes(6).toString("hex")}`);
  try {
    writePrivate(p, "probe", { strictDir: true });
    const ok = readPrivate(p, 64) === "probe";
    removeQuietly(p);
    return ok;
  } catch {
    removeQuietly(p);
    return false;
  }
}

/** Store and READ BACK. Throws on any mismatch (the caller decides what a failure means). */
export function putKey(ctx: Ctx, store: StoreKind, realm: Realm, profile: string, key: string): void {
  if (store === "keychain") {
    ctx.keychain.set(SERVICE, account(realm, profile), key);
  } else {
    writePrivate(credentialFile(ctx, realm, profile), `${key}\n`, { strictDir: true });
  }
  if (getKey(ctx, store, realm, profile) !== key) throw new Error("read-back mismatch");
}

export function getKey(ctx: Ctx, store: StoreKind, realm: Realm, profile: string): string | null {
  let v: string | null;
  if (store === "keychain") {
    try {
      v = ctx.keychain.get(SERVICE, account(realm, profile));
    } catch {
      throw new CliError(EXIT.auth, `Couldn't read the API key from ${ctx.keychain.description}. Unlock it, or log in again.`, "secret_store_unavailable");
    }
  } else {
    v = readPrivate(credentialFile(ctx, realm, profile), 4096);
    v = v === null ? null : v.trim();
  }
  if (v) rememberSecret(v);
  return v;
}

/** Delete, then re-read: true only when the key is really gone. */
export function deleteKey(ctx: Ctx, store: StoreKind, realm: Realm, profile: string): boolean {
  if (store === "keychain") {
    try { ctx.keychain.delete(SERVICE, account(realm, profile)); } catch { /* judged by the re-read */ }
    try { return ctx.keychain.get(SERVICE, account(realm, profile)) === null; } catch { return false; }
  }
  removeQuietly(credentialFile(ctx, realm, profile));
  try { return readPrivate(credentialFile(ctx, realm, profile), 4096) === null; } catch { return false; }
}

/** DARWIN_API_KEY or DARWIN_API_KEY_FILE (a private file), or null. */
export function envKey(ctx: Ctx): string | null {
  const direct = ctx.env.DARWIN_API_KEY;
  if (direct && direct.trim()) return direct.trim();
  const file = ctx.env.DARWIN_API_KEY_FILE;
  if (file && file.trim()) {
    const v = readPrivate(file.trim(), 4096);
    if (v === null) throw new CliError(EXIT.auth, "DARWIN_API_KEY_FILE names a file that doesn't exist.", "no_key");
    return v.trim();
  }
  return null;
}
