/**
 * A small argv parser (no dependency). `--name value`, `--name=value`, boolean flags, `--` ends
 * flags, `-h` = `--help`. 🔴 There is no flag that takes a key: keys come from stdin, a key file,
 * the environment or the secret store (plan D6) — argv is visible in `ps` and shell history.
 */
import { CliError, EXIT } from "./context.js";

export interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
  /** Flags given without a value. */
  bools: Set<string>;
}

/** Flags that never take a value. Tool flags with a boolean schema are added by the caller. */
export const BOOLEAN_FLAGS = new Set([
  "json", "dry-run", "quiet", "no-color", "help", "version", "beta", "prod", "reconnect", "start", "wait", "with-key",
  "delete-file", "from-skill", "delete-skill-copy", "revoke", "force-local", "all", "no-browser",
]);

/** Flags whose VALUE would be a secret if someone tried — refused outright with the right advice. */
const SECRET_FLAGS = new Set(["key", "api-key", "token", "access-token", "password", "secret"]);

export function parseArgs(argv: string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS): Parsed {
  const out: Parsed = { positionals: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { out.positionals.push(...argv.slice(i + 1)); break; }
    if (a === "-h") { out.bools.add("help"); continue; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new CliError(EXIT.usage, `"${a.slice(0, 40)}" is not a flag.`, "usage");
      if (SECRET_FLAGS.has(name)) {
        throw new CliError(EXIT.usage, "The Darwin CLI never takes an API key on the command line (it would show up in `ps` and your shell history). Use `darwin login --with-key` and paste it, or set DARWIN_API_KEY.", "key_on_argv");
      }
      if (eq !== -1 && booleans.has(name)) {
        // `--dry-run=true` must mean what it says — never a silently ignored value.
        const v = a.slice(eq + 1).toLowerCase();
        if (v === "true" || v === "1") out.bools.add(name);
        else if (v !== "false" && v !== "0") throw new CliError(EXIT.usage, `--${name} is a switch: write --${name} (or --${name}=true / --${name}=false).`, "usage");
      } else if (eq !== -1) {
        push(out, name, a.slice(eq + 1));
      } else if (booleans.has(name)) {
        out.bools.add(name);
      } else {
        const v = argv[i + 1];
        if (v === undefined || (v.startsWith("--") && v.length > 2)) throw new CliError(EXIT.usage, `--${name} needs a value.`, "usage");
        push(out, name, v);
        i++;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) throw new CliError(EXIT.usage, `Unknown option ${a.slice(0, 20)}. Flags are written --name.`, "usage");
    out.positionals.push(a);
  }
  return out;
}

function push(p: Parsed, name: string, v: string): void {
  const list = p.flags.get(name) ?? [];
  list.push(v);
  p.flags.set(name, list);
}

/** The single value of a flag (the last one wins is NOT allowed — repeated = usage error). */
export function one(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  if (!v) return undefined;
  if (v.length > 1) throw new CliError(EXIT.usage, `--${name} was given more than once.`, "usage");
  return v[0];
}

export function has(p: Parsed, name: string): boolean {
  return p.bools.has(name);
}

/** Refuse anything the command does not take. */
export function onlyFlags(p: Parsed, allowed: readonly string[], command: string): void {
  for (const f of [...p.flags.keys(), ...p.bools]) {
    if (!allowed.includes(f)) throw new CliError(EXIT.usage, `\`darwin ${command}\` doesn't take --${f}. See \`darwin ${command} --help\`.`, "usage");
  }
}
