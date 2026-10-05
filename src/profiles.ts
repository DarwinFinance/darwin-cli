/** Saving a key + its profile (shared by every way of logging in). */
import { CliError, EXIT, type Ctx } from "./context.js";
import { loadConfig, PROFILE_RE, updateConfig, type Profile, type StoreKind } from "./config.js";
import { copy } from "./copy.js";
import { warn } from "./output.js";
import { deleteKey, getKey, putKey, storeLabel, type KeyKind } from "./keystore.js";
import { manageUrl, type Realm } from "./realms.js";

export function slug(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return PROFILE_RE.test(s) ? s : "agent";
}

/** The profile name a new key goes to: --profile, else a free slug of the agent's name. */
export function chooseProfileName(ctx: Ctx, wanted: string | undefined, realm: Realm, agentName: string, agentId: string): string {
  const cfg = loadConfig(ctx);
  if (wanted) {
    const p = cfg.profiles[wanted];
    if (p && p.realm !== realm) throw new CliError(EXIT.usage, `Profile "${wanted}" is for ${p.realm}, not ${realm}. Pick another --profile.`, "realm_mismatch");
    return wanted;
  }
  const base = `${slug(agentName || "agent")}${realm === "beta.darwin.finance" ? "-beta" : ""}`.slice(0, 40);
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    const p = cfg.profiles[name];
    if (!p || (p.realm === realm && p.agent_id === agentId)) return name;
  }
  throw new CliError(EXIT.usage, "Too many profiles with that name; pass --profile.", "usage");
}

export interface NewKey {
  realm: Realm; kind: KeyKind; key: string; agentId: string; agentName: string; keyName: string | null; store: StoreKind; profile: string;
}

/**
 * Store the key (with one retry), read it back, then write the profile. On failure nothing is
 * printed that holds the key; the caller gets `false` and decides what to tell the owner (C.59).
 */
export function saveKey(ctx: Ctx, k: NewKey): boolean {
  // The key and its profile change together, under the config lock, against the LATEST state — so
  // a logout or another login running at the same time can neither lose nor orphan a key.
  let previous: string | null = null;
  let wrote = false;
  let verified = false;
  let oldStore: Profile["store"] | null = null;
  try {
    updateConfig(ctx, (cfg) => {
      const old = cfg.profiles[k.profile];
      // What is there now. Unreadable ≠ missing: never overwrite what we couldn't read.
      previous = getKey(ctx, k.store, k.realm, k.profile);
      for (let attempt = 0; attempt < 2; attempt++) {
        // `wrote` means "we may have changed the store" — set BEFORE the write, so a write whose
        // read-back fails is still rolled back.
        wrote = true;
        try { putKey(ctx, k.store, k.realm, k.profile, k.key); verified = true; break; } catch { /* retry once */ }
      }
      if (!verified) throw new Error("store_failed");
      cfg.profiles[k.profile] = {
        realm: k.realm, kind: k.kind, agent_id: k.agentId, agent_name: k.agentName.slice(0, 120),
        default_agent: k.kind === "agents" ? k.agentId : "", store: k.store,
      } satisfies Profile;
      cfg.default = k.profile;
      if (old && old.store !== k.store) oldStore = old.store;
    });
  } catch {
    // Nothing committed: put back exactly what was there (only if WE changed it).
    if (wrote) {
      try { if (previous !== null) putKey(ctx, k.store, k.realm, k.profile, previous); else deleteKey(ctx, k.store, k.realm, k.profile); } catch { /* best effort */ }
    }
    return false;
  }
  // Committed. A profile that moved stores: remove the old copy (a plain file!) — after the commit,
  // and only while the profile still points at the new store with this key.
  if (oldStore) {
    const from = oldStore;
    let removed = false;
    try {
      removed = updateConfig(ctx, (cfg) => {
        const now = cfg.profiles[k.profile];
        if (!now || now.store !== k.store || getKey(ctx, k.store, k.realm, k.profile) !== k.key) return true;
        return deleteKey(ctx, from, k.realm, k.profile);
      });
    } catch { removed = false; }
    if (!removed) warn(ctx, `The previous copy of this key in ${from === "keychain" ? ctx.keychain.description : "its file"} couldn't be removed; remove it by hand.`);
  }
  return true;
}

export function connectedLine(ctx: Ctx, k: NewKey): string {
  const store = storeLabel(ctx, k.store, k.realm, k.profile);
  return k.kind === "agents" ? copy.connectedAll(store, k.profile, k.agentName || k.agentId) : copy.connected(store, k.profile, "Read: this agent · Trade: this agent");
}

export function lostKeyLine(k: Pick<NewKey, "keyName" | "agentName" | "agentId" | "realm">): string {
  return copy.keyNotSaved(k.keyName ?? "(unnamed)", k.agentName || k.agentId, manageUrl(k.realm, k.agentId));
}
