/**
 * Unpack an npm package tarball (`package/…`, gzip'd ustar) into a directory — for `darwin setup`,
 * which only ever unpacks bytes whose sha512 it has already checked. Still defensive: regular files
 * and directories only (no links, devices or GNU extensions), every path under `package/`, no `..`,
 * no absolute or drive paths, files created exclusively, and size limits on the whole.
 */
import { gunzipSync } from "node:zlib";
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "./context.js";

const MAX_UNPACKED = 64 * 1024 * 1024;
const MAX_FILES = 2000;

const bad = (why: string): never => {
  throw new CliError(EXIT.refused, `A downloaded package was malformed (${why}). Nothing was installed.`, "bad_package");
};

function str(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul === -1 ? s.length : nul).toString("utf8");
}

function octal(b: Buffer, start: number, len: number): number {
  if (b[start]! & 0x80) bad("binary size field");
  const s = str(b, start, len).trim();
  if (!/^[0-7]*$/.test(s)) bad("size field");
  return s === "" ? 0 : parseInt(s, 8);
}

/** `package/dist/darwin.js` → ["dist", "darwin.js"]; anything outside `package/` or unsafe → refused. */
export function safeRelative(name: string): string[] {
  if (name.includes("\0") || name.includes("\\")) bad("unsafe path");
  const parts = name.split("/").filter((p, i, all) => p !== "" || i !== all.length - 1);
  if (parts[0] !== "package") bad("path outside package/");
  const rest = parts.slice(1);
  for (const p of rest) if (p === "" || p === "." || p === ".." || /[:]/.test(p) || p.length > 255) bad("unsafe path");
  return rest;
}

export function extractPackage(tgz: Buffer, dest: string): string[] {
  let tar: Buffer;
  try { tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED }); } catch { return bad("not gzip, or too large"); }
  const written: string[] = [];
  let off = 0;
  let paxPath: string | null = null;
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    // Header checksum: the sum of the header with the checksum field read as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== octal(h, 148, 8)) bad("header checksum");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const body = off + 512;
    const next = body + Math.ceil(size / 512) * 512;
    if (body + size > tar.length) bad("truncated");
    const magic = str(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? str(h, 345, 155) : "";
    const name = paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    if (type === "x") {
      paxPath = parsePaxPath(tar.subarray(body, body + size));
      off = next;
      continue;
    }
    paxPath = null;
    if (type === "g") { off = next; continue; }
    const rel = safeRelative(name);
    if (type === "5") {
      if (rel.length) mkdirSync(join(dest, ...rel), { recursive: true, mode: 0o755 });
    } else if (type === "0" || type === "\0" || type === "7") {
      if (rel.length === 0) bad("unsafe path");
      if (written.length >= MAX_FILES) bad("too many files");
      if (rel.length > 1) mkdirSync(join(dest, ...rel.slice(0, -1)), { recursive: true, mode: 0o755 });
      const fd = openSync(join(dest, ...rel), "wx", 0o644);
      try { writeSync(fd, tar.subarray(body, body + size)); } finally { closeSync(fd); }
      written.push(rel.join("/"));
    } else {
      bad(`entry type ${JSON.stringify(type)}`);
    }
    off = next;
  }
  return written;
}

/** The `path` record of a pax extended header, if any. */
function parsePaxPath(b: Buffer): string | null {
  let i = 0;
  let path: string | null = null;
  while (i < b.length) {
    const sp = b.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(b.subarray(i, sp).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > b.length) bad("pax header");
    const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === "path") path = rec.slice(eq + 1);
    i += len;
  }
  return path;
}
