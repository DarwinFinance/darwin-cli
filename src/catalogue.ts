/**
 * The command catalogue (plan §2.2–2.4): fetched from the realm the key belongs to, cached per
 * (realm, credential kind), with a snapshot built into this release as the fallback.
 *
 * 🔴 The catalogue shapes flags and help ONLY. It has no field for a host, header, method or path
 * (validateCatalogue refuses unknown keys) — what a tool call does is decided by the server, which
 * maps a tool name to its own route.
 */
import { join } from "node:path";
import agentSnapshot from "../snapshot/agent.json" with { type: "json" };
import agentsSnapshot from "../snapshot/agents.json" with { type: "json" };
import { type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { readPrivate, writePrivate } from "./fsx.js";
import { NetworkError, request } from "./http.js";
import type { Realm } from "./realms.js";
import type { KeyKind } from "./keystore.js";
import { looksSecret } from "./redact.js";

export interface CatalogueTool {
  name: string;
  cli: { path: string[]; aliases: string[][]; args: Record<string, { flag: string }>; positional: string[] };
  title: string;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, SchemaProp>; required?: string[]; additionalProperties?: unknown };
  annotations: Record<string, unknown>;
  write: boolean;
  costsTx: boolean;
  idempotency: { field: string } | null;
  quoteTtlSeconds: number | null;
  since: string;
  deprecated: { since: string; removeAfter: string; replacement: string | null } | null;
}

export interface SchemaProp { type?: string | string[]; description?: string; enum?: unknown[]; pattern?: string; maxLength?: number; minLength?: number }

export interface Catalogue {
  schemaVersion: number;
  catalogVersion: string;
  realm: string;
  credential: KeyKind;
  minCli: string;
  latestCli: string;
  install: string;
  instructions: string;
  globals: { agentParam: boolean };
  tools: CatalogueTool[];
}

export const CATALOGUE_HEADER = "x-darwin-catalog";

/** Commands the CLI implements itself — a catalogue path may never start with one. */
export const STATIC_COMMANDS = ["api", "cancel", "completion", "doctor", "help", "login", "logout", "mcp", "profile", "retry", "setup", "update", "version", "whoami"];
export const GLOBAL_FLAGS = ["agent", "body", "dry-run", "field", "format", "help", "json", "no-color", "profile", "quiet", "version"];
const RESERVED_TOOL_NAMES = ["call", "cancel_prepared", "check_prepared", "execute", "prepare", "status", "whoami"];

const SEGMENT = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,40}$/;
const PROP_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const TOOL_KEYS = new Set(["name", "cli", "title", "description", "inputSchema", "annotations", "write", "costsTx", "idempotency", "quoteTtlSeconds", "since", "deprecated"]);
const TOP_KEYS = new Set(["schemaVersion", "catalogVersion", "realm", "credential", "minCli", "latestCli", "install", "instructions", "globals", "tools"]);
const MAX_BYTES = 512 * 1024;
const CLI_KEYS = new Set(["path", "aliases", "args", "positional"]);
const isObj = (v: unknown): v is Record<string, unknown> & object => !!v && typeof v === "object" && !Array.isArray(v);

function walkStrings(v: unknown, fn: (s: string) => void): void {
  if (typeof v === "string") fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { fn(k); walkStrings(x, fn); }
}

/** Problems with a catalogue; empty = valid. Mirrors validateCatalogue() on the server. */
export function validateCatalogue(c: unknown): string[] {
  const errs: string[] = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["not an object"];
  if (JSON.stringify(c).length > MAX_BYTES) errs.push("catalogue exceeds 512 KiB");
  walkStrings(c, (s) => {
    if (CONTROL.test(s)) errs.push("control character");
    if (s.length > 8_000) errs.push("string too long");
    if (looksSecret(s)) errs.push("a credential-shaped string");
  });
  const cat = c as Partial<Catalogue>;
  for (const k of Object.keys(cat)) if (!TOP_KEYS.has(k)) errs.push(`unexpected key ${k}`);
  if (cat.schemaVersion !== 1) errs.push("schemaVersion");
  if (typeof cat.catalogVersion !== "string" || !/^sha256:[0-9a-f]{64}$/.test(cat.catalogVersion)) errs.push("catalogVersion");
  if (cat.credential !== "agent" && cat.credential !== "agents") errs.push("credential");
  for (const k of ["minCli", "latestCli"] as const) if (typeof cat[k] !== "string" || !/^\d+\.\d+\.\d+$/.test(cat[k] as string)) errs.push(k);
  if (typeof cat.instructions !== "string") errs.push("instructions");
  if (!isObj(cat.globals) || typeof cat.globals.agentParam !== "boolean" || Object.keys(cat.globals).join() !== "agentParam") errs.push("globals");
  if (typeof cat.realm !== "string" || typeof cat.install !== "string") errs.push("realm/install");
  if (!Array.isArray(cat.tools) || cat.tools.length > 200) return [...errs, "tools"];
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const t of cat.tools) {
    if (!t || typeof t !== "object") { errs.push("tool"); continue; }
    for (const k of Object.keys(t)) if (!TOOL_KEYS.has(k)) errs.push(`${String(t.name)}: unexpected key ${k}`);
    if (typeof t.name !== "string" || !TOOL_NAME.test(t.name) || RESERVED_TOOL_NAMES.includes(t.name)) errs.push(`tool name ${String(t.name)}`);
    if (names.has(t.name)) errs.push(`duplicate tool ${t.name}`);
    names.add(t.name);
    if (typeof t.title !== "string" || typeof t.description !== "string" || typeof t.write !== "boolean" || typeof t.costsTx !== "boolean") errs.push(`${t.name}: fields`);
    const cli = t.cli as CatalogueTool["cli"] | undefined;
    if (!isObj(cli) || !Array.isArray(cli.path) || !Array.isArray(cli.aliases) || !Array.isArray(cli.positional) || !isObj(cli.args)) {
      errs.push(`${t.name}: cli`);
      continue;
    }
    for (const k of Object.keys(cli)) if (!CLI_KEYS.has(k)) errs.push(`${t.name}: unexpected cli key ${k}`);
    if (!isObj(t.annotations)) errs.push(`${t.name}: annotations`);
    if (t.quoteTtlSeconds !== null && !(Number.isInteger(t.quoteTtlSeconds) && t.quoteTtlSeconds > 0 && t.quoteTtlSeconds <= 600)) errs.push(`${t.name}: quoteTtlSeconds`);
    if (typeof t.since !== "string") errs.push(`${t.name}: since`);
    if (t.deprecated !== null && !(isObj(t.deprecated) && typeof t.deprecated.since === "string" && typeof t.deprecated.removeAfter === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(t.deprecated.removeAfter) && (t.deprecated.replacement === null || typeof t.deprecated.replacement === "string"))) errs.push(`${t.name}: deprecated`);
    for (const p of [cli.path, ...cli.aliases]) {
      if (!Array.isArray(p) || p.length < 1 || p.length > 3 || !p.every((s) => typeof s === "string" && SEGMENT.test(s))) { errs.push(`${t.name}: bad cli path`); continue; }
      if (STATIC_COMMANDS.includes(p[0]!)) errs.push(`${t.name}: collides with a static command`);
      const key = p.join(" ");
      if (paths.has(key)) errs.push(`duplicate cli path ${key}`);
      paths.add(key);
    }
    const schema = t.inputSchema as CatalogueTool["inputSchema"];
    if (!isObj(schema) || (schema.properties !== undefined && !isObj(schema.properties))
      || (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === "string")))
      || Object.values(schema.properties ?? {}).some((v) => !isObj(v))) { errs.push(`${t.name}: inputSchema`); continue; }
    const props = Object.keys(schema.properties ?? {});
    const flags = new Set<string>();
    for (const [prop, a] of Object.entries(cli.args)) {
      if (!PROP_NAME.test(prop) || !props.includes(prop)) errs.push(`${t.name}: arg ${prop}`);
      if (!isObj(a) || Object.keys(a).join() !== "flag" || typeof a.flag !== "string" || !SEGMENT.test(a.flag) || GLOBAL_FLAGS.includes(a.flag)) errs.push(`${t.name}: flag`);
      else if (flags.has(a.flag)) errs.push(`${t.name}: duplicate flag`);
      else flags.add(a.flag);
    }
    for (const p of cli.positional) if (typeof p !== "string" || !props.includes(p)) errs.push(`${t.name}: positional`);
    if (t.idempotency !== null && !(isObj(t.idempotency) && Object.keys(t.idempotency).join() === "field" && typeof t.idempotency.field === "string" && PROP_NAME.test(t.idempotency.field))) errs.push(`${t.name}: idempotency`);
    if (t.write && (t.annotations as Record<string, unknown>)?.readOnlyHint === true) errs.push(`${t.name}: write marked read-only`);
  }
  return errs;
}

export function snapshotFor(kind: KeyKind): Catalogue {
  return (kind === "agents" ? agentsSnapshot : agentSnapshot) as unknown as Catalogue;
}

interface CacheEntry { fetchedAt: number; catalogue: Catalogue }

const cacheFile = (ctx: Ctx, realm: Realm, kind: KeyKind) => join(ctx.configDir, "cache", `${realm}-${kind}.json`);

export function readCache(ctx: Ctx, realm: Realm, kind: KeyKind): CacheEntry | null {
  try {
    const text = readPrivate(cacheFile(ctx, realm, kind), MAX_BYTES * 2, { requirePrivateMode: false });
    if (!text) return null;
    const e = JSON.parse(text) as CacheEntry;
    if (typeof e.fetchedAt !== "number" || validateCatalogue(e.catalogue).length || e.catalogue.realm !== realm || e.catalogue.credential !== kind) return null;
    return e;
  } catch {
    return null;
  }
}

function writeCache(ctx: Ctx, realm: Realm, kind: KeyKind, catalogue: Catalogue): void {
  try {
    writePrivate(cacheFile(ctx, realm, kind), JSON.stringify({ fetchedAt: ctx.now(), catalogue }));
  } catch { /* a cache that can't be written is just a cache miss next time */ }
}

export type Refresh = "offline" | "never" | "if-stale" | "force";
export const STALE_MS = 60 * 60 * 1000;

export interface Loaded { catalogue: Catalogue; source: "cache" | "server" | "snapshot" }

/**
 * The catalogue for this realm and credential kind. `key` absent → the public catalogue (one-agent
 * projection only). Never throws: any failure falls back to the cache, then to the snapshot (C.42).
 */
export async function loadCatalogue(ctx: Ctx, realm: Realm, kind: KeyKind, opts: { key?: string | null; refresh: Refresh }): Promise<Loaded> {
  const cached = readCache(ctx, realm, kind);
  // "offline": no request at all (--dry-run) — the cache, else the snapshot.
  if (opts.refresh === "offline") return cached ? { catalogue: cached.catalogue, source: "cache" } : { catalogue: snapshotFor(kind), source: "snapshot" };
  // "never": use the cache when there is one (zero requests in steady state — a changed
  // x-darwin-catalog on any answer triggers a forced refresh); with no cache, fetch once.
  if (cached && (opts.refresh === "never" || (opts.refresh === "if-stale" && ctx.now() - cached.fetchedAt <= STALE_MS))) {
    return { catalogue: cached.catalogue, source: "cache" };
  }
  if (!opts.key && kind === "agents") return cached ? { catalogue: cached.catalogue, source: "cache" } : { catalogue: snapshotFor(kind), source: "snapshot" };
  try {
    const res = opts.key
      ? await request(ctx, realm, "GET", "/api/agent/v1/tools", { key: opts.key, timeoutMs: 15_000, headers: cached ? { "if-none-match": `"${cached.catalogue.catalogVersion}"` } : {} })
      : await request(ctx, realm, "GET", "/agents/cli/catalog.json", { timeoutMs: 15_000 });
    if (res.status === 304 && cached) {
      writeCache(ctx, realm, kind, cached.catalogue);
      return { catalogue: cached.catalogue, source: "cache" };
    }
    if (res.status === 200 && validateCatalogue(res.json).length === 0) {
      const c = res.json as Catalogue;
      if (c.realm === realm && c.credential === kind) {
        writeCache(ctx, realm, kind, c);
        return { catalogue: c, source: "server" };
      }
    }
  } catch (e) {
    if (!(e instanceof NetworkError)) { /* fall through to the fallback */ }
  }
  if (cached) return { catalogue: cached.catalogue, source: "cache" };
  ctx.io.stderr(`${copy.snapshotUsed(realm)}\n`);
  return { catalogue: snapshotFor(kind), source: "snapshot" };
}

/** Every command path (and alias) → its tool. */
export function commandIndex(c: Catalogue): Map<string, CatalogueTool> {
  const m = new Map<string, CatalogueTool>();
  for (const t of c.tools) for (const p of [t.cli.path, ...t.cli.aliases]) m.set(p.join(" "), t);
  return m;
}
