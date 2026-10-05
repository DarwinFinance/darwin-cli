/**
 * 🔴 THE HOST ALLOWLIST (plan D7). A key is only ever sent to one of these two hosts, over https,
 * and a profile is bound to exactly one of them. There is no --host / --base-url override.
 */
export const REALMS = ["darwin.finance", "beta.darwin.finance"] as const;
export type Realm = (typeof REALMS)[number];

export function isRealm(v: unknown): v is Realm {
  return typeof v === "string" && (REALMS as readonly string[]).includes(v);
}

export function origin(realm: Realm): string {
  return `https://${realm}`;
}

/** `prod` / `production` / `darwin.finance` → darwin.finance; `beta` / `beta.darwin.finance` → beta. */
export function parseRealm(v: string | undefined | null): Realm | null {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "" ) return null;
  if (s === "prod" || s === "production" || s === "darwin.finance") return "darwin.finance";
  if (s === "beta" || s === "beta.darwin.finance") return "beta.darwin.finance";
  return null;
}

export function manageUrl(realm: Realm, agentId: string): string {
  return `${origin(realm)}/agent-account/${encodeURIComponent(agentId)}/manage`;
}

/** True only for an https URL on exactly this realm's host (default port). */
export function isRealmUrl(url: string, realm: Realm): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === realm && u.port === "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}
