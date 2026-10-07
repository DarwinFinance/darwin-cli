/**
 * 🔴 THE PINNED INSTALL (plan §7, v1.1-c). `darwin setup` installs one VERIFIED copy of the CLI into a
 * private directory and writes a launcher next to it:
 *
 *     ~/.local/share/darwin/                (Windows: %LOCALAPPDATA%\darwin\)       0700
 *       bin/darwin                          (Windows: bin\darwin.cmd)  the launcher
 *       versions/<version>-<random>/        the verified package + its keyring addon
 *       install.json                        what is installed, and its provenance  0600
 *
 * The launcher runs that copy with an ABSOLUTE Node and an absolute script, after clearing the
 * environment variables that make Node (or the keyring loader, or the dynamic linker) load other
 * code — so neither a `darwin` nor a `node` put first on PATH, nor NODE_OPTIONS / LD_PRELOAD / …, can
 * get between the user and the key.
 *
 * And the key is BOUND to it: a key in the OS secret store or a `--store file` is read or written only
 * when this program is that verified copy (its own file is the one install.json names) started by
 * the launcher. Anything else — the global npm copy reached through PATH, a source checkout — is told
 * to use the launcher. (Substituted code can of course skip this check; it keeps every genuine copy on
 * the one path whose provenance was verified, and the launcher is what keeps substitutes off that path.
 * `DARWIN_API_KEY` is a key the caller hands to this one process, so it needs no install.)
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { installProblem } from "./guard.js";
import { readPrivate } from "./fsx.js";

export interface Manifest {
  schema: 1;
  package: string;
  version: string;
  /** npm's `sha512-…` of the tarball that was verified and unpacked. */
  integrity: string;
  /** versions/<dir> */
  dir: string;
  /** Absolute, real path of the installed dist/darwin.js. */
  script: string;
  /** The absolute Node the launcher runs. */
  node: string;
  launcher: string;
  source: { repository: string; workflow: string; ref: string; commit: string | null; logIndex: string | null };
  installedAt: string;
}

export function installPaths(ctx: Pick<Ctx, "dataDir" | "platform">, root = ctx.dataDir) {
  return {
    root,
    bin: join(root, "bin"),
    launcher: join(root, "bin", ctx.platform === "win32" ? "darwin.cmd" : "darwin"),
    versions: join(root, "versions"),
    manifest: join(root, "install.json"),
  };
}

const real = (p: string) => {
  try { return realpathSync(p); } catch { return p; }
};

const samePath = (ctx: Pick<Ctx, "platform">, a: string, b: string) =>
  ctx.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** install.json under `ctx.dataDir` (where `darwin setup` installs by default). */
export function readManifest(ctx: Ctx): Manifest | null {
  return readManifestAt(installPaths(ctx).manifest);
}

/**
 * The install root a VERIFIED copy lives in: <root>/versions/<dir>/dist/darwin.js → <root>. Found from
 * the program's own path, so a pinned run never depends on XDG_DATA_HOME / LOCALAPPDATA being the same
 * as when setup ran (an agent harness may set them differently).
 */
export function rootOfScript(script: string): string | null {
  const parts = script.split(/[\\/]/);
  const n = parts.length;
  if (n < 5 || parts[n - 1] !== "darwin.js" || parts[n - 2] !== "dist" || parts[n - 4] !== "versions") return null;
  return parts.slice(0, n - 4).join(script.includes("\\") && !script.includes("/") ? "\\" : "/");
}

function readManifestAt(path: string): Manifest | null {
  let text: string | null;
  try { text = readPrivate(path, 64 * 1024); } catch { return null; }
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Manifest;
    const ok = m && m.schema === 1 && typeof m.version === "string" && typeof m.script === "string" && typeof m.launcher === "string"
      && typeof m.node === "string" && typeof m.dir === "string" && typeof m.integrity === "string";
    return ok ? m : null;
  } catch {
    return null;
  }
}

export type PinState =
  | { ok: true; manifest: Manifest; root: string }
  | { ok: false; manifest: Manifest | null; why: "not_set_up" | "not_launcher" | "node_injected" };

/** Is THIS process the verified copy, started through the launcher? */
export function pinState(ctx: Ctx): PinState {
  const script = real(ctx.scriptPath);
  const root = rootOfScript(script);
  const own = root ? readManifestAt(join(root, "install.json")) : null;
  if (root && own && samePath(ctx, script, own.script)) {
    // The launcher clears these; seeing one means the verified file was started some other way.
    if (ctx.nodeInjected) return { ok: false, manifest: own, why: "node_injected" };
    return { ok: true, manifest: own, root };
  }
  const m = readManifest(ctx);
  if (!m) return { ok: false, manifest: null, why: "not_set_up" };
  return { ok: false, manifest: m, why: "not_launcher" };
}

/** Every command that reads or writes a SAVED key (or a profile) calls this first. */
export function assertPinned(ctx: Ctx): Manifest {
  if (installProblem(ctx)) throw new CliError(EXIT.usage, copy.installFirst, "install_first");
  const s = pinState(ctx);
  if (s.ok) return s.manifest;
  if (!s.manifest) throw new CliError(EXIT.usage, copy.setupFirst, "setup_first");
  throw new CliError(EXIT.usage, copy.useLauncher(shellQuote(ctx, s.manifest.launcher)), "use_launcher");
}

/** A path as the user should type it in their shell. */
export function shellQuote(ctx: Pick<Ctx, "platform">, p: string): string {
  if (ctx.platform === "win32") return /[\s&()^%!,;=]/.test(p) ? `"${p}"` : p;
  return /^[A-Za-z0-9_./~+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

/** The command to update: through the launcher when there is one. */
export function updateCommand(ctx: Ctx): string {
  const s = pinState(ctx);
  return s.manifest ? `${shellQuote(ctx, s.manifest.launcher)} setup --latest` : copy.installAndSetup;
}

// ─── the launcher itself ────────────────────────────────────────────────────

/**
 * Environment variables that load or redirect code in Node, its TLS stack, the dynamic linker, or the
 * keyring addon's loader. Cleared by NAME with `unset` — a POSIX special built-in, which a function
 * smuggled in through the environment cannot replace (no `read`, `case`, `[` or `echo` in the launcher).
 *
 * 🔴 STATED BOUNDARY (codex v1.1-c r1): the dynamic-linker variables (LD_PRELOAD, LD_AUDIT; DYLD_* on
 * macOS, where SIP already strips them for /bin/sh) are cleared for NODE, but on Linux they have
 * already been applied to the launcher's own `/bin/sh` by the time it runs — as they would be to any
 * first program, static binaries aside. An environment that can set them already runs code in every
 * process the agent starts (its shell, its git, its harness); no launcher can undo that, and the plan
 * (§7) puts same-user code execution outside what a CLI can defend. What the launcher closes is the
 * Node-only class a project can set without that power: NODE_OPTIONS / NODE_PATH from a .envrc, a
 * Makefile or a package script, a `node` or `darwin` first on PATH, the keyring loader's override.
 */
export const LAUNCHER_CLEARS = [
  "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY", "NODE_USE_SYSTEM_CA", "NODE_ICU_DATA", "NODE_PRESERVE_SYMLINKS", "NODE_COMPILE_CACHE",
  "NODE_V8_COVERAGE", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_REDIRECT_WARNINGS", "NODE_SKIP_PLATFORM_CHECK",
  "NODE_PENDING_DEPRECATION", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID",
  "OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_ENGINES", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NAPI_RS_NATIVE_LIBRARY_PATH", "NAPI_RS_FORCE_WASI",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_VERSIONED_LIBRARY_PATH", "DYLD_VERSIONED_FRAMEWORK_PATH", "DYLD_ROOT_PATH", "DYLD_IMAGE_SUFFIX",
] as const;

/** Names the CLI itself refuses to see in a pinned run (they mean the launcher didn't start it). */
export const INJECTION_VARS = ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NAPI_RS_NATIVE_LIBRARY_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "OPENSSL_CONF"] as const;

const unsafePath = (p: string) => /[\0\n\r]/.test(p);

export function posixLauncher(node: string, script: string): string {
  if (unsafePath(node) || unsafePath(script)) throw new CliError(EXIT.unexpected, "The install path has a line break in it; setup can't write a launcher for it.", "unsafe_path");
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh
# Darwin CLI launcher, written by \`darwin setup\`. It runs the verified copy below with an absolute
# Node, after clearing variables that would load other code into it. Run \`<this file> setup --latest\`
# to update; don't edit.
unset ${LAUNCHER_CLEARS.join(" ")}
exec ${q(node)} ${q(script)} "$@"
`;
}

export function windowsLauncher(node: string, script: string): string {
  if (unsafePath(node) || unsafePath(script) || /["]/.test(node + script)) throw new CliError(EXIT.unexpected, "The install path has a character setup can't put in a launcher.", "unsafe_path");
  // In a batch file `%` expands even inside quotes; `%%` is a literal percent sign.
  const q = (s: string) => `"${s.replace(/%/g, "%%")}"`;
  return [
    "@echo off",
    "rem Darwin CLI launcher, written by `darwin setup`. It runs the verified copy below with an absolute",
    "rem Node, after clearing variables that would load other code into it. Don't edit.",
    "setlocal DisableDelayedExpansion",
    ...LAUNCHER_CLEARS.map((n) => `set "${n}="`),
    `${q(node)} ${q(script)} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}
