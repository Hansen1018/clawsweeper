import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  createReviewLiveProofAugmentation,
  materializeReviewLiveProofAugmentationArchive,
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

test("augmentation archive materialization accepts only fixed regular entries", () => {
  const value = fixture();
  const archivePath = path.join(value.root, "augmentation.zip");
  const destination = path.join(value.root, "materialized");
  writeZipArchive(archivePath, [
    { name: "manifest.json", data: Buffer.from('{"schema_version":1}\n') },
    {
      name: "live-proof/173/live-verification.json",
      data: Buffer.from('{"schema_version":1}\n'),
    },
  ]);

  const result = spawnSync(
    process.execPath,
    ["dist/live-proof/review-augmentation-cli.js", "materialize"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        REVIEW_LIVE_PROOF_ARCHIVE: archivePath,
        REVIEW_LIVE_PROOF_AUGMENTATION_DIR: destination,
        REVIEW_LIVE_PROOF_ITEM_NUMBER: "173",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { materialized: true });

  assert.equal(
    fs.readFileSync(path.join(destination, "manifest.json"), "utf8"),
    '{"schema_version":1}\n',
  );
  assert.equal(
    fs.readFileSync(path.join(destination, "live-proof/173/live-verification.json"), "utf8"),
    '{"schema_version":1}\n',
  );
});

test("augmentation archive rejects unsafe entry paths and types before writing", () => {
  const value = fixture();
  const outside = path.join(value.root, "outside.txt");
  fs.writeFileSync(outside, "sentinel\n");

  for (const [name, entries] of [
    ["absolute", [{ name: "/manifest.json", data: Buffer.from("invalid\n") }]],
    ["traversal", [{ name: "../outside.txt", data: Buffer.from("replaced\n"), mode: 0o100644 }]],
    [
      "duplicate",
      [
        { name: "manifest.json", data: Buffer.from("first\n") },
        { name: "manifest.json", data: Buffer.from("second\n") },
      ],
    ],
    ["symlink", [{ name: "manifest.json", data: Buffer.from("../outside.txt"), mode: 0o120777 }]],
    [
      "hardlink-metadata",
      [
        {
          name: "manifest.json",
          data: Buffer.from("outside.txt"),
          extra: Buffer.from([0x0d, 0, 0, 0]),
        },
      ],
    ],
    ["device", [{ name: "manifest.json", data: Buffer.from("device\n"), mode: 0o020666 }]],
  ] as const) {
    const archivePath = path.join(value.root, `${name}.zip`);
    const destination = path.join(value.root, `${name}-materialized`);
    writeZipArchive(archivePath, entries);
    assert.throws(
      () =>
        materializeReviewLiveProofAugmentationArchive({
          archivePath,
          destinationDir: destination,
          itemNumber: 173,
        }),
      /unexpected path|duplicate entries|plain regular files/,
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readFileSync(outside, "utf8"), "sentinel\n");
  }
});

function writeZipArchive(
  archivePath: string,
  entries: ReadonlyArray<{ name: string; data: Buffer; mode?: number; extra?: Buffer }>,
): void {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const extra = entry.extra ?? Buffer.alloc(0);
    const checksum = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((1 << 11) | (1 << 3), 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(entry.data.length, 12);
    localParts.push(local, name, extra, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((1 << 11) | (1 << 3), 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name, extra);
    localOffset +=
      local.length + name.length + extra.length + compressed.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  fs.writeFileSync(archivePath, Buffer.concat([...localParts, centralDirectory, end]));
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
