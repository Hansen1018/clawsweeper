import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseLiveProofManifest } from "./manifest.js";
import { REVIEW_LIVE_PROOF_CLEANUP_SCHEMA_VERSION } from "./review-artifacts.js";
import { parseLiveVerificationResult } from "./verification.js";

export const REVIEW_LIVE_PROOF_AUGMENTATION_SCHEMA_VERSION = 1 as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const FILE_PATTERN =
  /^live-proof\/[1-9]\d*\/(?:live-verification\.json|live-proof-manifest\.json|live-proof\.mp4|poster\.jpg)$/;
const MAX_FILES = 4;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ReviewLiveProofAugmentationContext {
  repository: string;
  sourceSha: string;
  runId: string;
  runAttempt: number;
  producerJob: "event-review-live-proof";
  runnerEnvironment: "github-hosted";
  coreArtifactId: string;
  coreArtifactDigest: string;
  targetRepo: string;
  itemNumber: number;
  pullHeadSha: string;
}

export interface ReviewLiveProofAugmentationFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ReviewLiveProofAugmentationManifest {
  schema_version: typeof REVIEW_LIVE_PROOF_AUGMENTATION_SCHEMA_VERSION;
  created_at: string;
  producer: {
    repository: string;
    source_sha: string;
    run_id: string;
    run_attempt: number;
    job: "event-review-live-proof";
    runner_environment: "github-hosted";
  };
  core: {
    artifact_id: string;
    artifact_digest: string;
    manifest_sha256: string;
  };
  target: {
    repo: string;
    item_number: number;
    pull_head_sha: string;
  };
  result:
    | { kind: "proof"; overall_pass: boolean }
    | { kind: "cleanup_only_failure"; proof_output_present: true };
  files: ReviewLiveProofAugmentationFile[];
}

export function createReviewLiveProofAugmentation(options: {
  augmentationDir: string;
  cleanupFailurePath?: string;
  coreManifestPath: string;
  proofDir: string;
  createdAt: string;
  context: ReviewLiveProofAugmentationContext;
}): ReviewLiveProofAugmentationManifest {
  const context = validateContext(options.context);
  const augmentationDir = path.resolve(options.augmentationDir);
  fs.rmSync(augmentationDir, { force: true, recursive: true });
  fs.mkdirSync(augmentationDir, { recursive: true });
  const coreManifestSha256 = regularFileSha256(options.coreManifestPath, 2 * 1024 * 1024);

  let result: ReviewLiveProofAugmentationManifest["result"];
  if (options.cleanupFailurePath && fs.existsSync(options.cleanupFailurePath)) {
    const cleanup = parseCleanupFailure(options.cleanupFailurePath);
    if (
      cleanup.item !== context.itemNumber ||
      cleanup.head_sha !== context.pullHeadSha ||
      cleanup.proof_output_present !== true
    ) {
      throw new Error("live-proof cleanup failure does not match the trusted target");
    }
    result = { kind: "cleanup_only_failure", proof_output_present: true };
  } else {
    const destination = path.join(augmentationDir, "live-proof", String(context.itemNumber));
    const verification = copyAndValidateProof(options.proofDir, destination, context);
    result = { kind: "proof", overall_pass: verification.overall_pass };
  }

  const manifest = validateManifest({
    schema_version: REVIEW_LIVE_PROOF_AUGMENTATION_SCHEMA_VERSION,
    created_at: canonicalTimestamp(options.createdAt),
    producer: {
      repository: context.repository,
      source_sha: context.sourceSha,
      run_id: context.runId,
      run_attempt: context.runAttempt,
      job: context.producerJob,
      runner_environment: context.runnerEnvironment,
    },
    core: {
      artifact_id: context.coreArtifactId,
      artifact_digest: context.coreArtifactDigest,
      manifest_sha256: coreManifestSha256,
    },
    target: {
      repo: context.targetRepo,
      item_number: context.itemNumber,
      pull_head_sha: context.pullHeadSha,
    },
    result,
    files: collectFiles(augmentationDir),
  });
  fs.writeFileSync(
    path.join(augmentationDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return manifest;
}

export function validateReviewLiveProofAugmentation(
  augmentationDirInput: string,
  coreManifestPath: string,
  expected: ReviewLiveProofAugmentationContext,
): ReviewLiveProofAugmentationManifest {
  const augmentationDir = path.resolve(augmentationDirInput);
  const manifestPath = path.join(augmentationDir, "manifest.json");
  const manifest = validateManifest(
    JSON.parse(readRegularFile(manifestPath, 2 * 1024 * 1024)) as unknown,
  );
  const context = validateContext(expected);
  const actual = {
    repository: manifest.producer.repository,
    sourceSha: manifest.producer.source_sha,
    runId: manifest.producer.run_id,
    runAttempt: manifest.producer.run_attempt,
    producerJob: manifest.producer.job,
    runnerEnvironment: manifest.producer.runner_environment,
    coreArtifactId: manifest.core.artifact_id,
    coreArtifactDigest: manifest.core.artifact_digest,
    targetRepo: manifest.target.repo,
    itemNumber: manifest.target.item_number,
    pullHeadSha: manifest.target.pull_head_sha,
  } satisfies ReviewLiveProofAugmentationContext;
  if (JSON.stringify(actual) !== JSON.stringify(context)) {
    throw new Error("live-proof augmentation does not match the trusted workflow context");
  }
  if (manifest.core.manifest_sha256 !== regularFileSha256(coreManifestPath, 2 * 1024 * 1024)) {
    throw new Error("live-proof augmentation does not match the immutable core manifest");
  }
  if (JSON.stringify(collectFiles(augmentationDir)) !== JSON.stringify(manifest.files)) {
    throw new Error("live-proof augmentation file inventory does not match its manifest");
  }
  return manifest;
}

export function mergeReviewLiveProofAugmentation(
  augmentationDirInput: string,
  destinationDirInput: string,
  manifest: ReviewLiveProofAugmentationManifest,
): void {
  if (manifest.result.kind !== "proof") {
    throw new Error("cleanup-only augmentation must not be merged into the core review");
  }
  const augmentationDir = path.resolve(augmentationDirInput);
  const destinationDir = path.resolve(destinationDirInput);
  for (const file of manifest.files) {
    const source = path.join(augmentationDir, file.path);
    const destination = path.join(destinationDir, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

function copyAndValidateProof(
  sourceDirInput: string,
  destinationDir: string,
  context: ReviewLiveProofAugmentationContext,
) {
  const sourceDir = path.resolve(sourceDirInput);
  const verificationPath = path.join(sourceDir, "live-verification.json");
  const verification = parseLiveVerificationResult(
    JSON.parse(readRegularFile(verificationPath, 2 * 1024 * 1024)) as unknown,
  );
  if (
    verification.repo !== context.targetRepo ||
    verification.item !== context.itemNumber ||
    verification.head_sha !== context.pullHeadSha
  ) {
    throw new Error("live verification result does not match the trusted target");
  }
  const manifestPath = path.join(sourceDir, "live-proof-manifest.json");
  const hasManifest = fs.existsSync(manifestPath);
  const hasVideo = fs.existsSync(path.join(sourceDir, "live-proof.mp4"));
  const hasPoster = fs.existsSync(path.join(sourceDir, "poster.jpg"));
  if (hasManifest !== (hasVideo && hasPoster)) {
    throw new Error("live-proof media and manifest must be complete");
  }
  if (hasManifest) {
    const media = parseLiveProofManifest(
      JSON.parse(readRegularFile(manifestPath, 2 * 1024 * 1024)) as unknown,
    );
    if (
      media.repo !== verification.repo ||
      media.item !== verification.item ||
      media.head_sha !== verification.head_sha ||
      media.surface !== verification.surface ||
      media.drive_status !== verification.drive_status
    ) {
      throw new Error("live-proof media manifest does not match verification");
    }
  }
  for (const name of [
    "live-verification.json",
    "live-proof-manifest.json",
    "live-proof.mp4",
    "poster.jpg",
  ]) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("live-proof augmentation source must contain regular files");
    }
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.copyFileSync(source, path.join(destinationDir, name), fs.constants.COPYFILE_EXCL);
  }
  return verification;
}

function parseCleanupFailure(file: string): {
  item: number;
  head_sha: string;
  proof_output_present: boolean;
} {
  const value = JSON.parse(readRegularFile(file, 16 * 1024)) as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(
        ["failures", "head_sha", "item", "proof_output_present", "schema_version"].sort(),
      ) ||
    value.schema_version !== REVIEW_LIVE_PROOF_CLEANUP_SCHEMA_VERSION ||
    !Number.isInteger(value.item) ||
    !SHA_PATTERN.test(String(value.head_sha)) ||
    typeof value.proof_output_present !== "boolean" ||
    !Array.isArray(value.failures) ||
    value.failures.length < 1 ||
    value.failures.length > 2
  ) {
    throw new Error("live-proof cleanup failure marker is invalid");
  }
  for (const failure of value.failures) {
    if (
      !failure ||
      typeof failure !== "object" ||
      Array.isArray(failure) ||
      !["remove_worktree", "remove_scratch"].includes(
        String((failure as Record<string, unknown>).operation),
      ) ||
      !/^[A-Z0-9_]{1,40}$/.test(String((failure as Record<string, unknown>).error_code))
    ) {
      throw new Error("live-proof cleanup failure marker is invalid");
    }
  }
  return {
    item: Number(value.item),
    head_sha: String(value.head_sha),
    proof_output_present: value.proof_output_present,
  };
}

function validateContext(
  value: ReviewLiveProofAugmentationContext,
): ReviewLiveProofAugmentationContext {
  if (!REPO_PATTERN.test(value.repository) || !REPO_PATTERN.test(value.targetRepo)) {
    throw new Error("live-proof augmentation repository is invalid");
  }
  if (!SHA_PATTERN.test(value.sourceSha) || !SHA_PATTERN.test(value.pullHeadSha)) {
    throw new Error("live-proof augmentation SHA is invalid");
  }
  if (
    !/^\d{1,30}$/.test(value.runId) ||
    !Number.isInteger(value.runAttempt) ||
    value.runAttempt < 1
  ) {
    throw new Error("live-proof augmentation run identity is invalid");
  }
  if (
    value.producerJob !== "event-review-live-proof" ||
    value.runnerEnvironment !== "github-hosted"
  ) {
    throw new Error("live-proof augmentation producer is invalid");
  }
  if (!/^[1-9]\d*$/.test(value.coreArtifactId)) {
    throw new Error("live-proof core artifact ID is invalid");
  }
  if (!ARTIFACT_DIGEST_PATTERN.test(value.coreArtifactDigest)) {
    throw new Error("live-proof core artifact digest is invalid");
  }
  if (!Number.isInteger(value.itemNumber) || value.itemNumber < 1) {
    throw new Error("live-proof augmentation item number is invalid");
  }
  return { ...value };
}

function validateManifest(value: unknown): ReviewLiveProofAugmentationManifest {
  const manifest = record(value, "manifest");
  exactKeys(manifest, [
    "schema_version",
    "created_at",
    "producer",
    "core",
    "target",
    "result",
    "files",
  ]);
  if (manifest.schema_version !== REVIEW_LIVE_PROOF_AUGMENTATION_SCHEMA_VERSION) {
    throw new Error("unsupported live-proof augmentation schema");
  }
  const createdAt = canonicalTimestamp(stringValue(manifest.created_at, "created_at"));
  const producer = record(manifest.producer, "producer");
  exactKeys(producer, [
    "repository",
    "source_sha",
    "run_id",
    "run_attempt",
    "job",
    "runner_environment",
  ]);
  const core = record(manifest.core, "core");
  exactKeys(core, ["artifact_id", "artifact_digest", "manifest_sha256"]);
  const target = record(manifest.target, "target");
  exactKeys(target, ["repo", "item_number", "pull_head_sha"]);
  const result = record(manifest.result, "result");
  if (result.kind === "proof") {
    exactKeys(result, ["kind", "overall_pass"]);
  } else if (result.kind === "cleanup_only_failure") {
    exactKeys(result, ["kind", "proof_output_present"]);
  } else {
    throw new Error("live-proof augmentation result is invalid");
  }
  const context = validateContext({
    repository: stringValue(producer.repository, "producer.repository"),
    sourceSha: stringValue(producer.source_sha, "producer.source_sha"),
    runId: stringValue(producer.run_id, "producer.run_id"),
    runAttempt: numberValue(producer.run_attempt, "producer.run_attempt"),
    producerJob: producer.job as "event-review-live-proof",
    runnerEnvironment: producer.runner_environment as "github-hosted",
    coreArtifactId: stringValue(core.artifact_id, "core.artifact_id"),
    coreArtifactDigest: stringValue(core.artifact_digest, "core.artifact_digest"),
    targetRepo: stringValue(target.repo, "target.repo"),
    itemNumber: numberValue(target.item_number, "target.item_number"),
    pullHeadSha: stringValue(target.pull_head_sha, "target.pull_head_sha"),
  });
  const coreManifestSha256 = stringValue(core.manifest_sha256, "core.manifest_sha256");
  if (!SHA256_PATTERN.test(coreManifestSha256)) {
    throw new Error("live-proof core manifest digest is invalid");
  }
  if (
    (result.kind === "proof" && typeof result.overall_pass !== "boolean") ||
    (result.kind === "cleanup_only_failure" && result.proof_output_present !== true)
  ) {
    throw new Error("live-proof augmentation result is invalid");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) {
    throw new Error("live-proof augmentation file inventory is invalid");
  }
  let totalBytes = 0;
  const files = manifest.files.map((entry, index) => {
    const file = record(entry, `files[${index}]`);
    exactKeys(file, ["path", "bytes", "sha256"]);
    const filePath = stringValue(file.path, `files[${index}].path`);
    const bytes = numberValue(file.bytes, `files[${index}].bytes`);
    const digest = stringValue(file.sha256, `files[${index}].sha256`);
    if (
      !FILE_PATTERN.test(filePath) ||
      !Number.isInteger(bytes) ||
      bytes < 0 ||
      !SHA256_PATTERN.test(digest)
    ) {
      throw new Error("live-proof augmentation file inventory is invalid");
    }
    totalBytes += bytes;
    return { path: filePath, bytes, sha256: digest };
  });
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("live-proof augmentation exceeds its byte limit");
  }
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(sorted) !== JSON.stringify(files)) {
    throw new Error("live-proof augmentation files must be sorted");
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("live-proof augmentation contains duplicate file paths");
  }
  if (result.kind === "cleanup_only_failure" && files.length !== 0) {
    throw new Error("cleanup-only augmentation must not contain proof files");
  }
  if (
    result.kind === "proof" &&
    !files.some((file) => file.path.endsWith("/live-verification.json"))
  ) {
    throw new Error("proof augmentation is missing live-verification.json");
  }
  return {
    schema_version: REVIEW_LIVE_PROOF_AUGMENTATION_SCHEMA_VERSION,
    created_at: createdAt,
    producer: {
      repository: context.repository,
      source_sha: context.sourceSha,
      run_id: context.runId,
      run_attempt: context.runAttempt,
      job: context.producerJob,
      runner_environment: context.runnerEnvironment,
    },
    core: {
      artifact_id: context.coreArtifactId,
      artifact_digest: context.coreArtifactDigest,
      manifest_sha256: coreManifestSha256,
    },
    target: {
      repo: context.targetRepo,
      item_number: context.itemNumber,
      pull_head_sha: context.pullHeadSha,
    },
    result:
      result.kind === "proof"
        ? { kind: "proof", overall_pass: result.overall_pass as boolean }
        : { kind: "cleanup_only_failure", proof_output_present: true },
    files,
  };
}

function collectFiles(root: string): ReviewLiveProofAugmentationFile[] {
  const files: ReviewLiveProofAugmentationFile[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "manifest.json") continue;
      if (entry.isSymbolicLink())
        throw new Error("live-proof augmentation must not contain symlinks");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        if (!FILE_PATTERN.test(relative)) {
          throw new Error(`live-proof augmentation contains an unexpected path: ${relative}`);
        }
        const bytes = fs.statSync(absolute).size;
        files.push({ path: relative, bytes, sha256: sha256(fs.readFileSync(absolute)) });
      } else {
        throw new Error("live-proof augmentation contains a non-file entry");
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readRegularFile(file: string, maxBytes: number): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error("live-proof augmentation input must be a bounded regular file");
  }
  return fs.readFileSync(file, "utf8");
}

function regularFileSha256(file: string, maxBytes: number): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error("live-proof augmentation input must be a bounded regular file");
  }
  return sha256(fs.readFileSync(file));
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("live-proof augmentation timestamp is invalid");
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`live-proof augmentation ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error("live-proof augmentation contains unexpected manifest fields");
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`live-proof augmentation ${label} must be a string`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`live-proof augmentation ${label} is invalid`);
  }
  return value;
}
