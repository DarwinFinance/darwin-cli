/**
 * Private files (plan §3.2 `--store file`, the config, the cache): owner-only, never through a
 * symlink, created exclusively. On Windows the POSIX mode bits are not enforced by the OS; the
 * per-user profile directory is what protects them there.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError, EXIT } from "./context.js";

const posix = process.platform !== "win32";
const uid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** `strict`: no group/other permission bits at all (the credentials directory). */
export function ensurePrivateDir(dir: string, strict = false): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new CliError(EXIT.unexpected, `${dir} is not a private directory; refusing to use it.`, "unsafe_path");
  if (posix) {
    if (uid() !== null && st.uid !== uid()) throw new CliError(EXIT.unexpected, `${dir} is owned by another user; refusing to use it.`, "unsafe_path");
    if (st.mode & (strict ? 0o077 : 0o022)) throw new CliError(EXIT.unexpected, `${dir} is ${strict ? "accessible" : "writable"} by other users; refusing to use it (chmod 700 it).`, "unsafe_path");
  }
}

/** Throws if `path` exists and is not a regular file owned by us (no links). Returns whether it exists. */
function checkTarget(path: string): boolean {
  let st;
  try { st = lstatSync(path); } catch { return false; }
  if (st.isSymbolicLink() || !st.isFile()) throw new CliError(EXIT.unexpected, `${path} is not a regular file; refusing to use it.`, "unsafe_path");
  if (posix && uid() !== null && st.uid !== uid()) throw new CliError(EXIT.unexpected, `${path} is owned by another user; refusing to use it.`, "unsafe_path");
  return true;
}

/** Atomically replace `path` through an exclusively-created 0600 temp file. */
export function writePrivate(path: string, data: string, opts: { strictDir?: boolean; mode?: number } = {}): void {
  ensurePrivateDir(dirname(path), opts.strictDir === true);
  checkTarget(path);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  // "wx" = O_WRONLY|O_CREAT|O_EXCL: a fresh file or failure — an existing name (or link) is EEXIST.
  const fd = openSync(tmp, "wx", opts.mode ?? 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** Read a private file; null when missing. Refuses links, foreign owners and group/world-readable files. */
export function readPrivate(path: string, maxBytes = 1024 * 1024, opts: { requirePrivateMode?: boolean } = { requirePrivateMode: true }): string | null {
  if (!checkTarget(path)) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CliError(EXIT.unexpected, `${path} is not a regular file.`, "unsafe_path");
    if (posix && opts.requirePrivateMode !== false && (st.mode & 0o077)) {
      throw new CliError(EXIT.unexpected, `${path} can be read by other users; refusing to use it (chmod 600 it).`, "unsafe_path");
    }
    if (st.size > maxBytes) throw new CliError(EXIT.unexpected, `${path} is unexpectedly large.`, "unsafe_path");
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > maxBytes) throw new CliError(EXIT.unexpected, `${path} is unexpectedly large.`, "unsafe_path");
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function removeQuietly(path: string): void {
  try {
    checkTarget(path);
    unlinkSync(path);
  } catch { /* gone or not ours */ }
}
