/**
 * 🔴 THE INSTALL GUARD (plan §2.8, §7; copy C.58). Any command that reads a key, the keychain or a
 * profile refuses to run when this program's own file came from npx / a package runner cache, or
 * from a `node_modules` that belongs to the current directory or one of its parents — a project the
 * user is merely working in could have put a same-named package there, and it would receive the key.
 *
 * Stated limit: substituted code can skip this check. It prevents accidents; what protects users is
 * that Darwin's docs never tell anyone to run the CLI through npx.
 */
import { realpathSync } from "node:fs";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";

const RUNNER_CACHE = /[\\/](?:_npx|\.npm|npm-cache|pnpm[\\/]dlx|\.pnpm-store|dlx-\d+)[\\/]|[\\/]bunx-|[\\/]\.bun[\\/]install[\\/]cache[\\/]|[\\/]\.yarn[\\/](?:berry[\\/])?cache[\\/]/i;

const real = (p: string) => {
  try { return realpathSync(p); } catch { return p; }
};

export function installProblem(ctx: Pick<Ctx, "scriptPath" | "cwd">): "runner" | "workspace" | null {
  const script = real(ctx.scriptPath);
  if (RUNNER_CACHE.test(script)) return "runner";
  const parts = script.split(/[\\/]/).filter((x, i) => x !== "" || i === 0);
  const cwd = real(ctx.cwd).split(/[\\/]/).filter((x, i) => x !== "" || i === 0);
  const eq = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  // EVERY node_modules on the path (pnpm nests them): the project owning any one of them must not be
  // the cwd or one of its parents.
  for (let nm = parts.indexOf("node_modules"); nm > 0; nm = parts.indexOf("node_modules", nm + 1)) {
    const owner = parts.slice(0, nm);
    if (owner.length <= cwd.length && owner.every((seg, i) => eq(seg, cwd[i]!))) return "workspace";
  }
  return null;
}

export function assertInstalled(ctx: Ctx): void {
  if (installProblem(ctx)) throw new CliError(EXIT.usage, copy.installFirst, "install_first");
}
