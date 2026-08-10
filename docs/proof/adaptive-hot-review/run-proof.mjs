#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const outputDir = path.resolve(process.env.PROOF_OUTPUT || ".artifacts/adaptive-hot-review");
const expectedHead = process.env.PROOF_SOURCE_SHA;
const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const secret = "synthetic-adaptive-hot-proof-secret";
const workerPort = Number(process.env.PROOF_PORT || 8797);
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const persistence = await mkdtemp(path.join(os.tmpdir(), "adaptive-hot-review-proof-"));

assert.ok(expectedHead, "PROOF_SOURCE_SHA is required");
assert.equal(actualHead, expectedHead, "proof must run from the recorded exact head");
await mkdir(outputDir, { recursive: true });

let worker;
try {
  worker = await startWorker("initial");

  const now = new Date();
  const observedAt = now.toISOString();
  const windowStartedAt = new Date(now.getTime() - 60 * 60_000).toISOString();
  const observation = plannerObservation({ observedAt, windowStartedAt });
  const unsigned = await fetch(new URL("/internal/adaptive-hot-review/observation", workerOrigin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(observation),
  });
  assert.equal(unsigned.status, 401);

  await signedRequest("/internal/adaptive-hot-review/observation", "POST", observation, 202);
  await signedRequest("/internal/adaptive-hot-review/observation", "POST", observation, 202);

  const planned = decisionRecord({ observedAt, status: "planned" });
  const dispatched = decisionRecord({ observedAt, status: "dispatched" });
  await signedRequest("/internal/adaptive-hot-review/decision", "POST", planned, 202);
  await signedRequest("/internal/adaptive-hot-review/decision", "POST", dispatched, 202);
  await signedRequest("/internal/adaptive-hot-review/decision", "POST", dispatched, 202);

  const reservationId = "900001:1:hot-intake";
  const cursorUpdates = [
    { mode: "hot-intake", next_cursor: 4, expected_revision: 0 },
    { mode: "adaptive-hot-review", next_cursor: 2, expected_revision: 0 },
    { mode: "adaptive-hot-review-probe", next_cursor: 1, expected_revision: 0 },
  ];
  const reserved = await signedJson(
    "/internal/state/cursors/adaptive-hot-reservation",
    "PUT",
    { reservation_id: reservationId, cursors: cursorUpdates },
    202,
  );
  assert.equal(reserved.reservation_id, reservationId);
  await assertCursors(cursorUpdates, 0, 0);

  await stopWorker(worker);
  worker = await startWorker("after-reservation-restart");

  const beforeCommitSnapshot = await publicSnapshot();
  assertAdaptiveSnapshot(beforeCommitSnapshot, 1, 1);
  await assertCursors(cursorUpdates, 0, 0);

  const committed = await signedJson(
    "/internal/state/cursors/adaptive-hot-reservation/commit",
    "PUT",
    { reservation_id: reservationId },
    202,
  );
  assert.deepEqual(
    committed.cursors.map(({ mode, next_cursor, revision }) => ({ mode, next_cursor, revision })),
    cursorUpdates.map(({ mode, next_cursor }) => ({ mode, next_cursor, revision: 1 })),
  );
  assert.equal(new Set(committed.cursors.map((cursor) => cursor.updated_at)).size, 1);

  await stopWorker(worker);
  worker = await startWorker("after-commit-restart");

  const retriedCommit = await signedJson(
    "/internal/state/cursors/adaptive-hot-reservation/commit",
    "PUT",
    { reservation_id: reservationId },
    202,
  );
  assert.deepEqual(retriedCommit, committed);
  await assertCursors(cursorUpdates, undefined, 1);

  const reusedReservation = await fetchSigned(
    "/internal/state/cursors/adaptive-hot-reservation",
    "PUT",
    {
      reservation_id: reservationId,
      cursors: cursorUpdates.map((cursor) => ({
        ...cursor,
        next_cursor: cursor.next_cursor + 1,
        expected_revision: 1,
      })),
    },
  );
  assert.equal(reusedReservation.status, 409);
  assert.deepEqual(await reusedReservation.json(), {
    error: "adaptive_hot_cursor_reservation_already_committed",
  });

  const finalSnapshot = await publicSnapshot();
  assertAdaptiveSnapshot(finalSnapshot, 1, 1);
  const publicJson = JSON.stringify(finalSnapshot);
  assert.equal(publicJson.includes(secret), false);
  assert.equal(publicJson.includes(persistence), false);
  assert.equal(publicJson.includes("adaptive-hot-review-proof-"), false);

  const summary = {
    schema_version: 1,
    source_sha: actualHead,
    runtime: {
      worker: "local Wrangler",
      durable_object: "persisted SQLite ExactReviewQueue",
      restarts: 2,
      invalid_signature_status: unsigned.status,
    },
    telemetry: {
      duplicate_observations_sent: 2,
      stored_observations: finalSnapshot.adaptive_hot_review.observations.length,
      planned_and_duplicate_dispatched_decisions_sent: 3,
      stored_decisions: finalSnapshot.adaptive_hot_review.decisions.length,
      final_decision_status: finalSnapshot.adaptive_hot_review.decisions[0].status,
    },
    cursor_commit: {
      reservation_id: reservationId,
      precommit_cursors_unchanged: true,
      committed_cursors: committed.cursors.map(({ mode, next_cursor, revision }) => ({
        mode,
        next_cursor,
        revision,
      })),
      retry_after_restart_identical: true,
      committed_identity_reuse_status: reusedReservation.status,
    },
    public_snapshot: {
      bounded_observations: finalSnapshot.adaptive_hot_review.observations.length <= 100,
      bounded_decisions: finalSnapshot.adaptive_hot_review.decisions.length <= 100,
      secret_absent: true,
      persistence_path_absent: true,
    },
    result: "PASS",
  };
  await writeFile(
    path.join(outputDir, "proof-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "runtime-transcript.md"),
    [
      "# Adaptive scheduled hot-review runtime transcript",
      "",
      `- Exact head: ${actualHead}.`,
      `- Auth boundary: unsigned observation returned HTTP ${unsigned.status}.`,
      "- Telemetry: duplicate observation and decision receipts collapsed to one durable record each across a restart.",
      "- Cursor fencing: reservation left all three cursors at revision 0 until the post-restart commit.",
      "- Atomic commit: all three cursors advanced to revision 1 with one timestamp.",
      "- Lost-response retry: the same commit receipt was returned after a second restart.",
      `- One-shot identity: reusing the committed reservation ID returned HTTP ${reusedReservation.status}.`,
      "- Public snapshot: bounded output omitted the synthetic secret and disposable persistence path.",
      "",
      "RESULT: PASS",
      "",
    ].join("\n"),
  );

  console.log(`exact head: ${actualHead}`);
  console.log(`auth boundary: HTTP ${unsigned.status}`);
  console.log("telemetry persistence: 1 observation, 1 dispatched decision after restart");
  console.log("cursor fencing: unchanged before commit; 3 cursors advanced atomically");
  console.log("commit retry after second restart: identical durable receipt");
  console.log(`committed reservation identity reuse: HTTP ${reusedReservation.status}`);
  console.log("public snapshot: bounded and sanitized");
  console.log("RESULT: PASS");
} finally {
  await stopWorker(worker);
  await rm(persistence, { recursive: true, force: true });
}

function plannerObservation({ observedAt, windowStartedAt }) {
  return {
    schemaVersion: "adaptive-hot-review-planner-observation/v1",
    observationId: "900001:1:hot_intake:example/alpha",
    policyVersion: "adaptive-hot-v1",
    runId: "900001",
    runAttempt: 1,
    targetRepo: "example/alpha",
    lane: "hot_intake",
    observedAt,
    windowStartedAt,
    eligibleDue: 4,
    selected: 2,
    offered: 2,
    attempted: 2,
    admitted: 1,
    deduped: 1,
    shed: 0,
    deferred: 0,
    rejected: 0,
    throttled: 0,
    sourceNovelDue: 1,
    oldestDueAt: windowStartedAt,
    oldestUnservedAt: windowStartedAt,
  };
}

function decisionRecord({ observedAt, status }) {
  return {
    schemaVersion: "adaptive-hot-review-decision-record/v1",
    decisionId: "900001:1:hot-intake",
    runId: "900001",
    runAttempt: 1,
    observedAt,
    requestedMode: "shadow",
    effectiveMode: "shadow",
    status,
    policyVersion: "adaptive-hot-v1",
    killSwitch: false,
    activationApproval: "none",
    rolloutPercent: 100,
    canaryRepositories: [],
    reason: "shadow_comparison",
    legacyCursor: { input: 0, next: 1 },
    adaptiveCursor: { input: 0, next: 1 },
    adaptiveProbeCursor: { input: 0, next: 0 },
    actual: [{ targetRepo: "example/alpha", candidateCapacity: 50, source: "legacy" }],
    proposed: {
      schemaVersion: "adaptive-hot-allocation-decision/v1",
      policyVersion: "adaptive-hot-v1",
      status: "allocated",
      serviceCapacity: 10,
      offerBudget: 15,
      perRepositoryLimit: 3,
      repositoryLimit: 20,
      repositoriesConsidered: 1,
      credentialBlockedRepositories: 0,
      unknownProbeCount: 0,
      allocations: [
        {
          targetRepo: "example/alpha",
          candidateCapacity: 3,
          initialReason: "ordinary_demand",
          observationStatus: "fresh",
        },
      ],
      allocationTrace: [
        {
          sequence: 1,
          targetRepo: "example/alpha",
          reason: "ordinary_demand",
          candidateNumber: 1,
        },
      ],
      unusedOfferBudget: 12,
      inputCursor: 0,
      nextCursor: 1,
      cursorAdvanced: true,
      inputProbeCursor: 0,
      nextProbeCursor: 0,
      probeCursorAdvanced: false,
    },
    control: {
      queueCapabilityAvailable: true,
      availableCandidateCapacity: 10,
      globalTokenBalance: 10,
      hotTokenBalance: 10,
      scheduledAdmissionThrottled: false,
      repositoryObservationsAvailable: true,
      activeCredentialCircuits: [],
      githubRequestMetricsUpdatedAt: null,
    },
    comparison: {
      legacyRepositoryCount: 1,
      legacyOfferBudget: 50,
      adaptiveRepositoryCount: 1,
      adaptiveOfferBudget: 3,
      predictedOfferReduction: 47,
      observedPlannerSamples: 2,
      observedAttempted: 4,
      observedDedupedOrShed: 1,
      estimatedAvoidedDedupeOrShed: 1,
      overdueRepositoriesBefore: 0,
      overdueRepositoriesSelected: 0,
      oldestUnservedAgeBeforeMs: null,
      oldestUnservedAgeAfterProposalMs: null,
    },
  };
}

async function signedRequest(requestPath, method, payload, expectedStatus) {
  const response = await fetchSigned(requestPath, method, payload);
  assert.equal(response.status, expectedStatus, await response.text());
  return response;
}

async function signedJson(requestPath, method, payload, expectedStatus) {
  const response = await signedRequest(requestPath, method, payload, expectedStatus);
  return response.json();
}

async function fetchSigned(requestPath, method, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return fetch(new URL(requestPath, workerOrigin), {
    method,
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    ...(payload === undefined ? {} : { body }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function publicSnapshot() {
  const response = await fetch(new URL("/api/exact-review-queue", workerOrigin), {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function assertAdaptiveSnapshot(snapshot, observationCount, decisionCount) {
  assert.equal(snapshot.adaptive_hot_review.observations.length, observationCount);
  assert.equal(snapshot.adaptive_hot_review.observations[0].targetRepo, "example/alpha");
  assert.equal(snapshot.adaptive_hot_review.decisions.length, decisionCount);
  assert.equal(snapshot.adaptive_hot_review.decisions[0].status, "dispatched");
}

async function assertCursors(updates, expectedCursor, expectedRevision) {
  for (const update of updates) {
    const cursor = await signedJson(
      `/internal/state/cursors/${update.mode}`,
      "GET",
      undefined,
      200,
    );
    assert.equal(cursor.next_cursor, expectedCursor ?? update.next_cursor);
    assert.equal(cursor.revision, expectedRevision);
  }
}

async function startWorker(name) {
  const log = createWriteStream(path.join(outputDir, `${name}-wrangler.log`), { flags: "w" });
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "dashboard/wrangler.toml",
      "--local",
      "--persist-to",
      persistence,
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${secret}`,
      "--var",
      "TARGET_REPOS:example/alpha,example/beta",
      "--var",
      "GITHUB_API_URL:http://127.0.0.1:9",
      "--var",
      "CACHE_TTL_SECONDS:0",
      "--var",
      "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:600000",
      "--log-level",
      "warn",
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.logStream = log;
  try {
    await waitForHttp(new URL("/api/health", workerOrigin));
    return child;
  } catch (error) {
    await stopWorker(child);
    throw error;
  }
}

async function stopWorker(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await Promise.race([onceExit(child), delay(5_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await onceExit(child);
  }
  child.logStream?.end();
  await waitForPortRelease();
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForPortRelease() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(new URL("/api/health", workerOrigin), { signal: AbortSignal.timeout(100) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(`worker port ${workerPort} remained occupied after process stop`);
}

function onceExit(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
