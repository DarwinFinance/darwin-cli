/** Replaced at build time (scripts/build.ts) from package.json; the fallback is for `bun test`. */
declare const __DARWIN_CLI_VERSION__: string | undefined;
export const VERSION: string = typeof __DARWIN_CLI_VERSION__ === "string" ? __DARWIN_CLI_VERSION__ : "1.1.1";

/** -1 / 0 / 1 for two x.y.z versions (anything unparseable compares as 0.0.0). */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? [0, 0, 0, 0]).slice(1, 4).map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}
