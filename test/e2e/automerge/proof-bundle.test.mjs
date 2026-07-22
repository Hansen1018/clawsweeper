import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactDirectory, gateExitCode, writeProofSummary } from "./proof-bundle.mjs";

const manifest = {
  id: "known-red",
  version: 1,
  phase: "publication",
  expectedProductOutcome: "preserved",
  expectedFingerprint: "state.sibling-lost",
  faultPoint: "before-cas",
  randomSeed: 0,
};

test("candidate gate remains red when a product oracle fails", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "red");
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode: "candidate",
    startedAtMs: Date.now(),
    observed: {
      productViolation: true,
      failureFingerprint: "state.sibling-lost",
      actualOutcome: "lost",
    },
  });
  assert.equal(summary.gate_status, "candidate-red");
  assert.equal(summary.gate_exit_code, 1);
  assert.equal(gateExitCode(summary), 1);
});

test("reproducer mode confirms the same exact red fingerprint", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "red");
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode: "reproducer",
    startedAtMs: Date.now(),
    observed: {
      productViolation: true,
      failureFingerprint: "state.sibling-lost",
      actualOutcome: "lost",
    },
  });
  assert.equal(summary.gate_status, "reproducer-confirmed");
  assert.equal(summary.gate_exit_code, 0);
  assert.equal(gateExitCode(summary), 0);
});

test("candidate mode passes when a fingerprinted violation is fixed", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "fixed");
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode: "candidate",
    startedAtMs: Date.now(),
    observed: {
      productViolation: false,
      actualOutcome: "preserved",
    },
  });
  assert.equal(summary.gate_status, "passed");
  assert.equal(summary.gate_exit_code, 0);
});

test("candidate mode treats a mismatched known violation as harness error", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "red");
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode: "candidate",
    startedAtMs: Date.now(),
    observed: {
      productViolation: true,
      failureFingerprint: "state.other",
      actualOutcome: "lost",
    },
  });
  assert.equal(summary.gate_status, "harness-error");
  assert.equal(summary.gate_exit_code, 1);
});

test("a different failure is a harness error, not a confirmed reproducer", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "red");
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode: "reproducer",
    startedAtMs: Date.now(),
    observed: {
      productViolation: true,
      failureFingerprint: "state.timeout",
      actualOutcome: "timeout",
    },
  });
  assert.equal(summary.gate_status, "harness-error");
});

test("an expected red that does not reproduce fails closed", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "red");
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode: "reproducer",
    startedAtMs: Date.now(),
    observed: {
      productViolation: false,
      actualOutcome: "unexpected-pass",
    },
  });
  assert.equal(summary.gate_status, "harness-error");
  assert.equal(summary.gate_exit_code, 1);
  assert.match(summary.error, /expected failure was not reproduced/);
});

test("reproducer mode fails closed without an expected fingerprint", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "green");
  const summary = writeProofSummary({
    artifacts,
    manifest: { ...manifest, expectedFingerprint: null },
    mode: "reproducer",
    startedAtMs: Date.now(),
    observed: {
      productViolation: false,
      actualOutcome: "passed",
    },
  });
  assert.equal(summary.gate_status, "harness-error");
  assert.equal(summary.gate_exit_code, 1);
  assert.match(summary.error, /requires an expected failure fingerprint/);
});

test("model-only evidence does not masquerade as a candidate pass", () => {
  const artifacts = artifactDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "model");
  const summary = writeProofSummary({
    artifacts,
    manifest: { ...manifest, kind: "model", expectedFingerprint: null },
    mode: "candidate",
    startedAtMs: Date.now(),
    observed: {
      evidenceOnly: true,
      productViolation: false,
      actualOutcome: "recovered",
    },
  });
  assert.equal(summary.gate_status, "evidence-only");
  assert.equal(summary.gate_exit_code, 1);
});
