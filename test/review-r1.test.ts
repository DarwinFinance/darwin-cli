/** Regression tests for codex review round 1 (M3). */
import { describe, expect, it } from "bun:test";
import { ALL_KEY, catalogueFor, json, loggedIn, ONE_KEY, world } from "./harness.js";
import { validateCatalogue } from "../src/catalogue.js";
import { installProblem } from "../src/guard.js";

const order = ["order", "--quote", "aqt_1", "--sell", "SOL", "--amount", "1", "--for", "USDC"];

describe("codex r1", () => {
  it("#1 --dry-run=true is a dry run; a bad value is refused; no order is sent", async () => {
    const w = await loggedIn();
    expect(await w.run(...order, "--dry-run=true", "--json")).toBe(0);
    expect(await w.run(...order, "--dry-run=yes", "--json")).toBe(2);
    // v1.1: a dry run asks Darwin to check it (prepare, dryRun) — never the order, never execute.
    expect(w.calls.filter((c) => c.url.includes("/tools/call/") && !c.url.endsWith("/prepare"))).toHaveLength(0);
    expect(w.calls.filter((c) => c.url.endsWith("/prepare")).every((c) => (c.body as { dryRun?: boolean }).dryRun === true)).toBe(true);
  });

  it("#2 a malformed 200 (or a 5xx carrying any error) after a write is uncertain → 6", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/call/place_spot_order", () => json(200, {}));
    expect(await w.run(...order, "--json")).toBe(6);
    w.route("/api/agent/v1/tools/call/place_spot_order", () => json(503, { error: "cli_upgrade_required", minCli: "9.9.9" }));
    expect(await w.run(...order, "--json")).toBe(6);
    w.route("/api/agent/v1/tools/call/place_spot_order", () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await w.run(...order, "--json")).toBe(6);
  });

  it("#3 a pairing link carrying the device code (or escapes) is never shown", async () => {
    const w = world();
    const device = `darwinAI_pair_${"d".repeat(60)}`;
    w.route("/api/agent/v1/pair", () => json(200, { device_code: device, user_code: "BCDF-GHJK", verification_uri_complete: `https://darwin.finance/agents/connect?code=${device}`, expires_in: 600, interval: 5 }));
    expect(await w.run("login")).toBe(1);
    expect(w.stderr() + w.stdout()).not.toContain("d".repeat(60));
  });

  it("#4 a key-shaped id from the server is never persisted", async () => {
    const w = world();
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: `darwinAI_agent_${"x".repeat(30)}`, homeAgentName: "A" }));
    w.route("/api/agent/v1/agents", () => json(200, { agents: [] }));
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key")).not.toBe(0);
    expect(w.keychain.items.size).toBe(0);
    const bad = catalogueFor("agent");
    bad.instructions = `use darwinAI_agent_${"y".repeat(30)}`;
    expect(validateCatalogue(bad).join()).toContain("credential-shaped");
  });

  it("#5 nested node_modules (pnpm) under the cwd is refused", () => {
    expect(installProblem({ scriptPath: "/p/node_modules/.pnpm/@darwin.finance+cli@1.0.0/node_modules/@darwin.finance/cli/dist/darwin.js", cwd: "/p" })).toBe("workspace");
  });

  it("#6 doctor from npx touches neither the keychain nor the profiles", async () => {
    const w = world({ scriptPath: "/h/.npm/_npx/1/node_modules/@darwin.finance/cli/dist/darwin.js" });
    const before = w.keychain.items.size;
    let touched = false;
    const real = w.keychain.set;
    w.keychain.set = (...a) => { touched = true; return real(...a); };
    expect(await w.run("doctor", "--json")).toBe(0);
    expect(touched).toBe(false);
    expect(w.keychain.items.size).toBe(before);
  });

  it("#7 a profile named pending-pairing is not clobbered by a pairing", async () => {
    const w = await loggedIn("agent");
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_pp", homeAgentName: "PP" }));
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key", "--profile", "pending-pairing")).toBe(0);
    w.route("/api/agent/v1/pair", () => json(200, { device_code: `darwinAI_pair_${"e".repeat(60)}`, user_code: "BCDF-GHJK", verification_uri_complete: "https://darwin.finance/agents/connect?code=BCDF-GHJK", expires_in: 600, interval: 5 }));
    expect(await w.run("login", "--start")).toBe(0);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:pending-pairing")).toBe(ONE_KEY);
  });

  it("#8 a failed re-save restores the key that was there", async () => {
    const w = await loggedIn();
    const real = w.keychain.set;
    let n = 0;
    w.keychain.set = (s, a, v, t) => { if (a === "darwin.finance:bot" && v !== ONE_KEY && ++n) throw new Error("locked"); return real(s, a, v, t); };
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_home", homeAgentName: "Laptop bot" }));
    w.stdin = `darwinAI_agent_${"n".repeat(40)}`;
    expect(await w.run("login", "--with-key", "--profile", "bot")).toBe(1);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBe(ONE_KEY);
  });

  it("#10 application/json-evil is not the exact success", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/key/revoke", () => new Response(JSON.stringify({ revoked: true, keyId: "t", changed: true }), { status: 200, headers: { "content-type": "application/json-evil" } }));
    expect(await w.run("logout", "--revoke")).toBe(4);
    expect([...w.keychain.items.values()]).toContain(ONE_KEY);
  });

  it("#11 a key that can't be deleted keeps its profile", async () => {
    const w = await loggedIn();
    w.keychain.delete = () => false;
    expect(await w.run("logout")).toBe(1);
    expect(w.stderr()).toContain("so the profile was kept");
    expect(await w.run("profile", "list", "--json")).toBe(0);
    expect(w.stdout()).toContain('"profile": "bot"');
  });

  it("#13 an all-agents --dry-run sends no request at all", async () => {
    const w = await loggedIn("agents");
    expect(await w.run("balances", "--agent", "Second", "--dry-run", "--json")).toBe(0);
    expect(w.calls).toHaveLength(0);
  });

  it("#14 --store file refuses a credentials dir others can read", async () => {
    const { mkdirSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (process.platform === "win32") return;
    const w = world();
    mkdirSync(join(w.ctx.configDir, "credentials"), { mode: 0o755 });
    chmodSync(join(w.ctx.configDir, "credentials"), 0o755);
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key", "--store", "file")).toBe(3);
    expect(w.calls).toHaveLength(0);
  });

  it("#15 malformed catalogue structures are refused", () => {
    const c = catalogueFor("agent");
    c.tools[0].inputSchema.required = {};
    c.tools[1].cli.headers = { x: 1 };
    const errs = validateCatalogue(c).join();
    expect(errs).toContain("inputSchema");
    expect(errs).toContain("unexpected cli key headers");
  });

  it("#17 whoami: network failure is exit 8, still printing what it knows", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/whoami", () => "throw-before-send");
    expect(await w.run("whoami", "--format", "table")).toBe(8);
    expect(w.stdout()).toContain('API key "name unavailable"');
    void ALL_KEY;
  });
});
