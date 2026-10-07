/** `darwin mcp` (M4). */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { catalogueFor, json, loggedIn, MCP_KEY, world } from "./harness.js";
import { snapshotFor } from "../src/catalogue.js";
import { toolDefs } from "../src/mcp.js";
import { copy } from "../src/copy.js";

const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const replies = (out: string) => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("darwin mcp", () => {
  it("initialize → the catalogue's instructions; tools/list = the catalogue's tools (parity with the snapshot)", async () => {
    const w = await loggedIn();
    w.stdin = [rpc(1, "initialize", { protocolVersion: "2025-06-18" }), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), rpc(2, "tools/list")].join("\n");
    expect(await w.run("mcp")).toBe(0);
    const [init, list] = replies(w.stdout());
    expect(init.result.instructions).toBe(catalogueFor("agent").instructions);
    expect(init.result.capabilities.tools.listChanged).toBe(true);
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([...snapshotFor("agent").tools.map((t) => t.name), "check_prepared", "cancel_prepared"]);
    const quote = list.result.tools.find((t: { name: string }) => t.name === "get_spot_quote");
    expect(quote.inputSchema).toEqual(snapshotFor("agent").tools.find((t) => t.name === "get_spot_quote")!.inputSchema);
    expect(quote.inputSchema.properties.agent).toBeUndefined();
  });

  it("an all-agents key adds an `agent` argument to every tool but list_agents", () => {
    const defs = toolDefs(snapshotFor("agents"));
    for (const d of defs) {
      const props = (d.inputSchema as { properties: Record<string, unknown> }).properties;
      if (d.name === "list_agents") expect(props.agent).toBeUndefined();
      else expect(props.agent).toBeDefined();
    }
  });

  it("tools/call goes through tools/call; an uncertain write is an error telling the model NOT to re-call — one request", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/call/spot_order_now", () => "throw-after-send");
    w.route("/api/agent/v1/tools/call/get_grant", () => json(200, { tool: "get_grant", isError: false, result: { status: 200, data: { caps: 1 } } }));
    w.stdin = [
      rpc(1, "tools/call", { name: "get_grant", arguments: {} }),
      rpc(2, "tools/call", { name: "spot_order_now", arguments: { sell: "SOL", amount: "1", for: "USDC", maxSlippageBps: 50 } }),
      rpc(3, "tools/call", { name: "no_such_tool", arguments: {} }),
    ].join("\n");
    expect(await w.run("mcp")).toBe(0);
    const [a, b, c] = replies(w.stdout());
    expect(a.result.isError).toBe(false);
    expect(a.result.structuredContent.data.caps).toBe(1);
    expect(b.result.isError).toBe(true);
    expect(b.result.structuredContent.detail).toContain("Do NOT call this tool again");
    expect(b.result.structuredContent.nonce).toMatch(/^cli_/);
    expect(w.calls.filter((x) => x.url.endsWith("/spot_order_now"))).toHaveLength(1);
    expect(c.result.isError).toBe(true);
  });

  it("refuses an MCP-page key (C.45)", async () => {
    const w = world({ env: { DARWIN_API_KEY: MCP_KEY } });
    expect(await w.run("mcp")).toBe(3);
    expect(w.stderr()).toContain(copy.mcpNeedsKey);
  });

  it("--print-config points at this installed copy by absolute path; refuses from npx (C.55)", async () => {
    const w = await loggedIn();
    expect(await w.run("mcp", "--print-config", "claude")).toBe(0);
    // v1.1-c: the registration runs the verified copy through its launcher (never node + a PATH copy).
    const launcher = join(w.ctx.dataDir, "bin", "darwin");
    expect(w.stdout()).toBe(`claude mcp add darwin -- '${launcher}' 'mcp' '--profile' 'bot'\n`);
    w.out.length = 0;
    expect(await w.run("mcp", "--print-config", "cursor")).toBe(0);
    expect(JSON.parse(w.stdout()).mcpServers.darwin).toEqual({ command: launcher, args: ["mcp", "--profile", "bot"] });
    // Windows: the same launcher (stable across updates, clears NODE_OPTIONS), through the absolute cmd.exe.
    const win = await loggedIn("agent", { platform: "win32", env: { SystemRoot: "C:\\Windows" } });
    expect(await win.run("mcp", "--print-config", "cursor")).toBe(0);
    const reg = JSON.parse(win.stdout()).mcpServers.darwin;
    expect(reg.command).toBe(join("C:\\Windows", "System32", "cmd.exe"));
    expect(reg.args).toEqual(["/d", "/c", join(win.ctx.dataDir, "bin", "darwin"), "mcp", "--profile", "bot"]);
    const n = world({ scriptPath: "/home/u/.npm/_npx/1/node_modules/@darwin.finance/cli/dist/darwin.js" });
    expect(await n.run("mcp", "--print-config", "claude")).toBe(2);
    expect(n.stderr()).toContain(copy.printConfigNpx);
  });
});


describe("darwin mcp — codex r1", () => {
  it("#1 an invalid `agent` is refused — never replaced by the default agent", async () => {
    const w = await loggedIn("agents");
    w.stdin = rpc(1, "tools/call", { name: "spot_order_now", arguments: { agent: 123, sell: "SOL", amount: "1", for: "USDC", maxSlippageBps: 50 } });
    expect(await w.run("mcp")).toBe(0);
    expect(replies(w.stdout())[0].result.isError).toBe(true);
    expect(w.calls.filter((c) => c.url.includes("/tools/call/"))).toHaveLength(0);
  });

  it("#2 a key echoed in a request id never reaches stdout", async () => {
    const w = await loggedIn();
    w.stdin = JSON.stringify({ jsonrpc: "2.0", id: "darwinAI_agent_" + "k".repeat(40), method: "ping" });
    await w.run("mcp");
    expect(w.stdout()).not.toContain("k".repeat(40));
  });

  it("#3 startup failures go to stderr only — stdout stays JSON-RPC-clean", async () => {
    for (const env of [{ DARWIN_API_KEY: MCP_KEY }, {} as Record<string, string>]) {
      const w = world({ env });
      expect(await w.run("mcp")).toBe(3);
      expect(w.stdout()).toBe("");
    }
  });

  it("#4 malformed ids and params are refused without running a tool", async () => {
    const w = await loggedIn();
    w.stdin = [JSON.stringify({ jsonrpc: "2.0", id: { x: 1 }, method: "tools/call", params: { name: "get_grant" } }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: 5 })].join("\n");
    await w.run("mcp");
    const r = replies(w.stdout());
    expect(r[0].error.code).toBe(-32600);
    expect(r[1].error.code).toBe(-32602);
    expect(w.calls.filter((c) => c.url.includes("/tools/call/"))).toHaveLength(0);
  });

  it("P3 schemas are verbatim for a one-agent key", () => {
    const c = snapshotFor("agent");
    toolDefs(c).slice(0, c.tools.length).forEach((d, i) => expect(d.inputSchema).toBe(c.tools[i]!.inputSchema));
  });
});

describe("darwin mcp — codex r2", () => {
  it("--print-config refuses a project-local copy even from an unrelated directory; global installs pass", async () => {
    const { isGlobalInstall } = await import("../src/guard.js");
    for (const client of ["claude", "cursor", "gemini"]) {
      const w = world({ scriptPath: "/tmp/some-project/node_modules/@darwin.finance/cli/dist/darwin.js", cwd: "/tmp/unrelated" });
      expect(await w.run("mcp", "--print-config", client)).toBe(2);
    }
    expect(isGlobalInstall("/usr/local/lib/node_modules/@darwin.finance/cli/dist/darwin.js")).toBe(true);
    expect(isGlobalInstall("/opt/homebrew/lib/node_modules/@darwin.finance/cli/dist/darwin.js")).toBe(true);
    expect(isGlobalInstall("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@darwin.finance\\cli\\dist\\darwin.js")).toBe(true);
    expect(isGlobalInstall("/home/u/.bun/install/global/node_modules/@darwin.finance/cli/dist/darwin.js")).toBe(true);
    expect(isGlobalInstall("/home/u/src/darwin-cli/dist/darwin.js")).toBe(true);
    expect(isGlobalInstall("/p/node_modules/.pnpm/x/node_modules/@darwin.finance/cli/dist/darwin.js")).toBe(false);
  });
});
