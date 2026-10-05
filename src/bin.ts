#!/usr/bin/env node
/** The `darwin` executable: the real world wired into run(). */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Ctx } from "./context.js";
import { osKeychain } from "./keychain.js";
import { run } from "./main.js";

function configDir(): string {
  if (process.env.DARWIN_CONFIG_DIR) return process.env.DARWIN_CONFIG_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "darwin");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "darwin");
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += (c as Buffer).length;
    if (n > 64 * 1024) break;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function prompt(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      // Echo nothing while the secret is typed or pasted.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stderr.write(question);
      };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stderr.write("\n"); resolve(answer); });
  });
}

const ctx: Ctx = {
  env: process.env,
  io: {
    stdout: (s) => { process.stdout.write(s); },
    stderr: (s) => { process.stderr.write(s); },
    readStdin: readAll,
    stdinLines: () => createInterface({ input: process.stdin, terminal: false }),
    prompt,
    isTTY: { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY },
  },
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  keychain: osKeychain(process.platform),
  configDir: configDir(),
  scriptPath: fileURLToPath(import.meta.url),
  execPath: process.execPath,
  cwd: process.cwd(),
  platform: process.platform,
  openUrl: (url) => {
    // The URL is the realm-checked pairing link; it is passed as one argument, never through a shell.
    // Absolute paths only — never a program found through PATH (a project can put its own first).
    const [cmd, args] = process.platform === "darwin" ? ["/usr/bin/open", [url]]
      : process.platform === "win32" ? [join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
        : ["/usr/bin/xdg-open", [url]];
    if (!existsSync(cmd as string)) return;
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  },
};

// 🔴 A Node environment can be told to load code before ours (NODE_OPTIONS=--require …); we can't
// undo that from inside, but we never pass it on to anything we start.
delete process.env.NODE_OPTIONS;

run(process.argv.slice(2), ctx).then((code) => {
  process.exitCode = code;
}, () => {
  process.exitCode = 1;
});
