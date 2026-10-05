/** `darwin login` / `logout` / `whoami` / profiles (plan §3, copy C.26–C.33, C.47, C.59, C.63–C.71). */
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_KEY, json, loggedIn, ONE_KEY, world } from "./harness.js";
import { copy } from "../src/copy.js";
import { brandSkeleton, detectClientName, validClientName } from "../src/login.js";

const DEVICE = `darwinAI_pair_${"d".repeat(60)}`;

function pairing(w: ReturnType<typeof world>, realm = "darwin.finance", extra: Record<string, unknown> = {}) {
  w.route("/api/agent/v1/pair", (c) => json(200, {
    device_code: DEVICE, user_code: "BCDF-GHJK", verification_uri: `https://${realm}/agents/connect`,
    verification_uri_complete: `https://${realm}/agents/connect?code=BCDF-GHJK`, expires_in: 600, interval: 5,
    mode: (c.body as { mode?: string })?.mode ?? "new", ...extra,
  }));
}

describe("pairing", () => {
  it("probes the secret store BEFORE asking for a code (C.28) — nothing is started without one", async () => {
    const w = world({ brokenKeychain: true });
    pairing(w);
    expect(await w.run("login")).toBe(3);
    expect(w.stderr()).toContain("Nothing was started: there's no secure place to keep the API key");
    expect(w.calls).toHaveLength(0);
  });

  it("C.47: with DARWIN_API_KEY set there's nowhere to save a new key", async () => {
    const w = world({ env: { DARWIN_API_KEY: ONE_KEY } });
    expect(await w.run("login")).toBe(2);
    expect(w.stderr()).toContain(copy.envKeySet);
  });

  it("pairs, shows C.26, polls, saves the key, says hello, and prints C.27", async () => {
    const w = world({ env: { CLAUDECODE: "1" } });
    pairing(w);
    let polls = 0;
    w.route("/api/agent/v1/pair/token", () => (++polls < 3 ? json(400, { error: "authorization_pending" }) : json(200, {
      access_token: ONE_KEY, token_type: "Bearer", agent: { id: "agr_new", name: "Claude bot" }, key_name: "Paired: Claude Code",
      mode: "new", permissions: "Read: this agent · Trade: this agent", all_agents: false,
    })));
    w.route("/api/agent/v1/hello", () => json(200, { welcome: "Welcome!\u001b[2J ```\nAddr\n```", solanaAddress: "So11111111111111111111111111111111111111112", agentPageUrl: "https://darwin.finance/agent-account/agr_new", instructions: "Show `welcome` to your user verbatim" }));
    expect(await w.run("login", "--format", "table")).toBe(0);
    expect((w.calls[0]!.body as { client_name: string }).client_name).toBe("Claude Code");
    expect(w.stderr()).toContain("To connect this terminal to Darwin, open this link and approve with your passkey:\n  https://darwin.finance/agents/connect?code=BCDF-GHJK\n  Code: BCDF-GHJK");
    expect(polls).toBe(3);
    // A terminal gets the CLI's own short welcome, built from hello's structured fields — never the chat-app prose.
    expect(w.stdout()).not.toContain("Welcome!");
    expect(w.stdout()).not.toContain("```");
    expect(w.stdout()).not.toContain("verbatim");
    expect(w.stdout()).toContain("Agent: Claude bot on darwin.finance\nAgent wallet (fund it to trade): So11111111111111111111111111111111111111112\nAgent page: https://darwin.finance/agent-account/agr_new\nTry: darwin market-status");
    expect(w.stdout()).not.toContain("\u001b");
    expect(w.stdout()).toContain(`Connected. Your API key is saved in the test keychain as profile "claude-bot". Read: this agent · Trade: this agent.`);
    expect(w.stdout() + w.stderr()).not.toContain(ONE_KEY);
    expect(w.stdout() + w.stderr()).not.toContain(DEVICE);
    expect(w.calls.find((c) => c.url.endsWith("/hello"))!.headers["x-darwin-agent"]).toBeUndefined();
  });

  it("🔴 the link shown is built from the realm + user code — a link the server names is never shown", async () => {
    const w = world();
    pairing(w, "evil.example");
    await w.run("login");
    expect(w.stderr()).toContain("https://darwin.finance/agents/connect?code=BCDF-GHJK");
    expect(w.stderr()).not.toContain("evil.example");
  });

  it("all-agents pickup (C.52): home agent saved as the default; hello names it", async () => {
    const w = world();
    pairing(w, "beta.darwin.finance");
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: ALL_KEY, agent: { id: "agr_home", name: "Home" }, key_name: "Paired: x", all_agents: true }));
    w.route("/api/agent/v1/hello", () => json(200, {}));
    expect(await w.run("login", "--beta", "--profile", "all", "--format", "table")).toBe(0);
    expect(w.calls.find((c) => c.url.endsWith("/hello"))!.headers["x-darwin-agent"]).toBe("agr_home");
    expect(w.stdout()).toContain(`Read: all agents · Trade: all active agents. Commands act on Home unless you pass --agent.`);
    const cfg = readFileSync(join(w.ctx.configDir, "config.toml"), "utf8");
    expect(cfg).toContain('kind = "agents"');
    expect(cfg).toContain('default_agent = "agr_home"');
    expect(cfg).toContain('realm = "beta.darwin.finance"');
  });

  it("a prefix that disagrees with all_agents is saved by its prefix, with a warning", async () => {
    const w = world();
    pairing(w);
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: ONE_KEY, agent: { id: "agr_1", name: "A" }, all_agents: true }));
    expect(await w.run("login")).toBe(0);
    expect(w.stderr()).toContain("its prefix says otherwise");
  });

  it("--reconnect refuses a server that didn't echo the mode", async () => {
    const w = world();
    pairing(w, "darwin.finance", { mode: "new" });
    expect(await w.run("login", "--reconnect")).toBe(1);
    expect(w.calls.filter((c) => c.url.endsWith("/pair/token"))).toHaveLength(0);
  });

  it("C.59: the key arrives but can't be saved → the owner is told which key to revoke, and the key is NOT printed", async () => {
    const w = world();
    pairing(w);
    w.route("/api/agent/v1/pair/token", () => json(200, { access_token: ONE_KEY, agent: { id: "agr_1", name: "Bot" }, key_name: "Paired: Command line" }));
    const real = w.keychain.set;
    let probe = true;
    w.keychain.set = (s, a, v, t) => { if (probe && a.startsWith("probe:")) return real(s, a, v, t); throw new Error("locked"); };
    expect(await w.run("login")).toBe(1);
    expect(w.stderr()).toContain(copy.keyNotSaved("Paired: Command line", "Bot", "https://darwin.finance/agent-account/agr_1/manage"));
    expect(w.stdout() + w.stderr()).not.toContain(ONE_KEY);
    probe = false;
  });

  it("--start / --wait split the flow; the device code is kept in the secret store, never printed", async () => {
    const w = world();
    pairing(w);
    expect(await w.run("login", "--start")).toBe(0);
    const started = JSON.parse(w.stdout());
    expect(started).toMatchObject({ user_code: "BCDF-GHJK", next: "darwin login --wait" });
    expect(w.stdout()).not.toContain(DEVICE);
    w.route("/api/agent/v1/pair/token", (c) => {
      expect((c.body as { device_code: string }).device_code).toBe(DEVICE);
      return json(200, { access_token: ONE_KEY, agent: { id: "agr_1", name: "Bot" } });
    });
    w.out.length = 0;
    expect(await w.run("login", "--wait", "--json")).toBe(0);
    expect(JSON.parse(w.stdout())).toMatchObject({ status: "connected", agentId: "agr_1" });
    expect(await w.run("login", "--wait")).toBe(2); // the pending pairing is gone
  });

  it("client names: never Darwin; detected from the host agent", () => {
    expect(() => validClientName("Darwin CLI")).toThrow();
    expect(() => validClientName("D-a-r-w-1-n bot")).toThrow();
    expect(brandSkeleton("DARWlN")).toBe("darwin");
    expect(validClientName("Claude Code")).toBe("Claude Code");
    expect(detectClientName({ CODEX_HOME: "/x" })).toBe("Codex");
    expect(detectClientName({})).toBe("Command line");
  });
});

describe("importing a key", () => {
  it("--with-key reads stdin, proves it with whoami, saves it (C.27)", async () => {
    const w = await loggedIn();
    expect(w.keychain.items.size).toBeGreaterThan(0);
  });

  it("a refused key is not saved", async () => {
    const w = world();
    w.route("/api/agent/v1/tools/whoami", () => json(401, { error: "unauthorized" }));
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key")).toBe(3);
    expect(w.keychain.items.size).toBe(0);
  });

  it("--key-file: realm mismatch is refused (C.31); a matching file imports, --delete-file deletes it", async () => {
    const w = world();
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_9", homeAgentName: "Nine" }));
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_9", homeAgentName: "Nine" }));
    const f = join(w.ctx.configDir, "darwin-beta-agent-key.json");
    writeFileSync(f, JSON.stringify({ type: "darwin-agent-key", version: 1, realm: "beta.darwin.finance", agent_id: "agr_9", key: ONE_KEY }));
    expect(await w.run("login", "--key-file", f, "--prod")).toBe(2);
    expect(w.stderr()).toContain(copy.keyFileRealm("beta.darwin.finance", "darwin.finance"));
    expect(w.calls).toHaveLength(0);
    expect(await w.run("login", "--key-file", f, "--delete-file")).toBe(0);
    expect(w.calls[0]!.url).toBe("https://beta.darwin.finance/api/agent/v1/tools/whoami");
    expect(existsSync(f)).toBe(false);
  });

  it("an older server without whoami: the agents list identifies the key", async () => {
    const w = world();
    w.route("/api/agent/v1/agents", () => json(200, { agents: [{ id: "agr_o", name: "Old" }] }));
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key")).toBe(0);
    expect(readFileSync(join(w.ctx.configDir, "config.toml"), "utf8")).toContain('agent_id = "agr_o"');
  });
});

describe("--from-skill (Q10b)", () => {
  function skillWorld() {
    const w = world();
    const dir = join(w.ctx.configDir, "..", "skill-state");
    mkdirSync(dir, { mode: 0o700 });
    w.ctx.env.DARWIN_SKILL_STATE_DIR = dir;
    const idx = join(dir, "keys.json");
    writeFileSync(idx, JSON.stringify({ v: 1, keys: [{ realm: "beta", agent_id: "agr_s", agent: "Skill bot", stored_in: "macos-keychain", extra: 1 }, { realm: "prod", agent_id: "agr_p", agent: "P", stored_in: "macos-keychain" }] }));
    chmodSync(idx, 0o600);
    w.keychain.set("finance.darwin.agent-skill", "beta.darwin.finance:agr_s", ONE_KEY);
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "Paired: skill", homeAgentId: "agr_s", homeAgentName: "Skill bot" }));
    return { w, dir, idx };
  }

  it("imports the skill's key into the CLI's own store, verified, and keeps the skill's copy (C.69)", async () => {
    const { w } = skillWorld();
    expect(await w.run("login", "--from-skill", "--beta")).toBe(0);
    expect(w.stdout()).toContain("Imported the API key for Skill bot that the Darwin skill saved. It's now in the test keychain as profile \"skill-bot-beta\".");
    expect(w.keychain.get("finance.darwin.cli", "beta.darwin.finance:skill-bot-beta")).toBe(ONE_KEY);
    expect(w.keychain.get("finance.darwin.agent-skill", "beta.darwin.finance:agr_s")).toBe(ONE_KEY);
    expect(w.calls[0]!.url).toBe("https://beta.darwin.finance/api/agent/v1/tools/whoami");
  });

  it("several saved keys → pick one", async () => {
    const { w } = skillWorld();
    expect(await w.run("login", "--from-skill")).toBe(2);
    expect(w.stderr()).toContain("pick one with --agent-id");
  });

  it.skipIf(process.platform === "win32")("--delete-skill-copy deletes it under the skill's lock, keeping other entries and unknown fields", async () => {
    const { w, idx } = skillWorld();
    expect(await w.run("login", "--from-skill", "--beta", "--delete-skill-copy")).toBe(0);
    expect(w.keychain.get("finance.darwin.agent-skill", "beta.darwin.finance:agr_s")).toBeNull();
    const after = JSON.parse(readFileSync(idx, "utf8"));
    expect(after.keys).toEqual([{ realm: "prod", agent_id: "agr_p", agent: "P", stored_in: "macos-keychain" }]);
    expect(w.stdout()).toContain("Deleted the Darwin skill's copy");
  });

  it.skipIf(process.platform === "win32")("C.71: if the skill's key changed in between, it is left alone", async () => {
    const { w } = skillWorld();
    const real = w.keychain.get;
    let reads = 0;
    w.keychain.get = (s, a, t) => {
      if (s === "finance.darwin.agent-skill" && ++reads > 1) return `darwinAI_agent_${"n".repeat(40)}`;
      return real(s, a, t);
    };
    expect(await w.run("login", "--from-skill", "--beta", "--delete-skill-copy")).toBe(0);
    expect(w.stderr()).toContain(copy.skillChanged);
    w.keychain.get = real;
    expect(w.keychain.get("finance.darwin.agent-skill", "beta.darwin.finance:agr_s")).toBe(ONE_KEY);
  });
});

describe("logout and self-revoke (§3.5)", () => {
  it("logout removes the key and says it still works until revoked (C.32)", async () => {
    const w = await loggedIn();
    expect(await w.run("logout")).toBe(0);
    expect(w.stdout()).toContain(copy.loggedOut("bot", "https://darwin.finance/agent-account/agr_home/manage"));
    expect([...w.keychain.items.values()]).not.toContain(ONE_KEY);
  });

  it("--revoke: ONLY the exact JSON success deletes the local copy (C.63)", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/key/revoke", (c) => { expect(c.body).toEqual({}); return json(200, { revoked: true, keyId: "tok_1", changed: true }); });
    expect(await w.run("logout", "--revoke")).toBe(0);
    expect(w.stdout()).toContain(copy.revoked("laptop key", "Laptop bot"));
    expect([...w.keychain.items.values()]).not.toContain(ONE_KEY);
    expect(w.calls.find((c) => c.url.endsWith("/key/revoke"))!.headers["x-darwin-agent"]).toBeUndefined();
  });

  for (const [label, res] of [
    ["an old build's 200 text/html", () => new Response("<html>invite</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["an opaque 401", () => json(401, { error: "unauthorized" })],
    ["a 404", () => json(404, { error: "not_found" })],
    ["an unexpected body", () => json(200, { revoked: true })],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "/invite" } })],
  ] as const) {
    it(`--revoke not confirmed on ${label}: key kept, C.65`, async () => {
      const w = await loggedIn();
      w.route("/api/agent/v1/key/revoke", res as () => Response);
      expect(await w.run("logout", "--revoke")).toBe(4);
      expect(w.stderr()).toContain(copy.revokeNotConfirmed("Laptop bot", "https://darwin.finance/agent-account/agr_home/manage"));
      expect([...w.keychain.items.values()]).toContain(ONE_KEY);
    });
  }

  it("--revoke with an all-agents key warns first (C.64) and sends no agent", async () => {
    const w = await loggedIn("agents");
    w.route("/api/agent/v1/key/revoke", () => json(200, { revoked: true, keyId: "t", changed: false }));
    expect(await w.run("logout", "--revoke")).toBe(0);
    expect(w.stderr()).toContain(copy.revokeAllWarning);
  });

  it("network failure: kept unless --force-local", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/key/revoke", () => "throw-after-send");
    expect(await w.run("logout", "--revoke")).toBe(4);
    expect([...w.keychain.items.values()]).toContain(ONE_KEY);
    expect(await w.run("logout", "--revoke", "--force-local")).toBe(4);
    expect([...w.keychain.items.values()]).not.toContain(ONE_KEY);
  });
});

describe("whoami and profiles", () => {
  it("whoami (C.33) never prints key characters", async () => {
    const w = await loggedIn();
    expect(await w.run("whoami", "--format", "table")).toBe(0);
    expect(w.stdout()).toBe(`bot · darwin.finance · Laptop bot · Read: this agent · Trade: this agent · API key "laptop key" (stored in the test keychain)\n`);
  });

  it("whoami says 'name unavailable' when the server can't tell", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/whoami", () => json(404, { error: "not_found" }));
    expect(await w.run("whoami", "--format", "table")).toBe(0);
    expect(w.stdout()).toContain('API key "name unavailable"');
  });

  it("profile rename / use / remove; beta and production never share a profile", async () => {
    const w = await loggedIn();
    expect(await w.run("profile", "rename", "bot", "bot2")).toBe(0);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot2")).toBe(ONE_KEY);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBeNull();
    w.stdin = ONE_KEY;
    expect(await w.run("login", "--with-key", "--beta", "--profile", "bot2")).toBe(2);
    expect(await w.run("profile", "remove", "bot2")).toBe(0);
    expect(w.keychain.items.size).toBe(0);
  });
});
