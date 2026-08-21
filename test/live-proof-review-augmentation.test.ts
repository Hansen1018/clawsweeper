import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReviewLiveProofAugmentation,
  mergeReviewLiveProofAugmentation,
  validateReviewLiveProofAugmentation,
  type ReviewLiveProofAugmentationContext,
} from "../dist/live-proof/review-augmentation.js";

const HEAD = "b".repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-proof-augmentation-"));
  const proofDir = path.join(root, "proof");
  const augmentationDir = path.join(root, "augmentation");
  const coreManifestPath = path.join(root, "core-manifest.json");
  fs.mkdirSync(proofDir);
  fs.writeFileSync(coreManifestPath, '{"schema_version":1}\n');
  fs.writeFileSync(
    path.join(proofDir, "live-verification.json"),
    `${JSON.stringify({
      schema_version: 1,
      repo: "openclaw/clickclack",
      item: 173,
      head_sha: HEAD,
      surface: "terminal",
      entry: "pnpm test",
      drive_status: "completed",
      steps: [
        {
          action: "expect_output",
          status: "completed",
          detail: "expected output observed",
          assertion: "ok",
          present_at_start: false,
          satisfied: true,
        },
      ],
      output: "ok",
      overall_pass: true,
      verified_at: "2026-08-21T17:00:00.000Z",
    })}\n`,
  );
  const context: ReviewLiveProofAugmentationContext = {
    repository: "openclaw/clawsweeper",
    sourceSha: "a".repeat(40),
    runId: "32500000000",
    runAttempt: 1,
    producerJob: "event-review-live-proof",
    runnerEnvironment: "github-hosted",
    coreArtifactId: "123456789",
    coreArtifactDigest: `sha256:${"c".repeat(64)}`,
    targetRepo: "openclaw/clickclack",
    itemNumber: 173,
    pullHeadSha: HEAD,
  };
  return { root, proofDir, augmentationDir, coreManifestPath, context };
}

test("live-proof augmentation binds proof to the immutable core artifact and exact head", () => {
  const value = fixture();
  const created = createReviewLiveProofAugmentation({
    augmentationDir: value.augmentationDir,
    coreManifestPath: value.coreManifestPath,
    proofDir: value.proofDir,
    createdAt: "2026-08-21T17:01:00.000Z",
    context: value.context,
  });
  const validated = validateReviewLiveProofAugmentation(
    value.augmentationDir,
    value.coreManifestPath,
    value.context,
  );

  assert.deepEqual(validated, created);
  assert.deepEqual(created.result, { kind: "proof", overall_pass: true });
  assert.deepEqual(
    created.files.map((file) => file.path),
    ["live-proof/173/live-verification.json"],
  );

  const destination = path.join(value.root, "publication");
  fs.mkdirSync(destination);
  mergeReviewLiveProofAugmentation(value.augmentationDir, destination, validated);
  assert.equal(
    fs.existsSync(path.join(destination, "live-proof/173/live-verification.json")),
    true,
  );
});

test("valid FAIL verification remains a publishable proof augmentation", () => {
  const value = fixture();
  const verificationPath = path.join(value.proofDir, "live-verification.json");
  const verification = JSON.parse(fs.readFileSync(verificationPath, "utf8")) as Record<
    string,
    unknown
  >;
  verification.drive_status = "failed";
  verification.steps = [
    {
      action: "expect_output",
      status: "failed",
      detail: "expected output missing",
      assertion: "ok",
      present_at_start: false,
      satisfied: false,
    },
  ];
  verification.failure = {
    phase: "step",
    reason: "expected output missing",
    step: 1,
    action: "expect_output",
  };
  verification.overall_pass = false;
  fs.writeFileSync(verificationPath, `${JSON.stringify(verification)}\n`);

  const created = createReviewLiveProofAugmentation({
    augmentationDir: value.augmentationDir,
    coreManifestPath: value.coreManifestPath,
    proofDir: value.proofDir,
    createdAt: "2026-08-21T17:01:00.000Z",
    context: value.context,
  });
  assert.deepEqual(created.result, { kind: "proof", overall_pass: false });
});

test("verified cleanup-only failure produces a core-only augmentation", () => {
  const value = fixture();
  const cleanupFailurePath = path.join(value.root, "cleanup.json");
  fs.writeFileSync(
    cleanupFailurePath,
    `${JSON.stringify({
      schema_version: 1,
      item: 173,
      head_sha: HEAD,
      proof_output_present: true,
      failures: [{ operation: "remove_scratch", error_code: "EACCES" }],
    })}\n`,
  );
  const created = createReviewLiveProofAugmentation({
    augmentationDir: value.augmentationDir,
    cleanupFailurePath,
    coreManifestPath: value.coreManifestPath,
    proofDir: value.proofDir,
    createdAt: "2026-08-21T17:01:00.000Z",
    context: value.context,
  });

  assert.deepEqual(created.result, {
    kind: "cleanup_only_failure",
    proof_output_present: true,
  });
  assert.deepEqual(created.files, []);
  assert.throws(
    () =>
      mergeReviewLiveProofAugmentation(
        value.augmentationDir,
        path.join(value.root, "publication"),
        created,
      ),
    /must not be merged/,
  );
});

test("augmentation rejects core, head, and file tampering", () => {
  const value = fixture();
  createReviewLiveProofAugmentation({
    augmentationDir: value.augmentationDir,
    coreManifestPath: value.coreManifestPath,
    proofDir: value.proofDir,
    createdAt: "2026-08-21T17:01:00.000Z",
    context: value.context,
  });
  assert.throws(
    () =>
      validateReviewLiveProofAugmentation(value.augmentationDir, value.coreManifestPath, {
        ...value.context,
        pullHeadSha: "d".repeat(40),
      }),
    /trusted workflow context/,
  );
  fs.appendFileSync(value.coreManifestPath, "changed\n");
  assert.throws(
    () =>
      validateReviewLiveProofAugmentation(
        value.augmentationDir,
        value.coreManifestPath,
        value.context,
      ),
    /immutable core manifest/,
  );
});

test("augmentation rejects unknown and duplicate manifest inventory fields", () => {
  const value = fixture();
  createReviewLiveProofAugmentation({
    augmentationDir: value.augmentationDir,
    coreManifestPath: value.coreManifestPath,
    proofDir: value.proofDir,
    createdAt: "2026-08-21T17:01:00.000Z",
    context: value.context,
  });
  const manifestPath = path.join(value.augmentationDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    files: Array<Record<string, unknown>>;
    producer: Record<string, unknown>;
  };
  manifest.producer.untrusted = true;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(
    () =>
      validateReviewLiveProofAugmentation(
        value.augmentationDir,
        value.coreManifestPath,
        value.context,
      ),
    /unexpected manifest fields/,
  );

  delete manifest.producer.untrusted;
  manifest.files.push({ ...manifest.files[0] });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(
    () =>
      validateReviewLiveProofAugmentation(
        value.augmentationDir,
        value.coreManifestPath,
        value.context,
      ),
    /duplicate file paths/,
  );
});
