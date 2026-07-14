import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readAllSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  RepairMutationFreshnessError,
  RepairMutationOutcomeUnknownError,
  createRepairMutationFreshnessGuard,
  runRepairMutation,
} from "../../dist/repair/repair-mutation-safety.js";

const EMPTY_REVIEW_ACTIVITY_CURSOR = `v2:0:${"0".repeat(64)}`;

test("repair mutation receipts distinguish accepted and unknown outcomes without raw content", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-ledger-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readUpdatedAt: () => "2026-07-14T10:00:00Z",
      readReviewActivityCursor: () => EMPTY_REVIEW_ACTIVITY_CURSOR,
    });
    const context = {
      phase: "post_flight" as const,
      repository: "openclaw/openclaw",
      clusterId: "repair-openclaw-openclaw-123",
      number: 123,
      targetKind: "pull_request" as const,
      operationKey: "repair-mutation-test",
      sourceRevision: "a".repeat(40),
    };

    assert.equal(
      runRepairMutation(context, {
        kind: "comment_create",
        identity: {
          repository: context.repository,
          number: context.number,
          bodySha256: "b".repeat(64),
        },
        freshness,
        operation: () => "accepted",
      }),
      "accepted",
    );
    assert.throws(
      () =>
        runRepairMutation(context, {
          kind: "pull_request_merge",
          identity: {
            repository: context.repository,
            number: context.number,
            bodySha256: "c".repeat(64),
          },
          freshness,
          operation: () => {
            throw new Error("request timed out after send with PRIVATE_REVIEW_BODY");
          },
        }),
      RepairMutationOutcomeUnknownError,
    );

    const events = readAllSpooledActionEvents(root).sort(
      (left, right) => left.phase_seq - right.phase_seq,
    );
    assert.deepEqual(
      events.map((event) => [
        event.action.status,
        event.action.mutation,
        event.attributes?.completion_reason,
      ]),
      [
        ["started", false, "mutation_attempted"],
        ["executed", true, "mutation_accepted"],
        ["started", false, "mutation_attempted"],
        ["failed", true, "mutation_outcome_unknown"],
      ],
    );
    assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
    assert.equal(events[3]?.parent_event_id, events[2]?.event_id);
    assert.equal(
      events[0]?.idempotency_key_sha256,
      events[1]?.idempotency_key_sha256,
    );
    assert.equal(
      events[2]?.idempotency_key_sha256,
      events[3]?.idempotency_key_sha256,
    );
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REVIEW_BODY/);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair freshness drift blocks before an attempt receipt or request", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-drift-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    let called = false;
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readUpdatedAt: () => "2026-07-14T10:01:00Z",
      readReviewActivityCursor: () => EMPTY_REVIEW_ACTIVITY_CURSOR,
    });

    assert.throws(
      () =>
        runRepairMutation(
          {
            phase: "apply_result",
            repository: "openclaw/openclaw",
            clusterId: "repair-openclaw-openclaw-123",
            number: 123,
            targetKind: "pull_request",
            operationKey: "repair-drift-test",
          },
          {
            kind: "pull_request_close",
            identity: { repository: "openclaw/openclaw", number: 123 },
            freshness,
            operation: () => {
              called = true;
            },
          },
        ),
      RepairMutationFreshnessError,
    );
    assert.equal(called, false);
    assert.deepEqual(readAllSpooledActionEvents(root), []);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair executors route authoritative GitHub writes through the mutation boundary", () => {
  const applySource = fs.readFileSync("src/repair/apply-result.ts", "utf8");
  const postFlightSource = fs.readFileSync("src/repair/post-flight.ts", "utf8");

  for (const source of [applySource, postFlightSource]) {
    assert.match(source, /kind: "pull_request_merge"/);
    assert.match(source, /kind: "label_add"/);
    assert.match(source, /kind: "label_create"/);
    assert.doesNotMatch(source, /ghWithRetry\(mergeArgs\)/);
    assert.doesNotMatch(source, /ghBestEffort/);
  }
  assert.match(applySource, /kind: "comment_create"/);
  assert.match(applySource, /kind: "pull_request_close"/);
  assert.match(applySource, /kind: "issue_close"/);
  assert.match(postFlightSource, /kind: "comment_create"/);
  assert.match(postFlightSource, /"pull_request_close" : "issue_close"/);
});

function repairActionLedgerEnv(root: string): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-mutation-test",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_SHA: "d".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    GITHUB_JOB: "execute",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTION: "post-flight",
    GITHUB_RUN_STARTED_AT: "2026-07-14T10:00:00Z",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
  };
}

function restoreEnv(previous: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
