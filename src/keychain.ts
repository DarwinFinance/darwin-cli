/**
 * The OS secret store (plan §3.2): macOS Keychain, Windows Credential Manager, Linux Secret Service —
 * through `@napi-rs/keyring` (Rust `keyring`, prebuilt N-API binaries, no install scripts). Loaded
 * lazily, so a machine without a usable store still runs every command that needs no key.
 *
 * 🔴 On Linux the entry is PINNED to the Secret Service: the library's fallback, the kernel keyring,
 * forgets keys at reboot — and Darwin shows a key only once.
 */
import { createRequire } from "node:module";

export interface Keychain {
  /** "the macOS Keychain", … — for messages. */
  readonly description: string;
  set(service: string, account: string, secret: string, target?: string): void;
  /** null = no such entry. Throws when the store itself is unusable. */
  get(service: string, account: string, target?: string): string | null;
  /** true = deleted, false = there was none. */
  delete(service: string, account: string, target?: string): boolean;
}

export function storeDescription(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "the macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "the Linux Secret Service";
}

type EntryCtor = {
  new (service: string, user: string, opts?: unknown): EntryLike;
  withTarget(target: string, service: string, user: string, opts?: unknown): EntryLike;
};
interface EntryLike { setPassword(p: string): void; getPassword(): string | null; deletePassword(): boolean }

export function osKeychain(platform: NodeJS.Platform): Keychain {
  let Entry: EntryCtor | null = null;
  const load = (): EntryCtor => {
    if (!Entry) {
      const req = createRequire(import.meta.url);
      Entry = (req("@napi-rs/keyring") as { Entry: EntryCtor }).Entry;
    }
    return Entry;
  };
  const opts = platform === "linux" ? { linux: { store: "secret-service" } } : undefined;
  const entry = (service: string, account: string, target?: string) =>
    target ? load().withTarget(target, service, account, opts) : new (load())(service, account, opts);
  return {
    description: storeDescription(platform),
    set: (s, a, secret, t) => entry(s, a, t).setPassword(secret),
    get: (s, a, t) => entry(s, a, t).getPassword(),
    delete: (s, a, t) => entry(s, a, t).deletePassword(),
  };
}

/** For tests: a keychain that lives in a Map (or fails, to test the no-store path). */
export function memoryKeychain(opts: { broken?: boolean; description?: string } = {}): Keychain & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const k = (s: string, a: string, t?: string) => `${t ?? ""}|${s}|${a}`;
  const guard = () => { if (opts.broken) throw new Error("no secret store"); };
  return {
    items,
    description: opts.description ?? "the test keychain",
    set: (s, a, secret, t) => { guard(); items.set(k(s, a, t), secret); },
    get: (s, a, t) => { guard(); return items.get(k(s, a, t)) ?? null; },
    delete: (s, a, t) => { guard(); return items.delete(k(s, a, t)); },
  };
}
