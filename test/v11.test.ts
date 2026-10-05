/**
 * v1.1 — prepared writes (prepare → execute → read-only status), `darwin retry` / `darwin cancel`,
 * perps / TP/SL / collateral commands, `darwin mcp`'s check_prepared / cancel_prepared, and the owner's
 * amendments: server words only, real dry runs, one order ID, a short landed wait, fresh-state refusals.
 */
import { describe, expect, it } from "bun:test";
import { ALL_KEY, json, loggedIn, type Call, type World } from "./harness.js";
import v11Agent from "./fixtures/v11-agent.json" with { type: "json" };
import v11Agents from "./fixtures/v11-agents.json" with { type: "json" };
import { snapshotFor } from "../src/catalogue.js";

const PID = "prp_AbCdEfGhIjKlMnOpQrStUvWx";
const SIG = "5".repeat(88);
const prep = (name: string) => `/api/agent/v1/tools/call/${name}/prepare`;

/** A v1.1 realm: the v1.1 catalogue, and a mock prepared-write server. */
async function v11World(kind: "agent" | "agents" = "agent", opts: { tty?: boolean } = { tty: true }) {
  const w = await loggedIn(kind, opts);
  const cat = kind === "agents" ? v11Agents : v11Agent;
  w.route("/api/agent/v1/tools", () => json(200, cat, { "x-darwin-catalog": cat.catalogVersion }));
  // The CLI loads its cached (v1) catalogue first; a perps command refreshes it once.
  return w;
}

interface Script {
  prepare?: (c: Call) => Response;
  execute?: (c: Call) => Response | "throw-after-send" | "throw-before-send";
  statuses?: Array<Record<string, unknown>>;
}

function serve(w: World, tool: string, s: Script) {
  const statuses = [...(s.statuses ?? [])];
  w.route(prep(tool), (c) => s.prepare?.(c) ?? json(200, { tool, isError: false, result: { preparedId: PID, summary: {}, request: {}, costsTx: true }, cli: { lines: ["Checked."] } }));
  w.route("/api/agent/v1/tools/execute", (c) => s.execute?.(c) ?? json(200, { tool, preparedId: PID, state: "done", isError: false, verdict: "sent", result: { status: 200, data: { ok: true, txSignature: SIG } }, cli: { lines: ["Sent."] } }));
  w.route("/api/agent/v1/tools/status", () => json(200, statuses.length > 1 ? statuses.shift()! : statuses[0] ?? { tool, preparedId: PID, verdict: "pending", cli: { lines: ["Darwin is still working on this order. Check again in a few seconds."] } }));
}

const calls = (w: World, path: string) => w.calls.filter((c) => c.url.endsWith(path));
const landed = (extra: string[] = []) => ({ preparedId: PID, verdict: "landed", state: "done", cli: { lines: ["This order went through: confirmed on chain.", ...extra] } });

describe("spot writes through prepare → execute", () => {
  it("instant: Darwin checks, sends once, then waits (reads only) and says it landed; the order ID is Darwin's, never the nonce", async () => {
    const w = await v11World();
    serve(w, "spot_order_now", {
      prepare: () => json(200, { tool: "spot_order_now", isError: false, result: { preparedId: PID, summary: {}, request: { method: "POST", path: "/api/agent/v2/order/instant", body: {} }, costsTx: true }, cli: { lines: ["Selling 0.1 SOL for USDC now, filling no worse than 0.5% slippage."] } }),
      execute: () => json(200, { tool: "spot_order_now", preparedId: PID, state: "done", isError: false, verdict: "sent", nonce: "cli_SECRETNONCE", result: { status: 200, data: { ok: true, orderId: "ord_42", txSignature: SIG, status: "submitted" } }, cli: { lines: ["Sold 0.1 SOL for USDC: about 15 USDC (at least 14.9).", "Sent to the network; not confirmed yet."] } }),
      statuses: [{ verdict: "sent", cli: { lines: ["x"] } }, landed()],
    });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(0);
    const p = calls(w, prep("spot_order_now"));
    expect(p).toHaveLength(1);
    expect(p[0]!.body).toEqual({ arguments: { sell: "SOL", amount: "0.1", for: "USDC", maxSlippageBps: 50 } }); // 🔴 no nonce on the prepared path
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(1);
    expect(calls(w, "/api/agent/v1/tools/execute")[0]!.body).toEqual({ preparedId: PID });
    expect(calls(w, "/api/agent/v1/tools/call/spot_order_now")).toHaveLength(0);
    expect(w.stdout()).toBe([
      "Sold 0.1 SOL for USDC: about 15 USDC (at least 14.9).",
      "Sent to the network; not confirmed yet.",
      "This order went through: confirmed on chain.",
      "Order ID: ord_42",
      "",
    ].join("\n"));
    expect(w.stdout() + w.stderr()).not.toContain("cli_SECRETNONCE");
  });

  it("--json is the whole story in one document: prepare, execute, status", async () => {
    const w = await v11World("agent", {});
    serve(w, "spot_order_now", { statuses: [landed()] });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50", "--json")).toBe(0);
    const doc = JSON.parse(w.stdout());
    expect(doc).toMatchObject({ preparedId: PID, tool: "spot_order_now", verdict: "landed", prepare: { preparedId: PID }, execute: { verdict: "sent" }, status: { verdict: "landed" } });
  });

  it("not landed within the wait: says so, with the command that checks it", async () => {
    const w = await v11World();
    serve(w, "spot_order_now", { statuses: [{ verdict: "sent", cli: { lines: ["Still."] } }] });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(0);
    expect(w.stdout()).toContain(`Not confirmed yet. Check it with: darwin retry ${PID}`);
    expect(calls(w, "/api/agent/v1/tools/status").length).toBeLessThanOrEqual(4);
  });
});

describe("--dry-run is Darwin's real check (amendment 3)", () => {
  it("one prepare with dryRun:true; nothing executed; Darwin's own words", async () => {
    const w = await v11World();
    serve(w, "place_perp_order", { prepare: () => json(200, { tool: "place_perp_order", isError: false, result: { dryRun: true, sent: false, summary: {}, request: {}, costsTx: true }, cli: { lines: ["Open a 0.01 SOL long at market.", "Dry run: Darwin checked it, and nothing was sent."] } }) });
    expect(await w.run("perps", "order", "SOL", "--side", "long", "--size", "0.01", "--type", "market", "--dry-run")).toBe(0);
    expect(calls(w, prep("place_perp_order"))[0]!.body).toEqual({ arguments: { symbol: "SOL", side: "long", sizeBaseUnits: "0.01", orderType: "market" }, dryRun: true });
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(0);
    expect(w.stdout()).toBe("Open a 0.01 SOL long at market.\nDry run: Darwin checked it, and nothing was sent.\nRunning it for real counts against today's transaction budget.\n");
  });

  it("a dry run Darwin refuses exits 4 with its reason", async () => {
    const w = await v11World();
    serve(w, "place_perp_order", { prepare: () => json(200, { tool: "place_perp_order", isError: true, result: { error: "no_free_collateral", sent: false }, cli: { lines: ["This agent has no free collateral in its perps account. Move some USDC in first: `darwin perps collateral deposit --amount <USDC>`. Nothing was sent."] } }) });
    expect(await w.run("perps", "order", "SOL", "--side", "long", "--size", "0.01", "--type", "market", "--dry-run")).toBe(4);
    expect(w.stderr()).toContain("no free collateral");
  });

  it("a site without prepared writes: says it can't check ahead — no local echo, nothing sent", async () => {
    const w = await loggedIn("agent", { tty: true });
    w.route(prep("place_spot_order"), () => json(404, { error: "prepared_unavailable" }));
    expect(await w.run("order", "--quote", "aqt_1", "--sell", "SOL", "--amount", "1", "--for", "USDC", "--dry-run")).toBe(0);
    expect(w.stdout()).toBe("Darwin can't check orders ahead of time on darwin.finance yet, so nothing was checked or sent.\n");
    expect(w.calls.filter((c) => c.url.endsWith("/tools/call/place_spot_order") || c.url.endsWith("/execute"))).toHaveLength(0);
  });
});

describe("a site without prepared writes: the v1 direct path, exactly as 1.0", () => {
  it("falls back once, with a generated nonce", async () => {
    const w = await loggedIn("agent", {});
    w.route(prep("place_spot_order"), () => json(404, { error: "prepared_unavailable" }));
    w.route("/api/agent/v1/tools/call/place_spot_order", () => json(200, { tool: "place_spot_order", isError: false, result: { status: 200, data: { ok: true } } }));
    expect(await w.run("order", "--quote", "aqt_1", "--sell", "SOL", "--amount", "1", "--for", "USDC", "--json")).toBe(0);
    const direct = calls(w, "/api/agent/v1/tools/call/place_spot_order");
    expect(direct).toHaveLength(1);
    expect((direct[0]!.body as { arguments: Record<string, string> }).arguments.clientOrderNonce).toMatch(/^cli_/);
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(0);
  });
});

describe("🔴 an uncertain write is never sent again — only read", () => {
  it("the answer to execute is lost: status is polled (never execute), then exit 6 with darwin retry", async () => {
    const w = await v11World();
    serve(w, "spot_order_now", { execute: () => "throw-after-send" });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(6);
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(1);
    expect(calls(w, prep("spot_order_now"))).toHaveLength(1);
    expect(calls(w, "/api/agent/v1/tools/status").length).toBeGreaterThan(0);
    expect(w.stderr()).toContain(`Don't run the command again. Check it with: darwin retry ${PID}`);
  });

  it("a lost answer whose status then says it landed is a success (exit 0)", async () => {
    const w = await v11World();
    serve(w, "spot_order_now", { execute: () => json(504, { error: "gateway_timeout" }), statuses: [landed(["Your SOL position is now 0.01 SOL long, entry $119.70."])] });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(0);
    expect(w.stdout()).toContain("This order went through: confirmed on chain.");
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(1);
  });

  it("execute answering 'uncertain' (state unknown) is exit 6 after the read-only polls", async () => {
    const w = await v11World();
    serve(w, "spot_order_now", { execute: () => json(200, { preparedId: PID, state: "unknown", verdict: "uncertain", isError: true, result: { error: "darwin_unavailable" }, cli: { lines: ["Darwin may have received this order, but its result didn't come back. Don't run the command again."] } }) });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(6);
    expect(w.stderr()).toContain("Darwin may have received this order");
    expect(w.stderr()).toContain(`darwin retry ${PID}`);
  });

  it("a prepare that never reached Darwin is exit 8: nothing was sent", async () => {
    const w = await v11World();
    w.route(prep("spot_order_now"), () => "throw-after-send");
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50")).toBe(8);
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(0);
  });
});

describe("perps commands (v1.1 catalogue)", () => {
  it("open: one prepare, one execute, then the landed line and where the position stands", async () => {
    const w = await v11World();
    serve(w, "place_perp_order", {
      prepare: () => json(200, { tool: "place_perp_order", isError: false, result: { preparedId: PID }, cli: { lines: ["Open a 0.01 SOL long at market."] } }),
      execute: () => json(200, { tool: "place_perp_order", preparedId: PID, state: "done", isError: false, verdict: "sent", result: { status: 200, data: { ok: true, status: "submitted", txSignature: SIG } }, cli: { lines: ["Sent an order to open a 0.01 SOL long at market.", "Not confirmed yet."] } }),
      statuses: [landed(["Your SOL position is now 0.01 SOL long, entry $119.70."])],
    });
    expect(await w.run("perps", "order", "SOL", "--side", "long", "--size", "0.01", "--type", "market")).toBe(0);
    expect(w.stdout()).toBe([
      "Sent an order to open a 0.01 SOL long at market.",
      "Not confirmed yet.",
      "This order went through: confirmed on chain.",
      "Your SOL position is now 0.01 SOL long, entry $119.70.",
      "Order ID: 5555…5555",
      "",
    ].join("\n"));
  });

  it("TP/SL, close and collateral take their own short arguments", async () => {
    const w = await v11World();
    serve(w, "set_perp_protections", { statuses: [landed()] });
    expect(await w.run("perps", "protect", "SOL", "--sl", "110", "--tp", "140", "--percent", "50")).toBe(0);
    expect(calls(w, prep("set_perp_protections"))[0]!.body).toEqual({ arguments: { symbol: "SOL", stopLoss: "110", takeProfit: "140", sizePercent: 50 } });
    serve(w, "close_perp_position", { statuses: [landed()] });
    expect(await w.run("perps", "close", "SOL")).toBe(0);
    expect(calls(w, prep("close_perp_position"))[0]!.body).toEqual({ arguments: { symbol: "SOL" } });
    serve(w, "move_perp_collateral", { statuses: [landed()] });
    expect(await w.run("perps", "collateral", "deposit", "--amount", "5")).toBe(0);
    expect(calls(w, prep("move_perp_collateral"))[0]!.body).toEqual({ arguments: { direction: "deposit", amount: "5" } });
    expect(await w.run("perps", "protect", "SOL", "--cancel", "tp", "--dry-run")).toBe(0);
  });

  // Amendment 6: every fresh / empty state is Darwin's own plain refusal, exit 4 (paused: 10).
  const fresh: Array<[string, string[], string, string, number]> = [
    ["not set up", ["perps", "order", "SOL", "--side", "long", "--size", "0.01", "--type", "market"], "place_perp_order", "perps_not_set_up", 4],
    ["no collateral", ["perps", "order", "SOL", "--side", "long", "--size", "0.01", "--type", "market"], "place_perp_order", "no_free_collateral", 4],
    ["no position to close", ["perps", "close", "SOL"], "close_perp_position", "position_not_found", 4],
    ["already-closed position", ["perps", "close", "SOL", "--size", "0.01"], "close_perp_position", "position_not_found", 4],
    ["TP/SL with no position", ["perps", "protect", "SOL", "--sl", "110"], "set_perp_protections", "position_not_found", 4],
    ["nothing to cancel", ["perps", "cancel-all", "SOL"], "cancel_all_perp_orders", "no_open_orders", 4],
    ["collateral, not set up", ["perps", "collateral", "withdraw", "--amount", "1"], "move_perp_collateral", "perps_not_set_up", 4],
    ["paused agent", ["perps", "close", "SOL"], "close_perp_position", "grant_paused", 10],
  ];
  for (const [what, argv, tool, code, exit] of fresh) {
    it(`fresh state — ${what}: exit ${exit}, Darwin's words, nothing executed`, async () => {
      const w = await v11World();
      const line = `Darwin says ${code} in plain words. Nothing was sent.`;
      serve(w, tool, { prepare: () => json(200, { tool, isError: true, result: { error: code, sent: false }, cli: { lines: [line] } }) });
      expect(await w.run(...argv)).toBe(exit);
      expect(w.stderr()).toContain(line);
      expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(0);
    });
  }

  it("a caller's --nonce is Darwin's to refuse on the prepared path (usage, nothing sent)", async () => {
    const w = await v11World();
    serve(w, "spot_order_now", { prepare: () => json(200, { tool: "spot_order_now", isError: true, result: { error: "nonce_not_accepted", sent: false }, cli: { lines: ["Leave out --nonce: Darwin gives every order a fresh ID. Nothing was sent."] } }) });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50", "--nonce", "mine")).toBe(2);
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(0);
  });

  it("a perps quote prints Darwin's notes (equity market outside the session)", async () => {
    const w = await v11World();
    w.route("/api/agent/v1/tools/call/get_perp_quote", () => json(200, { tool: "get_perp_quote", isError: false, result: { status: 200, data: { ok: true, symbol: "AAPL", markUsd: 200 } }, cli: { notes: ["The US stock market is closed now (it's the weekend): AAPL perps still trade, but with much less liquidity until it reopens."] } }));
    expect(await w.run("perps", "quote", "AAPL")).toBe(0);
    expect(w.stdout()).toContain("The US stock market is closed now");
  });
});

describe("darwin retry / darwin cancel", () => {
  const status = (w: World, body: Record<string, unknown>, http = 200) => w.route("/api/agent/v1/tools/status", () => json(http, body));
  it("exit codes follow the verdict; it only reads", async () => {
    const w = await v11World();
    for (const [verdict, exit] of [["landed", 0], ["sent", 0], ["replayed", 0], ["refused", 4], ["failed", 4], ["never_sent", 4], ["pending", 6], ["uncertain", 6], ["not_started", 6]] as const) {
      status(w, { preparedId: PID, verdict, cli: { lines: [`It is ${verdict}.`] } });
      expect(await w.run("retry", PID), verdict).toBe(exit);
    }
    expect(w.calls.filter((c) => c.url.endsWith("/execute") || c.url.endsWith("/prepare"))).toHaveLength(0);
    expect(w.stdout()).toContain(`To make sure it never runs: darwin cancel ${PID}`);
  });

  it("C.62: a 401 means unknown, not failed (exit 6)", async () => {
    const w = await v11World();
    status(w, { error: "unauthorized" }, 401);
    expect(await w.run("retry", PID)).toBe(6);
    expect(w.stderr()).toContain("Its outcome is still unknown, not failed. A paused agent is one possible cause. Check the agent's History on Darwin.");
  });

  it("a malformed id is usage (2), nothing sent", async () => {
    const w = await v11World();
    expect(await w.run("retry", "cli_notanid")).toBe(2);
    expect(await w.run("cancel")).toBe(2);
    expect(w.calls).toHaveLength(0);
  });

  it("cancel: cancelled → 0; one that started can't be cancelled and says what happened", async () => {
    const w = await v11World();
    w.route("/api/agent/v1/tools/cancel", () => json(200, { preparedId: PID, verdict: "never_sent", cancelled: true, cli: { lines: ["This order was never sent, and now it can't be. Run the command again if you still want it."] } }));
    expect(await w.run("cancel", PID)).toBe(0);
    w.route("/api/agent/v1/tools/cancel", () => json(200, { preparedId: PID, verdict: "landed", cancelled: false, cli: { lines: ["This order went through: confirmed on chain."] } }));
    expect(await w.run("cancel", PID)).toBe(0);
    expect(w.stdout()).toContain("It had already started, so it couldn't be cancelled.");
  });

  it("an all-agents key names its agent on prepare, execute, status and retry", async () => {
    const w = await v11World("agents");
    serve(w, "spot_order_now", { statuses: [landed()] });
    expect(await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50", "--agent", "Second")).toBe(0);
    for (const p of [prep("spot_order_now"), "/api/agent/v1/tools/execute", "/api/agent/v1/tools/status"]) {
      for (const c of calls(w, p)) expect(c.headers["x-darwin-agent"], p).toBe("agr_2");
    }
    expect(calls(w, prep("spot_order_now"))[0]!.headers.authorization).toBe(`Bearer ${ALL_KEY}`);
  });
});

describe("darwin mcp (v1.1)", () => {
  const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const replies = (out: string) => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("tools/list adds a READ-ONLY check_prepared and a separate write-annotated cancel_prepared (R16-2)", async () => {
    const w = await v11World("agent", {});
    w.stdin = rpc(1, "tools/list");
    await w.run("mcp");
    const tools = replies(w.stdout())[0].result.tools as Array<{ name: string; annotations: Record<string, unknown> }>;
    expect(tools.find((t) => t.name === "check_prepared")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "cancel_prepared")!.annotations.readOnlyHint).toBe(false);
  });

  it("a write goes prepare → execute; an uncertain one tells the model to call check_prepared, never to re-call", async () => {
    const w = await v11World("agent", {});
    serve(w, "spot_order_now", { execute: () => "throw-after-send" });
    w.stdin = [rpc(1, "tools/call", { name: "spot_order_now", arguments: { sell: "SOL", amount: "0.1", for: "USDC", maxSlippageBps: 50 } }), rpc(2, "tools/call", { name: "check_prepared", arguments: { preparedId: PID } })].join("\n");
    await w.run("mcp");
    const [a, b] = replies(w.stdout());
    expect(a.result.isError).toBe(true);
    expect(a.result.structuredContent).toMatchObject({ error: "outcome_unknown", preparedId: PID });
    expect(a.result.structuredContent.detail).toContain("check_prepared");
    expect(b.result.structuredContent).toMatchObject({ verdict: "pending" });
    expect(calls(w, "/api/agent/v1/tools/execute")).toHaveLength(1);
  });
});

// ─── amendment 1: human output never names a connector tool, never says "untrusted:" ───────────
describe("🔴 human output speaks CLI, never connector", () => {
  const CONNECTOR = [...new Set([...snapshotFor("agent").tools, ...v11Agent.tools].map((t) => t.name)), "get_api_reference", "check_prepared", "cancel_prepared"];
  it("across writes, refusals, uncertain results, dry runs, retry and cancel", async () => {
    const w = await v11World();
    const out: string[] = [];
    const runs: Array<() => Promise<unknown>> = [
      async () => { serve(w, "spot_order_now", { statuses: [landed()] }); await w.run("instant", "--sell", "SOL", "--amount", "0.1", "--for", "USDC", "--max-slippage-bps", "50"); },
      async () => { serve(w, "place_perp_order", { execute: () => "throw-after-send" }); await w.run("perps", "order", "SOL", "--side", "long", "--size", "0.01", "--type", "market"); },
      async () => { serve(w, "close_perp_position", { prepare: () => json(200, { tool: "close_perp_position", isError: true, result: { error: "position_not_found", sent: false }, cli: { lines: ["There's no open SOL position. Nothing was sent."] } }) }); await w.run("perps", "close", "SOL"); },
      async () => { await w.run("perps", "protect", "SOL", "--sl", "110", "--dry-run"); },
      async () => { await w.run("retry", PID); },
      async () => { w.route("/api/agent/v1/tools/status", () => json(401, {})); await w.run("retry", PID); },
      async () => { await w.run("help", "retry"); },
      async () => { await w.run("perps", "order", "--help"); },
    ];
    for (const r of runs) { w.out.length = 0; w.err.length = 0; await r(); out.push(w.stdout(), w.stderr()); }
    const text = out.join("\n");
    for (const n of CONNECTOR) expect(text, n).not.toMatch(new RegExp(`\\b${n}\\b`));
    expect(text).not.toMatch(/untrusted:/i);
    // The nonce is never shown or named outside help (where `--nonce` is a flag).
    expect(out.slice(0, 12).join("\n")).not.toMatch(/\bnonce\b/i);
  });
});
