import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readAllSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  RepairMutationFreshnessError,
  RepairMutationOutcomeUnknownError,
  createRepairMutationFreshnessGuard,
  repairCreatedCommentChange,
  runRepairMutation,
} from "../../dist/repair/repair-mutation-safety.js";
import {
  EMPTY_REPAIR_REVIEW_ACTIVITY_CURSOR,
  resolveRepairMutationReviewActivityCursor,
} from "../../dist/repair/repair-mutation-review-baseline.js";

const EMPTY_REVIEW_ACTIVITY_CURSOR = EMPTY_REPAIR_REVIEW_ACTIVITY_CURSOR;

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
      expectedReviewActivityCursor: EMPTY_REVIEW_ACTIVITY_CURSOR,
      readTargetActivity: () => targetActivity(),
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
    assert.equal(events[0]?.idempotency_key_sha256, events[1]?.idempotency_key_sha256);
    assert.equal(events[2]?.idempotency_key_sha256, events[3]?.idempotency_key_sha256);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REVIEW_BODY/);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair mutation receipts commit the attempt before the request and the outcome after it", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-durable-")));
  const sourceRoot = path.join(root, "source");
  const seedRoot = path.join(root, "seed");
  const stateRoot = path.join(root, "state");
  const remoteRoot = path.join(root, "state.git");
  const spoolRoot = path.join(root, "spool");
  const runnerTemp = path.join(root, "runner");
  const previous = { ...process.env };
  const previousCwd = process.cwd();

  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(seedRoot);
  fs.mkdirSync(spoolRoot);
  fs.mkdirSync(runnerTemp);
  git(["init", "--bare", remoteRoot]);
  git(["init", "-b", "state"], seedRoot);
  git(["config", "user.name", "ClawSweeper Test"], seedRoot);
  git(["config", "user.email", "clawsweeper-test@example.invalid"], seedRoot);
  fs.writeFileSync(path.join(seedRoot, ".gitkeep"), "");
  git(["add", ".gitkeep"], seedRoot);
  git(["commit", "-m", "chore: seed state"], seedRoot);
  git(["remote", "add", "origin", remoteRoot], seedRoot);
  git(["push", "-u", "origin", "state"], seedRoot);
  git(["clone", "--branch", "state", remoteRoot, stateRoot]);

  Object.assign(process.env, {
    ...repairActionLedgerEnv(spoolRoot),
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_STARTED_AT: "2026-07-14T10:00:00Z",
    RUNNER_TEMP: runnerTemp,
    CLAWSWEEPER_STATE_DIR: stateRoot,
    CLAWSWEEPER_GIT_USER_NAME: "ClawSweeper Test",
    CLAWSWEEPER_GIT_USER_EMAIL: "clawsweeper-test@example.invalid",
  });
  delete process.env.CLAWSWEEPER_INTERNAL_REPAIR_MUTATION_LEDGER_READY;
  delete process.env.CLAWSWEEPER_INTERNAL_REPAIR_MUTATION_LEDGER_DURABLE;

  try {
    process.chdir(sourceRoot);
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "issue",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readTargetActivity: () => targetActivity(),
    });
    runRepairMutation(
      {
        phase: "apply_result",
        repository: "openclaw/openclaw",
        clusterId: "repair-openclaw-openclaw-123",
        number: 123,
        targetKind: "issue",
        operationKey: "durable-receipt-test",
      },
      {
        kind: "issue_close",
        identity: {
          repository: "openclaw/openclaw",
          number: 123,
          bodySha256: "b".repeat(64),
        },
        freshness,
        operation: () => {
          assert.equal(Number(git(["rev-list", "--count", "HEAD"], stateRoot)), 2);
          return "accepted";
        },
      },
    );

    assert.equal(Number(git(["rev-list", "--count", "HEAD"], stateRoot)), 3);
    runRepairMutation(
      {
        phase: "apply_result",
        repository: "openclaw/openclaw",
        clusterId: "repair-openclaw-openclaw-124",
        number: 124,
        targetKind: "issue",
        operationKey: "second-durable-receipt-test",
      },
      {
        kind: "label_create",
        identity: {
          repository: "openclaw/openclaw",
          label: "clawsweeper",
        },
        freshness,
        operation: () => {
          assert.equal(Number(git(["rev-list", "--count", "HEAD"], stateRoot)), 4);
          return "accepted";
        },
      },
    );

    assert.equal(Number(git(["rev-list", "--count", "HEAD"], stateRoot)), 5);
    const eventText = walkFiles(path.join(stateRoot, "ledger", "v1", "events"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("");
    assert.equal(eventText.trim().split("\n").length, 4);
    assert.doesNotMatch(eventText, /PRIVATE_REVIEW_BODY|ClawSweeper closeout/);
  } finally {
    process.chdir(previousCwd);
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
    let reads = 0;
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      expectedReviewActivityCursor: EMPTY_REVIEW_ACTIVITY_CURSOR,
      readTargetActivity: () =>
        targetActivity(reads++ === 0 ? "2026-07-14T10:00:00Z" : "2026-07-14T10:01:00Z"),
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

test("repair freshness rechecks after the attempt receipt and before the request", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-boundary-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    let called = false;
    let reads = 0;
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      expectedReviewActivityCursor: EMPTY_REVIEW_ACTIVITY_CURSOR,
      readTargetActivity: () =>
        targetActivity(reads++ < 2 ? "2026-07-14T10:00:00Z" : "2026-07-14T10:01:00Z"),
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
            operationKey: "repair-boundary-test",
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
    assert.deepEqual(
      readAllSpooledActionEvents(root)
        .sort((left, right) => left.phase_seq - right.phase_seq)
        .map((event) => [event.action.status, event.attributes?.completion_reason]),
      [
        ["started", "mutation_attempted"],
        ["skipped", "mutation_rejected"],
      ],
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair review baselines do not absorb unbound live review activity", () => {
  const reviewedCursor = `v2:1:${"b".repeat(64)}`;
  const expectedReviewActivityCursor = resolveRepairMutationReviewActivityCursor({
    repository: "openclaw/openclaw",
    number: 123,
    targetKind: "pull_request",
    expectedUpdatedAt: "2026-07-14T10:00:00Z",
  });
  assert.equal(expectedReviewActivityCursor, EMPTY_REVIEW_ACTIVITY_CURSOR);

  const freshness = createRepairMutationFreshnessGuard({
    repository: "openclaw/openclaw",
    number: 123,
    targetKind: "pull_request",
    expectedUpdatedAt: "2026-07-14T10:00:00Z",
    expectedReviewActivityCursor,
    readTargetActivity: () => targetActivity(),
    readReviewActivityCursor: () => reviewedCursor,
  });
  assert.throws(
    () => freshness.assertFresh("pull_request_merge"),
    /review activity changed after repair validation/,
  );
});

test("repair review baselines reuse only state records reviewed before the repair plan", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-review-baseline-")));
  const recordPath = path.join(root, "records", "openclaw-openclaw", "items", "123.md");
  const reviewedCursor = `v2:1:${"b".repeat(64)}`;
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(
    recordPath,
    [
      "---",
      "number: 123",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "state_at_review: open",
      "item_updated_at: 2026-07-14T10:00:00Z",
      "reviewed_at: 2026-07-14T10:01:00Z",
      "review_status: complete",
      "review_terminal_failure: false",
      "local_checkout_access: verified",
      `review_activity_cursor: ${reviewedCursor}`,
      "---",
      "PRIVATE_REVIEW_BODY",
      "",
    ].join("\n"),
  );

  try {
    assert.equal(
      resolveRepairMutationReviewActivityCursor({
        repository: "openclaw/openclaw",
        number: 123,
        targetKind: "pull_request",
        expectedUpdatedAt: "2026-07-14T10:00:00Z",
        reviewedBefore: "2026-07-14T10:02:00Z",
        stateRoot: root,
      }),
      reviewedCursor,
    );
    assert.equal(
      resolveRepairMutationReviewActivityCursor({
        repository: "openclaw/openclaw",
        number: 123,
        targetKind: "pull_request",
        expectedUpdatedAt: "2026-07-14T10:00:00Z",
        reviewedBefore: "2026-07-14T10:00:30Z",
        stateRoot: root,
      }),
      EMPTY_REVIEW_ACTIVITY_CURSOR,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair review baselines accept only trusted exact-head post-repair verdicts", () => {
  const reviewedCursor = `v2:2:${"c".repeat(64)}`;
  const laterCursor = `v2:3:${"d".repeat(64)}`;
  const expectedHeadSha = "a".repeat(40);
  const comments = [
    {
      user: { login: "contributor" },
      body: `<!-- clawsweeper-verdict:pass item=123 sha=${expectedHeadSha} updated_at=2026-07-14T10:00:00Z reviewed_at=2020-01-01T00:00:00Z review_activity_cursor=${reviewedCursor} -->`,
    },
    {
      user: { login: "openclaw-clawsweeper[bot]" },
      body: `<!-- clawsweeper-verdict:pass item=123 sha=${expectedHeadSha} updated_at=2026-07-14T10:00:00Z reviewed_at=2020-01-01T00:01:00Z review_activity_cursor=${reviewedCursor} -->`,
    },
    {
      user: { login: "openclaw-clawsweeper[bot]" },
      body: `<!-- clawsweeper-verdict:pass item=123 sha=${expectedHeadSha} updated_at=2026-07-14T10:00:00Z reviewed_at=2026-07-14T10:03:00Z review_activity_cursor=${laterCursor} -->`,
    },
  ];

  assert.equal(
    resolveRepairMutationReviewActivityCursor({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      expectedHeadSha,
      reviewedBefore: "2026-07-14T10:02:00Z",
      readIssueComments: () => comments,
    }),
    reviewedCursor,
  );
  assert.equal(
    resolveRepairMutationReviewActivityCursor({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      expectedHeadSha: "d".repeat(40),
      reviewedBefore: "2026-07-14T10:02:00Z",
      readIssueComments: () => comments,
    }),
    null,
  );
  assert.equal(
    resolveRepairMutationReviewActivityCursor({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: "2026-07-14T10:00:01Z",
      expectedHeadSha,
      reviewedBefore: "2026-07-14T10:02:00Z",
      readIssueComments: () => comments,
    }),
    null,
  );
});

test("repair freshness rejects concurrent target activity after an owned comment", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-owned-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    let activity = targetActivity();
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: activity.updatedAt,
      expectedReviewActivityCursor: EMPTY_REVIEW_ACTIVITY_CURSOR,
      readTargetActivity: () => activity,
      readReviewActivityCursor: () => EMPTY_REVIEW_ACTIVITY_CURSOR,
    });
    const body = "ClawSweeper closeout";
    const bodySha256 = createHash("sha256").update(body).digest("hex");

    assert.throws(
      () =>
        runRepairMutation(
          {
            phase: "apply_result",
            repository: "openclaw/openclaw",
            clusterId: "repair-openclaw-openclaw-123",
            number: 123,
            targetKind: "pull_request",
            operationKey: "repair-owned-comment-test",
          },
          {
            kind: "comment_create",
            identity: { repository: "openclaw/openclaw", number: 123, bodySha256 },
            freshness,
            operation: () => {
              activity = {
                ...targetActivity("2026-07-14T10:01:00Z"),
                labels: ["security"],
                comments: [
                  {
                    id: "9001",
                    author: "clawsweeper[bot]",
                    authorAssociation: "CONTRIBUTOR",
                    createdAt: "2026-07-14T10:01:00Z",
                    updatedAt: "2026-07-14T10:01:00Z",
                    bodySha256,
                    metadataSha256: "c".repeat(64),
                  },
                ],
              };
              return { id: 9001, body };
            },
            acceptedChange: (created) => repairCreatedCommentChange(created, bodySha256),
          },
        ),
      /target activity changed concurrently with the ClawSweeper mutation/,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair freshness rejects concurrent PR identity drift after an owned comment", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-pr-drift-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    let activity = targetActivity();
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: activity.updatedAt,
      expectedReviewActivityCursor: EMPTY_REVIEW_ACTIVITY_CURSOR,
      readTargetActivity: () => activity,
      readReviewActivityCursor: () => EMPTY_REVIEW_ACTIVITY_CURSOR,
    });
    const body = "ClawSweeper closeout";
    const bodySha256 = createHash("sha256").update(body).digest("hex");

    assert.throws(
      () =>
        runRepairMutation(
          {
            phase: "apply_result",
            repository: "openclaw/openclaw",
            clusterId: "repair-openclaw-openclaw-123",
            number: 123,
            targetKind: "pull_request",
            operationKey: "repair-pr-drift-test",
          },
          {
            kind: "comment_create",
            identity: { repository: "openclaw/openclaw", number: 123, bodySha256 },
            freshness,
            operation: () => {
              activity = {
                ...targetActivity("2026-07-14T10:01:00Z"),
                metadataSha256: "b".repeat(64),
                comments: [
                  {
                    id: "9001",
                    author: "clawsweeper[bot]",
                    authorAssociation: "CONTRIBUTOR",
                    createdAt: "2026-07-14T10:01:00Z",
                    updatedAt: "2026-07-14T10:01:00Z",
                    bodySha256,
                    metadataSha256: "c".repeat(64),
                  },
                ],
              };
              return { id: 9001, body };
            },
            acceptedChange: (created) => repairCreatedCommentChange(created, bodySha256),
          },
        ),
      /target activity changed concurrently with the ClawSweeper mutation/,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair executors route authoritative GitHub writes through the mutation boundary", () => {
  const applySource = fs.readFileSync("src/repair/apply-result.ts", "utf8");
  const postFlightSource = fs.readFileSync("src/repair/post-flight.ts", "utf8");
  const activitySource = fs.readFileSync("src/repair/repair-mutation-activity.ts", "utf8");
  const safetySource = fs.readFileSync("src/repair/repair-mutation-safety.ts", "utf8");
  const reviewBaselineSource = fs.readFileSync(
    "src/repair/repair-mutation-review-baseline.ts",
    "utf8",
  );
  const receiptSource = fs.readFileSync("src/repair/repair-mutation-receipts.ts", "utf8");

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
  assert.match(receiptSource, /publishMainCommit/);
  assert.match(receiptSource, /importActionEventShards/);
  assert.match(receiptSource, /CLAWSWEEPER_STATE_DIR/);
  assert.match(safetySource, /reviewed pull request activity cursor is unavailable/);
  assert.match(reviewBaselineSource, /item_updated_at/);
  assert.match(reviewBaselineSource, /reviewedAt > options\.reviewedBefore/);
  assert.match(reviewBaselineSource, /candidate\.reviewedAt <= reviewedBefore/);
  assert.match(reviewBaselineSource, /attributes\.updated_at !== expectedUpdatedAt/);
  assert.match(reviewBaselineSource, /allowedVerdicts/);
  assert.match(activitySource, /requestedReviewers/);
  assert.match(activitySource, /compactPullRequestRef\(pull\.head\)/);
  assert.match(activitySource, /autoMerge: compactAutoMerge/);
  assert.match(postFlightSource, /fix PR head changed after repair validation/);
  assert.match(applySource, /resolveRepairMutationReviewActivityCursor/);
  assert.match(postFlightSource, /resolveRepairMutationReviewActivityCursor/);
  assert.match(applySource, /finally \{\s+await flushRepairMutationActionEvents\(\)/);
  assert.match(postFlightSource, /finally \{\s+await flushRepairMutationActionEvents\(\)/);
});

function targetActivity(updatedAt = "2026-07-14T10:00:00Z") {
  return {
    updatedAt,
    state: "open",
    labels: [],
    metadataSha256: "a".repeat(64),
    comments: [],
  };
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  });
}

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
