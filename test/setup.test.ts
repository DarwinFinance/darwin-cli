/**
 * v1.1-c — `darwin setup`, the pinned launcher, and the key bound to it (plan §7, §9A.1). The registry
 * is a mock; the Sigstore check is a stand-in that enforces the identity policy setup passes it (the
 * REAL Sigstore verification of a real release runs under Node in provenance-node.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { json, loggedIn, ONE_KEY, world, type World } from "./harness.js";
import { copy } from "../src/copy.js";
import { LAUNCHER_CLEARS, posixLauncher, windowsLauncher } from "../src/pinned.js";
import { releaseIdentity, type SigstorePolicy } from "../src/provenance.js";
import { extractPackage } from "../src/tar.js";
import { neededEntries } from "../src/setup.js";
import { VERSION } from "../src/version.js";

// ─── a tiny tar writer (ustar) ──────────────────────────────────────────────

type Entry = { name: string; body?: string | Buffer; type?: string; linkname?: string };

function tarHeader(name: string, size: number, type: string, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

export function tgz(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    parts.push(tarHeader(e.name, e.type && e.type !== "0" ? 0 : body.length, e.type ?? "0", e.linkname));
    if (!e.type || e.type === "0") {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const sri = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const hex = (b: Buffer) => createHash("sha512").update(b).digest("hex");
const R = "https://registry.npmjs.org";

// ─── a fake registry with one release ───────────────────────────────────────

function release(version = VERSION, o: { statementDigest?: string; tarballUrl?: string; depBytes?: Buffer } = {}) {
  const keyring = tgz([{ name: "package/package.json", body: JSON.stringify({ name: "@napi-rs/keyring", version: "2.1.0" }) }, { name: "package/index.js", body: "module.exports = {}" }]);
  const mac = tgz([{ name: "package/package.json", body: JSON.stringify({ name: "@napi-rs/keyring-darwin-arm64", version: "2.1.0" }) }, { name: "package/keyring.node", body: "binary" }]);
  const linux = tgz([{ name: "package/package.json", body: "{}" }]);
  const shrinkwrap = {
    name: "@darwin.finance/cli", version, lockfileVersion: 3,
    packages: {
      "": { name: "@darwin.finance/cli", version },
      "node_modules/@napi-rs/keyring": { version: "2.1.0", resolved: `${R}/@napi-rs/keyring/-/keyring-2.1.0.tgz`, integrity: sri(keyring) },
      "node_modules/@napi-rs/keyring-darwin-arm64": { version: "2.1.0", resolved: `${R}/@napi-rs/keyring-darwin-arm64/-/keyring-darwin-arm64-2.1.0.tgz`, integrity: sri(mac), optional: true, os: ["darwin"], cpu: ["arm64"] },
      "node_modules/@napi-rs/keyring-linux-x64-gnu": { version: "2.1.0", resolved: `${R}/@napi-rs/keyring-linux-x64-gnu/-/keyring-linux-x64-gnu-2.1.0.tgz`, integrity: sri(linux), optional: true, os: ["linux"], cpu: ["x64"] },
      "node_modules/typescript": { version: "5.9.3", dev: true, resolved: `${R}/typescript/-/typescript-5.9.3.tgz`, integrity: sri(linux) },
    },
  };
  const pkg = tgz([
    { name: "package/package.json", body: JSON.stringify({ name: "@darwin.finance/cli", version }) },
    { name: "package/dist/darwin.js", body: "#!/usr/bin/env node\n" },
    { name: "package/npm-shrinkwrap.json", body: JSON.stringify(shrinkwrap) },
  ]);
  const statement = {
    _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: `pkg:npm/%40darwin.finance/cli@${version}`, digest: { sha512: o.statementDigest ?? hex(pkg) } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { ref: `refs/tags/v${version}`, repository: "https://github.com/DarwinFinance/darwin-cli", path: ".github/workflows/release.yml" } }, resolvedDependencies: [{ digest: { gitCommit: "a".repeat(40) } }] } },
  };
  const attestations = { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { identity: releaseIdentity(version), dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64") }, verificationMaterial: { tlogEntries: [{ logIndex: "42" }] } } }] };
  const doc = {
    name: "@darwin.finance/cli", "dist-tags": { latest: version },
    versions: { [version]: { name: "@darwin.finance/cli", version, dist: { integrity: sri(pkg), tarball: o.tarballUrl ?? `${R}/@darwin.finance/cli/-/cli-${version}.tgz` } } },
  };
  return { pkg, keyring, mac, linux, doc, attestations, depBytes: o.depBytes };
}

/** The stand-in verifier: accepts exactly the bundle "signed" for the identity setup asks for. */
const fakeSigstore = (seen: SigstorePolicy[]) => (bundle: unknown, policy: SigstorePolicy) => {
  seen.push(policy);
  if ((bundle as { identity?: string }).identity !== policy.subjectAlternativeName || policy.issuer !== "https://token.actions.githubusercontent.com") throw new Error("certificate identity error");
};

function serve(w: World, r: ReturnType<typeof release>, version = VERSION) {
  const bin = (b: Buffer) => () => new Response(new Uint8Array(b), { status: 200, headers: { "content-type": "application/octet-stream" } });
  w.route(`${R}/@darwin.finance%2fcli`, () => json(200, r.doc));
  w.route(`${R}/-/npm/v1/attestations/@darwin.finance%2fcli@${version}`, () => json(200, r.attestations));
  w.route(`${R}/@darwin.finance/cli/-/cli-${version}.tgz`, bin(r.pkg));
  w.route(`${R}/@napi-rs/keyring/-/keyring-2.1.0.tgz`, bin(r.depBytes ?? r.keyring));
  w.route(`${R}/@napi-rs/keyring-darwin-arm64/-/keyring-darwin-arm64-2.1.0.tgz`, bin(r.mac));
  w.route(`${R}/@napi-rs/keyring-linux-x64-gnu/-/keyring-linux-x64-gnu-2.1.0.tgz`, bin(r.linux));
}

function setupWorld(opts: Parameters<typeof world>[0] = {}) {
  const w = world({ pinned: false, ...opts });
  const seen: SigstorePolicy[] = [];
  const loaded: string[] = [];
  w.ctx.verifySigstore = fakeSigstore(seen);
  w.ctx.loadKeyringFrom = (s) => { loaded.push(s); };
  return { w, seen, loaded };
}

const nothingInstalled = (w: World) => {
  expect(existsSync(join(w.ctx.dataDir, "bin", "darwin"))).toBe(false);
  expect(existsSync(join(w.ctx.dataDir, "install.json"))).toBe(false);
  const v = join(w.ctx.dataDir, "versions");
  expect(existsSync(v) ? readdirSync(v) : []).toEqual([]);
};

describe("darwin setup — installs only what Darwin's release workflow built", () => {
  it("verifies, installs the copy + its pinned keyring, writes the launcher and install.json", async () => {
    const { w, seen, loaded } = setupWorld({ tty: true });
    serve(w, release());
    expect(await w.run("setup", "--beta")).toBe(0);
    // The identity is EXACTLY the release workflow at this version's tag, issued by GitHub Actions.
    expect(seen).toEqual([{ subjectAlternativeName: `https://github.com/DarwinFinance/darwin-cli/.github/workflows/release.yml@refs/tags/v${VERSION}`, issuer: "https://token.actions.githubusercontent.com" }]);
    // Every request went to the npm registry; none followed a redirect; no realm was contacted.
    expect(w.calls.every((c) => c.url.startsWith(`${R}/`))).toBe(true);
    // Only the needed dependency entries: the loader + THIS platform's addon (never dev, never Linux).
    const files = w.calls.map((c) => c.url.split("/-/").pop());
    expect(files).toContain("keyring-2.1.0.tgz");
    expect(files.includes("keyring-darwin-arm64-2.1.0.tgz")).toBe(process.arch === "arm64");
    expect(files.some((f) => f?.includes("linux") || f?.includes("typescript"))).toBe(false);
    const m = JSON.parse(readFileSync(join(w.ctx.dataDir, "install.json"), "utf8"));
    expect(m.version).toBe(VERSION);
    expect(m.source).toEqual({ repository: "https://github.com/DarwinFinance/darwin-cli", workflow: ".github/workflows/release.yml", ref: `refs/tags/v${VERSION}`, commit: "a".repeat(40), logIndex: "42" });
    expect(m.script).toBe(realpathSync(join(w.ctx.dataDir, "versions", m.dir, "dist", "darwin.js")));
    expect(existsSync(join(w.ctx.dataDir, "versions", m.dir, "node_modules", "@napi-rs", "keyring", "index.js"))).toBe(true);
    expect(loaded).toEqual([m.script]);
    const launcher = join(w.ctx.dataDir, "bin", "darwin");
    if (process.platform !== "win32") {
      expect(statSync(launcher).mode & 0o777).toBe(0o700);
      expect(statSync(w.ctx.dataDir).mode & 0o077).toBe(0);
    }
    const text = readFileSync(launcher, "utf8");
    expect(text).toContain(`exec '/usr/local/bin/node' '${m.script}' "$@"`);
    expect(text).toContain(`unset ${LAUNCHER_CLEARS.join(" ")}`);
    expect(w.stdout()).toContain(`Installed Darwin CLI ${VERSION}, verified as built by Darwin's release workflow`);
    expect(w.stdout()).toContain(`${launcher} login --beta`);
  });

  it("a release signed for any other identity (another repo, workflow or tag) installs NOTHING", async () => {
    const { w } = setupWorld();
    const r = release();
    (r.attestations.attestations[0]!.bundle as { identity: string }).identity = "https://github.com/evil/darwin-cli/.github/workflows/release.yml@refs/tags/v1.1.1";
    serve(w, r);
    expect(await w.run("setup")).toBe(4);
    expect(w.stderr()).toContain("couldn't be verified as built by Darwin's release workflow");
    nothingInstalled(w);
  });

  it("no provenance at all (a hand publish / stolen token) installs nothing", async () => {
    const { w } = setupWorld();
    const r = release();
    serve(w, r);
    w.route(`${R}/-/npm/v1/attestations/@darwin.finance%2fcli@${VERSION}`, () => json(404, { error: "not found" }));
    expect(await w.run("setup")).toBe(4);
    expect(w.stderr()).toContain("no provenance published");
    nothingInstalled(w);
  });

  it("a statement naming a different tarball installs nothing", async () => {
    const { w } = setupWorld();
    serve(w, release(VERSION, { statementDigest: "0".repeat(128) }));
    expect(await w.run("setup")).toBe(4);
    expect(w.stderr()).toContain("different package or tarball");
    nothingInstalled(w);
  });

  it("a tarball that isn't the attested one (swapped in transit / by a mirror) installs nothing", async () => {
    const { w } = setupWorld();
    const r = release();
    serve(w, r);
    w.route(`${R}/@darwin.finance/cli/-/cli-${VERSION}.tgz`, () => new Response(new Uint8Array(tgz([{ name: "package/evil.js", body: "x" }])), { status: 200 }));
    expect(await w.run("setup")).toBe(4);
    expect(w.stderr()).toContain("doesn't match its verified checksum");
    nothingInstalled(w);
  });

  it("a dependency that isn't the shrinkwrap's pinned bytes installs nothing", async () => {
    const { w } = setupWorld();
    serve(w, release(VERSION, { depBytes: tgz([{ name: "package/index.js", body: "evil()" }]) }));
    expect(await w.run("setup")).toBe(4);
    expect(w.stderr()).toContain("doesn't match the checksum the package pins");
    nothingInstalled(w);
  });

  it("a tarball URL off the canonical path, or a registry redirect, is refused", async () => {
    const a = setupWorld();
    serve(a.w, release(VERSION, { tarballUrl: "https://evil.example/cli.tgz" }));
    expect(await a.w.run("setup")).toBe(4);
    nothingInstalled(a.w);
    const b = setupWorld();
    serve(b.w, release());
    b.w.route(`${R}/@darwin.finance%2fcli`, () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    expect(await b.w.run("setup")).toBe(4);
    expect(b.w.stderr()).toContain("never follows one");
    nothingInstalled(b.w);
  });

  it("refuses to run from npx or a project's node_modules", async () => {
    const { w } = setupWorld({ scriptPath: "/h/.npm/_npx/1/node_modules/@darwin.finance/cli/dist/darwin.js" });
    serve(w, release());
    expect(await w.run("setup")).toBe(2);
    expect(w.calls).toHaveLength(0);
    nothingInstalled(w);
  });

  it("--latest never silently downgrades; --version installs exactly that version", async () => {
    const { w } = setupWorld();
    serve(w, release());
    expect(await w.run("setup")).toBe(0);
    const m = JSON.parse(readFileSync(join(w.ctx.dataDir, "install.json"), "utf8"));
    writeFileSync(join(w.ctx.dataDir, "install.json"), JSON.stringify({ ...m, version: "99.0.0" }), { mode: 0o600 });
    expect(await w.run("setup", "--latest")).toBe(2);
    expect(w.stderr()).toContain("newer than npm's latest");
    expect(await w.run("setup", "--cli-version", "1.2")).toBe(2);
    expect(await w.run("setup", "--latest", "--cli-version", "1.2.0")).toBe(2);
  });

  it("one setup at a time per install folder (a crashed one's lock is taken over after 10 minutes)", async () => {
    const { w } = setupWorld();
    serve(w, release());
    mkdirSync(w.ctx.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(w.ctx.dataDir, ".setup.lock"), "", { mode: 0o600 });
    const t = statSync(join(w.ctx.dataDir, ".setup.lock")).mtimeMs;
    w.ctx.now = () => t + 60_000;
    expect(await w.run("setup")).toBe(2);
    expect(w.stderr()).toContain("Another `darwin setup` is running");
    expect(existsSync(join(w.ctx.dataDir, "install.json"))).toBe(false);
    w.ctx.now = () => t + 11 * 60_000;
    expect(await w.run("setup")).toBe(0);
    expect(existsSync(join(w.ctx.dataDir, ".setup.lock"))).toBe(false);
  });

  it("re-running setup replaces the old copy (one installed version at a time)", async () => {
    const { w } = setupWorld();
    serve(w, release());
    expect(await w.run("setup")).toBe(0);
    expect(await w.run("setup")).toBe(0);
    const m = JSON.parse(readFileSync(join(w.ctx.dataDir, "install.json"), "utf8"));
    expect(readdirSync(join(w.ctx.dataDir, "versions"))).toEqual([m.dir]);
  });
});

describe("the key is bound to the verified copy (plan §7)", () => {
  it("never set up: login / whoami / profile refuse, pointing at `darwin setup`; nothing touches the keychain", async () => {
    const w = world({ pinned: false });
    let touched = false;
    w.keychain.get = () => { touched = true; return null; };
    w.keychain.set = () => { touched = true; };
    for (const argv of [["login", "--with-key"], ["whoami"], ["profile", "list"], ["logout"], ["balances"]]) {
      w.err.length = 0;
      expect(await w.run(...argv)).toBe(2);
      expect(w.stderr()).toContain(copy.setupFirst);
    }
    expect(touched).toBe(false);
  });

  it("a plain `darwin` from PATH (not the verified file) is refused with the launcher to use", async () => {
    const w = await loggedIn();
    const other = world({ pinned: false });
    // Same machine, set up — but THIS process is a different copy than install.json names.
    mkdirSync(other.ctx.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(other.ctx.dataDir, "install.json"), readFileSync(join(w.ctx.dataDir, "install.json")), { mode: 0o600 });
    other.ctx.scriptPath = "/opt/homebrew/lib/node_modules/@darwin.finance/cli/dist/darwin.js";
    expect(await other.run("whoami")).toBe(2);
    expect(other.stderr()).toContain(`saved keys are only used through your verified Darwin CLI: run ${join(w.ctx.dataDir, "bin", "darwin")}`);
  });

  it("the verified file started with NODE_OPTIONS / --require (not by the launcher) is refused", async () => {
    const w = world({ nodeInjected: true });
    expect(await w.run("whoami")).toBe(2);
    expect(w.stderr()).toContain("verified Darwin CLI");
  });

  it("a pinned run finds its install from its OWN path, whatever XDG_DATA_HOME says now", async () => {
    const w = await loggedIn();
    w.ctx.dataDir = join(w.ctx.dataDir, "elsewhere");
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_home", homeAgentName: "Bot", permissions: "x" }));
    expect(await w.run("whoami")).toBe(0);
  });

  it("DARWIN_API_KEY (handed to this one process) and market-status need no setup", async () => {
    const w = world({ pinned: false, env: { DARWIN_API_KEY: ONE_KEY } });
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_1", homeAgentName: "Bot", permissions: "x" }));
    expect(await w.run("whoami")).toBe(0);
  });

  it("doctor says how this copy relates to the verified one, and reads no key outside it", async () => {
    const w = world({ pinned: false });
    let touched = false;
    w.keychain.get = () => { touched = true; return null; };
    expect(await w.run("doctor", "--json")).toBe(0);
    expect(JSON.parse(w.stdout()).install).toContain("not set up");
    expect(touched).toBe(false);
  });
});

describe("the launcher", () => {
  it("POSIX: clears code-loading variables with `unset` (a special built-in) and execs absolute paths only", () => {
    const t = posixLauncher("/opt/n'ode/bin/node", "/h/.local/share/darwin/versions/1.2.0-x/dist/darwin.js");
    expect(t.startsWith("#!/bin/sh\n")).toBe(true);
    expect(t).toContain("exec '/opt/n'\\''ode/bin/node' '/h/.local/share/darwin/versions/1.2.0-x/dist/darwin.js' \"$@\"");
    for (const v of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NAPI_RS_NATIVE_LIBRARY_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "OPENSSL_CONF"]) expect(t).toContain(` ${v}`);
    // Nothing a function smuggled in through the environment could replace: only unset + exec run.
    const commands = t.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" ")[0]);
    expect(commands).toEqual(["unset", "exec"]);
    expect(() => posixLauncher("/a\nb", "/s")).toThrow();
  });

  it("Windows: clears the same variables, quotes paths, and doubles % (batch expands it inside quotes)", () => {
    const t = windowsLauncher("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a%b\\AppData\\Local\\darwin\\versions\\1\\dist\\darwin.js");
    expect(t).toContain('set "NODE_OPTIONS="');
    expect(t).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a%%b\\AppData\\Local\\darwin\\versions\\1\\dist\\darwin.js" %*');
    expect(t).toContain("setlocal DisableDelayedExpansion");
  });

  // The real thing: a hostile `node` first on PATH, NODE_OPTIONS=--require, LD_PRELOAD and the keyring
  // loader's override all set — the launcher still runs the absolute Node, and none of them arrive.
  it.skipIf(process.platform === "win32")("POSIX, for real: hostile PATH node, NODE_OPTIONS --require and loader overrides never reach the CLI", () => {
    const node = Bun.which("node");
    if (!node) return;
    const d = mkdtempSync(join(tmpdir(), "darwin-launcher-"));
    mkdirSync(join(d, "evilbin"));
    writeFileSync(join(d, "evilbin", "node"), "#!/bin/sh\necho HIJACKED\n", { mode: 0o755 });
    writeFileSync(join(d, "evil.cjs"), "process.stdout.write('PRELOADED\\n');");
    writeFileSync(join(d, "cli.js"), "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, env: Object.keys(process.env).filter((k) => /^(NODE_|NAPI_RS_|LD_|DYLD_|OPENSSL_)/.test(k)) }));");
    const launcher = join(d, "darwin");
    writeFileSync(launcher, posixLauncher(node, join(d, "cli.js")));
    chmodSync(launcher, 0o700);
    const r = spawnSync(launcher, ["whoami", "it's \"quoted\""], {
      encoding: "utf8",
      env: { PATH: `${join(d, "evilbin")}:/usr/bin:/bin`, HOME: d, NODE_OPTIONS: `--require ${join(d, "evil.cjs")}`, NODE_PATH: d, NAPI_RS_NATIVE_LIBRARY_PATH: join(d, "evil.node"), LD_PRELOAD: join(d, "evil.so"), NODE_EXTRA_CA_CERTS: join(d, "ca.pem"), DARWIN_PROFILE: "kept" },
    });
    expect(r.stdout).not.toContain("HIJACKED");
    expect(r.stdout).not.toContain("PRELOADED");
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({ argv: ["whoami", "it's \"quoted\""], execArgv: [], env: [] });
  });
});

describe("unpacking", () => {
  const dest = () => join(mkdtempSync(join(tmpdir(), "darwin-tar-")), "out");
  it("refuses links, `..`, and paths outside package/", () => {
    expect(() => extractPackage(tgz([{ name: "package/x", type: "2", linkname: "/etc/passwd" }]), dest())).toThrow(/malformed/);
    expect(() => extractPackage(tgz([{ name: "package/../../x", body: "x" }]), dest())).toThrow(/malformed/);
    expect(() => extractPackage(tgz([{ name: "other/x", body: "x" }]), dest())).toThrow(/malformed/);
    expect(() => extractPackage(Buffer.from("not gzip"), dest())).toThrow(/malformed/);
  });

  it("unpacks regular files", () => {
    const d = dest();
    expect(extractPackage(tgz([{ name: "package/a/b.txt", body: "hi" }]), d)).toEqual(["a/b.txt"]);
    expect(readFileSync(join(d, "a", "b.txt"), "utf8")).toBe("hi");
  });

  it("the shrinkwrap filter: dev never, optional only for this os/cpu, nothing off the registry", () => {
    const sw = { packages: {
      "": {}, "node_modules/a": { resolved: `${R}/a/-/a-1.0.0.tgz`, integrity: sri(Buffer.from("a")) },
      "node_modules/d": { dev: true, resolved: "x", integrity: "y" },
      "node_modules/o": { optional: true, os: ["linux"], cpu: ["x64"], resolved: `${R}/o/-/o-1.0.0.tgz`, integrity: sri(Buffer.from("o")) },
    } };
    expect(neededEntries(sw, "darwin", "arm64").map((e) => e.location)).toEqual(["node_modules/a"]);
    expect(neededEntries(sw, "linux", "x64").map((e) => e.location)).toEqual(["node_modules/a", "node_modules/o"]);
    expect(() => neededEntries({ packages: { "node_modules/a": { resolved: "https://evil.example/a.tgz", integrity: sri(Buffer.from("a")) } } }, "darwin", "arm64")).toThrow(/outside the npm registry/);
    expect(() => neededEntries({ packages: { "node_modules/../x": { resolved: `${R}/a/-/a-1.0.0.tgz`, integrity: sri(Buffer.from("a")) } } }, "darwin", "arm64")).toThrow(/unexpected location/);
  });
});
