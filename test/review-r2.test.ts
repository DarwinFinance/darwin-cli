/** Regression tests for codex review round 2 (M3). */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { json, loggedIn, ONE_KEY, world } from "./harness.js";

const NEW_KEY = `darwinAI_agent_${"n".repeat(40)}`;

describe("codex r2", () => {
  it("#1 a percent-encoded device code in the server's link is never printed (the link is built locally)", async () => {
    const w = world();
    const device = `darwinAI_pair_${"d".repeat(60)}`;
    w.route("/api/agent/v1/pair", () => json(200, { device_code: device, user_code: "BCDF-GHJK", verification_uri_complete: `https://darwin.finance/agents/connect?x=%64${"d".repeat(59)}`, expires_in: 600, interval: 5 }));
    expect(await w.run("login", "--start")).toBe(0);
    expect(w.stdout()).not.toContain("d".repeat(59));
    expect(JSON.parse(w.stdout()).verification_uri_complete).toBe("https://darwin.finance/agents/connect?code=BCDF-GHJK");
  });

  it("#2 agent-list fields of the wrong shape are dropped before caching", async () => {
    const w = await loggedIn("agents");
    w.route("/api/agent/v1/agents", () => json(200, { agents: [{ id: "agr_2", name: "Second", solanaAddress: ONE_KEY, status: ONE_KEY }] }));
    w.route("/api/agent/v1/tools/call/get_balances", () => json(200, { tool: "get_balances", isError: false, result: { status: 200, data: {} } }));
    expect(await w.run("balances", "--agent", "Second", "--json")).toBe(0);
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = join(w.ctx.configDir, "cache");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toContain("ONEKEY");
  });

  it("#3 an unreadable existing key is never overwritten or deleted", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_home", homeAgentName: "Laptop bot" }));
    const realGet = w.keychain.get;
    w.keychain.get = (s, a, t) => { if (a === "darwin.finance:bot") throw new Error("locked"); return realGet(s, a, t); };
    w.stdin = NEW_KEY;
    expect(await w.run("login", "--with-key", "--profile", "bot")).toBe(1);
    w.keychain.get = realGet;
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBe(ONE_KEY);
  });

  it("#4 a login that lands while a revoke is in flight is not deleted by the revoke", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/key/revoke", async () => {
      // Another terminal re-logs this profile with a new key meanwhile.
      w.keychain.set("finance.darwin.cli", "darwin.finance:bot", NEW_KEY);
      return json(200, { revoked: true, keyId: "t", changed: true });
    });
    expect(await w.run("logout", "--revoke")).toBe(1);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBe(NEW_KEY);
    expect(w.stderr()).toContain("changed while this ran");
  });

  it.skipIf(process.platform === "win32")("#5 moving a profile from the keychain to a file removes the keychain copy (and back)", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_home", homeAgentName: "Laptop bot" }));
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key", "--profile", "bot", "--store", "file")).toBe(0);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBeNull();
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key", "--profile", "bot")).toBe(0);
    expect(existsSync(join(w.ctx.configDir, "credentials", "darwin.finance__bot"))).toBe(false);
  });

  it("#7 a rate-limited import exits 5", async () => {
    const w = world();
    w.route("/api/agent/v1/tools/whoami", () => json(429, { error: "rate_limited" }));
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key")).toBe(5);
  });
});
