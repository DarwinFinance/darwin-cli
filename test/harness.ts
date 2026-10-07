/** An in-process world for the CLI: a mock Darwin, an in-memory keychain, a temp config dir. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/context.js";
import { memoryKeychain } from "../src/keychain.js";
import { run } from "../src/main.js";
import { _forgetSecrets } from "../src/redact.js";
import agentSnap from "../snapshot/agent.json" with { type: "json" };
import agentsSnap from "../snapshot/agents.json" with { type: "json" };

export const ONE_KEY = "darwinAI_agent_ONEKEYabcdefghijklmnopqrstuvwxyz0123456789";
export const ALL_KEY = "darwinAI_agents_ALLKEYabcdefghijklmnopqrstuvwxyz0123456789";
export const MCP_KEY = "darwinAI_mcp_MCPKEYabcdefghijklmnopqrstuvwxyz0123456789";

export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
export type Handler = (c: Call) => Response | Promise<Response> | "throw-after-send" | "throw-before-send";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function catalogueFor(kind: "agent" | "agents", realm = "darwin.finance") {
  const c = JSON.parse(JSON.stringify(kind === "agents" ? agentsSnap : agentSnap));
  c.realm = realm;
  return c;
}

export interface World {
  ctx: Ctx;
  calls: Call[];
  out: string[];
  err: string[];
  keychain: ReturnType<typeof memoryKeychain>;
  stdin: string;
  prompts: string[];
  answers: string[];
  route: (match: string | RegExp, h: Handler) => void;
  run: (...argv: string[]) => Promise<number>;
  stdout: () => string;
  stderr: () => string;
}

export const GLOBAL_SCRIPT = "/usr/local/lib/node_modules/@darwin.finance/cli/dist/darwin.js";

/** install.json as `darwin setup` writes it (pinned.ts). */
export function writeManifest(dataDir: string, script: string, launcher = join(dataDir, "bin", "darwin")): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const m = {
    schema: 1, package: "@darwin.finance/cli", version: "1.2.0", integrity: "sha512-x", dir: "1.2.0-abc", script, node: "/usr/local/bin/node",
    launcher, source: { repository: "https://github.com/DarwinFinance/darwin-cli", workflow: ".github/workflows/release.yml", ref: "refs/tags/v1.2.0", commit: null, logIndex: null },
    installedAt: "2026-10-07T00:00:00.000Z",
  };
  writeFileSync(join(dataDir, "install.json"), JSON.stringify(m), { mode: 0o600 });
}

/**
 * `pinned` (default true): the program runs as the verified copy `darwin setup` installed — the
 * harness writes an install.json naming `scriptPath`. `pinned: false` = never set up.
 */
export function world(opts: { tty?: boolean; brokenKeychain?: boolean; env?: Record<string, string>; scriptPath?: string; cwd?: string; platform?: NodeJS.Platform; pinned?: boolean; nodeInjected?: boolean } = {}): World {
  _forgetSecrets();
  const dir = mkdtempSync(join(tmpdir(), "darwin-cli-test-"));
  mkdirSync(join(dir, "cfg"), { mode: 0o700 });
  // The verified copy `darwin setup` installs: <data>/versions/<dir>/dist/darwin.js.
  const scriptPath = opts.scriptPath ?? (opts.pinned === false ? GLOBAL_SCRIPT : join(dir, "data", "versions", "1.2.0-abc", "dist", "darwin.js"));
  if (opts.pinned !== false) writeManifest(join(dir, "data"), scriptPath);
  const routes: Array<[string | RegExp, Handler]> = [];
  const keychain = memoryKeychain({ broken: opts.brokenKeychain });
  const w: World = {
    calls: [], out: [], err: [], keychain, stdin: "", prompts: [], answers: [],
    route: (m, h) => { routes.unshift([m, h]); },
    run: (...argv) => run(argv, w.ctx),
    stdout: () => w.out.join(""),
    stderr: () => w.err.join(""),
    ctx: null as unknown as Ctx,
  };
  let t = 1_800_000_000_000;
  w.ctx = {
    env: { HOME: dir, ...(process.env.DARWIN_DEBUG ? { DARWIN_DEBUG: "1" } : {}), ...(opts.env ?? {}) },
    io: {
      stdout: (s) => { w.out.push(s); },
      stderr: (s) => { w.err.push(s); },
      readStdin: async () => w.stdin,
      stdinLines: async function* () { for (const l of w.stdin.split("\n")) yield l; },
      prompt: async (q) => { w.prompts.push(q); return w.answers.shift() ?? ""; },
      isTTY: { stdin: !!opts.tty, stdout: !!opts.tty, stderr: !!opts.tty },
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const call: Call = { url, method: init?.method ?? "GET", headers, body };
      for (const [m, h] of routes) {
        if (typeof m === "string" ? url.endsWith(m) || url.includes(`${m}?`) : m.test(url)) {
          const r = await h(call);
          if (r === "throw-before-send") { const e = new TypeError("fetch failed"); (e as unknown as { cause: unknown }).cause = { code: "ECONNREFUSED" }; throw e; }
          w.calls.push(call);
          if (r === "throw-after-send") { const e = new TypeError("fetch failed"); (e as unknown as { cause: unknown }).cause = { code: "ECONNRESET" }; throw e; }
          return r;
        }
      }
      w.calls.push(call);
      return json(404, { error: "not_found" });
    }) as typeof fetch,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    keychain,
    configDir: join(dir, "cfg"),
    scriptPath,
    execPath: "/usr/local/bin/node",
    dataDir: join(dir, "data"),
    nodeInjected: opts.nodeInjected ?? false,
    cwd: opts.cwd ?? dir,
    platform: opts.platform ?? "darwin",
    openUrl: () => {},
  };
  return w;
}

/** A world already logged in (one-agent or all-agents key) with the catalogue routes answering. */
export async function loggedIn(kind: "agent" | "agents" = "agent", o: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world(o);
  const key = kind === "agents" ? ALL_KEY : ONE_KEY;
  w.route("/api/agent/v1/tools/whoami", () => json(200, { kind, name: "laptop key", homeAgentId: "agr_home", homeAgentName: "Laptop bot", homeAgentPaused: false, permissions: "x" }));
  w.route("/api/agent/v1/tools", () => json(200, catalogueFor(kind), { "x-darwin-catalog": catalogueFor(kind).catalogVersion }));
  w.route("/api/agent/v1/agents", () => json(200, { permissions: "x", agents: [{ id: "agr_home", name: "Laptop bot", status: "active" }, { id: "agr_2", name: "Second", status: "active" }] }));
  w.stdin = `${key}\n`;
  w.answers.push(key);
  const code = await w.run("login", "--with-key", "--profile", "bot");
  if (code !== 0) throw new Error(`login failed: ${w.stderr()}`);
  w.calls.length = 0; w.out.length = 0; w.err.length = 0; w.prompts.length = 0;
  return w;
}
