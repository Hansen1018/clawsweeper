import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VALID_GATE_STATUSES = new Set([
  "candidate-red",
  "evidence-only",
  "reproducer-confirmed",
  "passed",
  "harness-error",
]);

export function artifactDirectory(outputRoot, scenarioId) {
  const directory = path.resolve(outputRoot, scenarioId);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function writeProofSummary({ artifacts, manifest, mode, observed, startedAtMs }) {
  if (!["candidate", "reproducer"].includes(mode))
    throw new Error(`unsupported gate mode: ${mode}`);
  const productViolation = Boolean(observed.productViolation);
  const fingerprintMatches =
    !manifest.expectedFingerprint || observed.failureFingerprint === manifest.expectedFingerprint;
  const gateStatus = gateStatusFor({
    mode,
    productViolation,
    fingerprintMatches,
    expectsFingerprint: Boolean(manifest.expectedFingerprint),
    evidenceOnly: observed.evidenceOnly,
    harnessError: observed.harnessError,
  });
  const summary = {
    scenario_id: manifest.id,
    scenario_version: manifest.version,
    gate_mode: mode,
    gate_status: gateStatus,
    gate_exit_code: gateStatus === "passed" || gateStatus === "reproducer-confirmed" ? 0 : 1,
    clawsweeper_sha: observed.clawsweeperSha ?? null,
    candidate_dependency_digest: observed.candidateDependencyDigest ?? null,
    candidate_executable_digest: observed.candidateExecutableDigest ?? null,
    openclaw_base_sha: observed.openclawBaseSha ?? null,
    openclaw_head_sha: observed.openclawHeadSha ?? null,
    fixture_digest: observed.fixtureDigest ?? null,
    event_sequence: observed.eventSequence ?? [],
    fault_point: manifest.faultPoint,
    random_seed: manifest.randomSeed,
    phase: observed.phase ?? manifest.phase,
    expected_outcome: manifest.expectedProductOutcome,
    actual_outcome: observed.actualOutcome ?? null,
    failure_fingerprint: observed.failureFingerprint ?? null,
    terminal_product_state: observed.terminalProductState ?? null,
    merge_call_count: observed.mergeCallCount ?? 0,
    git_refs_and_tree_digest: observed.gitRefsAndTreeDigest ?? null,
    child_process_snapshot: observed.childProcessSnapshot ?? [],
    wall_time_ms: Date.now() - startedAtMs,
    cpu_time_ms: observed.cpuTimeMs ?? null,
    peak_rss_bytes: observed.peakRssBytes ?? null,
    disk_delta_bytes: observed.diskDeltaBytes ?? null,
    invariant: observed.invariant ?? null,
    error:
      observed.error ??
      (mode === "reproducer" && !manifest.expectedFingerprint && gateStatus !== "evidence-only"
        ? "reproducer mode requires an expected failure fingerprint"
        : null) ??
      (mode === "reproducer" && manifest.expectedFingerprint && !productViolation
        ? `expected failure was not reproduced: ${manifest.expectedFingerprint}`
        : null),
  };
  validateProofSummary(summary);
  fs.writeFileSync(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export function validateProofSummary(summary) {
  if (!VALID_GATE_STATUSES.has(summary.gate_status)) {
    throw new Error(`invalid proof gate_status: ${summary.gate_status}`);
  }
  for (const key of [
    "scenario_id",
    "scenario_version",
    "event_sequence",
    "gate_exit_code",
    "phase",
    "expected_outcome",
    "merge_call_count",
    "child_process_snapshot",
    "wall_time_ms",
  ]) {
    if (summary[key] === undefined) throw new Error(`proof summary is missing ${key}`);
  }
  if (summary.gate_status === "reproducer-confirmed" && !summary.failure_fingerprint) {
    throw new Error("a confirmed reproducer requires an exact failure fingerprint");
  }
  if (
    summary.gate_mode === "reproducer" &&
    summary.gate_status !== "harness-error" &&
    summary.gate_status !== "evidence-only" &&
    !summary.failure_fingerprint
  ) {
    throw new Error("reproducer mode requires an expected failure fingerprint");
  }
  if (summary.gate_exit_code !== gateExitCode(summary)) {
    throw new Error("proof gate_exit_code does not match gate_status");
  }
}

export function digestStrings(values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) hash.update(String(value)).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

export function gateExitCode(summary) {
  return summary.gate_status === "passed" || summary.gate_status === "reproducer-confirmed" ? 0 : 1;
}

function gateStatusFor({
  mode,
  productViolation,
  fingerprintMatches,
  expectsFingerprint,
  evidenceOnly,
  harnessError,
}) {
  if (harnessError) return "harness-error";
  if (mode === "reproducer" && !expectsFingerprint) return "harness-error";
  if (evidenceOnly) return "evidence-only";
  if (!productViolation)
    return mode === "reproducer" && expectsFingerprint ? "harness-error" : "passed";
  if (expectsFingerprint && !fingerprintMatches) return "harness-error";
  return mode === "reproducer" ? "reproducer-confirmed" : "candidate-red";
}
