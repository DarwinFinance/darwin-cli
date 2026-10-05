/** Help, examples, config. */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { world } from "./harness.js";
import { parseArgs, BOOLEAN_FLAGS } from "../src/args.js";
import { resolve } from "../src/main.js";
import { buildArguments } from "../src/tool.js";
import { snapshotFor, validateCatalogue } from "../src/catalogue.js";
import { parse, serialize } from "../src/config.js";


describe("help and examples", () => {
  it("every documented example parses with the real parser and resolves to a command", () => {
    const examples = [
      "darwin balances",
      "darwin quote --sell SOL --amount 1 --for USDC",
      "darwin order --quote aqt_x --sell SOL --amount 1 --for USDC",
      "darwin instant --sell SOL --amount 1 --for USDC --max-slippage-bps 50",
      "darwin orders",
      "darwin agents",
      "darwin grant",
      "darwin pause --reason stop",
      "darwin tx 5abc",
      "darwin perps quote SOL",
      "darwin unlisted inspect So11111111111111111111111111111111111111112",
      "darwin history trades",
      "darwin docs 12",
      "darwin market",
      "darwin indicators --field symbol=SOL",
    ];
    const c = snapshotFor("agent");
    for (const e of examples) {
      const p = parseArgs(e.split(" ").slice(1), BOOLEAN_FLAGS);
      const hit = resolve(c, p.positionals);
      expect(hit, e).not.toBeNull();
      expect(() => buildArguments(hit!.tool, hit!.rest, p, new Set(["json", "agent", "profile", "dry-run"])), e).not.toThrow();
    }
    // The copy deck's own command lines parse too.
    for (const e of ["darwin login --client-name \"Claude\"", "darwin login --with-key", "darwin login --key-file f.json", "darwin profile set-agent bot", "darwin logout --revoke", "darwin mcp --print-config claude", "darwin login --from-skill --delete-skill-copy"]) {
      expect(() => parseArgs(e.split(" ").slice(1), BOOLEAN_FLAGS), e).not.toThrow();
    }
  });

  it("help --json lists every catalogue command with its flags, offline", async () => {
    const w = world();
    expect(await w.run("help", "--json")).toBe(0);
    const h = JSON.parse(w.stdout());
    expect(h.commands.map((x: { command: string }) => x.command)).toContain("quote");
    expect(h.commands.find((x: { command: string }) => x.command === "order").flags.map((f: { flag: string }) => f.flag)).toEqual(expect.arrayContaining(["--quote", "--nonce"]));
    expect(h.static.map((x: { command: string }) => x.command)).toEqual(expect.arrayContaining(["login", "logout", "mcp"]));
  });

  it("`darwin <cmd> --help` works without a key", async () => {
    const w = world({ tty: true });
    expect(await w.run("quote", "--help")).toBe(0);
    expect(w.stdout()).toContain("darwin quote --sell <sell> --amount <amount> --for <for>");
  });

  it("the embedded snapshots are valid catalogues", () => {
    expect(validateCatalogue(snapshotFor("agent"))).toEqual([]);
    expect(validateCatalogue(snapshotFor("agents"))).toEqual([]);
    const schema = JSON.parse(readFileSync("snapshot/catalog.schema.json", "utf8"));
    expect(Object.keys(schema.$defs.tool.properties).sort()).toEqual(Object.keys(snapshotFor("agent").tools[0]!).sort());
  });
});

describe("config", () => {
  it("round-trips and refuses what it can't read", () => {
    const c = { default: "a", profiles: { a: { realm: "beta.darwin.finance" as const, kind: "agents" as const, agent_id: "agr_1", agent_name: "Q \"uote\" \\ x", default_agent: "agr_1", store: "keychain" as const } } };
    expect(parse(serialize(c))).toEqual(c);
    expect(() => parse("x = 1")).toThrow();
    expect(() => parse('[profiles.a]\nrealm = "evil.example"\nkind = "agent"\nagent_id = "x"\nstore = "keychain"')).toThrow();
  });
});
