/**
 * One human rendering per command (a terminal, no `--json`). Each takes the tool call's `result`
 * — `{ status, data, summary? }` exactly as the server serialized it — and returns lines for `say`.
 * Anything without a renderer here falls back to `genericLines` (human.ts). `--json` never comes
 * through this file: it prints the server's object unchanged.
 *
 * 🔴 A server string is shown only through `txt` / `label` (cleaned, `{untrusted}` unwrapped).
 * 🔴 Text the server writes for an AI client (`next`, `instructions`, `tellYourUser`, `welcome`)
 *    is never printed; the CLI says what to do next in its own words.
 */
import { arr, clock, genericLines, label, money, num, obj, txt, usd, when, words } from "./human.js";
import { forTerminal } from "./help.js";
import type { Catalogue } from "./catalogue.js";
import type { Realm } from "./realms.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const ROUTER: Record<string, string> = { dflow: "dFlow", deflow: "dFlow", jupiter: "Jupiter" };

export interface RenderCtx {
  realm: Realm;
  now: number;
  /** The arguments the command sent (friendly: sell / amount / for …). */
  args: Record<string, unknown>;
  catalogue: Pick<Catalogue, "tools"> | null;
  /** C.46's "on <agent>", and the order ID (nonce) a write was sent with. */
  agentLabel: string;
  nonce: string | null;
  /** Spot markets by mint (for naming mints and converting atoms), when they could be read. */
  markets?: Map<string, { symbol: string; decimals: number | null }>;
}

// ─── small pieces ───────────────────────────────────────────────────────────

/** "So11…1112" — enough of a mint to recognise it. */
export const shortMint = (m: unknown): string => {
  const s = txt(m);
  return BASE58.test(s) ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

/** Exact whole-token decimal from an atoms string. */
export function formatAtoms(atoms: unknown, decimals: number | null | undefined): string {
  const a = txt(atoms);
  if (!/^[0-9]{1,40}$/.test(a) || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return "";
  if (decimals === 0) return BigInt(a).toString();
  const s = a.padStart(decimals + 1, "0");
  const whole = BigInt(s.slice(0, -decimals)).toString();
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const yesNo = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "");
const router = (v: unknown) => ROUTER[txt(v).toLowerCase()] ?? txt(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A token as a person knows it: its symbol, else its shortened mint. */
function tokenName(side: Record<string, unknown>, mint?: unknown, x?: RenderCtx): string {
  const sym = label(side.symbol, 24);
  if (sym) return sym;
  const m = txt(mint ?? side.mint);
  return x?.markets?.get(m)?.symbol || shortMint(m);
}

/** Fixed-width columns (no borders). Every cell is already plain text. */
export function columns(head: string[], rows: string[][], indent = ""): string[] {
  if (rows.length === 0) return [];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (vals: string[]) => `${indent}${vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]!))).join("  ")}`.trimEnd();
  return [line(head), ...rows.map(line)];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ─── login / hello ──────────────────────────────────────────────────────────

/**
 * The terminal welcome (login and `darwin hello`), from hello's STRUCTURED fields only: the agent's
 * wallet (base58-checked) and its page (an https link on this realm only). Never the server's prose.
 */
export function welcomeLines(realm: Realm, hello: Record<string, unknown> | null, agentName: string): string[] {
  const h = hello ?? {};
  const out = [`Agent: ${label(agentName, 120) || "your agent"} on ${realm}`];
  const addr = typeof h.solanaAddress === "string" && BASE58.test(h.solanaAddress) ? h.solanaAddress : null;
  if (addr) out.push(`Agent wallet (fund it to trade): ${addr}`);
  const page = sameRealmUrl(h.agentPageUrl, realm);
  if (page) out.push(`Agent page: ${page}`);
  out.push("Try: darwin market-status · darwin balances · darwin quote --sell USDC --amount 1 --for SOL");
  return out;
}

export function sameRealmUrl(v: unknown, realm: Realm): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.host === realm && !u.username && !u.password ? txt(u.toString()) : null;
  } catch {
    return null;
  }
}

function hello(r: Record<string, unknown>, x: RenderCtx): string[] {
  const name = txt(obj(r.untrusted).agentName) || txt(r.agentName) || x.agentLabel;
  return welcomeLines(x.realm, r, name);
}

// ─── account ────────────────────────────────────────────────────────────────

function agents(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const list = arr(d.agents).map(obj);
  if (list.length === 0) return ["No active agents for this API key."];
  const rows = list.map((a) => [label(a.name, 40) || "(unnamed)", txt(a.id), txt(a.status) || "", BASE58.test(txt(a.solanaAddress)) ? txt(a.solanaAddress) : ""]);
  const out = columns(["Name", "ID", "Status", "Wallet"], rows);
  const perms = txt(d.permissions);
  if (perms) out.push("", `This API key: ${perms}`);
  return out;
}

function capLine(key: string, c: Record<string, unknown>): string {
  const name = words(key).replace(/\busd\b/, "").trim();
  if (c.refusesAll === true) return `${name}: none allowed`;
  if (c.unlimited === true || c.value === null) return `${name}: no limit`;
  return `${name}: ${/Usd$/.test(key) ? usd(c.value) : num(c.value)}`;
}

function grant(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const g = obj(d.grant);
  const t = obj(d.today);
  const out: string[] = [];
  const paused = g.paused === true;
  out.push(`Agent: ${label(g.agentName, 80) || "this agent"} · ${paused ? `paused${when(g.pausedAt) ? ` since ${when(g.pausedAt)}` : ""}` : txt(g.status) || "active"}`);
  if (BASE58.test(txt(g.wallet))) out.push(`Wallet: ${txt(g.wallet)}`);
  const actions = arr(g.allowedActions).map(txt).filter(Boolean);
  if (actions.length) out.push(`Can: ${actions.map((a) => a.replace(/_/g, " ")).join(", ")}`);
  const caps = Object.entries(obj(g.capLimits)).map(([k, c]) => capLine(k, obj(c)));
  if (caps.length) out.push(`Limits: ${caps.join(" · ")}`);
  const sl = obj(g.slippage);
  if (typeof sl.globalMaxBps === "number") {
    const overrides = arr(sl.overrides).length;
    out.push(`Max slippage: ${sl.globalMaxBps} bps${overrides ? ` (${plural(overrides, "token-specific override")})` : ""}`);
  }
  const rem = obj(t.remaining);
  const left = [
    rem.notionalUsd === null ? "no dollar limit" : usd(rem.notionalUsd) ? `${usd(rem.notionalUsd)} to trade` : "",
    rem.txCount === null ? "no trade-count limit" : typeof rem.txCount === "number" ? plural(rem.txCount, "trade") : "",
    rem.riskUsd === null ? "" : usd(rem.riskUsd) ? `${usd(rem.riskUsd)} of risk` : "",
  ].filter(Boolean);
  if (left.length) out.push(`Left today: ${left.join(" · ")}`);
  const used = [usd(t.notionalUsd) ? `${usd(t.notionalUsd)} traded` : "", typeof t.txCount === "number" ? plural(t.txCount, "trade") : ""].filter(Boolean);
  if (used.length) out.push(`Used today: ${used.join(" · ")}${txt(t.day) ? ` (UTC day ${txt(t.day)}; resets at midnight UTC)` : ""}`);
  const u = obj(g.unlisted);
  if (u.enabled === true) out.push(`Tokens Darwin doesn't list: allowed — ${usd(u.dailyAcquisitionUsd)} a day to buy, ${usd(u.dailyDisposalUsd)} to sell`);
  else if (u.enabled === false) out.push("Tokens Darwin doesn't list: not allowed");
  return out;
}

function pause(r: Record<string, unknown>, x: RenderCtx, kind: "agent" | "agents"): string[] {
  const s = obj(r.summary);
  const at = when(s.pausedAtIso) || when(s.pausedAt) || when(obj(r.data).pausedAt);
  const changed = obj(r.data).changed;
  const head = changed === false ? `${x.agentLabel} was already paused.` : `Paused ${x.agentLabel}${at ? ` at ${at}` : ""}.`;
  return [
    head,
    kind === "agents"
      ? "It can't trade until you resume it on its Darwin page, and this API key can't act on it until then. It still works for your other active agents."
      : "It can't trade until you resume it on its Darwin page. This API key still reads its balances and orders.",
  ];
}

// ─── spot ───────────────────────────────────────────────────────────────────

/** The `--sell` / `--for` value to repeat: what the user typed (a symbol or a mint). */
const typed = (v: unknown) => txt(v).replace(/[^A-Za-z0-9._-]/g, "");

function quote(r: Record<string, unknown>, x: RenderCtx): string[] {
  const s = obj(r.summary);
  const d = obj(r.data);
  const sell = obj(s.sell);
  const recv = obj(s.receive);
  const sellName = tokenName(sell, d.inputMint, x);
  const getName = tokenName(recv, d.outputMint, x);
  const amount = num(sell.amount) || num(x.args.amount);
  const quoted = num(recv.quoted);
  const atLeast = num(recv.atLeast);
  const out = [`Sell ${amount} ${sellName} → ${quoted ? `about ${quoted} ${getName}` : getName}${atLeast ? ` (at least ${atLeast} ${getName})` : ""}`];
  const parts: string[] = [];
  if (typeof d.maxSlippageBps === "number") parts.push(`Max slippage ${d.maxSlippageBps} bps`);
  if (txt(d.router)) parts.push(`route ${router(d.router)}`);
  const exp = typeof d.expiresAtMs === "number" ? d.expiresAtMs : null;
  if (exp !== null) parts.push(`quote expires in ${Math.max(0, Math.ceil((exp - x.now) / 1000))}s (${clock(new Date(exp))})`);
  if (parts.length) out.push(parts.join(" · "));
  const id = txt(d.quoteId) || txt(s.quoteId);
  if (id && /^[A-Za-z0-9_-]{1,80}$/.test(id) && sell.amount !== null) {
    out.push(`To place it: darwin order --quote ${id} --sell ${typed(x.args.sell)} --amount ${amount} --for ${typed(x.args.for)}`);
  } else if (sell.amount === null) {
    out.push("This token's decimals aren't known, so this quote can't be placed by amount.");
  }
  return out;
}

function spotWrite(r: Record<string, unknown>, x: RenderCtx, instant: boolean): string[] {
  const s = obj(r.summary);
  const d = obj(r.data);
  const sell = obj(s.sell);
  const recv = obj(s.receive);
  const sellName = tokenName(sell, undefined, x) || typed(x.args.sell);
  const getName = tokenName(recv, undefined, x) || typed(x.args.for);
  const amount = num(sell.amount) || num(x.args.amount);
  const status = txt(s.status) || txt(d.status);
  const sig = txt(s.txSignature) || txt(d.txSignature);
  const orderId = txt(s.orderId) || txt(d.orderId);
  const nonce = x.nonce ?? txt(d.clientOrderNonce);
  const out = [`Sent: sell ${amount} ${sellName} for ${getName} on ${x.agentLabel} · ${orderId ? `order ${orderId} · ` : ""}nonce ${nonce}`];
  if (instant && d.replayed === true) out.push("(That nonce was already used, so this is the earlier order — nothing new was sent.)");
  const quoted = num(recv.quoted);
  const atLeast = num(recv.atLeast);
  if (quoted) out.push(`Expected: about ${quoted} ${getName}${atLeast ? ` (at least ${atLeast} ${getName})` : ""}`);
  if (status === "confirmed") out.push("Status: confirmed on chain");
  else if (status === "submitted") out.push("Status: sent to the network, not confirmed yet");
  else if (status) out.push(`Status: ${status}`);
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) out.push(`Transaction: ${sig}`);
  return out.filter(Boolean);
}

function balances(r: Record<string, unknown>, x: RenderCtx): string[] {
  const d = obj(r.data);
  const rows = arr(d.balances).map(obj);
  const out: string[] = [];
  if (BASE58.test(txt(d.wallet))) out.push(`Wallet: ${txt(d.wallet)}`);
  const lamports = txt(d.nativeSolLamports);
  const body = rows.map((b) => [
    tokenName(b, b.mint, x),
    num(b.amount) || formatAtoms(b.atoms, typeof b.decimals === "number" ? b.decimals : null) || `${txt(b.atoms)} (smallest units)`,
    b.listed === false ? `${txt(b.mint)} (not listed on Darwin)` : txt(b.mint),
  ]);
  if (body.length) out.push(...columns(["Token", "Amount", "Mint"], body));
  else out.push("No token balances.");
  if (/^[0-9]{1,20}$/.test(lamports)) out.push(`SOL for network fees: ${formatAtoms(lamports, 9)}`);
  if (d.gasSponsored === true) out.push("Network fees: paid by Darwin.");
  if (d.gasLow === true && d.gasSponsored !== true) out.push("⚠ Low on SOL for network fees — add SOL to keep trading.");
  if (d.partial === true) out.push("Some balances couldn't be read just now, so this list may be incomplete.");
  return out;
}

const atomsAs = (atoms: unknown, mint: unknown, x: RenderCtx): string => {
  const m = x.markets?.get(txt(mint));
  const amt = m ? formatAtoms(atoms, m.decimals) : "";
  return amt ? `${amt} ${m!.symbol}` : `${txt(atoms) || "?"} units of ${shortMint(mint)}`;
};

function orders(r: Record<string, unknown>, x: RenderCtx): string[] {
  const d = obj(r.data);
  const list = arr(d.orders).map(obj);
  if (list.length === 0) return ["No spot orders yet."];
  const rows = list.map((o) => [
    when(o.createdAt),
    `${atomsAs(o.inputAtoms, o.inputMint, x)} → ${o.outputAtoms === null ? x.markets?.get(txt(o.outputMint))?.symbol || shortMint(o.outputMint) : atomsAs(o.outputAtoms, o.outputMint, x)}`,
    `${txt(o.status)}${txt(o.errorCode) ? ` (${txt(o.errorCode)})` : ""}`,
    txt(o.orderId),
  ]);
  const out = columns(["When", "Trade", "Status", "Order"], rows);
  if (txt(d.nextCursor)) out.push("", `More: darwin orders --cursor ${txt(d.nextCursor)}`);
  return out;
}

function tx(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const st = txt(d.status);
  const what = st === "confirmed" ? "confirmed on chain" : st === "failed" ? "failed" : st === "submitted" ? "sent, not confirmed yet" : st;
  const out = [`Transaction ${txt(d.signature)}: ${what}${typeof d.slot === "number" ? ` (slot ${d.slot})` : ""}`];
  if (txt(d.error)) out.push(`Reason: ${txt(d.error).replace(/_/g, " ")}`);
  return out;
}

function spotMarkets(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const list = arr(d.instruments).map(obj);
  if (list.length === 0) return ["No markets."];
  const rows = list.map((m) => [
    label(m.symbol, 20),
    txt(m.instrumentType),
    txt(m.assetClass).replace(/_/g, " "),
    m.instrumentType === "perp" ? (m.tradeable === false || m.status === "paused" ? "paused" : "open") : m.marketOpen === false ? "closed now" : "open",
    m.instrumentType === "spot" ? txt(m.mint) : `max ${num(m.maxLeverage)}x`,
  ]);
  return columns(["Symbol", "Type", "Class", "Market", "Mint / leverage"], rows);
}

function unlistedInspect(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const name = label(d.name, 60);
  const sym = label(d.symbol, 24);
  const out = [`Token: ${[name, sym ? `(${sym})` : ""].filter(Boolean).join(" ") || "(no name)"}${txt(d.mint) ? ` · ${txt(d.mint)}` : ""}`];
  if (d.listing === "darwin") out.push("Darwin lists this token: trade it with `darwin quote`.");
  out.push(`Tradable as an unlisted token: ${d.eligible === true ? "yes" : "no"}`);
  for (const f of arr(d.refusals).map(obj)) out.push(`  ✗ ${txt(f.code).replace(/_/g, " ")}${txt(f.detail) ? ` — ${txt(f.detail)}` : ""}`);
  for (const f of arr(d.warnings).map(obj)) out.push(`  ! ${txt(f.code).replace(/_/g, " ")}${txt(f.detail) ? ` — ${txt(f.detail)}` : ""}`);
  const facts = [
    typeof d.decimals === "number" ? `${d.decimals} decimals` : "",
    typeof d.ageHours === "number" ? `${Math.round(d.ageHours)}h old` : "",
    typeof d.holders === "number" ? `${d.holders.toLocaleString("en-US")} holders` : "",
    usd(d.volume24hUsd) ? `24h volume ${usd(d.volume24hUsd)}` : "",
    usd(d.twapUsd) ? `price ${usd(d.twapUsd)} (${txt(d.twapWindow) || "1h"} average)` : "",
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(" · "));
  const b = obj(d.budget);
  if (usd(b.acquisitionRemainingUsd)) out.push(`Unlisted budget left today: ${usd(b.acquisitionRemainingUsd)} to buy · ${usd(b.disposalRemainingUsd)} to sell`);
  return out;
}

// ─── history ────────────────────────────────────────────────────────────────

const total = (t: unknown): string => {
  const o = obj(t);
  if (o.usd === null || o.usd === undefined) return o.complete === false ? "unknown" : "";
  return `${usd(o.usd)}${o.complete === false ? " (incomplete)" : ""}`;
};

function trades(r: Record<string, unknown>, x: RenderCtx): string[] {
  const d = obj(r.data);
  const list = arr(d.trades).map(obj);
  if (list.length === 0) return ["No settled trades yet."];
  const rows = list.map((t) => {
    if (t.kind === "perp") {
      return [when(t.settledAtMs), "perps", `${txt(t.side)} ${num(t.sizeBase)} ${label(t.symbol, 16)}${usd(t.priceUsd) ? ` @ ${usd(t.priceUsd)}` : ""}`, money(t.realizedPnlUsd)];
    }
    const i = obj(t.in);
    const o = obj(t.out);
    return [when(t.settledAtMs), "spot", `${atomsAs(i.atoms, i.mint, x)} → ${atomsAs(o.atoms, o.mint, x)}`, t.realizedPnlUsd === undefined ? "" : money(t.realizedPnlUsd) || "unknown"];
  });
  const out = columns(["Settled", "Kind", "Trade", "Realized P&L"], rows);
  if (txt(d.nextCursor)) out.push("", `More: darwin history trades --cursor ${txt(d.nextCursor)}`);
  return out;
}

function pnl(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const s = obj(d.spot);
  const p = obj(d.perps);
  const out = [`P&L${txt(d.period) ? ` (${txt(d.period)})` : ""}${when(d.asOfMs) ? ` as of ${when(d.asOfMs)}` : ""}`];
  const realized = obj(s.realizedUsd);
  const line = (name: string, parts: Array<[string, unknown]>) => {
    const shown = parts.map(([k, v]) => [k, total(v)] as const).filter(([, v]) => v);
    if (shown.length) out.push(`${name}: ${shown.map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  };
  line("Spot", [["realized", realized.total], ["short-term", realized.shortTerm], ["long-term", realized.longTerm], ["unrealized", s.unrealizedUsd], ["cost basis", s.costBasisUsd], ["market value", s.marketValueUsd], ["cash", s.cashUsd]]);
  line("Perps", [["realized", p.realizedUsd], ["fees", p.feesUsd], ["funding", p.fundingUsd], ["unrealized", p.unrealizedUsd], ["equity", p.equityUsd]]);
  const f = obj(d.feesUsd);
  line("Fees", [["network", f.networkWalletPaid], ["perps trading", f.perpTrading]]);
  const pos = arr(s.positions).map(obj);
  if (pos.length) {
    out.push("", ...columns(["Asset", "Qty", "Avg cost", "Mark", "Unrealized"], pos.map((x) => [label(x.assetId, 24), num(x.qty), usd(x.avgCostUsd), usd(x.markUsd), usd(x.unrealizedUsd) || (x.unpriced === true ? "unpriced" : "")])));
  }
  for (const n of arr(d.notes)) if (txt(n)) out.push(`Note: ${txt(n)}`);
  return out;
}

function lots(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const list = arr(d.lots).map(obj);
  const out = [`Tax lots${txt(d.method) ? ` (method: ${txt(d.method)})` : ""}`];
  if (list.length === 0) return [...out, "No open tax lots."];
  out.push(...columns(["Asset", "Qty", "Available", "Cost basis", "Acquired", "Term", "Unrealized"], list.map((l) => [
    label(l.assetId, 24), num(l.qty), num(l.availableQty), usd(l.costBasisUsd), when(l.acquiredAtMs), txt(l.term), usd(l.unrealizedUsd) || (l.unpriced === true ? "unpriced" : ""),
  ])));
  return out;
}

// ─── perps ──────────────────────────────────────────────────────────────────

function perpMarkets(r: Record<string, unknown>): string[] {
  const list = arr(obj(r.data).markets).map(obj);
  if (list.length === 0) return ["No perps markets."];
  return columns(["Symbol", "Name", "Max leverage", "Min size", "Tick", "Status"], list.map((m) => [
    label(m.symbol, 16), label(m.name, 30), m.maxLeverage === undefined ? "" : `${num(m.maxLeverage)}x`, num(m.minOrderSize), usd(m.tick), m.tradeable === false ? "not tradeable" : txt(m.status),
  ]));
}

function perpQuote(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const f = typeof d.fundingRatePct === "number" ? `${d.fundingRatePct >= 0 ? "+" : "−"}${Math.abs(d.fundingRatePct)}% funding (+ = longs pay)` : "";
  return [[`${label(d.symbol, 16)} perps: mark ${usd(d.markUsd)}`, usd(d.indexUsd) ? `index ${usd(d.indexUsd)}` : "", f, d.tradeable === false ? "not tradeable now" : ""].filter(Boolean).join(" · ")];
}

function perpAccount(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  if (d.hasTraderAccount === false) return ["This agent has no perps account yet."];
  const a = obj(d.account);
  return [`Equity ${money(a.equityUsd)} · collateral ${money(a.collateralUsd)} · free ${money(a.freeCollateralUsd)} · margin used ${money(a.marginUsedUsd)} · maintenance ${money(a.maintenanceMarginUsd)}`];
}

function perpPositions(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  if (d.hasTraderAccount === false) return ["This agent has no perps account yet."];
  const list = arr(d.positions).map(obj);
  if (list.length === 0) return ["No open perps positions."];
  // No liquidation price: either none exists (collateral covers the position at any price — the
  // server says `liqUnreachable`) or it is unknown right now. Never a blank cell (owner QA 2026-10-06).
  const liq = (p: Record<string, unknown>) => usd(p.liqUsd) || (p.liqUnreachable === true ? "none*" : "—");
  const out = columns(["Market", "Side", "Size", "Entry", "Mark", "Unrealized", "Liquidation", "TP / SL"], list.map((p) => [
    label(p.symbol, 16), txt(p.side), num(p.sizeBase), usd(p.entryUsd), usd(p.markUsd), money(p.uPnlUsd), liq(p),
    [usd(p.takeProfitUsd), usd(p.stopLossUsd)].map((v) => v || "—").join(" / "),
  ]));
  if (list.some((p) => p.liqUsd == null && p.liqUnreachable === true)) out.push("", "* none: this agent's collateral covers the position at any price.");
  if (list.some((p) => p.liqUsd == null && p.liqUnreachable !== true)) out.push("", "— : Darwin can't work out the liquidation price right now.");
  return out;
}

function perpOrders(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  if (d.hasTraderAccount === false) return ["This agent has no perps account yet."];
  const list = arr(d.orders).map(obj);
  const trig = arr(d.triggers).map(obj);
  const out = list.length
    ? columns(["Market", "Side", "Type", "Price", "Size", "Reduce-only", "Order"], list.map((o) => [label(o.symbol, 16), txt(o.side), txt(o.orderType), usd(o.priceUsd), num(o.sizeBase), yesNo(o.reduceOnly), txt(o.orderSequenceNumber)]))
    : ["No resting perps orders."];
  if (trig.length) out.push("", ...columns(["Market", "Trigger", "Price"], trig.map((t) => [label(t.symbol, 16), txt(t.kind).replace(/_/g, " "), usd(t.priceUsd)])));
  return out;
}

function perpProtections(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const all = arr(d.protections).map(obj);
  // Finished records (cancelled, filled, gone with their position) are history, not protection: hidden
  // here, counted, and all in --json (owner QA 2026-10-06).
  const FINISHED = new Set(["cancelled", "filled", "voided_with_position"]);
  const list = all.filter((p) => !FINISHED.has(txt(p.state)));
  const finished = all.length - list.length;
  const STATE: Record<string, string> = { armed: "armed", pending: "placing", triggered: "fired, exit working", unverified: "not confirmed — check positions" };
  const out = list.length
    ? columns(["Market", "Kind", "Trigger", "State", "Updated"], list.map((p) => [label(p.symbol, 16), txt(p.kind).replace(/_/g, " "), usd(p.triggerPriceUsd) || num(p.triggerPriceUsd), STATE[txt(p.state)] ?? txt(p.state), when(p.updatedAt)]))
    : [d.hasMore === true ? "No live TP/SL protections among the newest 200 records; older ones aren't shown here (use --json)." : "No live TP/SL protections."];
  if (finished) out.push("", `${finished} finished TP/SL record${finished === 1 ? "" : "s"} (cancelled, filled or closed with the position) not shown; --json lists them.`);
  if (d.hasMore === true) out.push("", "Only the newest 200 are shown.");
  return out;
}

function indicators(r: Record<string, unknown>): string[] {
  const d = obj(r.data);
  const bars = arr(d.bars).map(obj);
  const keys = arr(d.indicators).map((i) => txt(obj(i).key)).filter(Boolean);
  const out = [`Indicators for ${label(d.asset_id, 40)} on ${txt(d.timeframe)} candles${d.stale === true ? " (stale: the newest candle is old)" : ""}`];
  if (bars.length === 0) return [...out, "No bars."];
  const val = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : Object.entries(obj(v)).map(([k, n]) => `${k}=${typeof n === "number" ? Math.round(n * 1e6) / 1e6 : txt(n)}`).join(" "));
  out.push(...columns(["Bar opened", "Close", ...keys], bars.map((b) => [when(b.open_time_ms), num(b.close), ...keys.map((k) => val(b[k]))])));
  return out;
}

// ─── dispatch ───────────────────────────────────────────────────────────────

export type Renderer = (result: Record<string, unknown>, x: RenderCtx) => string[];

export function renderersFor(kind: "agent" | "agents"): Record<string, Renderer> {
  return {
    hello,
    list_agents: (r) => agents(r),
    get_grant: (r) => grant(r),
    pause_agent: (r, x) => pause(r, x, kind),
    get_spot_quote: quote,
    quote_unlisted_token: quote,
    place_spot_order: (r, x) => spotWrite(r, x, false),
    place_unlisted_order: (r, x) => spotWrite(r, x, false),
    spot_order_now: (r, x) => spotWrite(r, x, true),
    get_balances: balances,
    list_spot_orders: orders,
    get_tx_status: (r) => tx(r),
    list_spot_markets: (r) => spotMarkets(r),
    inspect_unlisted_token: (r) => unlistedInspect(r),
    list_trades: trades,
    get_pnl: (r) => pnl(r),
    list_lots: (r) => lots(r),
    list_perp_markets: (r) => perpMarkets(r),
    get_perp_quote: (r) => perpQuote(r),
    get_perp_account: (r) => perpAccount(r),
    list_perp_positions: (r) => perpPositions(r),
    list_perp_orders: (r) => perpOrders(r),
    list_perp_protections: (r) => perpProtections(r),
    get_indicators: (r) => indicators(r),
  };
}

/** A successful result as lines: the command's renderer, else the generic one. */
export function renderResult(tool: string, kind: "agent" | "agents", result: Record<string, unknown>, x: RenderCtx): string[] {
  if (typeof result.text === "string") return forTerminal(result.text, x.catalogue).split("\n");
  const r = renderersFor(kind)[tool];
  if (r) {
    try {
      const lines = r(result, x);
      if (lines.length) return lines;
    } catch { /* fall through to the generic rendering */ }
  }
  const { summary, data } = result;
  const lines: string[] = [];
  if (summary !== undefined) lines.push(...genericLines(summary));
  if (data !== undefined) lines.push(...genericLines(data));
  return lines.length ? lines : ["Done."];
}

// ─── refusals ───────────────────────────────────────────────────────────────

const NOTHING_SENT = "Nothing was sent.";

/** CLI wording for the refusals a person meets; `null` → show Darwin's own detail. */
const REFUSAL_TEXT: Record<string, string> = {
  market_closed: "That market is closed right now. `darwin market-status` shows when US stocks trade again.",
  quote_expired: "That quote expired (a quote lasts 30 seconds). Get a new one with `darwin quote`.",
  quote_not_found: "Darwin doesn't know that quote ID. Get a quote with `darwin quote` and place it within 30 seconds.",
  quote_required: "An order needs a quote first: run `darwin quote`, then `darwin order --quote <id>`.",
  quote_mismatch: "The order doesn't match its quote: use the same --sell, --amount and --for as the quote.",
  quote_already_used: "That quote was already used. Check `darwin orders`, or get a new quote.",
  quote_price_moved: "The price moved beyond the quote's slippage limit. Get a new quote and try again.",
  quote_wrong_agent: "That quote was made for a different agent.",
  quote_wrong_endpoint: "That quote is for a token Darwin doesn't list; it can't be placed with `darwin order`.",
  slippage_exceeds_grant: "That slippage is looser than your owner's maximum for this pair. Use a smaller --max-slippage-bps (`darwin grant` shows the maximum).",
  per_trade_cap: "This order is over the agent's per-trade limit. Try a smaller amount (`darwin grant` shows the limits).",
  per_trade_risk: "This order puts more at risk than the agent's per-trade limit allows. Try a smaller amount.",
  daily_cap: "This agent has used today's trading budget. It resets at midnight UTC; `darwin grant` shows what's left.",
  daily_tx_count: "This agent has made today's maximum number of trades. It resets at midnight UTC.",
  daily_risk: "This agent has used today's risk budget. Selling into a stablecoin still works; it resets at midnight UTC.",
  asset_daily_acquisition: "Today's budget for buying this token is used up. Another token may still work.",
  below_min_trade: "That amount is below the minimum trade size.",
  insufficient_sol: "Not enough SOL: selling that much would leave too little for network fees.",
  self_pay_insolvent: "This agent's wallet can't pay its network fees. Add SOL to its wallet to trade again.",
  kill_switch: "Darwin has paused agent trading for now. Try again later.",
  sanctions_blocked: "Refused for compliance reasons.",
  account_locked: "The owner's Darwin account is locked, so this agent can't trade.",
  grant_invalid: "This agent can no longer trade with this API key (revoked or expired). Ask the owner, or run `darwin login` again.",
  rate_limited: "Too many requests with this API key right now. Wait a minute and try again.",
  relay_unavailable: "Darwin couldn't send the transaction right now. Try again in a few seconds.",
  relay_rate_limited: "Too many transactions from this wallet just now. Wait a few seconds and try again.",
  simulation_unavailable: "Darwin couldn't check the transaction just now. Try again in a few seconds.",
  quote_unavailable: "No price is available for that trade right now. Try again shortly.",
  price_sanity: "The quoted price looked wrong compared with the market, so Darwin refused it. Try again shortly.",
  mint_not_in_scope: "This agent isn't allowed to trade that token.",
  unlisted_disabled: "This agent isn't allowed to trade tokens Darwin doesn't list.",
  ambiguous_asset: "That symbol names more than one token. Pass the token's mint address instead:",
};

/**
 * A refused tool call as lines (stderr). "Nothing was sent" is said ONLY on Darwin's own word:
 * `sent: false`, or `retrySafe: true` ("nothing was broadcast"). A write refused WITHOUT that word
 * may have gone through — the lines say to check `darwin orders` before trying again.
 */
export function refusalLines(result: Record<string, unknown>, catalogue: Pick<Catalogue, "tools"> | null, write = false): string[] {
  const d = obj(result.data);
  const code = [result.error, d.error, d.refusal].map(txt).find((c) => /^[a-z][a-z0-9_]{0,63}$/.test(c)) ?? "";
  const rawDetail = txt(result.detail) || txt(d.detail) || txt(d.message);
  const detail = /^[a-z][a-z0-9_]*$/.test(rawDetail) ? "" : forTerminal(rawDetail, catalogue);
  const retrySafe = d.retrySafe ?? result.retrySafe;
  // Only Darwin's own word settles it: anything else, for a write, is "maybe".
  const sent = result.sent === false || (retrySafe === true && result.sent !== true);
  const maybeSent = write && !sent;
  const tail = sent ? ` ${NOTHING_SENT}` : "";
  const out: string[] = [];
  const known = REFUSAL_TEXT[code];
  if (maybeSent) out.push(`Darwin couldn't confirm this order was sent${detail ? `: ${detail}` : "."}`, "It may have gone through — check `darwin orders` before trying again.");
  else if (known) out.push(`${known}${code === "ambiguous_asset" ? "" : tail}`);
  else if (detail) out.push(`Darwin refused this: ${detail}${tail}`);
  else if (code) out.push(`Darwin refused this (${code.replace(/_/g, " ")}).${tail}`);
  else out.push(`Darwin refused this${typeof result.status === "number" ? ` (HTTP ${result.status})` : ""}.`);
  if (!maybeSent && known && detail && code !== "ambiguous_asset" && code !== "rate_limited") out.push(`Darwin says: ${detail}`);
  for (const c of [...arr(result.candidates), ...arr(d.candidates)].map(obj).slice(0, 20)) {
    out.push(`  ${label(c.symbol, 20) || "?"}  ${txt(c.mint)}${label(c.issuer, 40) ? `  (${label(c.issuer, 40)})` : ""}`);
  }
  if (code && !out[0]!.includes(code)) out.push(`(${code})`);
  return out;
}

export { cut };
