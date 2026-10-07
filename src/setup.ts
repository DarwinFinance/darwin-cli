/**
 * `darwin setup` (plan §7, v1.1-c) — install ONE verified copy of the Darwin CLI into a private folder
 * and write the launcher every later command runs through (pinned.ts says why).
 *
 *   1. Ask the public npm registry (registry.npmjs.org only — never a project's `.npmrc`) for the
 *      version: this program's own by default, `--latest`, or `--cli-version x.y.z`.
 *   2. Verify its provenance (provenance.ts): Sigstore-signed by GitHub Actions for
 *      DarwinFinance/darwin-cli's release.yml at tag v<version>, naming the tarball's exact sha512.
 *   3. Download the tarball and check its sha512 against that; unpack it.
 *   4. Install its one runtime dependency (the keyring addon) from the tarball's OWN
 *      npm-shrinkwrap.json — exact versions, each download checked against the shrinkwrap's sha512.
 *      So every byte installed is pinned by the verified tarball.
 *   5. Write the launcher (absolute Node + absolute script, code-loading variables cleared) and
 *      install.json; remove older copies.
 *
 * Trust boundary, stated plainly: the copy that RUNS setup the first time is the one npm installed.
 * If that copy were itself a substitute, nothing it does can be trusted — exactly as with installing
 * any package. What setup closes is everything AFTER: PATH and Node-environment tricks, a project's
 * own copy, and (for `setup --latest`) a version published by anyone but Darwin's release workflow,
 * which the previously verified copy refuses.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { has, one, onlyFlags, type Parsed } from "./args.js";
import { CliError, EXIT, type Ctx } from "./context.js";
import { copy } from "./copy.js";
import { ensurePrivateDir, writePrivate } from "./fsx.js";
import { assertInstalled } from "./guard.js";
import { NPM_REGISTRY, registryGet } from "./http.js";
import { printJson, say, wantsJson, warn } from "./output.js";
import { installPaths, pinState, posixLauncher, readManifest, shellQuote, windowsLauncher, type Manifest } from "./pinned.js";
import { PACKAGE, verifyProvenance } from "./provenance.js";
import { extractPackage } from "./tar.js";
import { compareVersions, VERSION } from "./version.js";

const ENCODED = "@darwin.finance%2fcli";
const MAX_DOC = 32 * 1024 * 1024;
const MAX_TGZ = 32 * 1024 * 1024;
const SEMVER = /^\d+\.\d+\.\d+$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/;
/** A shrinkwrap install location: node_modules/[@scope/]name, nested any depth. */
const LOCATION = /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseJson(b: Buffer, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(b.toString("utf8"));
    if (isObj(v)) return v;
  } catch { /* below */ }
  throw new CliError(EXIT.refused, `The npm registry's ${what} wasn't readable. Nothing was installed.`, "registry_bad_answer");
}

const sha512Hex = (b: Buffer) => createHash("sha512").update(b).digest("hex");

function integrityHex(v: unknown, what: string): string {
  const m = typeof v === "string" ? INTEGRITY.exec(v) : null;
  if (!m) throw new CliError(EXIT.refused, `The npm registry gave no sha512 for ${what}. Nothing was installed.`, "no_integrity");
  return Buffer.from(m[1]!, "base64").toString("hex");
}

const real = (p: string) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/** Is `inner` the same as, or inside, `outer`? */
function within(platform: NodeJS.Platform, inner: string, outer: string): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const i = norm(resolve(inner));
  const o = norm(resolve(outer)).replace(/[\\/]+$/, "");
  return i === o || i.startsWith(o + sep) || i.startsWith(`${o}/`);
}

/**
 * Homebrew's Node lives at …/Cellar/node/<version>/bin/node, which `brew upgrade` deletes. When the
 * stable …/opt/node/bin/node link points at this same Node, the launcher uses the link instead.
 */
export function stableNode(execPath: string): string {
  const m = /^(.*)[\\/]Cellar[\\/](node(?:@\d+)?)[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(execPath);
  if (m) {
    const link = join(m[1]!, "opt", m[2]!, "bin", "node");
    if (existsSync(link) && real(link) === real(execPath)) return link;
  }
  return execPath;
}

/** Which shrinkwrap entries this machine needs: not dev; an optional one only if its os/cpu fit. */
export function neededEntries(shrinkwrap: unknown, platform: string, arch: string): Array<{ location: string; resolved: string; integrity: string }> {
  const pkgs = isObj(shrinkwrap) && isObj(shrinkwrap.packages) ? shrinkwrap.packages : null;
  if (!pkgs) throw new CliError(EXIT.refused, "The package has no npm-shrinkwrap.json to pin its dependencies. Nothing was installed.", "bad_package");
  const out: Array<{ location: string; resolved: string; integrity: string }> = [];
  for (const [location, e] of Object.entries(pkgs)) {
    if (location === "" || !isObj(e) || e.dev === true) continue;
    const fits = (field: unknown, value: string) => !Array.isArray(field) || field.length === 0
      || (field.includes(value) || (field.every((x) => typeof x === "string" && x.startsWith("!")) && !field.includes(`!${value}`)));
    if (e.optional === true && !(fits(e.os, platform) && fits(e.cpu, arch))) continue;
    if (!LOCATION.test(location)) throw new CliError(EXIT.refused, "The package's shrinkwrap names an unexpected location. Nothing was installed.", "bad_package");
    if (typeof e.resolved !== "string" || !e.resolved.startsWith(`${NPM_REGISTRY}/`)) {
      throw new CliError(EXIT.refused, "The package's shrinkwrap points outside the npm registry. Nothing was installed.", "bad_package");
    }
    out.push({ location, resolved: e.resolved, integrity: integrityHex(e.integrity, location) });
  }
  return out;
}

const defaultLoadKeyring = (script: string) => {
  const k = createRequire(script)("@napi-rs/keyring") as { Entry?: unknown };
  if (typeof k.Entry !== "function") throw new Error("no Entry");
};

export async function cmdSetup(ctx: Ctx, p: Parsed): Promise<number> {
  onlyFlags(p, ["latest", "cli-version", "beta", "prod", "json", "format", "quiet", "no-color", "help"], "setup");
  if (has(p, "beta") && has(p, "prod")) throw new CliError(EXIT.usage, "Pass --beta or --prod, not both.", "usage");
  // Never from npx or a project's node_modules: that copy is exactly what setup exists to avoid.
  assertInstalled(ctx);
  const json = wantsJson(ctx, { json: has(p, "json"), format: one(p, "format") });
  if (p.positionals.length > 1) throw new CliError(EXIT.usage, "`darwin setup` takes no arguments. See `darwin setup --help`.", "usage");
  // (`--version` alone prints this program's version, so the version to install is --cli-version.)
  const explicit = one(p, "cli-version");
  if (explicit !== undefined && !SEMVER.test(explicit)) throw new CliError(EXIT.usage, "--cli-version takes an exact version, like 1.2.0.", "usage");
  if (explicit !== undefined && has(p, "latest")) throw new CliError(EXIT.usage, "Pass --latest or --cli-version, not both.", "usage");
  // Updating from the verified copy installs next to it, wherever setup first put it.
  const pin = pinState(ctx);
  const paths = installPaths(ctx, pin.ok ? pin.root : ctx.dataDir);
  // A project folder must not hold the install (a workspace could point XDG_DATA_HOME into itself).
  // Running from your home folder (or above it) is fine.
  const home = ctx.env.HOME || ctx.env.USERPROFILE || "";
  const cwd = real(ctx.cwd);
  if (within(ctx.platform, paths.root, cwd) && !(home && within(ctx.platform, real(home), cwd))) {
    throw new CliError(EXIT.usage, `The install folder (${paths.root}) is inside the current folder; a project must not hold your Darwin CLI. Run setup from another folder, or unset XDG_DATA_HOME.`, "unsafe_path");
  }
  const before = pin.ok ? pin.manifest : readManifest(ctx);

  // 1. Which version, and what npm says its tarball is.
  const doc = parseJson(await registryGet(ctx, `/${ENCODED}`, MAX_DOC), "package document");
  const tags = isObj(doc["dist-tags"]) ? doc["dist-tags"] : {};
  const version = explicit ?? (has(p, "latest") ? String(tags.latest ?? "") : VERSION);
  if (!SEMVER.test(version)) throw new CliError(EXIT.refused, "The npm registry didn't name a usable latest version. Nothing was installed.", "registry_bad_answer");
  if (has(p, "latest") && before && compareVersions(version, before.version) < 0) {
    throw new CliError(EXIT.usage, `Your verified copy (${before.version}) is newer than npm's latest (${version}). Nothing was changed; pass --cli-version ${version} to go back on purpose.`, "downgrade");
  }
  const versions = isObj(doc.versions) ? doc.versions : {};
  const meta = versions[version];
  if (doc.name !== PACKAGE || !isObj(meta) || meta.name !== PACKAGE || meta.version !== version || !isObj(meta.dist)) {
    throw new CliError(EXIT.refused, `Darwin CLI ${version} isn't published on npm. Nothing was installed.`, "not_published");
  }
  const hex = integrityHex(meta.dist.integrity, `${PACKAGE}@${version}`);
  const tarballPath = `/@darwin.finance/cli/-/cli-${version}.tgz`;
  if (meta.dist.tarball !== `${NPM_REGISTRY}${tarballPath}`) throw new CliError(EXIT.refused, "The npm registry named an unexpected download for this version. Nothing was installed.", "bad_package");

  // 2. Who built it — before a byte of it is unpacked.
  let attBytes: Buffer;
  try {
    attBytes = await registryGet(ctx, `/-/npm/v1/attestations/${ENCODED}@${version}`, MAX_DOC);
  } catch (e) {
    // No provenance at all: published by hand or with a token — never by the release workflow.
    if (e instanceof CliError && e.code === "registry_not_found") attBytes = Buffer.from("{}");
    else throw e;
  }
  const att = parseJson(attBytes, "provenance");
  const source = verifyProvenance(att, version, hex, ctx.verifySigstore);

  // 3. The tarball itself must be the one the provenance names.
  const tgz = await registryGet(ctx, tarballPath, MAX_TGZ);
  if (sha512Hex(tgz) !== hex) throw new CliError(EXIT.refused, "The downloaded package doesn't match its verified checksum. Nothing was installed.", "integrity_mismatch");

  // 4. Unpack it, and its pinned dependencies, into a fresh private folder.
  ensurePrivateDir(paths.root, true);
  ensurePrivateDir(paths.versions, true);
  ensurePrivateDir(paths.bin, true);
  const dirName = `${version}-${randomBytes(6).toString("hex")}`;
  const staging = join(paths.versions, `.staging-${dirName}`);
  const final = join(paths.versions, dirName);
  try {
    extractPackage(tgz, staging);
    let pkg: Record<string, unknown> = {};
    try { pkg = JSON.parse(readFileSync(join(staging, "package.json"), "utf8")) as Record<string, unknown>; } catch { /* checked below */ }
    if (pkg.name !== PACKAGE || pkg.version !== version || !existsSync(join(staging, "dist", "darwin.js"))) {
      throw new CliError(EXIT.refused, "The package isn't the Darwin CLI it claims to be. Nothing was installed.", "bad_package");
    }
    let shrinkwrap: unknown = null;
    try { shrinkwrap = JSON.parse(readFileSync(join(staging, "npm-shrinkwrap.json"), "utf8")); } catch { /* neededEntries refuses */ }
    for (const dep of neededEntries(shrinkwrap, ctx.platform, process.arch)) {
      const bytes = await registryGet(ctx, dep.resolved.slice(NPM_REGISTRY.length), MAX_TGZ);
      if (sha512Hex(bytes) !== dep.integrity) throw new CliError(EXIT.refused, `A dependency (${dep.location.slice("node_modules/".length)}) doesn't match the checksum the package pins. Nothing was installed.`, "integrity_mismatch");
      extractPackage(bytes, join(staging, ...dep.location.split("/")));
    }
    renameSync(staging, final);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const script = real(join(final, "dist", "darwin.js"));
  try {
    (ctx.loadKeyringFrom ?? defaultLoadKeyring)(script);
  } catch {
    warn(ctx, "Note: the secret-store addon didn't load on this computer, so saved keys won't work here. Set DARWIN_API_KEY for each session instead.");
  }

  // 5. The launcher and the record of what is installed. If setup stops between the two, the launcher
  //    and install.json disagree and saved keys are refused until setup is run again (fails closed).
  const node = stableNode(ctx.execPath);
  const launcherText = ctx.platform === "win32" ? windowsLauncher(node, script) : posixLauncher(node, script);
  writePrivate(paths.launcher, launcherText, { strictDir: true, mode: 0o700 });
  const manifest: Manifest = {
    schema: 1, package: PACKAGE, version, integrity: `sha512-${Buffer.from(hex, "hex").toString("base64")}`, dir: dirName, script, node,
    launcher: paths.launcher, source, installedAt: new Date(ctx.now()).toISOString(),
  };
  writePrivate(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { strictDir: true });
  // Older copies go (best effort: a copy that is running right now may be locked on Windows).
  for (const d of readdirSync(paths.versions)) {
    if (d === dirName || d.startsWith(".")) continue;
    rmSync(join(paths.versions, d), { recursive: true, force: true, maxRetries: 0 });
  }

  const launcher = shellQuote(ctx, paths.launcher);
  if (json) {
    printJson(ctx, { installed: version, previous: before?.version ?? null, integrity: manifest.integrity, launcher: paths.launcher, script, node, source });
  } else {
    say(ctx, copy.setupDone(version, launcher));
    say(ctx, `Built from ${source.repository.replace(/^https:\/\//, "")} at tag v${version}${source.commit ? ` (commit ${source.commit.slice(0, 12)})` : ""}${source.logIndex ? `; transparency log entry ${source.logIndex}` : ""}.`);
    say(ctx, copy.setupNext(launcher, has(p, "beta")));
  }
  return EXIT.ok;
}
