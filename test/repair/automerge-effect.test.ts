import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeAttemptReceiptOutcome,
  automergeUnconfirmedFailureDisposition,
  confirmAutomergeEffectSnapshot,
} from "../../dist/repair/automerge-effect.js";

const headSha = "a".repeat(40);

test("automerge effect certification binds the merged REST snapshot to the reviewed head", () => {
  assert.deepEqual(
    confirmAutomergeEffectSnapshot(
      {
        pull: {
          head: { sha: headSha },
          merged_at: "2026-07-13T08:00:00Z",
          merge_commit_sha: "b".repeat(40),
        },
        view: {
          headRefOid: "c".repeat(40),
          isInMergeQueue: true,
        },
      },
      headSha,
    ),
    {
      mergedAt: "2026-07-13T08:00:00Z",
      mergeCommitSha: "b".repeat(40),
      pendingReason: "",
      block: "",
    },
  );
});

test("automerge effect certification uses exact-head GraphQL queue and auto-merge state", () => {
  const pull = { head: { sha: headSha }, merged_at: null, merge_commit_sha: null };
  const queued = confirmAutomergeEffectSnapshot(
    {
      pull,
      view: { headRefOid: headSha, isInMergeQueue: true, autoMergeRequest: null },
    },
    headSha,
  );
  assert.equal(queued.pendingReason, `reviewed head ${headSha} is pending in the merge queue`);
  assert.equal(automergeAttemptReceiptOutcome({ confirmation: queued }), "accepted");

  const autoMerge = confirmAutomergeEffectSnapshot(
    {
      pull,
      view: {
        headRefOid: headSha,
        isInMergeQueue: false,
        autoMergeRequest: { mergeMethod: "SQUASH" },
      },
    },
    headSha,
  );
  assert.equal(autoMerge.pendingReason, `reviewed head ${headSha} has auto-merge pending`);
  assert.equal(automergeAttemptReceiptOutcome({ confirmation: autoMerge }), "accepted");
});

test("automerge effect certification preserves uncertainty for conflicting head observations", () => {
  const confirmation = confirmAutomergeEffectSnapshot(
    {
      pull: { head: { sha: headSha }, merged_at: null },
      view: { headRefOid: "b".repeat(40), isInMergeQueue: true },
    },
    headSha,
  );
  assert.equal(
    confirmation.block,
    "pull request head changed before the automerge effect could be confirmed",
  );
  assert.equal(automergeAttemptReceiptOutcome({ confirmation }), "unknown");
});

test("transient unconfirmed merge responses remain waiting with unknown receipts", () => {
  const attempt = {
    command_result: {
      status: 1,
      stdout: "",
      stderr: "gh: HTTP 502: Bad Gateway",
      error: null,
    },
    command_error: null,
    confirmation: {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: "",
    },
  };
  assert.equal(automergeUnconfirmedFailureDisposition(attempt), "waiting");
  assert.equal(automergeAttemptReceiptOutcome(attempt), "unknown");
});

test("definitive unconfirmed merge rejection closes the mutation receipt", () => {
  const attempt = {
    command_result: {
      status: 1,
      stdout: "",
      stderr: "GraphQL: Pull Request is not mergeable (mergePullRequest)",
      error: null,
    },
    command_error: null,
    confirmation: {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: "",
    },
  };
  assert.equal(automergeUnconfirmedFailureDisposition(attempt), "blocked");
  assert.equal(automergeAttemptReceiptOutcome(attempt), "rejected");
});
