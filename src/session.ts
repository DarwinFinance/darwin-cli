/**
 * WHICH KEY a command runs with: `DARWIN_API_KEY` / `DARWIN_API_KEY_FILE` (a source — realm from
 * DARWIN_REALM, production by default) unless `--profile` is given, else the profile from
 * `--profile` / DARWIN_PROFILE / the config's default. The install guard runs first (C.58).
 */
import { CliError, EXIT, type Ctx } from "./context.js";
import { loadConfig, PROFILE_RE, type Profile } from "./config.js";
import { assertInstalled } from "./guard.js";
import { assertPinned } from "./pinned.js";
import { acceptKey, envKey, getKey, type KeyKind } from "./keystore.js";
import { parseRealm, type Realm } from "./realms.js";

export interface Session {
  realm: Realm;
  kind: KeyKind;
  key: string;
  /** "env" for an environment key. */
  profileName: string;
  profile: Profile | null;
}

export function realmFromEnv(ctx: Ctx): Realm {
  const raw = ctx.env.DARWIN_REALM;
  if (raw === undefined || raw === "") return "darwin.finance";
  const r = parseRealm(raw);
  if (!r) throw new CliError(EXIT.usage, "DARWIN_REALM must be prod or beta.", "usage");
  return r;
}

export function profileName(ctx: Ctx, flag: string | undefined): string | undefined {
  const n = flag ?? ctx.env.DARWIN_PROFILE;
  if (n !== undefined && !PROFILE_RE.test(n)) throw new CliError(EXIT.usage, "A profile name is 1–40 of a–z, 0–9, _ and -, starting with a letter or digit.", "usage");
  return n;
}

export function openSession(ctx: Ctx, flags: { profile?: string }): Session {
  assertInstalled(ctx);
  const explicit = profileName(ctx, flags.profile);
  if (!flags.profile) {
    const fromEnv = envKey(ctx);
    if (fromEnv !== null) {
      const { key, kind } = acceptKey(fromEnv);
      return { realm: realmFromEnv(ctx), kind, key, profileName: "env", profile: null };
    }
  }
  // 🔴 A SAVED key (or profile) only through the verified copy `darwin setup` installed (pinned.ts).
  assertPinned(ctx);
  const cfg = loadConfig(ctx);
  const name = explicit ?? cfg.default;
  const profile = name ? cfg.profiles[name] : undefined;
  if (!name || !profile) {
    throw new CliError(EXIT.auth, name ? `There's no profile "${name}". \`darwin profile list\` shows them; \`darwin login\` makes one.` : "This terminal isn't connected to Darwin yet. Run `darwin login` (or set DARWIN_API_KEY).", "no_key");
  }
  const stored = getKey(ctx, profile.store, profile.realm, name);
  if (!stored) throw new CliError(EXIT.auth, `The API key for "${name}" is missing from ${profile.store === "keychain" ? ctx.keychain.description : "its file"}. Run \`darwin login\` again.`, "no_key");
  const { key, kind } = acceptKey(stored);
  if (kind !== profile.kind) throw new CliError(EXIT.auth, `The key saved for "${name}" is not the kind this profile expects. Run \`darwin login\` again.`, "key_kind_mismatch");
  return { realm: profile.realm, kind, key, profileName: name, profile };
}
