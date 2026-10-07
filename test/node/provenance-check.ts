/**
 * Run under NODE (the CLI's runtime) by provenance-node.test.ts: the REAL Sigstore verification of a
 * REAL release (@darwin.finance/cli 1.1.1's provenance, as the registry serves it), plus the ways it
 * must fail. Prints one JSON object of outcomes.
 */
import { readFileSync } from "node:fs";
import { sigstoreVerify, verifyProvenance } from "../../src/provenance.js";

const att = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const SHA = "f54abb0a849bc7d0548ef903accba1f38549e4fd386a4d1535a37863676599b7995ab793d7f51fe42fa7445d382577c9d0bd124f46374bb550f396ef36e4fd58";
const outcome = (f: () => unknown) => {
  try { return { ok: true, value: f() }; } catch (e) { return { ok: false, error: String((e as Error).message) }; }
};
const clone = () => JSON.parse(JSON.stringify(att));
const slsa = (a: { attestations: Array<{ predicateType: string; bundle: Record<string, any> }> }) => a.attestations.find((x) => x.predicateType === "https://slsa.dev/provenance/v1")!;

const tamperedPayload = clone();
{
  const b = slsa(tamperedPayload).bundle;
  const st = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString());
  st.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/evil/darwin-cli";
  b.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString("base64");
}
const swappedCert = clone();
{
  // Another release's (valid, logged) certificate and signature over a different statement.
  const b = slsa(swappedCert).bundle;
  b.dsseEnvelope.signatures[0].sig = Buffer.alloc(70, 1).toString("base64");
}
const noTlog = clone();
slsa(noTlog).bundle.verificationMaterial.tlogEntries = [];

const bundle111 = slsa(att).bundle;
const identity111 = "https://github.com/DarwinFinance/darwin-cli/.github/workflows/release.yml@refs/tags/v1.1.1";
const issuer = "https://token.actions.githubusercontent.com";

process.stdout.write(JSON.stringify({
  // The signer identity is matched EXACTLY — never as an unanchored pattern (codex r4).
  exactIdentity: outcome(() => sigstoreVerify(bundle111, { subjectAlternativeName: identity111, issuer })),
  prefixIdentity: outcome(() => sigstoreVerify(bundle111, { subjectAlternativeName: identity111.slice(0, -2), issuer })),
  wildcardIdentity: outcome(() => sigstoreVerify(bundle111, { subjectAlternativeName: identity111.replace("release.yml", "release.ym."), issuer })),
  regexIdentity: outcome(() => sigstoreVerify(bundle111, { subjectAlternativeName: ".*", issuer })),
  otherIssuer: outcome(() => sigstoreVerify(bundle111, { subjectAlternativeName: identity111, issuer: "https://gitlab.com" })),
  genuine: outcome(() => verifyProvenance(att, "1.1.1", SHA)),
  otherTarball: outcome(() => verifyProvenance(att, "1.1.1", "0".repeat(128))),
  otherVersion: outcome(() => verifyProvenance(att, "1.1.0", SHA)),
  tamperedPayload: outcome(() => verifyProvenance(tamperedPayload, "1.1.1", SHA)),
  badSignature: outcome(() => verifyProvenance(swappedCert, "1.1.1", SHA)),
  noTransparencyLog: outcome(() => verifyProvenance(noTlog, "1.1.1", SHA)),
  publishAttestationOnly: outcome(() => verifyProvenance({ attestations: att.attestations.filter((x: { predicateType: string }) => x.predicateType !== "https://slsa.dev/provenance/v1") }, "1.1.1", SHA)),
}));
