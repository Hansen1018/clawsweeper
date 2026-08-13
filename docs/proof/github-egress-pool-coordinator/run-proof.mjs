#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createWriteStream, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";

import { GithubEgressPoolCoordinatorClient } from "../../../dist/repair/github-egress-pool-client.js";
import {
  GITHUB_EGRESS_POOL_DEFERRED_EXIT,
  runGithubEgressPoolCommand,
} from "../../../dist/repair/github-egress-pool-runner.js";

const repoRoot = process.cwd();
const outputDir = required("GITHUB_EGRESS_POOL_PROOF_OUTPUT");
const scratch = required("GITHUB_EGRESS_POOL_PROOF_SCRATCH");
const tlsKey = required("GITHUB_EGRESS_POOL_PROOF_TLS_KEY");
const tlsCert = required("GITHUB_EGRESS_POOL_PROOF_TLS_CERT");
const realGh = required("GITHUB_EGRESS_POOL_PROOF_REAL_GH");
const persistPath = path.join(scratch, "wrangler-state");
const workerLogPath = path.join(scratch, "wrangler.log");
const metricsPath = path.join(scratch, "github-egress.jsonl");
const rateLimitPath = path.join(scratch, "github-rate-limits.jsonl");
const legacyRateLimitPath = path.join(scratch, "github-rate-limit-observations.jsonl");
const proofGh = path.join(scratch, "bin", "gh");
const proofSecret = "disposable-github-egress-pool-proof-secret";
const workers = [];
const requestSummary = { success: 0, throttle: 0 };
const loopbackRequestPaths = [];
const fullPathAuthorizationDigests = [];
const candidateHead = process.env.GITHUB_EGRESS_POOL_PROOF_SOURCE_SHA || (await gitHead());

await mkdir(outputDir, { recursive: true });
await mkdir(path.dirname(proofGh), { recursive: true });
await Promise.all(
  ["proof-summary.json", "public-coordinator-state.json", "wrangler.log"].map((name) =>
    rm(path.join(outputDir, name), { force: true }),
  ),
);
await writeFile(
  proofGh,
  `#!/usr/bin/env bash\nset -euo pipefail\nif [ -n "\${CLAWSWEEPER_PROOF_GH_HOST:-}" ]; then\n  export GH_HOST="$CLAWSWEEPER_PROOF_GH_HOST"\n  export GH_ENTERPRISE_TOKEN="\${GH_TOKEN:-}"\nfi\nexec bash "${repoRoot}/scripts/github-egress-observer.sh" "$@"\n`,
);
await chmod(proofGh, 0o755);

const github = createHttpsServer(
  { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) },
  githubRequest,
);
await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
const githubAddress = github.address();
assert.ok(githubAddress && typeof githubAddress !== "string");
const githubHost = `127.0.0.1:${githubAddress.port}`;
const commonGhEnv = {
  ...process.env,
  GH_HOST: githubHost,
  GH_ENTERPRISE_TOKEN: "disposable-loopback-token",
  SSL_CERT_FILE: tlsCert,
  GH_DEBUG: "",
};

let worker;
try {
  const workerPort = await availablePort();
  worker = await startWorker(workerPort, persistPath, workerLogPath);
  workers.push(worker);
  await waitForWorker(worker.origin);
  let client = coordinatorClient(worker.origin);

  const siblings = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      client.acquire({ callerHash: digest(`initial-sibling:${index}`, 24), declaredBudget: 1 }),
    ),
  );
  assert.equal(
    siblings.every((result) => result.granted),
    true,
  );
  const permits = siblings.map((result) => result.permit);
  assert.equal(new Set(permits.map((permit) => permit.permitId)).size, 8);
  for (const permit of permits.slice(0, 3)) {
    const started = await client.start({ permit, operationIndex: 1 });
    assert.equal(started.started, true);
  }

  const firstThrottle = await githubCommand(1, true);
  assert.notEqual(firstThrottle.status, 0);
  const observedAt = new Date().toISOString();
  const throttleReceipt = digest("initial-throttle-receipt", 64);
  const opened = await client.throttle({
    permit: permits[0],
    operationIndex: 1,
    receiptId: throttleReceipt,
    status: 403,
    observedAt,
    headers: {
      retryAfterPresent: true,
      retryAfterSeconds: 8,
      resetPresent: true,
      resetEpochSeconds: Math.floor((Date.parse(observedAt) + 8_000) / 1_000),
    },
  });
  assert.equal(opened.state, "open");
  assert.equal(opened.epoch, 2);
  assert.equal(opened.resetProvenance, "retry_after");

  const staleStarts = await Promise.all(
    permits.slice(3).map((permit) => client.start({ permit, operationIndex: 1 })),
  );
  assert.equal(
    staleStarts.every((result) => result.started !== true),
    true,
  );
  assert.deepEqual([...new Set(staleStarts.map((result) => result.reason))], ["stale_epoch"]);
  const replayedStaleStart = await client.start({ permit: permits[3], operationIndex: 1 });
  assert.notEqual(replayedStaleStart.started, true);
  assert.equal(replayedStaleStart.reason, "stale_epoch");
  assert.equal(totalRequests(), 1);

  const staleStartedReplay = await client.start({ permit: permits[1], operationIndex: 1 });
  assert.notEqual(staleStartedReplay.started, true);
  assert.equal(staleStartedReplay.reason, "stale_epoch");
  assert.equal((await coordinatorState(worker.origin)).rejected_before_start, 6);

  for (let index = 1; index < 3; index += 1) {
    const result = await githubCommand(index + 1, false);
    assert.equal(result.status, 0);
    await client.finish({
      permit: permits[index],
      operationIndex: 1,
      receiptId: digest(`initial-finish:${index}`, 64),
      outcome: "success",
    });
  }
  assert.equal(totalRequests(), 3);
  await client.throttle({
    permit: permits[0],
    operationIndex: 1,
    receiptId: throttleReceipt,
    status: 403,
    observedAt,
    headers: {
      retryAfterPresent: true,
      retryAfterSeconds: 8,
      resetPresent: true,
      resetEpochSeconds: Math.floor((Date.parse(observedAt) + 8_000) / 1_000),
    },
  });

  const beforeRestart = await coordinatorState(worker.origin);
  assert.equal(beforeRestart.state, "open");
  assert.equal(beforeRestart.epoch, 2);
  assert.equal(beforeRestart.permits_in_flight_at_open, 2);
  assert.equal(beforeRestart.already_on_wire_completions, 2);
  assert.equal(beforeRestart.rejected_before_start, 6);
  assert.equal(beforeRestart.throttle_observations, 1);
  assert.equal(beforeRestart.telemetry_complete, true);

  const completedReplay = await client.start({ permit: permits[1], operationIndex: 1 });
  assert.notEqual(completedReplay.started, true);
  assert.equal(completedReplay.reason, "already_completed");
  assert.equal((await coordinatorState(worker.origin)).rejected_before_start, 6);

  await stopWorker(worker);
  workers.splice(workers.indexOf(worker), 1);
  worker = await startWorker(workerPort, persistPath, workerLogPath, true);
  workers.push(worker);
  await waitForWorker(worker.origin);
  client = coordinatorClient(worker.origin);
  const afterRestart = await coordinatorState(worker.origin);
  for (const field of [
    "state",
    "epoch",
    "blocked_until",
    "reset_provenance",
    "permits_in_flight_at_open",
    "already_on_wire_completions",
    "rejected_before_start",
    "throttle_observations",
    "telemetry_complete",
  ]) {
    assert.deepEqual(afterRestart[field], beforeRestart[field], field);
  }

  await waitUntil(Date.parse(afterRestart.blocked_until) + 150);
  const probeRace = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      client.acquire({ callerHash: digest(`probe-contender:${index}`, 24), declaredBudget: 1 }),
    ),
  );
  const probes = probeRace.filter((result) => result.granted);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].permit.mode, "probe");
  assert.equal(probeRace.filter((result) => !result.granted).length, 7);
  const probePermit = probes[0].permit;
  assert.equal((await client.start({ permit: probePermit, operationIndex: 1 })).started, true);
  assert.equal((await githubCommand(50, false)).status, 0);
  const recovering = await client.finish({
    permit: probePermit,
    operationIndex: 1,
    receiptId: digest("probe-success", 64),
    outcome: "success",
  });
  assert.equal(recovering.state, "recovering");

  const rampTimeline = [];
  let finalCohortRefillRejected = false;
  for (const waveSize of [1, 2, 4, 8]) {
    const wave = await Promise.all(
      Array.from({ length: waveSize }, (_, index) =>
        client.acquire({
          callerHash: digest(`ramp:${waveSize}:${index}`, 24),
          declaredBudget: 1,
        }),
      ),
    );
    assert.equal(
      wave.every((result) => result.granted && result.permit.mode === "ramp"),
      true,
    );
    for (const item of wave) {
      assert.equal((await client.start({ permit: item.permit, operationIndex: 1 })).started, true);
    }
    for (let index = 0; index < wave.length; index += 1) {
      assert.equal((await githubCommand(100 + waveSize * 10 + index, false)).status, 0);
      await client.finish({
        permit: wave[index].permit,
        operationIndex: 1,
        receiptId: digest(`ramp-finish:${waveSize}:${index}`, 64),
        outcome: "success",
      });
      if (waveSize === 8 && index === 0) {
        const replacement = await client.acquire({
          callerHash: digest("final-ramp-replacement", 24),
          declaredBudget: 1,
        });
        assert.equal(replacement.granted, false);
        assert.equal(replacement.reason, "ramp_cohort_full");
        const midFinalWave = await coordinatorState(worker.origin);
        assert.equal(midFinalWave.state, "recovering");
        assert.equal(midFinalWave.ramp.outstanding, 7);
        finalCohortRefillRejected = true;
      }
    }
    const state = await coordinatorState(worker.origin);
    rampTimeline.push({ wave: waveSize, state: state.state, limit: state.ramp.limit });
  }
  assert.deepEqual(rampTimeline, [
    { wave: 1, state: "recovering", limit: 2 },
    { wave: 2, state: "recovering", limit: 4 },
    { wave: 4, state: "recovering", limit: 8 },
    { wave: 8, state: "closed", limit: 8 },
  ]);
  assert.equal(totalRequests(), 19);

  const fullPathWorkerPort = await availablePort();
  const fullPathWorker = await startWorker(
    fullPathWorkerPort,
    path.join(scratch, "wrangler-full-publication-path-state"),
    path.join(scratch, "wrangler-full-publication-path.log"),
  );
  workers.push(fullPathWorker);
  await waitForWorker(fullPathWorker.origin);
  const fullPathBefore = totalRequests();
  const firstFullPath = await fullPublicationPath({
    item: 42,
    runId: "full-path-first",
    workerOrigin: fullPathWorker.origin,
    githubHost,
  });
  assert.notEqual(
    firstFullPath.result.status,
    0,
    JSON.stringify({
      outcome: firstFullPath.outcome,
      stdout: firstFullPath.result.stdout.toString("utf8").slice(-2_000),
      stderr: firstFullPath.result.stderr.toString("utf8").slice(-2_000),
      requests: loopbackRequestPaths.slice(fullPathBefore),
      authorization_digests: fullPathAuthorizationDigests,
      expected_repository_authorization_digests: [
        digest("token disposable-repository-actions-token", 16),
        digest("Bearer disposable-repository-actions-token", 16),
      ],
      expected_target_authorization_digests: [
        digest("token disposable-target-app-token", 16),
        digest("Bearer disposable-target-app-token", 16),
      ],
    }),
  );
  assert.equal(
    firstFullPath.outcome.kind,
    "retryable_failure",
    JSON.stringify({
      outcome: firstFullPath.outcome,
      stdout: firstFullPath.result.stdout.toString("utf8").slice(-2_000),
      stderr: firstFullPath.result.stderr.toString("utf8").slice(-2_000),
      requests: loopbackRequestPaths.slice(fullPathBefore),
      authorization_digests: fullPathAuthorizationDigests,
      expected_repository_authorization_digests: [
        digest("token disposable-repository-actions-token", 16),
        digest("Bearer disposable-repository-actions-token", 16),
      ],
      expected_target_authorization_digests: [
        digest("token disposable-target-app-token", 16),
        digest("Bearer disposable-target-app-token", 16),
      ],
    }),
  );
  assert.equal(firstFullPath.outcome.reasonCode, "github_rate_limit");
  assert.equal(firstFullPath.outcome.attempted, true);
  assert.equal(totalRequests(), fullPathBefore + 1);
  assert.match(loopbackRequestPaths.at(-1), /\/api\/v3\/repos\/openclaw\/openclaw\/issues\/42$/);
  const fullPathOpen = await coordinatorState(fullPathWorker.origin);
  assert.equal(fullPathOpen.state, "open");
  assert.equal(fullPathOpen.epoch, 2);

  const secondFullPath = await fullPublicationPath({
    item: 43,
    runId: "full-path-sibling",
    workerOrigin: fullPathWorker.origin,
    githubHost,
  });
  assert.notEqual(secondFullPath.result.status, 0);
  assert.equal(secondFullPath.outcome.kind, "retryable_failure");
  assert.equal(secondFullPath.outcome.reasonCode, "github_rate_limit");
  assert.equal(secondFullPath.outcome.attempted, false);
  assert.equal(totalRequests(), fullPathBefore + 1);
  assert.equal(
    loopbackRequestPaths.some((requestPath) => requestPath.endsWith("/issues/43")),
    false,
  );
  assert.match(secondFullPath.result.stderr.toString("utf8"), /rate limited until/i);
  const fullPathState = await coordinatorState(fullPathWorker.origin);
  assert.equal(fullPathState.rejected_before_start, 1);
  await stopWorker(fullPathWorker);
  workers.splice(workers.indexOf(fullPathWorker), 1);

  const artifactWorkerPort = await availablePort();
  const artifactWorker = await startWorker(
    artifactWorkerPort,
    path.join(scratch, "wrangler-artifact-download-state"),
    path.join(scratch, "wrangler-artifact-download.log"),
  );
  workers.push(artifactWorker);
  await waitForWorker(artifactWorker.origin);
  const artifactRoot = path.join(scratch, "artifact-download");
  const artifactRateLimitPath = path.join(artifactRoot, "github-rate-details.jsonl");
  const artifactObservationPath = path.join(artifactRoot, "github-rate-observations.jsonl");
  await mkdir(artifactRoot, { recursive: true });
  const artifactEnv = {
    ...commonGhEnv,
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_prepare",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: "exact_review_artifact_publish",
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "1",
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: "false",
    CLAWSWEEPER_GITHUB_OBSERVER_ROOT: repoRoot,
    CLAWSWEEPER_REAL_GH_BIN: realGh,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: path.join(artifactRoot, "github-egress.jsonl"),
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: artifactRateLimitPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: artifactObservationPath,
    EXACT_REVIEW_QUEUE_URL: artifactWorker.origin,
    CLAWSWEEPER_WEBHOOK_SECRET: proofSecret,
    GITHUB_REPOSITORY: "pool-owner/pool-repo",
    GITHUB_RUN_ID: "artifact-download-first",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const artifactBefore = totalRequests();
  const artifactThrottle = await runGithubEgressPoolCommand(
    proofGh,
    [
      "run",
      "download",
      "777",
      "--repo",
      "pool-owner/pool-repo",
      "--name",
      "synthetic-artifact",
      "--dir",
      path.join(artifactRoot, "first"),
    ],
    { env: artifactEnv },
  );
  assert.equal(artifactThrottle.deferred, false);
  assert.notEqual(artifactThrottle.code, 0);
  assert.match(artifactThrottle.stderr.toString("utf8"), /API rate limit exceeded/i);
  assert.equal(totalRequests(), artifactBefore + 1);
  assert.match(loopbackRequestPaths.at(-1), /\/actions\/runs\/777\/artifacts$/);
  const artifactOpen = await coordinatorState(artifactWorker.origin);
  assert.equal(artifactOpen.state, "open");
  assert.equal(artifactOpen.epoch, 2);
  const artifactSibling = await runGithubEgressPoolCommand(
    proofGh,
    [
      "run",
      "download",
      "778",
      "--repo",
      "pool-owner/pool-repo",
      "--name",
      "synthetic-artifact",
      "--dir",
      path.join(artifactRoot, "sibling"),
    ],
    { env: { ...artifactEnv, GITHUB_RUN_ID: "artifact-download-sibling" } },
  );
  assert.equal(artifactSibling.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
  assert.equal(artifactSibling.deferred, true);
  assert.equal(totalRequests(), artifactBefore + 1);
  assert.equal(
    loopbackRequestPaths.some((requestPath) => requestPath.endsWith("/actions/runs/778/artifacts")),
    false,
  );
  await stopWorker(artifactWorker);
  workers.splice(workers.indexOf(artifactWorker), 1);

  const confirmationWorkerPort = await availablePort();
  const confirmationWorker = await startWorker(
    confirmationWorkerPort,
    path.join(scratch, "wrangler-terminal-confirmation-state"),
    path.join(scratch, "wrangler-terminal-confirmation.log"),
  );
  workers.push(confirmationWorker);
  await waitForWorker(confirmationWorker.origin);
  const confirmationRoot = path.join(scratch, "terminal-confirmation");
  const confirmationOutcomePath = path.join(confirmationRoot, "coordinator-outcome.json");
  await mkdir(confirmationRoot, { recursive: true });
  const confirmationEnv = {
    ...commonGhEnv,
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_apply",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: "exact_review_artifact_publish",
    CLAWSWEEPER_GITHUB_COORDINATOR_OUTCOME_PATH: confirmationOutcomePath,
    CLAWSWEEPER_GITHUB_OBSERVER_ROOT: repoRoot,
    CLAWSWEEPER_REAL_GH_BIN: realGh,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: path.join(confirmationRoot, "github-egress.jsonl"),
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: path.join(
      confirmationRoot,
      "github-rate-details.jsonl",
    ),
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: path.join(
      confirmationRoot,
      "github-rate-observations.jsonl",
    ),
    EXACT_REVIEW_QUEUE_URL: confirmationWorker.origin,
    CLAWSWEEPER_WEBHOOK_SECRET: proofSecret,
    GITHUB_REPOSITORY: "pool-owner/pool-repo",
    TARGET_REPO: "openclaw/openclaw",
    GITHUB_RUN_ID: "terminal-confirmation-first",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const confirmationBefore = totalRequests();
  const confirmationThrottle = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/openclaw/openclaw/issues/97", "--jq", ".state"],
    { env: confirmationEnv },
  );
  assert.notEqual(confirmationThrottle.code, 0);
  assert.equal(confirmationThrottle.deferred, false);
  assert.match(confirmationThrottle.stderr.toString("utf8"), /synthetic forbidden/i);
  assert.doesNotMatch(confirmationThrottle.stderr.toString("utf8"), /rate limit/i);
  assert.deepEqual(JSON.parse(await readFile(confirmationOutcomePath, "utf8")), {
    attempted: true,
    rateLimited: true,
  });
  assert.equal(totalRequests(), confirmationBefore + 1);
  assert.equal((await coordinatorState(confirmationWorker.origin)).state, "open");
  const confirmationSibling = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/openclaw/openclaw/issues/96", "--jq", ".state"],
    { env: { ...confirmationEnv, GITHUB_RUN_ID: "terminal-confirmation-sibling" } },
  );
  assert.equal(confirmationSibling.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
  assert.equal(confirmationSibling.deferred, true);
  assert.equal(totalRequests(), confirmationBefore + 1);
  await stopWorker(confirmationWorker);
  workers.splice(workers.indexOf(confirmationWorker), 1);

  const attemptedOutcomePath = path.join(scratch, "attempted-outcome.json");
  const deferredOutcomePath = path.join(scratch, "deferred-outcome.json");
  const rollbackOutcomePath = path.join(scratch, "rollback-outcome.json");
  const acknowledgementLossOutcomePath = path.join(scratch, "acknowledgement-loss-outcome.json");
  const coordinatorOutcomePath = path.join(scratch, "coordinator-outcome.json");
  await writeFile(attemptedOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  await writeFile(deferredOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  await writeFile(rollbackOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  await writeFile(acknowledgementLossOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  const runnerEnv = {
    ...commonGhEnv,
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_router",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: "exact_review_batch_publish",
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "2",
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: "false",
    CLAWSWEEPER_GITHUB_OBSERVER_ROOT: repoRoot,
    CLAWSWEEPER_REAL_GH_BIN: realGh,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: metricsPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: rateLimitPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: legacyRateLimitPath,
    CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: attemptedOutcomePath,
    CLAWSWEEPER_GITHUB_COORDINATOR_OUTCOME_PATH: coordinatorOutcomePath,
    EXACT_REVIEW_QUEUE_URL: worker.origin,
    CLAWSWEEPER_WEBHOOK_SECRET: proofSecret,
    GITHUB_REPOSITORY: "pool-owner/pool-repo",
    TARGET_REPO: "proof-owner/proof-repo",
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "1",
  };
  let throttleAcknowledgementAttempts = 0;
  const beforeAcknowledgementLoss = totalRequests();
  const acknowledgementLoss = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/proof-owner/proof-repo/issues/98/comments"],
    {
      env: {
        ...runnerEnv,
        CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: acknowledgementLossOutcomePath,
        GITHUB_RUN_ID: "9000",
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/throttle")) {
          throttleAcknowledgementAttempts += 1;
          return new Response("synthetic coordinator acknowledgement loss", { status: 503 });
        }
        return fetch(request);
      },
    },
  );
  assert.equal(acknowledgementLoss.deferred, false);
  assert.notEqual(acknowledgementLoss.code, 0);
  assert.match(acknowledgementLoss.stderr.toString("utf8"), /API rate limit exceeded/i);
  assert.equal(totalRequests(), beforeAcknowledgementLoss + 1);
  assert.equal(throttleAcknowledgementAttempts, 2);
  assert.equal(
    JSON.parse(await readFile(acknowledgementLossOutcomePath, "utf8")).postEffectsGithubAttempted,
    true,
  );
  const acknowledgementLossObservations = jsonLines(await readFile(legacyRateLimitPath, "utf8"));
  assert.equal(acknowledgementLossObservations.length, 1);
  assert.equal(acknowledgementLossObservations[0].scope, "repository_actions");
  assert.equal(acknowledgementLossObservations[0].provenance, "fallback");
  assert.equal(acknowledgementLossObservations[0].authoritative, false);
  assert.equal(acknowledgementLossObservations[0].coordinator_deferred, false);
  assert.equal(
    Date.parse(acknowledgementLossObservations[0].retry_at) -
      Date.parse(acknowledgementLossObservations[0].observed_at),
    5 * 60_000,
  );
  const stillClosedAfterAcknowledgementLoss = await coordinatorState(worker.origin);
  assert.equal(stillClosedAfterAcknowledgementLoss.state, "closed");

  const runnerThrottle = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/proof-owner/proof-repo/issues/99/comments"],
    { env: runnerEnv },
  );
  assert.equal(runnerThrottle.deferred, false);
  assert.notEqual(runnerThrottle.code, 0);
  assert.match(runnerThrottle.stderr.toString("utf8"), /synthetic forbidden/i);
  assert.doesNotMatch(runnerThrottle.stderr.toString("utf8"), /rate limit/i);
  assert.deepEqual(JSON.parse(await readFile(coordinatorOutcomePath, "utf8")), {
    attempted: true,
    rateLimited: true,
  });
  assert.equal(
    JSON.parse(await readFile(attemptedOutcomePath, "utf8")).postEffectsGithubAttempted,
    true,
  );
  const rateDetails = jsonLines(await readFile(rateLimitPath, "utf8"));
  assert.ok(rateDetails.length >= 1);
  assert.equal(rateDetails.at(-1).poolClass, "repository_actions");
  assert.equal(rateDetails.at(-1).status, 403);
  const runnerOpen = await coordinatorState(worker.origin);
  if (runnerOpen.state !== "open") {
    const legacyObservations = jsonLines(
      await readFile(legacyRateLimitPath, "utf8").catch(() => ""),
    );
    throw new Error(
      `runner throttle acknowledgement failed: ${JSON.stringify({
        state: runnerOpen.state,
        epoch: runnerOpen.epoch,
        rate_detail_count: rateDetails.length,
        rate_detail_authority: rateDetails.at(-1).resetAuthorityCandidate,
        legacy_observation_count: legacyObservations.length,
      })}`,
    );
  }
  assert.equal(runnerOpen.epoch, 3);
  assert.equal(runnerOpen.reset_provenance, "fallback");
  assert.equal(runnerOpen.reset_authoritative, false);

  const beforeDeferred = totalRequests();
  const deferred = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/proof-owner/proof-repo/issues/200/comments"],
    {
      env: {
        ...runnerEnv,
        CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: deferredOutcomePath,
        GITHUB_RUN_ID: "9002",
      },
    },
  );
  assert.equal(deferred.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
  assert.equal(deferred.deferred, true);
  assert.equal(totalRequests(), beforeDeferred);
  assert.equal(
    JSON.parse(await readFile(deferredOutcomePath, "utf8")).postEffectsGithubAttempted,
    undefined,
  );

  const targetApp = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/proof-owner/proof-repo/issues/201/comments"],
    {
      env: {
        ...runnerEnv,
        CLAWSWEEPER_GITHUB_POOL_CLASS: "target_app",
        GITHUB_RUN_ID: "9003",
      },
    },
  );
  assert.equal(targetApp.code, 0);
  assert.equal(targetApp.deferred, false);

  const detailIsolationOutcomePath = path.join(scratch, "detail-isolation-outcome.json");
  await writeFile(detailIsolationOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  const detailWorkerPort = await availablePort();
  const detailWorker = await startWorker(
    detailWorkerPort,
    path.join(scratch, "wrangler-detail-isolation-state"),
    path.join(scratch, "wrangler-detail-isolation.log"),
  );
  workers.push(detailWorker);
  await waitForWorker(detailWorker.origin);
  const beforeDetailIsolationFailure = totalRequests();
  const detailIsolationFailure = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/proof-owner/proof-repo/issues/203/comments"],
    {
      env: {
        ...runnerEnv,
        CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: detailIsolationOutcomePath,
        EXACT_REVIEW_QUEUE_URL: detailWorker.origin,
        GITHUB_RUN_ID: "9005",
      },
      isolateRateLimitDetails: () => null,
    },
  );
  assert.equal(detailIsolationFailure.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
  assert.equal(detailIsolationFailure.deferred, true);
  assert.equal(totalRequests(), beforeDetailIsolationFailure);
  assert.equal(
    JSON.parse(await readFile(detailIsolationOutcomePath, "utf8")).postEffectsGithubAttempted,
    undefined,
  );
  const detailIsolationState = await coordinatorState(detailWorker.origin);
  assert.equal(detailIsolationState.permits_in_flight, 0);
  assert.equal(detailIsolationState.state, "closed");
  await stopWorker(detailWorker);
  workers.splice(workers.indexOf(detailWorker), 1);

  const rollback = await runGithubEgressPoolCommand(
    proofGh,
    ["api", "repos/proof-owner/proof-repo/issues/202/comments"],
    {
      env: {
        ...runnerEnv,
        CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "false",
        CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: rollbackOutcomePath,
        GITHUB_RUN_ID: "9004",
      },
    },
  );
  assert.equal(rollback.code, 0);
  assert.equal(rollback.deferred, false);
  assert.equal(
    JSON.parse(await readFile(rollbackOutcomePath, "utf8")).postEffectsGithubAttempted,
    true,
  );
  const runnerTermination = await proveRunnerTermination();

  const finalState = await coordinatorState(worker.origin);
  assert.equal(finalState.state, "open");
  assert.equal(finalState.epoch, 3);
  assert.equal(finalState.already_on_wire_completions, 2);
  assert.ok(finalState.rejected_before_start >= 13);
  assert.equal(finalState.telemetry_complete, true);
  privacyScan(JSON.stringify(finalState));

  const summary = {
    schema: "github-egress-pool-coordinator-proof/v1",
    generated_at: new Date().toISOString(),
    candidate_head: candidateHead,
    runtime: {
      node: process.version,
      gh: (await command(realGh, ["--version"], commonGhEnv)).stdout
        .toString("utf8")
        .split("\n")[0],
      worker: "wrangler 4.107.0 dev --local",
      durable_object: "SQLite-backed GithubEgressPoolCoordinator",
      transport: "real loopback TLS GitHub CLI and HTTP Worker sockets",
    },
    assertions: {
      sibling_permits: 8,
      started_at_first_throttle: 3,
      rejected_before_start_at_first_throttle: 5,
      replayed_rejection_counter_idempotent: true,
      stale_started_replay_rejected: true,
      completed_after_open: 2,
      loopback_requests_before_reset: 3,
      restart_state_preserved: true,
      reset_contenders: 8,
      probes_granted: 1,
      ramp_timeline: rampTimeline,
      final_ramp_cohort_refill_rejected: finalCohortRefillRejected,
      full_artifact_to_apply_path_throttle_opened_pool: true,
      full_artifact_to_apply_sibling_attempted_false: true,
      full_artifact_to_apply_sibling_requests_avoided: 1,
      real_artifact_download_first_throttle_opened_pool: true,
      real_artifact_download_sibling_requests_avoided: 1,
      terminal_confirmation_first_throttle_opened_pool: true,
      terminal_confirmation_header_only_classification: true,
      terminal_confirmation_sibling_requests_avoided: 1,
      target_app_mutations_remain_outside_repository_pool: true,
      runner_termination: runnerTermination,
      runner_acknowledgement_loss_fallback: true,
      runner_over_horizon_fallback: true,
      header_classified_throttle_sidecar: true,
      attempted_member_receipt_written: true,
      deferred_member_receipt_absent: true,
      next_runner_avoided: true,
      target_app_independent: true,
      disabled_rollback_reaches_egress: true,
      disabled_rollback_preserves_attempt_accounting: true,
      detail_isolation_failure_requests_avoided: 1,
      public_privacy_scan_passed: true,
    },
    request_summary: requestSummary,
    final_public_state: finalState,
    production_mutations: 0,
    openclaw_bay_affected: false,
    run_status: "succeeded",
    limits: [
      "Synthetic loopback GitHub responses, not live GitHub quota consumption.",
      "The real gh run download proof classifies its loopback 403 from bounded stderr because binary archive transport intentionally suppresses GH_DEBUG; its opaque internal request count remains Phase 0 telemetry scope.",
      "The full-path fixture reaches publish-event-result -> apply-decisions and proves the first repository-token public read opens the pool; mutation credential separation is asserted structurally and by the independent target_app runner boundary.",
      "The terminal-state confirmation proof uses the real gh issue-state read with generic forbidden stderr; bounded headers open the pool and the next confirmation is rejected before wire.",
      "Fake-time unit tests cover headerless jitter, throttled probes and ramps, completed non-throttled failures, unexecuted failures, expiry, and other-pool state isolation.",
      "Durable attempted=false and retry/DLQ conservation are covered by focused publication CLI tests.",
    ],
  };
  await writeFile(
    path.join(outputDir, "public-coordinator-state.json"),
    `${JSON.stringify(finalState, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "proof-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await Promise.all(workers.map(stopWorker));
  await new Promise((resolve) => github.close(resolve));
  const workerLog = await readFile(workerLogPath, "utf8").catch(() => "");
  await writeFile(
    path.join(outputDir, "wrangler.log"),
    workerLog.replaceAll(proofSecret, "[redacted-local-proof-secret]").slice(0, 64_000),
  );
}

function githubRequest(request, response) {
  const url = new URL(request.url || "/", "https://loopback.invalid");
  loopbackRequestPaths.push(url.pathname);
  const authorization = String(request.headers.authorization || "");
  if (url.pathname.endsWith("/issues/42")) {
    fullPathAuthorizationDigests.push(digest(authorization, 16));
  }
  const fullPathRepositoryRead =
    url.pathname.endsWith("/issues/42") &&
    authorization.includes("disposable-repository-actions-token");
  const throttled =
    url.pathname.endsWith("/issues/1/comments") ||
    url.pathname.endsWith("/issues/98/comments") ||
    url.pathname.endsWith("/issues/99/comments") ||
    url.pathname.endsWith("/issues/97") ||
    url.pathname.endsWith("/actions/runs/777/artifacts") ||
    fullPathRepositoryRead;
  const overHorizon =
    url.pathname.endsWith("/issues/99/comments") || url.pathname.endsWith("/issues/97");
  const commonHeaders = {
    "content-type": "application/json",
    etag: '"synthetic-etag-secret"',
    "x-github-request-id": "synthetic-request-id-secret",
    "x-ratelimit-limit": "15000",
    "x-ratelimit-resource": "core",
  };
  if (throttled) {
    const retrySeconds = fullPathRepositoryRead ? 120 : overHorizon ? 7201 : 8;
    requestSummary.throttle += 1;
    response.writeHead(403, {
      ...commonHeaders,
      "retry-after": String(retrySeconds),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-used": "15000",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + retrySeconds),
    });
    response.end(
      JSON.stringify({
        message: overHorizon
          ? "synthetic forbidden"
          : "API rate limit exceeded for synthetic proof",
      }),
    );
    return;
  }
  requestSummary.success += 1;
  response.writeHead(200, {
    ...commonHeaders,
    "x-ratelimit-remaining": "14999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  });
  response.end(JSON.stringify([{ id: 1, body: "synthetic body secret" }]));
}

async function fullPublicationPath({ item, runId, workerOrigin, githubHost }) {
  const root = path.join(scratch, runId);
  const artifactDir = path.join(root, "artifacts", "event");
  const outcomePath = path.join(root, "batch-outcome.json");
  const outputPath = path.join(root, "github-output.txt");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, `${item}.md`), publicationProofReport(item));
  const env = {
    ...process.env,
    PATH: `${path.dirname(proofGh)}:${process.env.PATH || ""}`,
    HOME: root,
    GH_CONFIG_DIR: path.join(root, "gh-config"),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "0",
    SSL_CERT_FILE: tlsCert,
    CLAWSWEEPER_PROOF_GH_HOST: githubHost,
    CLAWSWEEPER_CODE_ROOT: repoRoot,
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
    CLAWSWEEPER_GH_RETRY_ATTEMPTS: "2",
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_OBSERVER_ROOT: repoRoot,
    CLAWSWEEPER_REAL_GH_BIN: realGh,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: path.join(root, "github-egress.jsonl"),
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: path.join(root, "github-rate-details.jsonl"),
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: path.join(
      root,
      "github-rate-observations.jsonl",
    ),
    CLAWSWEEPER_GITHUB_STAGE: "publication_apply",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: "exact_review_artifact_publish",
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "1",
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: "false",
    CLAWSWEEPER_WEBHOOK_SECRET: proofSecret,
    EXACT_REVIEW_QUEUE_URL: workerOrigin,
    EXACT_EVENT_PUBLICATION: "true",
    EXACT_REVIEW_BATCH_MUTATION_OUTPUT: outcomePath,
    EXACT_REVIEW_BATCH_ITEM_KEY: `openclaw/openclaw#${item}:proof`,
    EXACT_REVIEW_BATCH_REVISION: "1",
    EXACT_REVIEW_BATCH_CLAIM_GENERATION: "1",
    EXACT_REVIEW_WORK_ROOT: root,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REPOSITORY: "pool-owner/pool-repo",
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "disposable-target-app-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "disposable-repository-actions-token",
    REPO_TOKEN: "disposable-repository-actions-token",
    ITEM_NUMBER: String(item),
    TARGET_REPO: "openclaw/openclaw",
  };
  delete env.GH_HOST;
  delete env.GH_ENTERPRISE_TOKEN;
  const result = await command(
    process.execPath,
    [path.join(repoRoot, "dist", "repair", "publish-event-result.js")],
    env,
    true,
    root,
  );
  return { result, outcome: JSON.parse(await readFile(outcomePath, "utf8")) };
}

function publicationProofReport(item) {
  return [
    "---",
    `number: ${item}`,
    "repository: openclaw/openclaw",
    "type: issue",
    "review_status: complete",
    "local_checkout_access: verified",
    "decision: keep_open",
    "action_taken: kept_open",
    `item_snapshot_hash: full-path-proof-${item}`,
    `reviewed_at: ${new Date().toISOString()}`,
    "---",
    "",
    "# Full artifact-to-apply pool proof",
    "",
  ].join("\n");
}

function githubCommand(item, throttle) {
  return command(
    realGh,
    ["api", `repos/proof-owner/proof-repo/issues/${item}/comments`],
    commonGhEnv,
    throttle,
  );
}

function coordinatorClient(origin) {
  return new GithubEgressPoolCoordinatorClient({ baseUrl: origin, webhookSecret: proofSecret });
}

async function coordinatorState(origin) {
  const response = await fetch(`${origin}/api/github-egress-pool-coordinator`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function command(executable, args, env, allowFailure = false, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = {
        status: status ?? 128,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (!allowFailure && (status !== 0 || signal)) {
        reject(
          new Error(`${executable} ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`),
        );
      } else resolve(result);
    });
  });
}

async function proveRunnerTermination() {
  const root = path.join(scratch, "runner-termination");
  const fakeGh = path.join(root, "gh");
  const startedPath = path.join(root, "started");
  const terminatedPath = path.join(root, "terminated");
  await mkdir(root, { recursive: true });
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.once("SIGTERM", () => {
  writeFileSync(process.env.CLAWSWEEPER_PROOF_TERMINATED_PATH, "SIGTERM\\n");
  process.exit(0);
});
writeFileSync(process.env.CLAWSWEEPER_PROOF_STARTED_PATH, String(process.pid));
setInterval(() => {}, 1_000);
`,
  );
  await chmod(fakeGh, 0o755);
  const runner = spawn(
    process.execPath,
    [path.join(repoRoot, "dist/repair/github-egress-pool-runner.js"), "--", fakeGh],
    {
      env: {
        ...process.env,
        CLAWSWEEPER_PROOF_STARTED_PATH: startedPath,
        CLAWSWEEPER_PROOF_TERMINATED_PATH: terminatedPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderr = [];
  runner.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = new Promise((resolve, reject) => {
    runner.once("error", reject);
    runner.once("close", (status, signal) => resolve({ status, signal }));
  });
  try {
    await waitForFile(startedPath);
    assert.equal(runner.kill("SIGTERM"), true);
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Runner did not exit after SIGTERM")), 5_000),
      ),
    ]);
    await waitForFile(terminatedPath);
    assert.deepEqual(outcome, { status: 1, signal: null }, Buffer.concat(stderr).toString("utf8"));
    assert.equal((await readFile(terminatedPath, "utf8")).trim(), "SIGTERM");
    return {
      wrapper_exit_code: outcome.status,
      wrapper_exit_signal: outcome.signal,
      child_signal_receipt: "SIGTERM",
    };
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
  }
}

async function startWorker(port, persist, logPath, append = false) {
  const log = createWriteStream(logPath, { flags: append ? "a" : "w" });
  const child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.107.0",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--config",
      "dashboard/wrangler.toml",
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${proofSecret}`,
      "--var",
      "CLAWSWEEPER_REPO:pool-owner/pool-repo",
      "--var",
      "GITHUB_EGRESS_POOL_MAX_PERMITS:8",
      "--var",
      "GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS:5000",
      "--var",
      "GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS:60000",
      "--var",
      "GITHUB_EGRESS_POOL_FALLBACK_BASE_MS:60000",
      "--var",
      "GITHUB_EGRESS_POOL_FALLBACK_MAX_MS:600000",
      "--var",
      "GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO:0",
    ],
    {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, log, origin: `http://127.0.0.1:${port}` };
}

async function waitForWorker(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker did not become ready: ${origin}`);
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function stopWorker(activeWorker) {
  if (!activeWorker?.child) return;
  signalProcessTree(activeWorker.child, "SIGTERM");
  if (activeWorker.child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => activeWorker.child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  signalProcessTree(activeWorker.child, "SIGKILL");
  await new Promise((resolve) => activeWorker.log.end(resolve));
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitUntil(timestamp) {
  const delay = timestamp - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function privacyScan(serialized) {
  for (const sentinel of [
    "proof-owner",
    "proof-repo",
    "pool-owner",
    "pool-repo",
    "synthetic-etag-secret",
    "synthetic-request-id-secret",
    "synthetic body secret",
    "disposable-loopback-token",
    "/issues/",
    "https://127.0.0.1",
  ]) {
    assert.equal(serialized.includes(sentinel), false, `privacy sentinel: ${sentinel}`);
  }
}

function totalRequests() {
  return requestSummary.success + requestSummary.throttle;
}

function jsonLines(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function digest(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function gitHead() {
  const result = await command("git", ["rev-parse", "HEAD"], process.env);
  return result.stdout.toString("utf8").trim();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
