#!/usr/bin/env node
import {
  createReviewLiveProofAugmentation,
  materializeReviewLiveProofAugmentationArchive,
  mergeReviewLiveProofAugmentation,
  validateReviewLiveProofAugmentation,
  type ReviewLiveProofAugmentationContext,
} from "./review-augmentation.js";

function main(): void {
  const [command] = process.argv.slice(2);
  if (
    command !== "create" &&
    command !== "materialize" &&
    command !== "validate" &&
    command !== "merge"
  ) {
    throw new Error("usage: review-augmentation-cli.ts <create|materialize|validate|merge>");
  }

  const env = process.env;
  if (command === "materialize") {
    materializeReviewLiveProofAugmentationArchive({
      archivePath: requiredEnv(env, "REVIEW_LIVE_PROOF_ARCHIVE"),
      destinationDir: requiredEnv(env, "REVIEW_LIVE_PROOF_AUGMENTATION_DIR"),
      itemNumber: positiveIntegerEnv(env, "REVIEW_LIVE_PROOF_ITEM_NUMBER"),
    });
    process.stdout.write('{"materialized":true}\n');
    return;
  }
  const context = contextFromEnv(env);
  const augmentationDir = requiredEnv(env, "REVIEW_LIVE_PROOF_AUGMENTATION_DIR");
  const coreManifestPath = requiredEnv(env, "REVIEW_LIVE_PROOF_CORE_MANIFEST");
  if (command === "create") {
    const manifest = createReviewLiveProofAugmentation({
      augmentationDir,
      cleanupFailurePath: optionalEnv(env, "REVIEW_LIVE_PROOF_CLEANUP_FAILURE"),
      coreManifestPath,
      proofDir: requiredEnv(env, "REVIEW_LIVE_PROOF_PROOF_DIR"),
      createdAt: new Date().toISOString(),
      context,
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } else {
    const manifest = validateReviewLiveProofAugmentation(
      augmentationDir,
      coreManifestPath,
      context,
    );
    if (command === "merge") {
      mergeReviewLiveProofAugmentation(
        augmentationDir,
        requiredEnv(env, "REVIEW_LIVE_PROOF_DESTINATION_DIR"),
        manifest,
      );
    }
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  }
}

main();

function contextFromEnv(env: NodeJS.ProcessEnv): ReviewLiveProofAugmentationContext {
  return {
    repository: requiredEnv(env, "GITHUB_REPOSITORY"),
    sourceSha: requiredShaEnv(env, "REVIEW_LIVE_PROOF_SOURCE_SHA"),
    runId: requiredEnv(env, "GITHUB_RUN_ID"),
    runAttempt: positiveIntegerEnv(env, "GITHUB_RUN_ATTEMPT"),
    producerJob: "event-review-live-proof",
    runnerEnvironment: requiredGithubRunnerEnvironment(env),
    coreArtifactId: requiredEnv(env, "REVIEW_LIVE_PROOF_CORE_ARTIFACT_ID"),
    coreArtifactDigest: requiredEnv(env, "REVIEW_LIVE_PROOF_CORE_ARTIFACT_DIGEST"),
    targetRepo: requiredEnv(env, "REVIEW_LIVE_PROOF_TARGET_REPO"),
    itemNumber: positiveIntegerEnv(env, "REVIEW_LIVE_PROOF_ITEM_NUMBER"),
    pullHeadSha: requiredShaEnv(env, "REVIEW_LIVE_PROOF_PULL_HEAD_SHA"),
  };
}

function requiredGithubRunnerEnvironment(
  env: NodeJS.ProcessEnv,
): ReviewLiveProofAugmentationContext["runnerEnvironment"] {
  const value = requiredEnv(env, "REVIEW_LIVE_PROOF_RUNNER_ENVIRONMENT");
  if (value !== "github-hosted") {
    throw new Error("REVIEW_LIVE_PROOF_RUNNER_ENVIRONMENT must be github-hosted");
  }
  return value;
}

function requiredShaEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnv(env, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full commit SHA`);
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnv(env, name));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? "").trim();
}
