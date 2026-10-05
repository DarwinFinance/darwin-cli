/**
 * Human (terminal) renderings, one per command — and `--json` unchanged for each. Fixtures are the
 * server's real shapes: `{ tool, isError, result: { status, data, summary? } }`, every third-party
 * string wrapped `{ untrusted }` exactly as the serializer wraps it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { json, loggedIn, world, type World } from "./harness.js";
import { marketHeadline } from "../src/market.js";
import { forTerminal } from "../src/help.js";
import { refusalLines } from "../src/render.js";
import { snapshotFor } from "../src/catalogue.js";

let tz: string | undefined;
beforeAll(() => { tz = process.env.TZ; process.env.TZ = "America/Chicago"; });
afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

const call = (name: string) => `/api/agent/v1/tools/call/${name}`;
const ok = (tool: string, result: unknown) => json(200, { tool, isError: false, result });
const refused = (tool: string, result: unknown) => json(200, { tool, isError: true, result });
const U = (s: string) => ({ untrusted: s });
const HOSTILE = "cli1\u001b[31m\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007‮\u0000";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const SIG = "5".repeat(88);
// 1_800_000_000_000 ms = 2027-01-15T08:00:00Z = Jan 15, 2:00 AM CST (harness clock; TZ below).
const NOW = 1_800_000_000_000;

const QUOTE_RESULT = {
  status: 200,
  data: {
    ok: true, quoteId: "aqt_abc123", instrumentId: `spot:solana:${SOL}`, side: "buy", inputMint: USDC, outputMint: SOL,
    inAtoms: "1000000", outAtomsQuoted: "8242000", minOutAtoms: "8221000", maxSlippageBps: 25, grantMaxSlippageBps: 100,
    router: "dflow", expiresAtMs: NOW + 30_000, expiresAtIso: new Date(NOW + 30_000).toISOString(), ttlMs: 30_000,
  },
  summary: {
    sell: { symbol: U("USDC"), mint: USDC, amount: "1", atoms: "1000000" },
    receive: { symbol: U("SOL"), mint: SOL, quoted: "0.008242", atLeast: "0.008221", quotedAtoms: "8242000", atLeastAtoms: "8221000" },
    quoteId: "aqt_abc123",
    next: "To execute, call place_spot_order with this quoteId, the same \"sell\" and \"for\", amount \"1\" and a new clientOrderNonce. This quote lives 30 seconds; if it expires, quote again.",
  },
};

const MARKETS_RESULT = {
  status: 200,
  data: {
    ok: true, venues: { spot: "included" },
    instruments: [
      { instrumentId: `spot:solana:${USDC}`, instrumentType: "spot", symbol: U("USDC"), assetClass: "stablecoin", mint: USDC, decimals: 6, issuer: null, marketOpen: true, quoteRequired: true },
      { instrumentId: `spot:solana:${SOL}`, instrumentType: "spot", symbol: U("SOL"), assetClass: "crypto", mint: SOL, decimals: 9, issuer: null, marketOpen: true, quoteRequired: true },
    ],
  },
};

async function tty(kind: "agent" | "agents" = "agent"): Promise<World> {
  const w = await loggedIn(kind, { tty: true });
  w.route(call("list_spot_markets"), () => ok("list_spot_markets", MARKETS_RESULT));
  return w;
}

/** Runs the same command in a terminal and with --json; returns the terminal text. */
async function both(w: World, tool: string, result: unknown, ...argv: string[]): Promise<string> {
  w.route(call(tool), () => ok(tool, result));
  w.out.length = 0; w.err.length = 0;
  expect(await w.run(...argv, "--json")).toBe(0);
  const j = JSON.parse(w.stdout());
  // 🔴 --json is the server's result exactly (plus the nonce a write was sent with).
  const { nonce, ...rest } = j as Record<string, unknown>;
  expect(rest).toEqual(result as Record<string, unknown>);
  if (nonce !== undefined) expect(String(nonce)).toMatch(/^cli_/);
  w.out.length = 0; w.err.length = 0;
  expect(await w.run(...argv)).toBe(0);
  const out = w.stdout();
  if (process.env.DUMP) process.stderr.write(`\n$ darwin ${argv.join(" ")}\n${out}${w.stderr()}`);
  expect(out).not.toContain("untrusted");
  expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  return out;
}

describe("market-status: the reason only when it adds something", () => {
  const base = { open: false, holidayName: null, earlyClose: false };
  it.each([
    [{ session: "after_hours", reason: "after_hours" }, "US stock market: after hours"],
    [{ session: "pre_market", reason: "pre_market" }, "US stock market: pre-market"],
    [{ session: "closed", reason: "weekend" }, "US stock market: closed (weekend)"],
    [{ session: "closed", reason: "overnight" }, "US stock market: closed (overnight)"],
    [{ session: "closed", reason: "holiday", holidayName: "Thanksgiving Day" }, "US stock market: closed (holiday: Thanksgiving Day)"],
    [{ session: "after_hours", reason: "early_close", earlyClose: true }, "US stock market: after hours (early close)"],
    [{ session: "regular", reason: null, open: true, earlyClose: true }, "US stock market: open (regular session) — early close today"],
    [{ session: "regular", reason: null, open: true }, "US stock market: open (regular session)"],
  ])("%o", (s, line) => {
    expect(marketHeadline({ ...base, ...s })).toBe(line);
  });

  it("the full terminal answer, times local", async () => {
    const w = world({ tty: true });
    w.route("/api/agent/v1/market-status/us-equities", () => json(200, {
      open: false, session: "after_hours", reason: "after_hours", holidayName: null, earlyClose: false,
      sessionEndsAt: "2026-10-05T20:00:00-04:00", nextOpenAt: "2026-10-06T09:30:00-04:00", nextCloseAt: "2026-10-06T16:00:00-04:00",
      agentStockOrders: { accepted: false, closesAt: null, opensAt: "2026-10-06T09:30:00-04:00" }, notes: "wait for agentStockOrders.opensAt rather than retrying",
    }));
    expect(await w.run("market-status")).toBe(0);
    expect(w.stdout()).toBe([
      "US stock market: after hours",
      "After hours ends: Mon, Oct 5, 7:00 PM CDT",
      "Next open: Tue, Oct 6, 8:30 AM CDT",
      "Next close: Tue, Oct 6, 3:00 PM CDT",
      "Darwin agent stock orders: not accepted now; next accepted Tue, Oct 6, 8:30 AM CDT",
      "Tokenized stocks trade 24/7, but liquidity is much lower when the US market is closed.",
      "",
    ].join("\n"));
  });
});

describe("darwin quote", () => {
  it("a compact summary, a CLI hint (never the connector's `next`), local expiry", async () => {
    const w = await tty();
    w.route(call("get_balances"), () => ok("get_balances", { status: 200, data: { ok: true, partial: false, balances: [{ mint: USDC, atoms: "5000000", decimals: 6, amount: "5", symbol: U("USDC") }] } }));
    const out = await both(w, "get_spot_quote", QUOTE_RESULT, "quote", "--sell", "USDC", "--amount", "1", "--for", "SOL");
    expect(out).toBe([
      "Sell 1 USDC → about 0.008242 SOL (at least 0.008221 SOL)",
      "Max slippage 25 bps · route dFlow · quote expires in 30s (2:00:30 AM)",
      "To place it: darwin order --quote aqt_abc123 --sell USDC --amount 1 --for SOL",
      "",
    ].join("\n"));
    expect(out).not.toContain("place_spot_order");
    expect(out).not.toContain("clientOrderNonce");
    expect(w.stderr()).toBe("");
  });

  it("warns when the agent holds less than the quote sells (one extra read)", async () => {
    const w = await tty();
    w.route(call("get_balances"), () => ok("get_balances", { status: 200, data: { ok: true, partial: false, balances: [{ mint: USDC, atoms: "500000", decimals: 6, amount: "0.5", symbol: U("USDC") }] } }));
    w.route(call("get_spot_quote"), () => ok("get_spot_quote", QUOTE_RESULT));
    expect(await w.run("quote", "--sell", "USDC", "--amount", "1", "--for", "SOL")).toBe(0);
    expect(w.stderr()).toContain("This agent holds 0.5 USDC, so an order for this quote would fail.");
  });

  it("--json keeps C.39 on stderr and no balance read", async () => {
    const w = await tty();
    w.route(call("get_spot_quote"), () => ok("get_spot_quote", QUOTE_RESULT));
    expect(await w.run("quote", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--json")).toBe(0);
    expect(w.stderr()).toContain("Quote aqt_abc123 expires in 30s. To place it: darwin order --quote aqt_abc123 --sell USDC --amount 1 --for SOL");
    expect(w.calls.some((c) => c.url.endsWith(call("get_balances")))).toBe(false);
  });
});

describe("darwin order / instant", () => {
  const ORDER = {
    status: 200,
    data: { ok: true, orderId: "s6l8wht2qxo8vaky5ps8o", txSignature: SIG, quotedOutAtoms: "8242000", clientOrderNonce: "cli_x", status: "submitted" },
    summary: { sell: { symbol: U("USDC"), mint: USDC, amount: "1", atoms: "1000000" }, receive: { symbol: U("SOL"), mint: SOL, quoted: "0.008242", quotedAtoms: "8242000" } },
  };

  it("names the order and the nonce correctly, waits briefly, and reports what was received", async () => {
    const w = await tty();
    let polls = 0;
    w.route(call("get_tx_status"), () => ok("get_tx_status", { status: 200, data: { ok: true, signature: SIG, status: ++polls >= 2 ? "confirmed" : "submitted" } }));
    w.route(call("list_spot_orders"), () => ok("list_spot_orders", { status: 200, data: { ok: true, orders: [{ orderId: "s6l8wht2qxo8vaky5ps8o", inputMint: USDC, inputAtoms: "1000000", outputMint: SOL, outputAtoms: "8238000", status: "confirmed", createdAt: NOW }], nextCursor: null } }));
    w.route(call("get_grant"), () => ok("get_grant", { status: 200, data: { ok: true, grant: {}, today: { remaining: { notionalUsd: null, txCount: null, riskUsd: null } } } }));
    const out = await both(w, "place_spot_order", ORDER, "order", "--quote", "aqt_abc123", "--sell", "USDC", "--amount", "1", "--for", "SOL");
    const nonce = (w.calls.filter((c) => c.url.endsWith(call("place_spot_order"))).at(-1)!.body as { arguments: { clientOrderNonce: string } }).arguments.clientOrderNonce;
    expect(out).toBe([
      `Sent: sell 1 USDC for SOL on Laptop bot · order s6l8wht2qxo8vaky5ps8o · nonce ${nonce}`,
      "Expected: about 0.008242 SOL",
      "Status: sent to the network, not confirmed yet",
      `Transaction: ${SIG}`,
      "Confirmed on chain: received 0.008238 SOL.",
      "",
    ].join("\n"));
    // No trade-count limit → no "counts against today's transaction budget".
    expect(out).not.toContain("budget");
    expect(out).not.toContain("get_tx_status");
  });

  it("not landed within the wait → the CLI command that checks it; a trade-count cap is shown", async () => {
    const w = await tty();
    w.route(call("get_tx_status"), () => ok("get_tx_status", { status: 200, data: { ok: true, signature: SIG, status: "submitted" } }));
    w.route(call("get_grant"), () => ok("get_grant", { status: 200, data: { ok: true, grant: {}, today: { remaining: { notionalUsd: 90, txCount: 7, riskUsd: null } } } }));
    w.route(call("spot_order_now"), () => ok("spot_order_now", {
      status: 200,
      data: { ok: true, orderId: "ord_9", txSignature: SIG, clientOrderNonce: "cli_y", status: "submitted", inputMint: USDC, outputMint: SOL, inAtoms: "1000000", quotedOutAtoms: "8242000", minOutAtoms: "8200000", maxSlippageBps: 50, router: "dflow", quoteId: "q" },
      summary: { sell: { symbol: U("USDC"), mint: USDC, amount: "1" }, receive: { symbol: U("SOL"), quoted: "0.008242", atLeast: "0.0082" }, orderId: "ord_9", txSignature: SIG, status: "submitted", next: "Sent to the network, not yet confirmed. Call get_tx_status with this txSignature to see whether it landed." },
    }));
    expect(await w.run("instant", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--max-slippage-bps", "50")).toBe(0);
    const out = w.stdout();
    expect(out).toContain("Expected: about 0.008242 SOL (at least 0.0082 SOL)");
    expect(out).toContain(`Not confirmed yet. Check it with: darwin tx ${SIG}`);
    expect(out).toContain("Trades left today: 7");
    expect(out).not.toContain("get_tx_status");
    expect(w.calls.filter((c) => c.url.endsWith(call("get_tx_status")))).toHaveLength(4);
  });
});

describe("account commands", () => {
  it("agents: names plain (escapes stripped), never 'untrusted:'", async () => {
    const w = await tty("agents");
    const result = { status: 200, data: { permissions: "Read: all agents · Trade: all active agents", agents: [
      { id: "agr_home", name: U(HOSTILE), solanaAddress: SOL, status: "active" },
      { id: "agr_2", name: U("USDC"), solanaAddress: USDC, status: "paused" },
    ] } };
    const out = await both(w, "list_agents", result, "agents");
    expect(out).toContain("cli1click");
    expect(out).not.toContain("evil.example");
    expect(out).toMatch(/^Name +ID +Status +Wallet$/m);
    expect(out).toContain("This API key: Read: all agents · Trade: all active agents");
  });

  it("hello: the CLI welcome from structured fields; the connector's instructions never printed", async () => {
    const w = await tty();
    const result = { welcome: "## Welcome\n```\nSo11…\n```\nYour agent has already read Darwin's docs", solanaAddress: SOL, agentPageUrl: "https://darwin.finance/agent-account/agr_home", manageUrl: "https://evil.example/x", ok: true, untrusted: { agentName: "Laptop bot" }, instructions: "Show `welcome` to your user verbatim, before anything else you say." };
    const out = await both(w, "hello", result, "hello");
    expect(out).toBe([
      "Agent: Laptop bot on darwin.finance",
      `Agent wallet (fund it to trade): ${SOL}`,
      "Agent page: https://darwin.finance/agent-account/agr_home",
      "Try: darwin market-status · darwin balances · darwin quote --sell USDC --amount 1 --for SOL",
      "",
    ].join("\n"));
  });

  it("hello: a page link on another host is never shown", async () => {
    const w = await tty();
    w.route(call("hello"), () => ok("hello", { solanaAddress: SOL, agentPageUrl: "https://evil.example/agent", ok: true, untrusted: { agentName: "x" } }));
    expect(await w.run("hello")).toBe(0);
    expect(w.stdout()).not.toContain("evil.example");
  });

  it("grant: limits in words", async () => {
    const w = await tty();
    const result = { status: 200, data: { ok: true,
      grant: { id: "g", status: "active", agentName: U("Laptop bot"), paused: false, pausedAt: null, wallet: SOL, allowedActions: ["spot_swap", "perps"],
        capLimits: { perTxMaxUsd: { value: 100, unlimited: false, refusesAll: false }, dailyMaxUsd: { value: null, unlimited: true, refusesAll: false } },
        slippage: { globalMaxBps: 100, overrides: [], source: "grant" }, unlisted: { enabled: false } },
      today: { day: "2027-01-15", notionalUsd: 12.5, txCount: 2, riskUsd: 0, remaining: { notionalUsd: null, txCount: null, riskUsd: null } } } };
    const out = await both(w, "get_grant", result, "grant");
    expect(out).toContain("Agent: Laptop bot · active");
    expect(out).toContain("Limits: per tx max: $100.00 · daily max: no limit");
    expect(out).toContain("Max slippage: 100 bps");
    expect(out).toContain("Left today: no dollar limit · no trade-count limit");
    expect(out).toContain("Used today: $12.50 traded · 2 trades (UTC day 2027-01-15; resets at midnight UTC)");
    expect(out).toContain("Tokens Darwin doesn't list: not allowed");
  });

  it("pause: CLI wording, not the connector's tellYourUser", async () => {
    const w = await tty();
    const result = { status: 200, data: { ok: true, paused: true, pausedAt: 1_800_000_000, changed: true }, summary: { paused: true, canResume: false, tellYourUser: "This Darwin agent is paused: it can't trade until its owner resumes it on Darwin.", pausedAt: 1_800_000_000, pausedAtIso: "2027-01-15T08:00:00.000Z" } };
    const out = await both(w, "pause_agent", result, "pause");
    expect(out).toBe("Paused Laptop bot at Jan 15, 2:00 AM CST.\nIt can't trade until you resume it on its Darwin page. This API key still reads its balances and orders.\n");
  });

  it("balances: whole tokens in a table, fee SOL and warnings in words", async () => {
    const w = await tty();
    const result = { status: 200, data: { ok: true, wallet: SOL, partial: true,
      balances: [{ mint: USDC, atoms: "12500000", decimals: 6, uiAmount: 12.5, amount: "12.5", symbol: U("USDC"), listed: true }, { mint: "Bad1111111111111111111111111111111111111111", atoms: "5", decimals: null, uiAmount: null, symbol: U("\u001b[2JEVIL"), listed: false }],
      nativeSolLamports: "25000000", wrappedSolAtoms: null, gasSponsored: true, gasLow: false, gasLowThresholdLamports: "1" } };
    const out = await both(w, "get_balances", result, "balances");
    expect(out).toMatch(/^USDC +12\.5 +EPjF/m);
    expect(out).toMatch(/^EVIL +5 \(smallest units\) +Bad1/m);
    expect(out).toContain("(not listed on Darwin)");
    expect(out).toContain("SOL for network fees: 0.025");
    expect(out).toContain("Network fees: paid by Darwin.");
    expect(out).toContain("may be incomplete");
  });

  it("orders: symbols and whole tokens (from the markets), local time, a next-page command", async () => {
    const w = await tty();
    const result = { status: 200, data: { ok: true, orders: [{ orderId: "ord_1", instrumentId: `spot:solana:${SOL}`, side: "buy", listing: "darwin", status: "confirmed", terminal: true, inputMint: USDC, inputAtoms: "1000000", outputMint: SOL, outputAtoms: "8238000", router: "dflow", slippageBps: 25, quoteId: "q", txSignature: SIG, errorCode: null, createdAt: NOW, updatedAt: NOW }], nextCursor: "1800000000000.ord_1" } };
    const out = await both(w, "list_spot_orders", result, "orders");
    expect(out).toContain("Jan 15, 2:00 AM CST  1 USDC → 0.008238 SOL  confirmed  ord_1");
    expect(out).toContain("More: darwin orders --cursor 1800000000000.ord_1");
    expect(out).not.toContain(USDC);
  });

  it("tx, markets, docs", async () => {
    const w = await tty();
    expect(await both(w, "get_tx_status", { status: 200, data: { ok: true, signature: SIG, status: "failed", error: "not_landed" } }, "tx", SIG)).toBe(`Transaction ${SIG}: failed\nReason: not landed\n`);
    const m = await both(w, "list_spot_markets", MARKETS_RESULT, "markets");
    expect(m).toMatch(/^USDC +spot +stablecoin +open +EPjF/m);
    const d = await both(w, "get_api_reference", { text: "## 12. Spot\nUse place_spot_order after get_spot_quote (§12b)." }, "docs", "12");
    expect(d).toContain("Use `darwin order` after `darwin quote` (`darwin docs 12b`).");
  });
});

describe("history and perps", () => {
  it("trades / pnl / lots", async () => {
    const w = await tty();
    const t = await both(w, "list_trades", { status: 200, data: { ok: true, wallet: SOL, asOfMs: NOW, nextCursor: null, trades: [
      { tradeId: "t1", kind: "spot", side: "buy", placedBy: "agent", instrumentAssetId: "solana", in: { mint: USDC, atoms: "1000000", usd: 1 }, out: { mint: SOL, atoms: "8238000", usd: 1 }, networkFee: {}, realizedSlippageBps: 3, taxPending: false, txSignature: SIG, settledAtMs: NOW },
      { tradeId: "t2", kind: "perp", symbol: U("SOL"), side: "sell", placedBy: "agent", sizeBase: "0.5", priceUsd: 120.5, realizedPnlUsd: -1.25, feesUsd: 0.01, liquidity: null, tradeType: null, txSignature: null, settledAtMs: NOW },
    ] } }, "history", "trades");
    expect(t).toContain("1 USDC → 0.008238 SOL");
    expect(t).toContain("sell 0.5 SOL @ $120.50");
    expect(t).toContain("−$1.25");
    const p = await both(w, "get_pnl", { status: 200, data: { ok: true, wallet: SOL, asOfMs: NOW, period: "ytd",
      spot: { realizedUsd: { shortTerm: { usd: 1, complete: true, excluded: [] }, longTerm: { usd: 0, complete: true, excluded: [] }, total: { usd: 1, complete: false, excluded: [] } }, unrealizedUsd: { usd: 2.5, complete: true, excluded: [] }, positions: [] },
      perps: { realizedUsd: { usd: null, complete: false, excluded: [] } }, feesUsd: {}, notes: ["Wash sales are not applied."] } }, "history", "pnl");
    expect(p).toContain("P&L (ytd) as of Jan 15, 2:00 AM CST");
    expect(p).toContain("Spot: realized $1.00 (incomplete) · short-term $1.00 · long-term $0.00 · unrealized $2.50");
    expect(p).toContain("Perps: realized unknown");
    expect(p).toContain("Note: Wash sales are not applied.");
    const l = await both(w, "list_lots", { status: 200, data: { ok: true, wallet: SOL, asOfMs: NOW, method: "FIFO", lots: [{ lotId: "l1", assetId: "solana", qty: 0.5, availableQty: 0.5, reservedQty: 0, basisPerUnitUsd: 100, costBasisUsd: 50, acquiredAtMs: NOW, term: "short", markUsd: 120, unrealizedUsd: 10, unpriced: false, provisional: false }] } }, "history", "lots");
    expect(l).toContain("Tax lots (method: FIFO)");
    expect(l).toMatch(/solana +0\.5 +0\.5 +\$50\.00 +Jan 15, 2:00 AM CST +short +\$10\.00/);
  });

  it("perps reads", async () => {
    const w = await tty();
    expect(await both(w, "get_perp_quote", { status: 200, data: { ok: true, symbol: "SOL", markUsd: 120.5, indexUsd: 120.4, fundingRatePct: -0.01, tradeable: true, slot: 1 } }, "perps", "quote", "SOL"))
      .toBe("SOL perps: mark $120.50 · index $120.40 · −0.01% funding (+ = longs pay)\n");
    const pos = await both(w, "list_perp_positions", { status: 200, data: { ok: true, wallet: SOL, hasTraderAccount: true, slot: 1, positions: [{ symbol: "SOL", side: "long", sizeBase: 1.5, entryUsd: 100, markUsd: 120, notionalUsd: 180, uPnlUsd: 30, liqUsd: 50, marginUsd: 20, takeProfitUsd: 150, stopLossUsd: null, takeProfitCount: 1, stopLossCount: 0, subaccountIndex: 0, marginKind: "cross" }] } }, "perps", "positions");
    expect(pos).toMatch(/^SOL +long +1\.5 +\$100\.00 +\$120\.00 +\$30\.00 +\$50\.00 +\$150\.00 \/ —$/m);
    expect(await both(w, "get_perp_account", { status: 200, data: { ok: true, wallet: SOL, hasTraderAccount: false, account: {} } }, "perps", "account")).toBe("This agent has no perps account yet.\n");
  });

  it("indicators: required flags are checked locally, before anything is sent", async () => {
    const w = await tty();
    expect(await w.run("indicators", "--timeframe", "1h")).toBe(2);
    expect(w.stderr()).toContain("needs --indicators");
    w.err.length = 0;
    expect(await w.run("indicators", "--timeframe", "1h", "--indicators", "rsi:14")).toBe(2);
    expect(w.stderr()).toContain("exactly one of --instrument-id");
    expect(w.calls.filter((c) => c.url.includes("/tools/call/"))).toHaveLength(0);
    w.route(call("get_indicators"), (c) => ok("get_indicators", { status: 200, data: { asset_id: "solana", candle_asset_id: "solana", timeframe: (c.body as { arguments: { timeframe: string } }).arguments.timeframe, indicators: [{ key: "rsi_14", name: "rsi", params: { period: 14 } }], bars: [{ open_time_ms: NOW, open: 1, high: 2, low: 0.5, close: 1.5, rsi_14: 55.123456789 }], last_closed_bar_ms: NOW, stale: false, source_realm: "production" } }));
    w.out.length = 0;
    expect(await w.run("indicators", "--instrument-id", `spot:solana:${SOL}`, "--timeframe", "1h", "--indicators", "rsi:14")).toBe(0);
    expect(w.stdout()).toContain("Indicators for solana on 1h candles");
    expect(w.stdout()).toMatch(/Jan 15, 2:00 AM CST +1\.5 +55\.123457/);
    const sent = w.calls.find((c) => c.url.endsWith(call("get_indicators")))!.body as { arguments: Record<string, unknown> };
    expect(sent.arguments).toEqual({ instrumentId: `spot:solana:${SOL}`, timeframe: "1h", indicators: "rsi:14" });
  });

  it("--json help is the catalogue's own (no local flags, no terminal wording)", async () => {
    const w = world();
    expect(await w.run("indicators", "--help", "--json")).toBe(0);
    expect(JSON.parse(w.stdout()).flags).toEqual([]);
    w.out.length = 0;
    expect(await w.run("hello", "--help", "--json")).toBe(0);
    expect(JSON.parse(w.stdout()).description).toBe(snapshotFor("agent").tools.find((t) => t.name === "hello")!.description);
  });

  it("indicators --help names its flags", async () => {
    const w = world({ tty: true });
    expect(await w.run("indicators", "--help")).toBe(0);
    expect(w.stdout()).toContain("--timeframe <timeframe>");
    expect(w.stdout()).toContain("--timeframe <string> (required)  Candle size");
  });
});

describe("refusals in a terminal", () => {
  const c = snapshotFor("agent");
  it("connector tool names in Darwin's detail become CLI commands", () => {
    const lines = refusalLines({ error: "unknown_asset", detail: U("sell: \"FOO\" is not a Darwin spot market symbol. Check list_spot_markets, or pass the token's mint address."), sent: false }, c);
    expect(lines[0]).toBe("Darwin refused this: sell: \"FOO\" is not a Darwin spot market symbol. Check `darwin markets`, or pass the token's mint address. Nothing was sent.");
    expect(lines.join("\n")).not.toContain("list_spot_markets");
  });

  it.each([
    ["market_closed", "That market is closed right now."],
    ["quote_expired", "That quote expired (a quote lasts 30 seconds)."],
    ["quote_price_moved", "The price moved beyond the quote's slippage limit."],
    ["daily_cap", "This agent has used today's trading budget."],
    ["slippage_exceeds_grant", "looser than your owner's maximum"],
  ])("%s", (code, text) => {
    const lines = refusalLines({ status: 409, data: { ok: false, error: code, refusal: code, retrySafe: true, retryable: false, detail: "execution_reference_market_closed" } }, c);
    expect(lines[0]).toContain(text);
    expect(lines[0]).toContain("Nothing was sent.");
    expect(lines.join("\n")).not.toContain("execution_reference");
    expect(lines.at(-1)).toBe(`(${code})`);
  });

  it("an ambiguous symbol lists the candidates (hostile names cleaned)", () => {
    const lines = refusalLines({ error: "ambiguous_asset", detail: U("several"), sent: false, candidates: [{ symbol: U("USDC\u001b[2J"), mint: USDC, issuer: U("Circle") }, { symbol: U("USDC"), mint: SOL, issuer: null }] }, c);
    expect(lines).toEqual([
      "That symbol names more than one token. Pass the token's mint address instead:",
      `  USDC  ${USDC}  (Circle)`,
      `  USDC  ${SOL}`,
      "(ambiguous_asset)",
    ]);
  });

  it("a refused order prints the refusal to stderr, never a data dump", async () => {
    const w = await tty();
    w.route(call("place_spot_order"), () => refused("place_spot_order", { status: 410, data: { ok: false, error: "quote_expired", refusal: "quote_expired", retrySafe: true, retryable: true, detail: U("quote expired") } }));
    expect(await w.run("order", "--quote", "aqt_1", "--sell", "USDC", "--amount", "1", "--for", "SOL")).toBe(4);
    expect(w.stdout()).toBe("");
    expect(w.stderr()).toContain("That quote expired (a quote lasts 30 seconds). Get a new one with `darwin quote`. Nothing was sent.");
    expect(w.stderr()).toContain("Order nonce: cli_");
    expect(w.stderr()).not.toContain("retrySafe");
  });
});

describe("--dry-run checks what it can without sending", () => {
  it("an order against a quote this terminal made: expiry and sell/amount/for compared locally", async () => {
    const w = await tty();
    w.route(call("get_balances"), () => ok("get_balances", { status: 200, data: { ok: true, partial: false, balances: [] } }));
    w.route(call("get_spot_quote"), () => ok("get_spot_quote", QUOTE_RESULT));
    expect(await w.run("quote", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--json")).toBe(0);
    w.calls.length = 0; w.out.length = 0;
    expect(await w.run("order", "--quote", "aqt_abc123", "--sell", "USDC", "--amount", "1.0", "--for", "SOL", "--dry-run")).toBe(0);
    expect(w.stdout()).toContain("Dry run — nothing was sent.");
    expect(w.stdout()).toContain("✓ --sell, --amount and --for match the quote");
    expect(w.stdout()).toContain("Not checked: the balance, the agent's limits and the price");
    w.out.length = 0;
    expect(await w.run("order", "--quote", "aqt_abc123", "--sell", "USDC", "--amount", "2", "--for", "SOL", "--dry-run")).toBe(4);
    expect(w.stdout()).toContain("✗ this doesn't match the quote: --amount (quote: 1)");
    w.out.length = 0;
    await w.ctx.sleep(31_000);
    expect(await w.run("order", "--quote", "aqt_abc123", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--dry-run")).toBe(4);
    expect(w.stdout()).toContain("✗ the quote expired");
    // --json: the 1.0.0 preview, exit 0; the failed check is on stderr.
    w.out.length = 0; w.err.length = 0;
    expect(await w.run("order", "--quote", "aqt_abc123", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--dry-run", "--json")).toBe(0);
    expect(Object.keys(JSON.parse(w.stdout())).sort()).toEqual(["agent", "arguments", "command", "costsTx", "dryRun", "note", "realm", "sent", "tool", "write"]);
    expect(w.stderr()).toContain("Dry run check failed: the quote expired");
    expect(w.calls).toHaveLength(0);
  });

  it("an unknown quote id is reported as not checked, not as fine", async () => {
    const w = await tty();
    expect(await w.run("order", "--quote", "aqt_doesnotexist", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--dry-run")).toBe(0);
    expect(w.stdout()).toContain("Not checked: the quote: this terminal didn't make it");
    expect(w.calls).toHaveLength(0);
  });
});

describe("help is written for a person", () => {
  it("connector names and § references become commands", () => {
    const c = snapshotFor("agent");
    expect(forTerminal("Execute a spot quote. Pass the quote's quoteId (from get_spot_quote); see get_api_reference §14 and list_spot_markets.", c))
      .toBe("Execute a spot quote. Pass the quote's quoteId (from `darwin quote`); see `darwin docs 14` and `darwin markets`.");
    expect(forTerminal("Call `get_tx_status` — not quote_expired.\n    indented  code", c)).toBe("Call `darwin tx` — not quote_expired.\n    indented  code");
  });

  it("the overview ends with CLI guidance, not the AI client's instructions", async () => {
    const w = world({ tty: true });
    expect(await w.run("help")).toBe(0);
    const out = w.stdout();
    expect(out).not.toContain("untrusted");
    expect(out).not.toContain("ONLY when the user explicitly asks");
    expect(out).toContain("JSON when piped or redirected");
    expect(out).toContain("`darwin grant` shows your limits");
  });

  it("order --help", async () => {
    const w = world({ tty: true });
    expect(await w.run("order", "--help")).toBe(0);
    const out = w.stdout();
    expect(out).not.toMatch(/\bget_spot_quote\b|\bplace_spot_order\b|summary\.sell\.amount|get_api_reference/);
    expect(out).toContain("`darwin quote`");
  });
});

describe("codex review r1", () => {
  it("a sub-dollar price keeps its digits", async () => {
    const { usd } = await import("../src/human.js");
    expect(usd(0.00000123)).toBe("$0.00000123");
    expect(usd(0.5)).toBe("$0.50");
    expect(usd("0.012345")).toBe("$0.01235");
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(-0.25)).toBe("−$0.25");
    expect(usd(0.99999)).toBe("$1.00");
    expect(usd(1e-21)).toBe("$1.000e-21");
    expect(usd(0.1)).toBe("$0.10");
  });

  it("an atoms field is kept when its whole-token twin is null", async () => {
    const { genericLines } = await import("../src/human.js");
    expect(genericLines({ amount: null, atoms: "123456789", decimals: null }).join("\n")).toContain("atoms: 123456789");
    expect(genericLines({ amount: "1.5", atoms: "1500000" }).join("\n")).not.toContain("atoms");
  });

  it("a write refused with retrySafe:false never says 'Nothing was sent'", () => {
    const lines = refusalLines({ status: 502, data: { ok: false, error: "relay_unavailable", refusal: "relay_unavailable", retrySafe: false, retryable: true } }, null, true);
    expect(lines.join("\n")).not.toContain("Nothing was sent");
    expect(lines.join("\n")).toContain("check `darwin orders` before trying again");
    // No retrySafe at all → no claim, and no "try again" for a write.
    const bare = refusalLines({ status: 400, data: { error: "relay_unavailable" } }, null, true).join("\n");
    expect(bare).not.toContain("Nothing was sent");
    expect(bare).not.toContain("Try again");
    expect(bare).toContain("check `darwin orders` before trying again");
    // A read refused with no flags just says what Darwin said.
    expect(refusalLines({ status: 400, data: { error: "below_min_trade" } }, null, false)[0]).toBe("That amount is below the minimum trade size.");
  });

  it("a transaction known to have failed exits 4; the wait is bounded", async () => {
    const w = await tty();
    w.route(call("get_tx_status"), () => ok("get_tx_status", { status: 200, data: { ok: true, signature: SIG, status: "failed" } }));
    w.route(call("place_spot_order"), () => ok("place_spot_order", { status: 200, data: { ok: true, orderId: "o", txSignature: SIG, status: "submitted" } }));
    const t0 = w.ctx.now();
    expect(await w.run("order", "--quote", "q", "--sell", "USDC", "--amount", "1", "--for", "SOL")).toBe(4);
    expect(w.stderr()).toContain("The transaction failed on chain");
    expect(w.ctx.now() - t0).toBeLessThan(20_000);
  });

  it("a write the server already reports failed exits 4 without waiting", async () => {
    const w = await tty();
    w.route(call("spot_order_now"), () => ok("spot_order_now", { status: 200, data: { ok: true, orderId: "o", txSignature: SIG, status: "failed", replayed: true } }));
    expect(await w.run("instant", "--sell", "USDC", "--amount", "1", "--for", "SOL", "--max-slippage-bps", "50")).toBe(4);
    expect(w.calls.some((c) => c.url.endsWith(call("get_tx_status")))).toBe(false);
  });

  it("a malformed markets list doesn't break `darwin orders`", async () => {
    const w = await loggedIn("agent", { tty: true });
    w.route(call("list_spot_markets"), () => ok("list_spot_markets", { status: 200, data: { instruments: [null, 5, { mint: USDC, symbol: U("USDC"), decimals: 6, instrumentType: "spot" }] } }));
    w.route(call("list_spot_orders"), () => ok("list_spot_orders", { status: 200, data: { orders: [{ orderId: "o1", inputMint: USDC, inputAtoms: "1000000", outputMint: SOL, outputAtoms: null, status: "failed", errorCode: "quote_expired", createdAt: NOW }], nextCursor: null } }));
    expect(await w.run("orders")).toBe(0);
    expect(w.stdout()).toContain("1 USDC → So11…1112  failed (quote_expired)  o1");
  });

  it("--dry-run compares a mint exactly", async () => {
    const w = await tty();
    w.route(call("get_balances"), () => ok("get_balances", { status: 200, data: { balances: [] } }));
    w.route(call("get_spot_quote"), () => ok("get_spot_quote", QUOTE_RESULT));
    expect(await w.run("quote", "--sell", USDC, "--amount", "1", "--for", "SOL", "--json")).toBe(0);
    w.out.length = 0;
    expect(await w.run("order", "--quote", "aqt_abc123", "--sell", USDC.toLowerCase(), "--amount", "1", "--for", "sol", "--dry-run")).toBe(4);
    expect(w.stdout()).toContain("✗ this doesn't match the quote: --sell");
  });
});
