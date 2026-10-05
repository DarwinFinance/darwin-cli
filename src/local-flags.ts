/**
 * Query parameters the catalogue doesn't name yet. Several read commands take their API's query
 * parameters only as `--field name=value`, so `darwin indicators` didn't say it NEEDS a timeframe
 * and indicators and the server refused it (`bad_params`). Here each gets a real flag, a help line
 * and — where the API requires it — a local check, so nothing is sent that can only be refused.
 *
 * Only ever ADDS a property the catalogue lacks (a newer catalogue that names one wins), and only to
 * a read: the server still validates everything. The flag's value is sent exactly as `--field` would.
 */
import { CliError, EXIT } from "./context.js";
import type { CatalogueTool, SchemaProp } from "./catalogue.js";

interface LocalParam { prop: string; flag: string; description: string; type?: "string" | "number" | "boolean"; required?: boolean }

const PARAMS: Record<string, LocalParam[]> = {
  get_indicators: [
    { prop: "timeframe", flag: "timeframe", required: true, description: "Candle size: 1m, 5m, 15m, 30m, 1h, 4h, 6h, 12h or 1d." },
    { prop: "indicators", flag: "indicators", required: true, description: "Comma-separated, e.g. rsi:14,macd:12:26:9." },
    { prop: "instrumentId", flag: "instrument-id", description: "The market, as `darwin markets` lists it (spot:solana:<mint>). Give this or --asset." },
    { prop: "asset", flag: "asset", description: "A Darwin asset id instead of --instrument-id." },
    { prop: "bars", flag: "bars", type: "number", description: "How many bars (default 50)." },
    { prop: "includeFormingBar", flag: "include-forming-bar", type: "boolean", description: "Also show the bar still forming." },
  ],
  list_spot_orders: [
    { prop: "limit", flag: "limit", type: "number", description: "How many (1–200, default 50)." },
    { prop: "cursor", flag: "cursor", description: "The next page, from the line a previous page printed." },
  ],
  list_trades: [
    { prop: "kind", flag: "kind", description: "spot, perp or all (default all)." },
    { prop: "since", flag: "since", type: "number", description: "Only trades settled after this time (epoch milliseconds)." },
    { prop: "limit", flag: "limit", type: "number", description: "How many (at most 200)." },
    { prop: "cursor", flag: "cursor", description: "The next page, from the line a previous page printed." },
  ],
  get_pnl: [{ prop: "period", flag: "period", description: "ytd (default), 30d, 90d, all, or a tax year such as 2025." }],
  list_lots: [
    { prop: "sort", flag: "sort", description: "unrealized_asc, acquired_asc or basis_desc." },
    { prop: "mint", flag: "mint", description: "Only this token's lots." },
    { prop: "instrumentId", flag: "instrument-id", description: "Only this market's lots." },
  ],
  list_spot_markets: [{ prop: "type", flag: "type", description: "spot or perp (default both)." }],
};

/** The tool with any local query flags it lacks. Never mutates the catalogue's own object. */
export function withLocalFlags(tool: CatalogueTool): CatalogueTool {
  const extra = PARAMS[tool.name];
  if (!extra || tool.write) return tool;
  const props: Record<string, SchemaProp> = { ...(tool.inputSchema.properties ?? {}) };
  const args = { ...tool.cli.args };
  const required = [...(tool.inputSchema.required ?? [])];
  const taken = new Set(Object.values(args).map((a) => a.flag));
  for (const p of extra) {
    if (props[p.prop] || taken.has(p.flag)) continue;
    props[p.prop] = { type: p.type ?? "string", description: p.description };
    args[p.prop] = { flag: p.flag };
    taken.add(p.flag);
    if (p.required && !required.includes(p.prop)) required.push(p.prop);
  }
  return { ...tool, cli: { ...tool.cli, args }, inputSchema: { ...tool.inputSchema, properties: props, required } };
}

/** Checks that need more than "is it present" (run after buildArguments). */
export function checkLocalArguments(tool: CatalogueTool, args: Record<string, unknown>): void {
  if (tool.name === "get_indicators" && PARAMS.get_indicators && (args.instrumentId === undefined) === (args.asset === undefined)) {
    throw new CliError(EXIT.usage, "`darwin indicators` needs exactly one of --instrument-id (from `darwin markets`) or --asset. See `darwin indicators --help`.", "usage");
  }
}
