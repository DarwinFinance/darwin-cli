/** Regression tests for codex review round 3 (M3). */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { json, loggedIn, ONE_KEY, world } from "./harness.js";

describe("codex r3", () => {
  it("#3 --delete-file deletes only the file it imported, never one swapped in meanwhile", async () => {
    const w = world();
    const f = join(w.ctx.configDir, "darwin-agent-key.json");
    const other = JSON.stringify({ type: "darwin-agent-key", version: 1, realm: "darwin.finance", agent_id: "agr_other", key: `darwinAI_agent_${"o".repeat(40)}` });
    writeFileSync(f, JSON.stringify({ type: "darwin-agent-key", version: 1, realm: "darwin.finance", agent_id: "agr_9", key: ONE_KEY }));
    w.route("/api/agent/v1/tools/whoami", () => {
      writeFileSync(f, other); // another key file lands at the same path during verification
      return json(200, { kind: "agent", name: "k", homeAgentId: "agr_9", homeAgentName: "Nine" });
    });
    expect(await w.run("login", "--key-file", f, "--delete-file")).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(other);
  });

  it("#3b a failed import puts the key file back", async () => {
    const w = world();
    const f = join(w.ctx.configDir, "k.json");
    writeFileSync(f, JSON.stringify({ type: "darwin-agent-key", version: 1, realm: "darwin.finance", agent_id: "agr_9", key: ONE_KEY }));
    w.route("/api/agent/v1/tools/whoami", () => json(401, { error: "unauthorized" }));
    expect(await w.run("login", "--key-file", f, "--delete-file")).toBe(3);
    expect(existsSync(f)).toBe(true);
  });

  it("#4 whoami: 426 → 7, 403 → 4, unexpected → 1, 404 → 0", async () => {
    const w = await loggedIn();
    for (const [status, code] of [[426, 7], [403, 4], [418, 1], [404, 0]] as const) {
      w.route("/api/agent/v1/tools/whoami", () => json(status, { error: "x", minCli: "9.0.0" }));
      expect(await w.run("whoami", "--json"), String(status)).toBe(code);
    }
  });

  it("#1 rename moves the key and removes the old entry", async () => {
    const w = await loggedIn();
    expect(await w.run("profile", "rename", "bot", "bot2")).toBe(0);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot2")).toBe(ONE_KEY);
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBeNull();
  });
});

describe("codex r4 (fixed after the review cap)", () => {
  it("#1 a write whose read-back fails is rolled back to the previous key", async () => {
    const w = await loggedIn();
    w.route("/api/agent/v1/tools/whoami", () => json(200, { kind: "agent", name: "k", homeAgentId: "agr_home", homeAgentName: "Laptop bot" }));
    const realGet = w.keychain.get;
    let reads = 0;
    w.keychain.get = (s, a, t) => {
      // the first read (what's there) works; every read-back after a write fails
      if (a === "darwin.finance:bot" && ++reads > 1 && reads < 4) throw new Error("locked");
      return realGet(s, a, t);
    };
    w.stdin = `darwinAI_agent_${"n".repeat(40)}`;
    expect(await w.run("login", "--with-key", "--profile", "bot")).toBe(1);
    w.keychain.get = realGet;
    expect(w.keychain.get("finance.darwin.cli", "darwin.finance:bot")).toBe(ONE_KEY);
  });

  it("#2 a failed --delete-file import never overwrites a file that arrived meanwhile", async () => {
    const w = world();
    const f = join(w.ctx.configDir, "k.json");
    writeFileSync(f, JSON.stringify({ type: "darwin-agent-key", version: 1, realm: "darwin.finance", agent_id: "agr_9", key: ONE_KEY }));
    w.route("/api/agent/v1/tools/whoami", () => { writeFileSync(f, "replacement"); return json(401, { error: "unauthorized" }); });
    expect(await w.run("login", "--key-file", f, "--delete-file")).toBe(3);
    expect(readFileSync(f, "utf8")).toBe("replacement");
    expect(w.stderr()).toContain("The key file is now at");
  });
});
