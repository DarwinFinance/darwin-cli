/** M5: market-status (C.72), the update notice (C.40), the package name. */
import { describe, expect, it } from "bun:test";
import { VERSION } from "../src/version.js";
import { readFileSync } from "node:fs";
import { catalogueFor, json, loggedIn, world } from "./harness.js";
import { localTime, MARKET_STATUS_HELP } from "../src/market.js";
import { updateNotice } from "../src/main.js";
import { INSTALL_LINE } from "../src/copy.js";

const STATUS = {
  market: "us_equities", calendar: "NYSE", timezone: "America/New_York", asOf: "2026-10-05T14:00:00Z", open: false, session: "closed",
  reason: "holiday", date: "2026-10-05", holidayName: "Test Day\u001b[2J", earlyClose: false, sessionEndsAt: "2026-10-06T04:00:00-04:00",
  nextOpenAt: "2026-10-06T09:30:00-04:00", nextCloseAt: "2026-10-06T16:00:00-04:00",
  agentStockOrders: { accepted: false, closesAt: null, opensAt: "2026-10-06T09:30:00-04:00" }, calendarCoversThrough: "2027-12-31",
};

describe("darwin market-status (C.72)", () => {
  it("works with NO key and NO profile, sends no Authorization, and never touches the keychain", async () => {
    const w = world({ tty: true });
    let touched = false;
    w.keychain.get = () => { touched = true; return null; };
    w.keychain.set = () => { touched = true; };
    w.route("/api/agent/v1/market-status/us-equities", () => json(200, STATUS));
    expect(await w.run("market-status")).toBe(0);
    expect(touched).toBe(false);
    expect(w.calls[0]!.url).toBe("https://darwin.finance/api/agent/v1/market-status/us-equities");
    expect(w.calls[0]!.headers.authorization).toBeUndefined();
    expect(w.stdout()).toContain("US stock market: closed (holiday: Test Day)");
    expect(w.stdout()).not.toContain("\u001b");
    expect(w.stdout()).toContain("Darwin agent stock orders: not accepted now; next accepted");
  });

  it("works from npx too (it reads no key), on beta with --beta, and as JSON", async () => {
    const w = world({ scriptPath: "/h/.npm/_npx/1/node_modules/@darwin.finance/cli/dist/darwin.js" });
    w.route("/api/agent/v1/market-status/us-equities", () => json(200, STATUS));
    expect(await w.run("market-status", "--beta", "--json")).toBe(0);
    expect(w.calls[0]!.url).toBe("https://beta.darwin.finance/api/agent/v1/market-status/us-equities");
    expect(JSON.parse(w.stdout()).session).toBe("closed");
  });

  it("help shows C.72 — locally: no keychain read, no request, even with a saved profile", async () => {
    const w = await loggedIn("agent", { tty: true });
    let touched = false;
    const real = w.keychain.get;
    w.keychain.get = (...a) => { touched = true; return real(...a); };
    for (const argv of [["market-status", "--help"], ["help", "market-status"]]) {
      w.out.length = 0;
      expect(await w.run(...argv)).toBe(0);
      expect(w.stdout()).toContain(MARKET_STATUS_HELP);
    }
    expect(touched).toBe(false);
    expect(w.calls).toHaveLength(0);
  });

  it("local times are 12-hour with a zone", () => {
    expect(localTime("2026-10-06T09:30:00-04:00")).toMatch(/\d{1,2}:\d{2} (AM|PM) \S+/);
    expect(localTime("nope")).toBeNull();
  });
});

describe("update notice (C.40)", () => {
  it("at most daily, on an interactive stderr, never in CI or when switched off", async () => {
    const w = await loggedIn("agent", { tty: true });
    const c = { ...catalogueFor("agent"), latestCli: "9.0.0" };
    updateNotice(w.ctx, c);
    expect(w.stderr()).toContain(`Darwin CLI 9.0.0 is available (you have ${VERSION}). Update: ${INSTALL_LINE}`);
    w.err.length = 0;
    updateNotice(w.ctx, c);
    expect(w.stderr()).toBe("");
    for (const env of [{ CI: "1" }, { DARWIN_NO_UPDATE_NOTIFIER: "1" }] as Record<string, string>[]) {
      const x = world({ tty: true, env });
      updateNotice(x.ctx, c);
      expect(x.stderr()).toBe("");
    }
    const piped = world();
    updateNotice(piped.ctx, c);
    expect(piped.stderr()).toBe("");
  });
});

describe("package", () => {
  it("is @darwin.finance/cli with bin darwin; every install line says so", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.name).toBe("@darwin.finance/cli");
    expect(pkg.bin).toEqual({ darwin: "dist/darwin.js" });
    expect(INSTALL_LINE).toBe("npm i -g @darwin.finance/cli");
    expect(Object.keys(pkg.dependencies)).toEqual(["@napi-rs/keyring"]);
    expect(pkg.dependencies["@napi-rs/keyring"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("supply chain", () => {
  it("npm-shrinkwrap.json pins the keyring and every platform binary with integrity hashes", () => {
    const sw = JSON.parse(readFileSync("npm-shrinkwrap.json", "utf8"));
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(sw.name).toBe(pkg.name);
    const want = pkg.dependencies["@napi-rs/keyring"];
    const entries = Object.entries(sw.packages as Record<string, { version?: string; integrity?: string; dev?: boolean }>).filter(([k]) => k.includes("@napi-rs/keyring"));
    expect(entries.length).toBeGreaterThan(8);
    for (const [k, v] of entries) {
      expect(v.version, k).toBe(want);
      expect(v.integrity, k).toMatch(/^sha512-/);
    }
  });
});
