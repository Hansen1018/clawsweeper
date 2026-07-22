/**
 * Scenario metadata is deliberately data-only. The runner, proof writer, and
 * gate composer consume the same contract so a red reproducer cannot be
 * presented as a release-ready pass by changing only CLI control flow.
 */
export const SCENARIO_MANIFESTS = Object.freeze([
  flow("dependency-setup-mutation", "target-setup", "blocked"),
  flow("happy-path", "terminal-state", "merged"),
  flow("pending-checks", "pre-merge-readiness", "merged"),
  flow("planning-head-drift", "pre-target-checkout", "blocked"),
  flow("verdict-head-drift", "pre-merge-readiness", "blocked"),
  // The suite exercises the fixed control path. Its historical failure remains
  // available only through explicit legacy --expect, without making quick gates
  // claim that a current candidate should still reproduce a repaired incident.
  flow("ci-regression-29623139111", "terminal-state", "merged"),
  runtime({
    id: "openclaw-110725-process-leak",
    phase: "target-validation-process-drain",
    expectedFingerprint: "openclaw.validation-background-processes-4",
    candidateRevision: "c24a9ca92a112fe40109a3cffd3c457c72e6445b",
    candidateExecutableDigest:
      "sha256:ff0184d57a959bcc5cc2823d779719640de882a5ee6b65df584f1d8b3e80f134",
    candidateDependencyDigest:
      "sha256:cfcc340fb5b31aae1353db0e0d941742f544cbf9c6632adfcf4c3ab9d7fd6fe3",
    expectedDependencyCacheDigest:
      "sha256:5ae579bfe2b46fa16cb5dade351fe68b2c06a928754468b0cbbd232586686fcf",
  }),
  runtime({
    id: "openclaw-110725-git-hooks-path",
    phase: "target-setup-git-safety",
    expectedFingerprint: "openclaw.unsafe-core-hookspath",
    candidateRevision: "3beb5f044d25971c9b46f68521e5420674529874",
    candidateExecutableDigest:
      "sha256:186cf47c80f1fa204de0904772d9cae430aa51e148e64510d72d779f637d8f4c",
    candidateDependencyDigest:
      "sha256:cfcc340fb5b31aae1353db0e0d941742f544cbf9c6632adfcf4c3ab9d7fd6fe3",
  }),
  publication({
    id: "publisher-depth1-concurrent-sibling",
    phase: "state-publication-rebuild",
    expectedFingerprint: "state-publication.concurrent-sibling-lost",
    candidateRevision: "5c28770bcb7955f69dfe25c1725c9b26d04a9988",
    candidateExecutableDigest:
      "sha256:0945daa1e04d47505759fa972759f49a6e0f6c0b97af4889f732b8a847d1a96f",
    candidateDependencyDigest:
      "sha256:cfcc340fb5b31aae1353db0e0d941742f544cbf9c6632adfcf4c3ab9d7fd6fe3",
    faultPoint: "after-ledger-ref-read-before-cas",
  }),
  publication({
    id: "publisher-two-parent-then-depth1",
    phase: "state-publication-rebuild",
    expectedFingerprint: "state-publication.merge-tree-entry-lost",
    candidateRevision: "5c28770bcb7955f69dfe25c1725c9b26d04a9988",
    candidateExecutableDigest:
      "sha256:0945daa1e04d47505759fa972759f49a6e0f6c0b97af4889f732b8a847d1a96f",
    candidateDependencyDigest:
      "sha256:cfcc340fb5b31aae1353db0e0d941742f544cbf9c6632adfcf4c3ab9d7fd6fe3",
    faultPoint: "after-server-side-merge-before-depth1-publish",
  }),
  publication({
    id: "publisher-canonical-path-conflict",
    phase: "state-publication-precondition",
    expectedFingerprint: null,
    candidateRevision: null,
    faultPoint: "before-immutable-path-write",
    expectedProductOutcome: "blocked",
  }),
  model("pending-run-replacement", "command-discovery", "after-command-discovery"),
  model("duplicate-command-replay", "idempotency", "after-intent-durable"),
  model("crash-after-intent", "reconciliation", "after-intent-durable"),
  model("crash-after-merge-before-outcome", "reconciliation", "after-merge-before-outcome"),
  model(
    "head-drift-before-mutation",
    "pre-merge-readiness",
    "after-verdict-before-snapshot-refresh",
  ),
  model(
    "base-drift-before-mutation",
    "pre-merge-readiness",
    "after-verdict-before-snapshot-refresh",
  ),
  model("check-drift-before-mutation", "pre-merge-readiness", "before-merge-mutation"),
  model("review-drift-before-mutation", "pre-merge-readiness", "before-merge-mutation"),
  model("permission-drift-before-mutation", "pre-merge-readiness", "before-merge-mutation"),
  model("protected-label-drift-before-mutation", "pre-merge-readiness", "before-merge-mutation"),
]);

export const SCENARIO_IDS = Object.freeze(SCENARIO_MANIFESTS.map(({ id }) => id));

export function scenarioManifest(id) {
  const manifest = SCENARIO_MANIFESTS.find((entry) => entry.id === id);
  if (!manifest) throw new Error(`unsupported scenario: ${id}`);
  return manifest;
}

export function scenariosForSuite(suite) {
  if (suite === "flow") return SCENARIO_MANIFESTS.filter(({ kind }) => kind === "flow");
  if (suite === "publication") {
    return SCENARIO_MANIFESTS.filter(({ kind }) => kind === "publication");
  }
  if (suite === "runtime") {
    throw new Error(
      "runtime scenarios pin different candidates; run them with explicit --scenario",
    );
  }
  if (suite === "model") return SCENARIO_MANIFESTS.filter(({ kind }) => kind === "model");
  if (suite === "quick") return SCENARIO_MANIFESTS.filter(({ kind }) => kind !== "runtime");
  if (suite === "all") {
    throw new Error(
      "all suite requires a candidate mapping protocol; use --suite quick plus explicit runtime scenarios",
    );
  }
  throw new Error(`unsupported suite: ${suite}`);
}

function flow(id, phase, expectedProductOutcome, legacyExpectedOutcome = "success") {
  return Object.freeze({
    id,
    version: 1,
    kind: "flow",
    fixture: "openclaw-shaped",
    phase,
    expectedProductOutcome,
    expectedFingerprint: null,
    legacyExpectedOutcome,
    candidateRevision: null,
    faultPoint: null,
    randomSeed: 0,
  });
}

function publication({
  id,
  phase,
  expectedFingerprint,
  candidateRevision,
  candidateExecutableDigest = null,
  candidateDependencyDigest = null,
  faultPoint,
  expectedProductOutcome = "preserved",
}) {
  return Object.freeze({
    id,
    version: 1,
    kind: "publication",
    fixture: "local-state-bare",
    phase,
    expectedProductOutcome,
    expectedFingerprint,
    candidateRevision,
    candidateExecutableDigest,
    candidateDependencyDigest,
    faultPoint,
    randomSeed: 0,
  });
}

function runtime({
  id,
  phase,
  expectedFingerprint,
  candidateRevision,
  candidateExecutableDigest,
  candidateDependencyDigest,
  expectedDependencyCacheDigest = null,
}) {
  return Object.freeze({
    id,
    version: 1,
    kind: "runtime",
    fixture: "openclaw-real",
    phase,
    expectedProductOutcome: "passed",
    expectedFingerprint,
    candidateRevision,
    candidateExecutableDigest,
    candidateDependencyDigest,
    expectedDependencyCacheDigest,
    faultPoint: null,
    randomSeed: 0,
    openclawBaseRevision: "223235044a29474ee50835fcfff350a5128cc94b",
    openclawHeadRevision: "f8f30becf2e9c36982d772b29db4d7b3b6120292",
  });
}

function model(id, phase, faultPoint) {
  return Object.freeze({
    id,
    version: 1,
    kind: "model",
    fixture: "deterministic-state-model",
    phase,
    expectedProductOutcome: id.includes("drift") ? "blocked" : "recovered",
    expectedFingerprint: null,
    candidateRevision: null,
    faultPoint,
    randomSeed: 0,
  });
}
