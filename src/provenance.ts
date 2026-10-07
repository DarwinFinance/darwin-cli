/**
 * 🔴 WHO BUILT THIS PACKAGE (plan §7, v1.1-c). Before `darwin setup` installs a version, it checks the
 * version's npm provenance: a Sigstore-signed SLSA statement that names the exact tarball (sha512) and
 * the GitHub workflow run that built it. It must be signed for
 *
 *     https://github.com/DarwinFinance/darwin-cli/.github/workflows/release.yml@refs/tags/v<version>
 *
 * by GitHub Actions' OIDC issuer, logged in the public transparency log — and name exactly the
 * tarball setup then downloads. A version published any other way (a stolen npm token, a different
 * repository or workflow, a hand publish) has no such statement and is refused.
 *
 * The cryptography is Sigstore's own verifier (@sigstore/verify, bundled), against a PINNED trusted
 * root (src/sigstore/trusted_root.json, from Sigstore's TUF repository). No network is used to decide
 * trust. If Sigstore rotates its keys, an older CLI refuses newer releases (fails closed) until it is
 * reinstalled from npm — the message says so.
 */
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";
import { CliError, EXIT } from "./context.js";
import trustedRootJson from "./sigstore/trusted_root.json" with { type: "json" };

export const PACKAGE = "@darwin.finance/cli";
export const SOURCE_REPOSITORY = "https://github.com/DarwinFinance/darwin-cli";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_V1 = "https://in-toto.io/Statement/v1";

export interface SigstorePolicy {
  subjectAlternativeName: string;
  issuer: string;
}

/** Throws unless `bundle` is a valid Sigstore bundle signed for exactly this identity. */
export type SigstoreVerify = (bundle: unknown, policy: SigstorePolicy) => void;

/** A string as a regular expression that matches exactly it, whole. */
export const exactPattern = (s: string) => `^${s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}$`;

export const sigstoreVerify: SigstoreVerify = (bundle, policy) => {
  const trust = toTrustMaterial(TrustedRoot.fromJSON(trustedRootJson));
  const verifier = new Verifier(trust, { tlogThreshold: 1, ctlogThreshold: 1, tsaThreshold: 0 });
  // 🔴 @sigstore/verify treats `subjectAlternativeName` as a REGULAR EXPRESSION, unanchored (codex
  // v1.1-c r4): `release.yml@refs/tags/v1.2.0` would also accept `release-yml@…` or `…v1.2.0-x`.
  // So the pattern is escaped and anchored, AND the signer it returns is compared exactly.
  const signer = verifier.verify(toSignedEntity(bundleFromJSON(bundle as Parameters<typeof bundleFromJSON>[0])), {
    subjectAlternativeName: exactPattern(policy.subjectAlternativeName),
    extensions: { issuer: policy.issuer },
  });
  if (signer.identity?.subjectAlternativeName !== policy.subjectAlternativeName || signer.identity?.extensions?.issuer !== policy.issuer) {
    throw new Error(`certificate identity error - signed by ${String(signer.identity?.subjectAlternativeName).slice(0, 200)}`);
  }
};

export interface Provenance {
  repository: string;
  workflow: string;
  ref: string;
  /** The git commit the release was built from (40 hex), when the statement names one. */
  commit: string | null;
  /** Its entry in the public transparency log. */
  logIndex: string | null;
}

export const releaseIdentity = (version: string) => `${SOURCE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/tags/v${version}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function refuse(why: string): never {
  throw new CliError(EXIT.refused, `This version of the Darwin CLI couldn't be verified as built by Darwin's release workflow (${why}). Nothing was installed.`, "provenance_unverified");
}

/**
 * `attestations` is the registry's `/-/npm/v1/attestations/<pkg>@<version>` document; `sha512Hex`
 * the tarball's digest as the registry states it (setup separately checks the downloaded bytes).
 */
export function verifyProvenance(attestations: unknown, version: string, sha512Hex: string, verify: SigstoreVerify = sigstoreVerify): Provenance {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{128}$/.test(sha512Hex)) refuse("bad input");
  const list = isObj(attestations) && Array.isArray(attestations.attestations) ? attestations.attestations : null;
  if (!list) refuse("no provenance published");
  const slsa = list.filter((a) => isObj(a) && a.predicateType === SLSA_V1);
  if (slsa.length !== 1) refuse(slsa.length === 0 ? "no provenance published" : "more than one provenance statement");
  const bundle = (slsa[0] as Record<string, unknown>).bundle;
  // 1. The signature: a Fulcio certificate for EXACTLY our release workflow at this version's tag,
  //    issued to GitHub Actions, logged in Rekor, over this very envelope.
  try {
    verify(bundle, { subjectAlternativeName: releaseIdentity(version), issuer: GITHUB_ACTIONS_ISSUER });
  } catch (e) {
    refuse(`signature check failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  // 2. What was signed: the statement inside that envelope (the verifier checked these exact bytes).
  const env = isObj(bundle) && isObj(bundle.dsseEnvelope) ? bundle.dsseEnvelope : null;
  if (!env || env.payloadType !== "application/vnd.in-toto+json" || typeof env.payload !== "string") refuse("not an in-toto statement");
  let st: unknown;
  try { st = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")); } catch { refuse("unreadable statement"); }
  if (!isObj(st) || st._type !== IN_TOTO_V1 || st.predicateType !== SLSA_V1) refuse("not a SLSA v1 statement");
  const subject = Array.isArray(st.subject) ? st.subject : [];
  const s0 = subject[0];
  if (subject.length !== 1 || !isObj(s0) || s0.name !== `pkg:npm/%40darwin.finance/cli@${version}` || !isObj(s0.digest) || s0.digest.sha512 !== sha512Hex) {
    refuse("it names a different package or tarball");
  }
  const pred = isObj(st.predicate) ? st.predicate : {};
  const bd = isObj(pred.buildDefinition) ? pred.buildDefinition : {};
  const ext = isObj(bd.externalParameters) ? bd.externalParameters : {};
  const wf = isObj(ext.workflow) ? ext.workflow : {};
  if (wf.repository !== SOURCE_REPOSITORY || wf.path !== RELEASE_WORKFLOW || wf.ref !== `refs/tags/v${version}`) refuse("built by a different repository, workflow or tag");
  let commit: string | null = null;
  for (const d of Array.isArray(bd.resolvedDependencies) ? bd.resolvedDependencies : []) {
    if (isObj(d) && isObj(d.digest) && typeof d.digest.gitCommit === "string" && /^[0-9a-f]{40}$/.test(d.digest.gitCommit)) { commit = d.digest.gitCommit; break; }
  }
  const vm = isObj(bundle) && isObj(bundle.verificationMaterial) ? bundle.verificationMaterial : {};
  const tlog = Array.isArray(vm.tlogEntries) && isObj(vm.tlogEntries[0]) ? vm.tlogEntries[0] : {};
  const logIndex = typeof tlog.logIndex === "string" && /^\d{1,20}$/.test(tlog.logIndex) ? tlog.logIndex : null;
  return { repository: SOURCE_REPOSITORY, workflow: RELEASE_WORKFLOW, ref: `refs/tags/v${version}`, commit, logIndex };
}
