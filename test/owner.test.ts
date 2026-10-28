/**
 * 1.3.0 — ACCOUNT-LEVEL (owner) keys: routed to the owner REST door, never the tool runner; reads only;
 * every trade refused before ANY request; `darwin login --read-only` accepts exactly Darwin's read-only
 * answer. Standing rule: no asset theft from a stolen credential — a read-only key must never trade.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogueFor, json, MCP_KEY, ONE_KEY, world, loggedIn, type Call, type World } from "./harness.js";
import { copy } from "../src/copy.js";
import v11Agent from "./fixtures/v11-agent.json" with { type: "json" };

const PERM_NONE = "Read: all Darwin market data, plus your whole account · Trade: none";
const PERM_ONE = "Read: all Darwin market data, plus your whole account · Trade: one agent";
const PERM_ALL = "Read: all Darwin market data, plus your whole account · Trade: all active agents";
const DEVICE = `darwinAI_pair_${"d".repeat(60)}`;
const SIG = "5".repeat(88);

type Scope = "none" | "agent" | "all_active";
const PERMS: Record<Scope, string> = { none: PERM_NONE, agent: PERM_ONE, all_active: PERM_ALL };

function agentsRoute(w: World, scope: Scope) {
  w.route("/api/agent/v1/agents", () => json(200, {
    permissions: PERMS[scope],
    agents: scope === "agent" ? [{ id: "agr_one", name: "Solo", status: "active" }] : [{ id: "agr_home", name: "Laptop bot", status: "active" }, { id: "agr_2", name: "Second", status: "active" }],
  }));
}

/** A world with a saved owner-key profile ("acct"), every request since login cleared. */
async function ownerLoggedIn(scope: Scope = "none", o: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world(o);
  agentsRoute(w, scope);
  w.stdin = `${MCP_KEY}\n`;
  w.answers.push(MCP_KEY);
  const code = await w.run("login", "--with-key", "--profile", "acct");
  if (code !== 0) throw new Error(`owner login failed: ${w.stderr()}`);
  w.calls.length = 0; w.out.length = 0; w.err.length = 0;
  return w;
}

/** No request ever reached the tool runner (or its catalogue / whoami / prepare / execute). */
const noToolRunner = (w: World) => expect(w.calls.filter((c) => c.url.includes("/api/agent/v1/tools"))).toHaveLength(0);

describe("🔴 a READ-ONLY account-level key's trades are refused BEFORE anything is sent", () => {
  for (const argv of [
    ["order", "--quote", "q_1"],
    ["quote", "--sell", "USDC", "--amount", "1", "--for", "SOL"],
    ["instant", "--sell", "USDC", "--amount", "1", "--for", "SOL"],
    ["pause", "--agent", "agr_home"],
    ["order", "--quote", "q_1", "--dry-run"],
  ]) {
    it(`read-only key: darwin ${argv.join(" ")} → read-only refusal, zero requests`, async () => {
      const w = await ownerLoggedIn("none");
      expect(await w.run(...argv)).toBe(4);
      expect(w.stderr()).toContain(copy.readOnlyRefusal);
      expect(w.calls).toHaveLength(0);
    });
  }

  it("beta v1.1 writes (perps order, collateral, unlisted order) are refused with zero requests", async () => {
    const b = await ownerLoggedIn("none", { env: { DARWIN_REALM: "beta" } });
    for (const argv of [["perps", "order", "SOL", "--side", "buy", "--size", "1"], ["perps", "collateral", "deposit"], ["unlisted", "order", "--quote", "q"]]) {
      b.calls.length = 0; b.err.length = 0;
      expect(await b.run(...argv)).toBe(4);
      expect(b.calls).toHaveLength(0);
    }
    expect(v11Agent.tools.some((t) => t.name === "place_perp_order")).toBe(true);
  });

  it("darwin api never sends an account key to the tool runner's routes — dot segments included (codex r1 P2)", async () => {
    const w = await ownerLoggedIn("none");
    for (const path of ["/api/agent/v1/tools/whoami", "/api/agent/v1/./tools/whoami", "/api/agent/v1//tools/whoami", "/api/agent/v1/%2e/tools/whoami", "/api/agent/v1/x/%2E%2E/tools"]) {
      expect(await w.run("api", "GET", path)).toBe(2);
    }
    expect(w.calls).toHaveLength(0);
  });

  it("retry / cancel are refused locally (a read-only key places no orders)", async () => {
    const w = await ownerLoggedIn("none");
    expect(await w.run("retry", `prp_${"a".repeat(24)}`)).toBe(2);
    expect(w.stderr()).toContain(copy.ownerNoPrepared);
    expect(await w.run("cancel", `prp_${"a".repeat(24)}`)).toBe(2);
    expect(w.calls).toHaveLength(0);
  });

  it("an ENVIRONMENT read-only key: its scope is read from Darwin's agents list first (a read), then refused — no trade sent", async () => {
    const w = world({ env: { DARWIN_API_KEY: MCP_KEY } });
    agentsRoute(w, "none");
    expect(await w.run("order", "--quote", "q_1", "--agent", "agr_home")).toBe(4);
    expect(w.stderr()).toContain(copy.readOnlyRefusal);
    expect(w.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/agent/v1/agents"]);
  });

  it("logout --revoke: Darwin's self-revoke (owner-key branch), exact answer → removed here", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v1/key/revoke", () => json(200, { revoked: true, keyId: "mcpo_k_key_1", changed: true }));
    expect(await w.run("logout", "--revoke")).toBe(0);
    expect(w.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/agent/v1/key/revoke"]);
    expect(w.calls[0]!.headers.authorization).toBe(`Bearer ${MCP_KEY}`);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:acct")).toBeNull();
  });
});

describe("reads go to the owner REST door, never the tool runner", () => {
  it("an agent's read names the agent (X-Darwin-Agent), bearer = the owner key", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v2/balances", () => json(200, { balances: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", atoms: "1500000000", decimals: 9 }] }));
    expect(await w.run("balances", "--agent", "Second", "--json")).toBe(0);
    const call = w.calls.find((c) => c.url.includes("/api/agent/v2/balances"))!;
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBe(`Bearer ${MCP_KEY}`);
    expect(call.headers["x-darwin-agent"]).toBe("agr_2");
    expect(JSON.parse(w.stdout())).toEqual({ status: 200, data: { balances: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", atoms: "1500000000", decimals: 9 }] } });
    noToolRunner(w);
  });

  it("without --agent a read-only key is told to name one — nothing sent to the read", async () => {
    const w = await ownerLoggedIn("none");
    expect(await w.run("balances")).toBe(2);
    expect(w.stderr()).toContain(copy.needAgentOwner);
    expect(w.calls.filter((c) => c.url.includes("/v2/balances"))).toHaveLength(0);
  });

  it("a ONE-agent owner key may leave --agent out: no header, Darwin uses its agent", async () => {
    const w = await ownerLoggedIn("agent");
    w.route("/api/agent/v2/orders", () => json(200, { orders: [] }));
    expect(await w.run("orders", "--json")).toBe(0);
    const call = w.calls.find((c) => c.url.includes("/api/agent/v2/orders"))!;
    expect(call.headers["x-darwin-agent"]).toBeUndefined();
  });

  it("an agent this key may not name is refused locally (Darwin's list), nothing read", async () => {
    const w = await ownerLoggedIn("agent");
    expect(await w.run("balances", "--agent", "agr_other")).toBe(2);
    expect(w.calls.filter((c) => c.url.includes("/v2/balances"))).toHaveLength(0);
  });

  it("path parameters and query fields: tx <sig>, history trades --field", async () => {
    const w = await ownerLoggedIn("none");
    w.route(`/api/agent/v1/tx/${SIG}`, () => json(200, { status: "confirmed" }));
    w.route("/api/agent/v2/trades", () => json(200, { trades: [] }));
    expect(await w.run("tx", SIG, "--agent", "agr_home", "--json")).toBe(0);
    expect(w.calls.some((c) => c.url === `https://darwin.finance/api/agent/v1/tx/${SIG}`)).toBe(true);
    expect(await w.run("history", "trades", "--agent", "agr_home", "--field", "limit=5", "--json")).toBe(0);
    expect(w.calls.some((c) => c.url === "https://darwin.finance/api/agent/v2/trades?limit=5")).toBe(true);
    noToolRunner(w);
  });

  it("market data: POST /api/agent/v1/data/{tool} with the catalogue's own arguments, no agent", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v1/data/search_assets", () => json(200, { results: [{ symbol: "SOL" }] }));
    expect(await w.run("search", "sol", "--json")).toBe(0);
    const call = w.calls.find((c) => c.url.endsWith("/api/agent/v1/data/search_assets"))!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ query: "sol" });
    expect(call.headers["x-darwin-agent"]).toBeUndefined();
    noToolRunner(w);
  });

  it("perps markets (holder door) and market-status (public) name no agent", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v1/markets", () => json(200, { markets: [] }));
    expect(await w.run("perps", "markets", "--json")).toBe(0);
    expect(w.calls.find((c) => c.url.endsWith("/api/agent/v1/markets"))!.headers["x-darwin-agent"]).toBeUndefined();
  });

  it("hello with no agent: Darwin's account-level read-only welcome", async () => {
    const w = await ownerLoggedIn("none", { tty: true });
    w.route("/api/agent/v1/hello", () => json(200, { welcome: "w", ok: true, message: "Hello World", read_only: true, permissions: PERM_NONE }));
    expect(await w.run("hello")).toBe(0);
    expect(w.stdout()).toContain("read-only");
    expect(w.calls.find((c) => c.url.endsWith("/api/agent/v1/hello"))!.headers["x-darwin-agent"]).toBeUndefined();
  });

  it("docs: the public API reference, sectioned locally, sent WITHOUT the key", async () => {
    const w = await ownerLoggedIn("none", { tty: true });
    w.route("/agents/docs/llms.txt", () => new Response("# Ref\n\n## 1. Start\nhello\n\n## 2. Keys\nkeys text\n", { status: 200, headers: { "content-type": "text/markdown" } }));
    expect(await w.run("docs", "2")).toBe(0);
    expect(w.stdout()).toContain("keys text");
    expect(w.stdout()).not.toContain("hello");
    expect(w.calls.find((c) => c.url.endsWith("/agents/docs/llms.txt"))!.headers.authorization).toBeUndefined();
  });

  it("Darwin's refusal (a paused agent) is shown, exit 4", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v2/balances", () => json(403, { error: "agent_paused", message: "This agent is paused." }));
    expect(await w.run("balances", "--agent", "agr_home", "--json")).toBe(4);
    expect(JSON.parse(w.stdout())).toEqual({ status: 403, data: { error: "agent_paused", message: "This agent is paused." } });
  });

  it("an opaque 401 (door off on this site, or revoked) says so", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v2/balances", () => json(401, { error: "unauthorized" }));
    expect(await w.run("balances", "--agent", "agr_home")).toBe(3);
    expect(w.stderr()).toContain(copy.ownerKeyRefused);
  });
});

describe("darwin account", () => {
  it("portfolio / watchlists: the data door, list only", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/api/agent/v1/data/get_portfolio", () => json(200, { total_usd: 10 }));
    w.route("/api/agent/v1/data/manage_watchlist", () => json(200, { watchlists: [] }));
    expect(await w.run("account", "portfolio", "--json")).toBe(0);
    expect(JSON.parse(w.stdout())).toEqual({ status: 200, data: { total_usd: 10 } });
    expect(await w.run("account", "watchlists", "--json")).toBe(0);
    expect(w.calls.find((c) => c.url.endsWith("/manage_watchlist"))!.body).toEqual({ action: "list" });
    noToolRunner(w);
  });

  it("an agent's key is refused locally (it can't read the owner's account)", async () => {
    const w = await loggedIn("agent");
    expect(await w.run("account", "portfolio")).toBe(2);
    expect(w.stderr()).toContain(copy.accountNeedsOwnerKey);
    expect(w.calls).toHaveLength(0);
  });

  it("an unknown section is a usage error", async () => {
    const w = await ownerLoggedIn("none");
    expect(await w.run("account", "withdraw")).toBe(2);
    expect(w.calls).toHaveLength(0);
  });
});

describe("whoami / profiles", () => {
  it("whoami reads Darwin's permission line from /agents (no tool-runner whoami)", async () => {
    const w = await ownerLoggedIn("none");
    expect(await w.run("whoami", "--json")).toBe(0);
    const j = JSON.parse(w.stdout());
    expect(j).toMatchObject({ profile: "acct", kind: "owner", readOnly: true, permissions: PERM_NONE });
    noToolRunner(w);
  });

  it("the profile records the scope, never the key", async () => {
    const w = await ownerLoggedIn("none");
    const toml = readFileSync(join(w.ctx.configDir, "config.toml"), "utf8");
    expect(toml).toContain('kind = "owner"');
    expect(toml).toContain('owner_scope = "none"');
    expect(toml).not.toContain(MCP_KEY);
  });

  it("an owner profile with no scope is refused as incomplete (fail closed)", async () => {
    const w = await ownerLoggedIn("none");
    const p = join(w.ctx.configDir, "config.toml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/owner_scope = "none"\n/, ""));
    expect(await w.run("balances", "--agent", "agr_home")).toBe(1);
    expect(w.calls).toHaveLength(0);
  });
});

describe("login with an existing account key", () => {
  it("--with-key --read-only refuses a key Darwin says trades — nothing saved", async () => {
    const w = world();
    agentsRoute(w, "all_active");
    w.stdin = `${MCP_KEY}\n`;
    expect(await w.run("login", "--with-key", "--read-only")).toBe(2);
    expect(w.stderr()).toContain(copy.readOnlyKeyNotReadOnly);
    w.out.length = 0;
    expect(await w.run("profile", "list", "--json")).toBe(0);
    expect(JSON.parse(w.stdout()).profiles).toEqual([]);
  });

  it("--with-key --read-only refuses an AGENT key outright, before asking Darwin", async () => {
    const w = world();
    w.stdin = `${ONE_KEY}\n`;
    expect(await w.run("login", "--with-key", "--read-only")).toBe(2);
    expect(w.calls).toHaveLength(0);
  });

  it("--key-file version 2 (scope none) imports; a file whose scope Darwin contradicts does not", async () => {
    const w = world();
    agentsRoute(w, "none");
    const f = join(w.ctx.cwd, "k.json");
    writeFileSync(f, JSON.stringify({ type: "darwin-agent-key", version: 2, realm: "darwin.finance", credential: "owner_key", trade: { scope: "none" }, key: MCP_KEY }));
    expect(await w.run("login", "--key-file", f, "--profile", "ro")).toBe(0);
    const w2 = world();
    agentsRoute(w2, "all_active");
    const f2 = join(w2.ctx.cwd, "k.json");
    writeFileSync(f2, JSON.stringify({ type: "darwin-agent-key", version: 2, realm: "darwin.finance", credential: "owner_key", trade: { scope: "none" }, key: MCP_KEY }));
    expect(await w2.run("login", "--key-file", f2)).toBe(3);
    expect(w2.stderr()).toContain(copy.keyFileScopeMismatch);
  });

  it("a version-2 file whose trade shape Darwin never writes is refused", async () => {
    const w = world();
    const f = join(w.ctx.cwd, "k.json");
    writeFileSync(f, JSON.stringify({ type: "darwin-agent-key", version: 2, realm: "darwin.finance", credential: "owner_key", trade: { scope: "none", extra: 1 }, key: MCP_KEY }));
    expect(await w.run("login", "--key-file", f)).toBe(2);
    expect(w.calls).toHaveLength(0);
  });
});

function readOnlyPairing(w: World, echo: Record<string, unknown> = { credential: 2, read_only: "only" }) {
  w.route("/api/agent/v1/pair", () => json(200, {
    device_code: DEVICE, user_code: "BCDF-GHJK", verification_uri: "https://darwin.finance/agents/connect",
    verification_uri_complete: "https://darwin.finance/agents/connect?code=BCDF-GHJK", expires_in: 600, interval: 5, mode: "new", ...echo,
  }));
}

describe("🔴 darwin login --read-only (pairing)", () => {
  it("asks for read-only (credential 2 + read_only only), accepts EXACTLY Darwin's read-only answer, says hello with no agent", async () => {
    const w = world();
    readOnlyPairing(w);
    w.route("/api/agent/v1/pair/token", () => json(200, {
      access_token: MCP_KEY, token_type: "Bearer", credential: "owner_key", trade: { scope: "none" }, read_only: true,
      key_name: "Paired: Command line", permissions: PERM_NONE,
    }));
    w.route("/api/agent/v1/hello", () => json(200, { welcome: "hi", read_only: true }));
    expect(await w.run("login", "--read-only", "--profile", "ro")).toBe(0);
    const start = w.calls.find((c) => c.url.endsWith("/api/agent/v1/pair"))!;
    expect(start.body).toMatchObject({ credential: 2, read_only: "only" });
    expect(JSON.parse(w.stdout())).toMatchObject({ status: "connected", kind: "owner", readOnly: true, profile: "ro", permissions: PERM_NONE });
    expect(w.calls.find((c) => c.url.endsWith("/api/agent/v1/hello"))!.headers["x-darwin-agent"]).toBeUndefined();
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:ro")).toBe(MCP_KEY);
    noToolRunner(w);
  });

  it("in a terminal: Connected read-only, and what to try", async () => {
    const w = world({ tty: true });
    readOnlyPairing(w);
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: MCP_KEY, credential: "owner_key", trade: { scope: "none" }, read_only: true, key_name: "k", permissions: PERM_NONE }));
    expect(await w.run("login", "--read-only", "--no-browser")).toBe(0);
    expect(w.stdout()).toContain("Connected read-only.");
    expect(w.stdout()).toContain(copy.readOnlyTry);
  });

  for (const [label, echo] of [
    ["no echo (an older Darwin)", {}],
    ["credential only", { credential: 2 }],
    ["read_only allowed", { credential: 2, read_only: "allowed" }],
  ] as const) {
    it(`refuses without the exact echo — ${label}: no link, nothing pending`, async () => {
      const w = world();
      readOnlyPairing(w, echo as Record<string, unknown>);
      expect(await w.run("login", "--read-only")).toBe(4);
      expect(w.stderr()).toContain(copy.readOnlyUnsupported);
      expect(w.stderr()).not.toContain("BCDF-GHJK");
      expect(w.calls.filter((c) => c.url.includes("/pair/token"))).toHaveLength(0);
      expect(await w.run("login", "--wait")).toBe(2);
      expect(w.stderr()).toContain("No pairing is waiting");
    });
  }

  it("a read-only start drops an OLDER pairing waiting here, even when Darwin then fails", async () => {
    const w = world();
    w.route("/api/agent/v1/pair", () => json(200, {
      device_code: DEVICE, user_code: "BCDF-GHJK", verification_uri_complete: "https://darwin.finance/agents/connect?code=BCDF-GHJK", expires_in: 600, interval: 5, mode: "new",
    }));
    expect(await w.run("login", "--start")).toBe(0);
    w.route("/api/agent/v1/pair", () => json(503, { error: "unavailable" }));
    expect(await w.run("login", "--read-only")).toBe(4);
    expect(await w.run("login", "--wait")).toBe(2);
    expect(w.stderr()).toContain("No pairing is waiting");
  });

  for (const [label, answer] of [
    ["an agent key", { access_token: ONE_KEY, agent: { id: "agr_x", name: "X" } }],
    ["an owner key that trades one agent", { access_token: MCP_KEY, credential: "owner_key", trade: { scope: "agent", agent: "agr_x" } }],
    ["an owner key that trades all", { access_token: MCP_KEY, credential: "owner_key", trade: { scope: "all_active" }, read_only: true }],
    ["scope none without read_only: true", { access_token: MCP_KEY, credential: "owner_key", trade: { scope: "none" } }],
    ["scope none with an extra field", { access_token: MCP_KEY, credential: "owner_key", trade: { scope: "none", agent: "agr_x" }, read_only: true }],
  ] as const) {
    it(`🔴 the pickup refuses ${label} — nothing saved, the user is told to revoke it`, async () => {
      const w = world();
      readOnlyPairing(w);
      w.route("/api/agent/v1/pair/token", () => json(200, { key_name: "Paired: Command line", ...answer }));
      expect(await w.run("login", "--read-only")).toBe(4);
      expect(w.stderr()).toContain("Revoke the API key \"Paired: Command line\"");
      expect(w.keychain.get("finance.darwin.cli", "darwin.finance:read-only")).toBeNull();
      expect(readFileSync(join(w.ctx.configDir, "config.toml"), { flag: "a+" }).toString()).not.toContain("[profiles.");
    });
  }

  it("🔴 `--wait --read-only` never redeems an ORDINARY pairing (codex r1 P1): refused, nothing polled or saved", async () => {
    const w = world();
    readOnlyPairing(w, {});
    expect(await w.run("login", "--start")).toBe(0);
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: ONE_KEY, agent: { id: "agr_x", name: "X" }, key_name: "k" }));
    expect(await w.run("login", "--wait", "--read-only")).toBe(2);
    expect(w.calls.filter((c) => c.url.includes("/pair/token"))).toHaveLength(0);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:x")).toBeNull();
  });

  it("--start / --wait keep the read-only demand across the two steps", async () => {
    const w = world();
    readOnlyPairing(w);
    expect(await w.run("login", "--read-only", "--start")).toBe(0);
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: ONE_KEY, agent: { id: "agr_x", name: "X" }, key_name: "k" }));
    expect(await w.run("login", "--wait")).toBe(4);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:x")).toBeNull();
  });

  it("an ordinary (agent) pairing that gets an account key back refuses it", async () => {
    const w = world();
    readOnlyPairing(w, {});
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: MCP_KEY, credential: "owner_key", trade: { scope: "none" }, read_only: true, key_name: "k" }));
    expect(await w.run("login")).toBe(1);
    expect(w.stderr()).toContain("didn't ask for");
    expect(w.calls.find((c) => c.url.endsWith("/api/agent/v1/pair"))!.body).toEqual({ client_name: "Command line" });
  });

  it("--read-only with --reconnect is a usage error", async () => {
    const w = world();
    expect(await w.run("login", "--read-only", "--reconnect")).toBe(2);
    expect(w.calls).toHaveLength(0);
  });
});

describe("darwin mcp with an account-level key", () => {
  const replies = (s: string) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("lists reads only (no write, no quote, no prepared tools) and refuses a trade without sending", async () => {
    const w = world({ env: { DARWIN_API_KEY: MCP_KEY } });
    agentsRoute(w, "none");
    w.route("/api/agent/v2/balances", () => json(200, { balances: [] }));
    w.stdin = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "place_spot_order", arguments: { quoteId: "q" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_balances", arguments: { agent: "Second" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "check_prepared", arguments: { preparedId: `prp_${"a".repeat(24)}` } } }),
    ].join("\n");
    expect(await w.run("mcp")).toBe(0);
    const r = replies(w.stdout());
    const names = r[0].result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_balances");
    expect(names).toContain("search_assets");
    for (const n of ["place_spot_order", "spot_order_now", "get_spot_quote", "pause_agent", "check_prepared", "cancel_prepared"]) expect(names).not.toContain(n);
    expect(r[1].result.isError).toBe(true);
    expect(r[1].result.structuredContent.error).toBe("read_only");
    expect(r[2].result.isError).toBe(false);
    expect(r[3].result.isError).toBe(true);
    expect(w.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.calls.find((c) => c.url.endsWith("/v2/balances"))!.headers["x-darwin-agent"]).toBe("agr_2");
    noToolRunner(w);
  });
});

describe("catalogue for an account-level key", () => {
  it("is the PUBLIC one (no key sent), cached apart from an agent key's", async () => {
    const w = await ownerLoggedIn("none");
    w.route("/agents/cli/catalog.json", () => json(200, catalogueFor("agent")));
    w.route("/api/agent/v1/data/get_news", () => json(200, { items: [] }));
    expect(await w.run("news", "sol", "--json")).toBe(0);
    noToolRunner(w);
    const cat = w.calls.find((c) => c.url.endsWith("/agents/cli/catalog.json"));
    if (cat) expect(cat.headers.authorization).toBeUndefined();
  });
});

const PID = `prp_${"P".repeat(24)}`;

describe("✅ an account-level key that TRADES: Darwin's owner CLI door — the same runner, never /tools", () => {
  function serveOwner(w: World, tool: string, seen: { prepare?: Call; execute?: Call } = {}) {
    w.route(`/api/agent/v1/owner-cli/call/${tool}/prepare`, (c) => { seen.prepare = c; return json(200, { tool, isError: false, result: { preparedId: PID, summary: {}, request: {}, costsTx: true }, cli: { lines: ["Checked."] } }); });
    w.route("/api/agent/v1/owner-cli/execute", (c) => { seen.execute = c; return json(200, { tool, preparedId: PID, state: "done", isError: false, verdict: "sent", result: { status: 200, data: { ok: true } }, cli: { lines: ["Sent."] } }); });
    w.route("/api/agent/v1/owner-cli/status", () => json(200, { tool, preparedId: PID, verdict: "landed", state: "done", cli: { lines: ["This order went through: confirmed on chain."] } }));
  }

  it("all sub-accounts: prepare → execute on owner-cli, naming the agent; nothing to /tools", async () => {
    const w = await ownerLoggedIn("all_active", { tty: true });
    const seen: { prepare?: Call; execute?: Call } = {};
    serveOwner(w, "spot_order_now", seen);
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50", "--agent", "Second")).toBe(0);
    expect(seen.prepare!.headers["x-darwin-agent"]).toBe("agr_2");
    expect(seen.prepare!.headers.authorization).toBe(`Bearer ${MCP_KEY}`);
    expect(seen.prepare!.body).toEqual({ arguments: { sell: "SOL", amount: "0.1", for: "USDC", maxSlippageBps: 50 } });
    expect(seen.execute!.body).toEqual({ preparedId: PID });
    expect(seen.execute!.headers["x-darwin-agent"]).toBe("agr_2");
    noToolRunner(w);
  });

  it("all sub-accounts without --agent: told to name one, nothing sent to owner-cli", async () => {
    const w = await ownerLoggedIn("all_active");
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(2);
    expect(w.stderr()).toContain(copy.needAgentOwner);
    expect(w.calls.filter((c) => c.url.includes("/owner-cli/"))).toHaveLength(0);
  });

  it("ONE sub-account: may leave --agent out (no header; Darwin's door uses its one agent)", async () => {
    const w = await ownerLoggedIn("agent", { tty: true });
    const seen: { prepare?: Call; execute?: Call } = {};
    serveOwner(w, "place_spot_order", seen);
    expect(await w.run("order", "--quote", "q_1")).toBe(0);
    expect(seen.prepare!.headers["x-darwin-agent"]).toBeUndefined();
  });

  it("a quote and pause go to owner-cli/call/{name}", async () => {
    const w = await ownerLoggedIn("all_active");
    w.route("/api/agent/v1/owner-cli/call/get_spot_quote", () => json(200, { tool: "get_spot_quote", isError: false, result: { status: 200, data: { quoteId: "q_1" } } }));
    w.route("/api/agent/v1/owner-cli/call/pause_agent", () => json(200, { tool: "pause_agent", isError: false, result: { status: 200, data: { paused: true } } }));
    expect(await w.run("quote", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--agent", "agr_home", "--json")).toBe(0);
    expect(await w.run("pause", "--agent", "agr_home", "--json")).toBe(0);
    const q = w.calls.find((c) => c.url.endsWith("/owner-cli/call/get_spot_quote"))!;
    expect(q.body).toEqual({ arguments: { sell: "USDC", amount: "1", for: "SOL" } });
    expect(q.headers["x-darwin-agent"]).toBe("agr_home");
    expect(w.calls.some((c) => c.url.endsWith("/owner-cli/call/pause_agent"))).toBe(true);
    noToolRunner(w);
  });

  it("retry / cancel read and cancel THIS key's order on owner-cli/status|cancel", async () => {
    const w = await ownerLoggedIn("all_active");
    w.route("/api/agent/v1/owner-cli/status", () => json(200, { tool: "spot_order_now", preparedId: PID, verdict: "landed", cli: { lines: ["ok"] } }));
    w.route("/api/agent/v1/owner-cli/cancel", () => json(200, { tool: "spot_order_now", preparedId: PID, verdict: "never_sent", cancelled: true, cli: { lines: ["ok"] } }));
    expect(await w.run("retry", PID, "--agent", "agr_home", "--json")).toBe(0);
    expect(await w.run("cancel", PID, "--agent", "agr_home", "--json")).toBe(0);
    expect(w.calls.filter((c) => c.url.includes("/owner-cli/")).map((c) => [new URL(c.url).pathname, c.headers["x-darwin-agent"], c.body])).toEqual([
      ["/api/agent/v1/owner-cli/status", "agr_home", { preparedId: PID }],
      ["/api/agent/v1/owner-cli/cancel", "agr_home", { preparedId: PID }],
    ]);
    noToolRunner(w);
  });

  it("a site without the owner door (prepare 404): refused — NEVER a direct fallback", async () => {
    const w = await ownerLoggedIn("all_active");
    w.route("/api/agent/v1/owner-cli/call/spot_order_now/prepare", () => json(404, { error: "not_found" }));
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50", "--agent", "agr_home")).toBe(4);
    expect(w.stderr()).toContain(copy.ownerTradingUnavailable);
    expect(w.calls.filter((c) => c.url.endsWith("/owner-cli/call/spot_order_now"))).toHaveLength(0);
    noToolRunner(w);
  });

  it("darwin mcp: trades and recovery tools are listed and run through owner-cli", async () => {
    const w = world({ env: { DARWIN_API_KEY: MCP_KEY } });
    agentsRoute(w, "all_active");
    serveOwner(w, "place_spot_order");
    w.stdin = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "place_spot_order", arguments: { quoteId: "q_1", agent: "agr_home" } } }),
    ].join("\n");
    expect(await w.run("mcp")).toBe(0);
    const r = w.stdout().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const names = r[0].result.tools.map((t: { name: string }) => t.name);
    for (const n of ["place_spot_order", "get_spot_quote", "check_prepared", "cancel_prepared"]) expect(names).toContain(n);
    expect(r[1].result.isError).toBe(false);
    expect(w.calls.find((c) => c.url.endsWith("/owner-cli/call/place_spot_order/prepare"))!.headers["x-darwin-agent"]).toBe("agr_home");
    noToolRunner(w);
  });
});
