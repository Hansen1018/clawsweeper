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
  createRepairMutationBoundaryGuard,
  createRepairMutationFreshnessGuard,
  repairCreatedCommentChange,
  runRepairMutation,
} from "../../dist/repair/repair-mutation-safety.js";
import {
  mintRepairMutationReviewAuthorizations,
  validateRepairMutationReviewAuthorization,
  validateRepairMutationReviewAuthorizationAfterMerge,
} from "../../dist/repair/repair-mutation-review-baseline.js";
import {
  repairTargetActivityDigest,
  repairTargetActivitySnapshotFromTarget,
} from "../../dist/repair/repair-mutation-activity.js";

test("repair mutation receipts distinguish accepted and unknown outcomes without raw content", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-ledger-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "issue",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readTargetActivity: () => targetActivity(),
    });
    const context = {
      phase: "post_flight" as const,
      repository: "openclaw/openclaw",
      clusterId: "repair-openclaw-openclaw-123",
      number: 123,
      targetKind: "issue" as const,
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
      targetKind: "issue",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readTargetActivity: () =>
        targetActivity(reads++ === 0 ? "2026-07-14T10:00:00Z" : "2026-07-14T10:01:00Z"),
    });

    assert.throws(
      () =>
        runRepairMutation(
          {
            phase: "apply_result",
            repository: "openclaw/openclaw",
            clusterId: "repair-openclaw-openclaw-123",
            number: 123,
            targetKind: "issue",
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
      targetKind: "issue",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readTargetActivity: () =>
        targetActivity(reads++ < 4 ? "2026-07-14T10:00:00Z" : "2026-07-14T10:01:00Z"),
    });

    assert.throws(
      () =>
        runRepairMutation(
          {
            phase: "apply_result",
            repository: "openclaw/openclaw",
            clusterId: "repair-openclaw-openclaw-123",
            number: 123,
            targetKind: "issue",
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

test("repair freshness rereads target activity after review pagination", () => {
  const authorization = reviewAuthorizationFixture();
  let activity = authorization.targetActivity;
  const freshness = createRepairMutationFreshnessGuard({
    repository: "openclaw/openclaw",
    number: 123,
    targetKind: "pull_request",
    expectedUpdatedAt: null,
    reviewAuthorization: authorization.guard,
    readTargetActivityEvidence: () => ({
      snapshot: authorization.targetActivity,
      comments: authorization.comments,
    }),
    readTargetActivity: () => activity,
    readReviewActivityCursor: () => {
      activity = {
        ...authorization.targetActivity,
        updatedAt: "2026-07-14T10:01:00Z",
        labels: ["security"],
      };
      return authorization.cursor;
    },
  });

  assert.throws(
    () => freshness.assertFresh("pull_request_close"),
    /target activity changed while review activity was being refreshed/,
  );
});

test("owned mutation acceptance advances only after the post-review target reread", () => {
  const bodySha256 = createHash("sha256").update("ClawSweeper closeout").digest("hex");
  const authorization = reviewAuthorizationFixture();
  const baseline = authorization.targetActivity;
  const ownedActivity = {
    ...authorization.targetActivity,
    updatedAt: "2026-07-14T10:01:00Z",
    comments: [
      ...authorization.targetActivity.comments,
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
  let activity = baseline;
  let injectConcurrentChange = true;
  const freshness = createRepairMutationFreshnessGuard({
    repository: "openclaw/openclaw",
    number: 123,
    targetKind: "pull_request",
    expectedUpdatedAt: null,
    reviewAuthorization: authorization.guard,
    readTargetActivityEvidence: () => ({
      snapshot: authorization.targetActivity,
      comments: authorization.comments,
    }),
    readTargetActivity: () => activity,
    readReviewActivityCursor: () => {
      if (injectConcurrentChange) {
        activity = {
          ...ownedActivity,
          labels: ["security"],
        };
      }
      return authorization.cursor;
    },
  });
  activity = ownedActivity;
  const change = {
    kind: "comment_create" as const,
    commentId: "9001",
    bodySha256,
  };

  assert.throws(
    () => freshness.acceptOwnedMutation("comment_create", change),
    /target activity changed while owned mutation activity was being accepted/,
  );

  injectConcurrentChange = false;
  activity = ownedActivity;
  assert.doesNotThrow(() => freshness.acceptOwnedMutation("comment_create", change));
});

test("repair boundary guards reject drift after the attempt receipt", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-boundary-guard-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    let boundaryReads = 0;
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "issue",
      expectedUpdatedAt: "2026-07-14T10:00:00Z",
      readTargetActivity: () => targetActivity(),
    });
    const requiredChecks = createRepairMutationBoundaryGuard({
      expectedState: { checks: ["green"] },
      readState: () => ({ checks: [boundaryReads++ === 0 ? "green" : "failed"] }),
      changedReason: "required check rollup changed after merge preflight",
      readFailureReason: "required check rollup could not be refreshed",
      retryableOnChange: true,
    });

    assert.throws(
      () =>
        runRepairMutation(
          {
            phase: "apply_result",
            repository: "openclaw/openclaw",
            clusterId: "repair-openclaw-openclaw-123",
            number: 123,
            targetKind: "issue",
            operationKey: "repair-required-check-boundary",
          },
          {
            kind: "pull_request_merge",
            identity: { repository: "openclaw/openclaw", number: 123 },
            freshness,
            boundaryGuards: [requiredChecks],
            operation: () => assert.fail("merge request must not run"),
          },
        ),
      /required check rollup changed after merge preflight/,
    );
    assert.equal(boundaryReads, 2);
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

test("repair review authorization rejects forged carried fields", () => {
  const authorization = reviewAuthorizationFixture();
  for (const forged of [
    { ...authorization.snapshot, authorization: "close" },
    { ...authorization.snapshot, review_activity_cursor: `v2:0:${"b".repeat(64)}` },
    { ...authorization.snapshot, head_sha: "b".repeat(40) },
    { ...authorization.snapshot, target_activity_digest: "b".repeat(64) },
  ]) {
    assert.throws(
      () =>
        validateRepairMutationReviewAuthorization({
          snapshot: forged,
          repository: "openclaw/openclaw",
          number: 123,
          targetKind: "pull_request",
          authorization: "merge",
          expectedHeadSha: authorization.headSha,
          expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
          reviewedBefore: "2026-07-14T10:05:00Z",
          targetActivity: authorization.targetActivity,
          comments: authorization.comments,
        }),
      /authorization is unavailable or stale/,
    );
  }
});

test("repair review authorization rejects legacy verdicts without a target digest", () => {
  const authorization = reviewAuthorizationFixture();
  const comments = authorization.comments.map((comment) => ({
    ...comment,
    body: String(comment.body).replace(/\s+target_activity_digest=[a-f0-9]{64}/, ""),
  }));
  assert.deepEqual(
    mintRepairMutationReviewAuthorizations({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      target: authorization.target,
      comments,
      expectedHeadSha: authorization.headSha,
      reviewedBefore: "2026-07-14T10:05:00Z",
    }),
    [],
  );
});

test("repair review authorization binds trusted verdicts to the exact head", () => {
  const authorization = reviewAuthorizationFixture();
  assert.equal(
    validateRepairMutationReviewAuthorization({
      snapshot: authorization.snapshot,
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      authorization: "merge",
      expectedHeadSha: authorization.headSha,
      expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
      reviewedBefore: "2026-07-14T10:05:00Z",
      targetActivity: authorization.targetActivity,
      comments: authorization.comments,
    }),
    authorization.cursor,
  );
  assert.throws(
    () =>
      validateRepairMutationReviewAuthorization({
        snapshot: authorization.snapshot,
        repository: "openclaw/openclaw",
        number: 123,
        targetKind: "pull_request",
        authorization: "merge",
        expectedHeadSha: "b".repeat(40),
        expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
        reviewedBefore: "2026-07-14T10:05:00Z",
        targetActivity: authorization.targetActivity,
        comments: authorization.comments,
      }),
    /authorization is unavailable or stale/,
  );
});

test("repair review authorization permits only the expected merge-state transition", () => {
  const authorization = reviewAuthorizationFixture();
  const mergedActivity = {
    ...authorization.targetActivity,
    updatedAt: "2026-07-14T10:03:00Z",
    state: "closed",
  };
  assert.equal(
    validateRepairMutationReviewAuthorizationAfterMerge({
      snapshot: authorization.snapshot,
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      authorization: "merge",
      expectedHeadSha: authorization.headSha,
      expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
      reviewedBefore: "2026-07-14T10:05:00Z",
      targetActivity: mergedActivity,
      comments: authorization.comments,
      reviewActivityCursor: authorization.cursor,
    }),
    authorization.cursor,
  );
  assert.throws(
    () =>
      validateRepairMutationReviewAuthorizationAfterMerge({
        snapshot: authorization.snapshot,
        repository: "openclaw/openclaw",
        number: 123,
        targetKind: "pull_request",
        authorization: "merge",
        expectedHeadSha: authorization.headSha,
        expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
        reviewedBefore: "2026-07-14T10:05:00Z",
        targetActivity: { ...mergedActivity, labels: ["security"] },
        comments: authorization.comments,
        reviewActivityCursor: authorization.cursor,
      }),
    /authorization is unavailable or stale/,
  );
  assert.throws(
    () =>
      validateRepairMutationReviewAuthorizationAfterMerge({
        snapshot: authorization.snapshot,
        repository: "openclaw/openclaw",
        number: 123,
        targetKind: "pull_request",
        authorization: "merge",
        expectedHeadSha: authorization.headSha,
        expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
        reviewedBefore: "2026-07-14T10:05:00Z",
        targetActivity: mergedActivity,
        comments: authorization.comments,
        reviewActivityCursor: `v2:0:${"b".repeat(64)}`,
      }),
    /authorization is unavailable or stale/,
  );
});

test("repair review authorization rejects unrelated activity followed by a bot edit", () => {
  const authorization = reviewAuthorizationFixture();
  const unrelatedComment = {
    id: "9001",
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    created_at: "2026-07-14T10:01:30Z",
    updated_at: "2026-07-14T10:01:30Z",
    body: "unrelated target activity after review",
  };
  const editedComments = [
    unrelatedComment,
    {
      ...authorization.comments[0],
      updated_at: "2026-07-14T10:02:30Z",
    },
  ];
  assert.deepEqual(
    mintRepairMutationReviewAuthorizations({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      target: { ...authorization.target, updated_at: "2026-07-14T10:02:30Z" },
      comments: editedComments,
      expectedHeadSha: authorization.headSha,
      reviewedBefore: "2026-07-14T10:05:00Z",
    }),
    [],
  );
});

test("repair review authorization permits owned verdict-comment timestamp drift", () => {
  const authorization = reviewAuthorizationFixture({
    reviewedUpdatedAt: "2026-07-14T10:00:00Z",
    liveUpdatedAt: "2026-07-14T10:02:00Z",
  });
  assert.notEqual(
    authorization.snapshot.reviewed_updated_at,
    authorization.targetActivity.updatedAt,
  );
  assert.equal(
    validateRepairMutationReviewAuthorization({
      snapshot: authorization.snapshot,
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      authorization: "merge",
      expectedHeadSha: authorization.headSha,
      expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
      reviewedBefore: "2026-07-14T10:05:00Z",
      targetActivity: authorization.targetActivity,
      comments: authorization.comments,
    }),
    authorization.cursor,
  );
});

test("repair review authorization rejects target timestamp drift after minting", () => {
  const authorization = reviewAuthorizationFixture({
    reviewedUpdatedAt: "2026-07-14T10:00:00Z",
    liveUpdatedAt: "2026-07-14T10:02:00Z",
  });
  assert.throws(
    () =>
      validateRepairMutationReviewAuthorization({
        snapshot: authorization.snapshot,
        repository: "openclaw/openclaw",
        number: 123,
        targetKind: "pull_request",
        authorization: "merge",
        expectedHeadSha: authorization.headSha,
        expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
        reviewedBefore: "2026-07-14T10:05:00Z",
        targetActivity: {
          ...authorization.targetActivity,
          updatedAt: "2026-07-14T10:03:00Z",
        },
        comments: authorization.comments,
      }),
    /authorization is unavailable or stale/,
  );
});

test("repair review authorization is action-specific", () => {
  for (const authorizationKind of ["merge", "close"] as const) {
    const authorization = reviewAuthorizationFixture({ authorization: authorizationKind });
    assert.equal(authorization.snapshot.authorization, authorizationKind);
    const wrongKind = authorizationKind === "merge" ? "close" : "merge";
    assert.throws(
      () =>
        validateRepairMutationReviewAuthorization({
          snapshot: authorization.snapshot,
          repository: "openclaw/openclaw",
          number: 123,
          targetKind: "pull_request",
          authorization: wrongKind,
          expectedHeadSha: authorization.headSha,
          expectedReviewedUpdatedAt: "2026-07-14T10:00:00Z",
          reviewedBefore: "2026-07-14T10:05:00Z",
          targetActivity: authorization.targetActivity,
          comments: authorization.comments,
        }),
      /authorization is unavailable or stale/,
    );
  }
});

test("repair freshness rejects concurrent target activity after an owned comment", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-owned-")));
  const previous = { ...process.env };
  Object.assign(process.env, repairActionLedgerEnv(root));

  try {
    const authorization = reviewAuthorizationFixture();
    let activity = authorization.targetActivity;
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: null,
      reviewAuthorization: authorization.guard,
      readTargetActivityEvidence: () => ({
        snapshot: authorization.targetActivity,
        comments: authorization.comments,
      }),
      readTargetActivity: () => activity,
      readReviewActivityCursor: () => authorization.cursor,
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
                ...authorization.targetActivity,
                updatedAt: "2026-07-14T10:01:00Z",
                labels: ["security"],
                comments: [
                  ...authorization.targetActivity.comments,
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
    const authorization = reviewAuthorizationFixture();
    let activity = authorization.targetActivity;
    const freshness = createRepairMutationFreshnessGuard({
      repository: "openclaw/openclaw",
      number: 123,
      targetKind: "pull_request",
      expectedUpdatedAt: null,
      reviewAuthorization: authorization.guard,
      readTargetActivityEvidence: () => ({
        snapshot: authorization.targetActivity,
        comments: authorization.comments,
      }),
      readTargetActivity: () => activity,
      readReviewActivityCursor: () => authorization.cursor,
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
                ...authorization.targetActivity,
                updatedAt: "2026-07-14T10:01:00Z",
                metadataSha256: "b".repeat(64),
                comments: [
                  ...authorization.targetActivity.comments,
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
    assert.match(source, /outcome: \(confirmed\) => \{[\s\S]*confirmed\.merged_at/);
    assert.match(
      source,
      /merge command completed but GitHub has not reported the pull request as merged/,
    );
    assert.match(source, /kind: "label_add"/);
    assert.match(source, /kind: "label_create"/);
    assert.doesNotMatch(source, /ghWithRetry\(mergeArgs\)/);
    assert.doesNotMatch(source, /ghBestEffort/);
  }
  assert.match(applySource, /kind: "comment_create"/);
  assert.match(applySource, /kind: "pull_request_close"/);
  assert.match(applySource, /kind: "issue_close"/);
  assert.doesNotMatch(postFlightSource, /kind: "comment_create"/);
  assert.doesNotMatch(postFlightSource, /kind: "(?:pull_request|issue)_close"/);
  assert.match(receiptSource, /publishMainCommit/);
  assert.match(receiptSource, /importActionEventShards/);
  assert.match(receiptSource, /CLAWSWEEPER_STATE_DIR/);
  assert.match(safetySource, /trusted repair review authorization is unavailable/);
  assert.match(reviewBaselineSource, /target_activity_digest/);
  assert.match(reviewBaselineSource, /snapshot_sha256/);
  assert.match(reviewBaselineSource, /trusted_comment/);
  assert.match(reviewBaselineSource, /reviewedAt > options\.reviewedBefore/);
  assert.match(reviewBaselineSource, /AUTHORIZED_REVIEW_VERDICTS/);
  assert.doesNotMatch(reviewBaselineSource, /needs-changes|needs-human/);
  assert.doesNotMatch(reviewBaselineSource, /explicitCursor|explicitVerdict/);
  assert.match(applySource, /authorization: "merge"/);
  assert.match(applySource, /authorization: "close"/);
  assert.match(postFlightSource, /authorization: "merge"/);
  assert.match(activitySource, /requestedReviewers/);
  assert.match(activitySource, /compactPullRequestRef\(pull\.head\)/);
  assert.match(activitySource, /autoMerge: compactAutoMerge/);
  assert.match(postFlightSource, /fix PR head changed after repair validation/);
  assert.doesNotMatch(postFlightSource, /CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS/);
  assert.match(applySource, /clusterPlanReviewAuthorization/);
  assert.match(postFlightSource, /mintRepairMutationReviewAuthorizations/);
  assert.doesNotMatch(
    `${applySource}\n${postFlightSource}`,
    /action\.(?:target_)?review_(?:activity_cursor|verdict)/,
  );
  assert.match(applySource, /finally \{\s+await flushRepairMutationActionEvents\(\)/);
  assert.match(postFlightSource, /finally \{\s+await flushRepairMutationActionEvents\(\)/);
});

test("repair worker renews and rebinds state credentials before post-flight publication", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const executeIndex = workflow.indexOf("- name: Execute credited fix artifact");
  const stateTokenIndex = workflow.indexOf("- name: Renew state token for post-flight");
  const rebindIndex = workflow.indexOf("- name: Rebind state checkout credentials");
  const ledgerPublishIndex = workflow.indexOf(
    "- name: Publish immutable execute-fix action ledger",
  );
  const deferredIndex = workflow.indexOf("- name: Publish deferred fix outcome");
  const applyIndex = workflow.indexOf("- name: Apply safe closure actions");
  const postFlightIndex = workflow.indexOf("- name: Post-flight finalize fix PRs");
  const closeoutIndex = workflow.indexOf("- name: Apply post-flight closeouts");
  const requeueIndex = workflow.indexOf("- name: Requeue source-head repair races");

  for (const index of [
    executeIndex,
    stateTokenIndex,
    rebindIndex,
    ledgerPublishIndex,
    deferredIndex,
    applyIndex,
    postFlightIndex,
    closeoutIndex,
    requeueIndex,
  ]) {
    assert.notEqual(index, -1);
  }
  assert.ok(executeIndex < stateTokenIndex);
  assert.ok(stateTokenIndex < rebindIndex);
  assert.ok(rebindIndex < ledgerPublishIndex);
  assert.ok(ledgerPublishIndex < deferredIndex);
  assert.ok(rebindIndex < deferredIndex);
  assert.ok(rebindIndex < applyIndex);
  assert.ok(rebindIndex < postFlightIndex);
  assert.ok(rebindIndex < closeoutIndex);
  assert.ok(rebindIndex < requeueIndex);

  const rebindBlock = workflow.slice(rebindIndex, deferredIndex);
  assert.match(
    rebindBlock,
    /STATE_TOKEN: \$\{\{ steps\.state_post_flight_token\.outputs\.token \}\}/,
  );
  assert.match(
    rebindBlock,
    /git -C "\$CLAWSWEEPER_STATE_DIR" config --local --replace-all[\s\S]*http\.https:\/\/github\.com\/\.extraheader/,
  );
  assert.match(
    rebindBlock,
    /git -C "\$CLAWSWEEPER_STATE_DIR" ls-remote --exit-code origin refs\/heads\/state/,
  );

  for (const stepIndex of [
    ledgerPublishIndex,
    deferredIndex,
    applyIndex,
    postFlightIndex,
    closeoutIndex,
    requeueIndex,
  ]) {
    const stepHeader = workflow.slice(
      stepIndex,
      workflow.indexOf("\n      - name:", stepIndex + 1),
    );
    assert.match(stepHeader, /steps\.state_post_flight_credentials\.outcome == 'success'/);
  }
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

function reviewAuthorizationFixture(
  options: {
    authorization?: "merge" | "close";
    reviewedUpdatedAt?: string;
    liveUpdatedAt?: string;
    extraComments?: Record<string, unknown>[];
  } = {},
) {
  const authorization = options.authorization ?? "merge";
  const verdict = authorization === "merge" ? "pass" : "close";
  const reviewedUpdatedAt = options.reviewedUpdatedAt ?? "2026-07-14T10:00:00Z";
  const liveUpdatedAt = options.liveUpdatedAt ?? "2026-07-14T10:02:00Z";
  const headSha = "a".repeat(40);
  const cursor = `v2:0:${createHash("sha256").update("[]").digest("hex")}`;
  const target = {
    number: 123,
    state: "open",
    title: "Repair target",
    body: "Target body",
    updated_at: liveUpdatedAt,
    locked: false,
    labels: [],
    author_association: "CONTRIBUTOR",
    assignees: [],
    milestone: null,
    head: { sha: headSha, ref: "repair", repo: { full_name: "openclaw/openclaw" } },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "openclaw/openclaw" } },
    requested_reviewers: [],
    requested_teams: [],
  };
  const priorComments = options.extraComments ?? [];
  const targetActivityDigest = repairTargetActivityDigest(
    repairTargetActivitySnapshotFromTarget(target, priorComments, "pull_request"),
  );
  const comment = {
    id: "9000",
    user: { login: "openclaw-clawsweeper[bot]" },
    author_association: "CONTRIBUTOR",
    created_at: "2026-07-14T10:01:00Z",
    updated_at: liveUpdatedAt,
    body: [
      `<!-- clawsweeper-review item=123 -->`,
      `<!-- clawsweeper-verdict:${verdict} item=123 sha=${headSha} updated_at=${reviewedUpdatedAt} reviewed_at=2026-07-14T10:00:30Z source_revision=${"f".repeat(64)} review_activity_cursor=${cursor} target_activity_digest=${targetActivityDigest} -->`,
    ].join("\n"),
  };
  const comments = [...priorComments, comment];
  const targetActivity = repairTargetActivitySnapshotFromTarget(target, comments, "pull_request");
  const snapshot = mintRepairMutationReviewAuthorizations({
    repository: "openclaw/openclaw",
    number: 123,
    targetKind: "pull_request",
    target,
    comments,
    expectedHeadSha: headSha,
    reviewedBefore: "2026-07-14T10:05:00Z",
  }).find((candidate) => candidate.authorization === authorization);
  assert.ok(snapshot);
  return {
    comments,
    cursor,
    headSha,
    snapshot,
    target,
    targetActivity,
    guard: {
      snapshot,
      authorization,
      expectedHeadSha: headSha,
      expectedReviewedUpdatedAt: reviewedUpdatedAt,
      reviewedBefore: "2026-07-14T10:05:00Z",
    },
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
    GITHUB_ACTIONS: "false",
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
