/**
 * The REAL Sigstore check (provenance.ts), run under Node — the CLI's runtime — against the provenance
 * npm serves for @darwin.finance/cli 1.1.1 (test/fixtures/attestations-1.1.1.json, captured
 * 2026-10-07). Offline: the trusted root is pinned in the CLI.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const node = Bun.which("node");

describe("provenance — real Sigstore verification under Node", () => {
  it.skipIf(!node)("accepts the genuine 1.1.1 release; refuses every substitution", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "darwin-prov-")), "check.mjs");
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "node", "provenance-check.ts")], target: "node", format: "esm" });
    expect(built.success).toBe(true);
    await Bun.write(out, await built.outputs[0]!.text());
    const r = spawnSync(node!, [out, join(import.meta.dir, "fixtures", "attestations-1.1.1.json")], { encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).toBe("");
    const res = JSON.parse(r.stdout);
    expect(res.genuine).toEqual({ ok: true, value: {
      repository: "https://github.com/DarwinFinance/darwin-cli", workflow: ".github/workflows/release.yml", ref: "refs/tags/v1.1.1",
      commit: "631e271d7cce5e9419e09498e31a7b8238fd6873", logIndex: expect.stringMatching(/^\d+$/),
    } });
    for (const k of ["otherTarball", "otherVersion", "tamperedPayload", "badSignature", "noTransparencyLog", "publishAttestationOnly"]) {
      expect({ k, ok: res[k].ok }).toEqual({ k, ok: false });
      expect(res[k].error).toContain("couldn't be verified as built by Darwin's release workflow");
    }
    expect(res.otherVersion.error).toContain("certificate identity");
  }, 120_000);
});
