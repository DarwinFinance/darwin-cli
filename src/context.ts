/**
 * Everything the CLI touches in the outside world, injected — so the whole program runs in-process
 * under test against a mock server, an in-memory keychain and a temp config dir.
 */
import type { Keychain } from "./keychain.js";

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  /** All of stdin (piped input). */
  readStdin(): Promise<string>;
  /** stdin, line by line (for `darwin mcp`). */
  stdinLines(): AsyncIterable<string>;
  /** A line from the terminal; `hidden` = no echo. Only called when stdin is a TTY. */
  prompt(question: string, hidden: boolean): Promise<string>;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
}

export interface Ctx {
  env: Record<string, string | undefined>;
  io: Io;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  keychain: Keychain;
  /** ~/.config/darwin (or the platform equivalent, or DARWIN_CONFIG_DIR). */
  configDir: string;
  /** Absolute path of this program's own file (for the npx / workspace guard and --print-config). */
  scriptPath: string;
  /** The Node binary running it. */
  execPath: string;
  /**
   * Where `darwin setup` installs the verified copy and its launcher (pinned.ts):
   * ~/.local/share/darwin (or $XDG_DATA_HOME/darwin), %LOCALAPPDATA%\\darwin on Windows.
   */
  dataDir: string;
  /** True when Node was started with code-loading options (NODE_OPTIONS, execArgv, …) — never by the launcher. */
  nodeInjected: boolean;
  /** Sigstore verification for `darwin setup` (provenance.ts); tests substitute it. */
  verifySigstore?: import("./provenance.js").SigstoreVerify;
  /** Loads the keyring addon from a freshly unpacked copy (setup's last check); tests substitute it. */
  loadKeyringFrom?: (scriptPath: string) => void;
  cwd: string;
  platform: NodeJS.Platform;
  /** Opens a URL in the browser (TTY only, realm-checked by the caller). */
  openUrl(url: string): void;
}

/** Thrown for every expected failure; main() prints it and exits with `exit`. */
export class CliError extends Error {
  constructor(public readonly exit: number, message: string, public readonly code = "error", public readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** §5.5 exit codes. */
export const EXIT = {
  ok: 0, unexpected: 1, usage: 2, auth: 3, refused: 4, rateLimited: 5, uncertain: 6, upgrade: 7, network: 8, paused: 10,
} as const;
