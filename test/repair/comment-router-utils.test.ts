import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELETED_DURABLE_COMMENT_VERSION_REASON,
  EDITED_DURABLE_COMMENT_VERSION_REASON,
  SUPERSEDED_RE_REVIEW_REASON,
  appendLedger,
  commentBodySha256,
  dispatchClaimDecision,
  dispatchClaimLookupKeys,
  dispatchReceiptKeyMaterial,
  durableForcedReplayCommentIds,
  exactCommentVersionFastPathDecision,
  exactCommentVersionMatchesLive,
  finalizeRouterItemFanout,
  hasSuccessfulDispatchExecutionJob,
  isGitHubAppIntegrationAuthError,
  isAllowedMutationActor,
  mergeCommentRouterLedgers,
  normalizeGitHubActor,
  parseRepairLoopSweepCommandId,
  readLedger,
  reconcileDurableCommentVersions,
  repairLoopSweepAttemptIdentity,
  routerDispatchReceiptKey,
  routerCommandNeedsExactLane,
  routerFanoutItemNumbers,
  routerPendingItemNumbers,
  selectCommentsForRouting,
  selectRouterCommentItemPage,
  selectRouterItemFanoutPage,
  shouldSuppressProcessedCommentVersion,
  sortCommentsForRouting,
  stageForcedReplayCommands,
  stageSelectedRouterCommands,
  supersededReReviewCommentVersions,
  summarizeChecks,
  writeLedger,
} from "../../dist/repair/comment-router-utils.js";
import { forcedReplayCommandFields, readCommentRouterConfig } from "../../dist/repair/config.js";

const COMMENT_ROUTER_LEDGER_ENTRY_LIMIT = 1000;

function routerLedgerEntry(index: number, status: "waiting" | "claimed" | "executed") {
  const commentId = String(index + 1);
  return {
    idempotency_key: `command-${commentId}`,
    comment_id: commentId,
    comment_version_key: `${commentId}:2026-07-12T20:00:00Z`,
    comment_updated_at: "2026-07-12T20:00:00Z",
    processed_at: new Date(Date.UTC(2026, 6, 12, 20, 0, index)).toISOString(),
    repo: "openclaw/openclaw",
    issue_number: index + 1,
    status,
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status }],
  };
}

test("exact terminal comment versions short-circuit duplicate created deliveries", () => {
  const body = "@clawsweeper re-review";
  const ledger = exactVersionLedger({
    status: "executed",
    body,
  });

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256(body),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
    }),
    {
      suppress: true,
      reason: "exact_terminal_comment_version",
      commentVersionKey: "456:2026-07-12T20:00:00Z",
      status: "executed",
    },
  );
});

test("edited comments and changed body bytes always use the full router path", () => {
  const ledger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
  });

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "edited",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:01:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review with new context"),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
    }),
    { suppress: false, reason: "edited_or_unknown_action" },
  );
  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review with changed bytes"),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
    }),
    { suppress: false, reason: "body_digest_mismatch" },
  );
});

test("terminal cleanup requires the same live comment version", () => {
  const body = "@clawsweeper re-review";
  const command = {
    comment_id: "456",
    comment_updated_at: "2026-07-12T20:00:00Z",
    comment_body_sha256: commentBodySha256(body),
  };

  assert.equal(
    exactCommentVersionMatchesLive(command, {
      id: 456,
      updated_at: "2026-07-12T20:00:00Z",
      body,
    }),
    true,
  );
  assert.equal(
    exactCommentVersionMatchesLive(command, {
      id: 456,
      updated_at: "2026-07-12T20:01:00Z",
      body: `${body} now`,
    }),
    false,
  );
});

test("missing timestamps or authenticated provenance use the full router path", () => {
  const ledger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
  });
  const base = {
    sourceAction: "created",
    targetRepo: "openclaw/openclaw",
    commentId: 456,
    commentUpdatedAt: "2026-07-12T20:00:00Z",
    commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
    forceReprocess: false,
    ledger,
    verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
  };

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      ...base,
      authenticated: true,
      commentUpdatedAt: null,
    }),
    { suppress: false, reason: "incomplete_exact_version" },
  );
  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      ...base,
      authenticated: false,
    }),
    { suppress: false, reason: "auth_uncertain" },
  );
});

test("retryable claims and failed action leases are never short-circuited", () => {
  for (const status of ["waiting", "claimed"]) {
    const ledger = exactVersionLedger({
      status,
      body: "@clawsweeper re-review",
      actions: [{ action: "dispatch_clawsweeper", status }],
    });
    assert.deepEqual(
      exactCommentVersionFastPathDecision({
        authenticated: true,
        sourceAction: "created",
        targetRepo: "openclaw/openclaw",
        commentId: 456,
        commentUpdatedAt: "2026-07-12T20:00:00Z",
        commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
        forceReprocess: false,
        ledger,
        verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
      }),
      { suppress: false, reason: "version_retryable" },
    );
  }

  const failedLedger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
    actions: [{ action: "dispatch_clawsweeper", status: "failed" }],
  });
  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
      forceReprocess: false,
      ledger: failedLedger,
      verificationLedgers: [structuredClone(failedLedger), structuredClone(failedLedger)],
    }),
    { suppress: false, reason: "lease_uncertain" },
  );
});

test("concurrent ledger changes fail closed to the full router path", () => {
  const ledger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
  });
  const changedLedger = structuredClone(ledger);
  changedLedger.updated_at = "2026-07-12T20:01:00Z";

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), changedLedger],
    }),
    { suppress: false, reason: "state_drift" },
  );
});

test("synthetic dispatch claims retain a stable idempotency lookup across router runs", () => {
  const idempotencyKey = "repair-loop-label-sweep:openclaw/openclaw:automerge:74499";
  const first = dispatchClaimLookupKeys({
    idempotency_key: idempotencyKey,
    comment_id: "repair-loop-label-sweep:automerge:74499",
    comment_updated_at: "2026-04-29T03:01:00Z",
  });
  const replay = dispatchClaimLookupKeys({
    idempotency_key: idempotencyKey,
    comment_id: "repair-loop-label-sweep:automerge:74499",
    comment_updated_at: "2026-04-29T03:06:00Z",
  });

  assert.deepEqual(
    first.filter((key) => replay.includes(key)),
    [`idempotency:${idempotencyKey}`],
  );
});

test("forced replay attempts scope durable dispatch claims", () => {
  const command = {
    idempotency_key: "comment-router:openclaw/openclaw:74499:101:re_review",
    comment_id: "101",
    comment_updated_at: "2026-07-12T20:00:00Z",
  };

  assert.deepEqual(
    dispatchClaimLookupKeys({ ...command, forced_replay: true, attempt_id: "attempt-a" }),
    [
      'forced-replay:["comment:101:2026-07-12T20:00:00Z","attempt-a"]',
      'forced-replay:["idempotency:comment-router:openclaw/openclaw:74499:101:re_review","attempt-a"]',
    ],
  );
  assert.notDeepEqual(
    dispatchClaimLookupKeys({ ...command, forced_replay: true, attempt_id: "attempt-a" }),
    dispatchClaimLookupKeys({ ...command, forced_replay: true, attempt_id: "attempt-b" }),
  );
});

test("synthetic repair-loop command ids parse only exact positive item targets", () => {
  assert.deepEqual(parseRepairLoopSweepCommandId("repair-loop-label-sweep:AUTOMERGE:74499"), {
    intent: "automerge",
    number: 74499,
    commentId: "repair-loop-label-sweep:automerge:74499",
  });
  assert.deepEqual(parseRepairLoopSweepCommandId("repair-loop-label-sweep:autofix:1"), {
    intent: "autofix",
    number: 1,
    commentId: "repair-loop-label-sweep:autofix:1",
  });
  for (const invalid of [
    "repair-loop-label-sweep:automerge:0",
    "repair-loop-label-sweep:autofix:-1",
    "repair-loop-label-sweep:review:74499",
    "repair-loop-label-sweep:automerge:74499:extra",
    "74499",
  ]) {
    assert.equal(parseRepairLoopSweepCommandId(invalid), null);
  }
});

test("combined router item fanout stays bounded across continuations without starvation", () => {
  const candidates = [46, 43, 42, 45, 42, 44];
  const pages = [];
  let after: number | null = null;
  do {
    const page = selectRouterItemFanoutPage({
      itemNumbers: candidates,
      after,
      limit: 2,
    });
    pages.push(page);
    after = page.nextAfterItemNumber;
  } while (after !== null);

  assert.deepEqual(
    pages.map((page) => page.itemNumbers),
    [[42, 43], [44, 45], [46]],
  );
  assert.ok(pages.every((page) => page.itemNumbers.length <= 2));
  assert.deepEqual(
    pages.flatMap((page) => page.itemNumbers),
    [42, 43, 44, 45, 46],
  );
});

test("broad comment discovery pages distinct items before applying comment budgets", () => {
  const hotItemComments = Array.from({ length: 250 }, (_, index) => ({
    id: 10_000 - index,
    issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/42",
    updated_at: new Date(Date.UTC(2026, 6, 12, 20, 0, 0) - index * 1_000).toISOString(),
  }));
  const olderQuietItem = {
    id: 1,
    issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/43",
    updated_at: "2026-07-11T20:00:00Z",
  };
  const comments = [...hotItemComments, olderQuietItem];

  const first = selectRouterCommentItemPage({
    comments,
    after: null,
    limit: 1,
  });
  const second = selectRouterCommentItemPage({
    comments,
    after: first.nextAfterItemNumber,
    limit: 1,
  });

  assert.deepEqual(first, {
    itemNumbers: [42],
    candidateCount: 2,
    nextAfterItemNumber: 42,
  });
  assert.deepEqual(second, {
    itemNumbers: [43],
    candidateCount: 1,
    nextAfterItemNumber: null,
  });
});

test("router item fanout reports only final actionable selections", () => {
  const commands = [
    { issue_number: 42, status: "ready", actions: [] },
    { issue_number: 43, status: "skipped", actions: [] },
    { issue_number: 44, status: "waiting", actions: [{ status: "waiting" }] },
  ];
  const page = selectRouterItemFanoutPage({
    itemNumbers: [42, 43, 44],
    after: null,
    limit: 2,
  });

  assert.deepEqual(routerFanoutItemNumbers(commands), [42, 44]);
  assert.equal(routerCommandNeedsExactLane(commands[1]), false);
  assert.deepEqual(finalizeRouterItemFanout(page, commands, 2), {
    limit: 2,
    candidate_count: 3,
    examined_count: 2,
    selected_count: 1,
    selected_item_numbers: [42],
    next_after_item_number: 43,
  });
});

test("synthetic dispatch receipt material is stable within an attempt and changes next attempt", () => {
  const command = {
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:automerge:74499",
    automation_source: "repair_loop_label_sweep",
    comment_updated_at: "2026-04-29T03:01:00Z",
  };
  const firstClaim = { processed_at: "2026-04-29T03:01:01Z" };
  const replayedClaim = { processed_at: "2026-04-29T03:01:01Z" };
  const nextClaim = { processed_at: "2026-04-29T04:15:00Z" };

  assert.equal(
    dispatchReceiptKeyMaterial(command, firstClaim),
    dispatchReceiptKeyMaterial(command, replayedClaim),
  );
  assert.notEqual(
    dispatchReceiptKeyMaterial(command, firstClaim),
    dispatchReceiptKeyMaterial(command, nextClaim),
  );

  const firstAttempt = { ...command, attempt_id: "synthetic-attempt-1" };
  const secondAttempt = { ...command, attempt_id: "synthetic-attempt-2" };
  assert.equal(
    dispatchReceiptKeyMaterial(firstAttempt, firstClaim),
    dispatchReceiptKeyMaterial(firstAttempt, nextClaim),
  );
  assert.notEqual(
    dispatchReceiptKeyMaterial(firstAttempt, firstClaim),
    dispatchReceiptKeyMaterial(secondAttempt, firstClaim),
  );
  assert.equal(
    dispatchReceiptKeyMaterial(firstAttempt, firstClaim),
    `${command.idempotency_key}:attempt:synthetic-attempt-1`,
  );
});

test("repair-loop sweeps reuse one active attempt and advance only after terminal state", () => {
  const idempotencyKey = "repair-loop-label-sweep:openclaw/openclaw:automerge:74499";
  const first = repairLoopSweepAttemptIdentity({ commands: [], idempotencyKey });
  const repeatedFirst = repairLoopSweepAttemptIdentity({ commands: [], idempotencyKey });

  assert.equal(first.attemptSequence, 1);
  assert.match(first.attemptId, /^[a-f0-9]{64}$/);
  assert.deepEqual(repeatedFirst, first);

  const activeFirst = {
    idempotency_key: idempotencyKey,
    automation_source: "repair_loop_label_sweep",
    attempt_id: first.attemptId,
    attempt_sequence: first.attemptSequence,
    status: "waiting",
    processed_at: "2026-07-12T20:00:00Z",
  };
  assert.deepEqual(
    repairLoopSweepAttemptIdentity({ commands: [activeFirst], idempotencyKey }),
    first,
  );

  const terminalFirst = { ...activeFirst, status: "executed" };
  const second = repairLoopSweepAttemptIdentity({
    commands: [terminalFirst],
    idempotencyKey,
  });
  const repeatedSecond = repairLoopSweepAttemptIdentity({
    commands: [terminalFirst],
    idempotencyKey,
  });
  assert.equal(second.attemptSequence, 2);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.deepEqual(repeatedSecond, second);
  assert.deepEqual(
    repairLoopSweepAttemptIdentity({
      commands: [
        terminalFirst,
        {
          ...activeFirst,
          attempt_id: second.attemptId,
          attempt_sequence: second.attemptSequence,
          status: "claimed",
          processed_at: "2026-07-12T21:00:00Z",
        },
      ],
      idempotencyKey,
    }),
    second,
  );
});

test("production forced replay parsing scopes claims and dispatch keys by durable attempt", () => {
  const baseArgs = {
    repo: "openclaw/openclaw",
    "repair-repo": "openclaw/clawsweeper",
    "review-repo": "openclaw/clawsweeper",
  };
  const baseCommand = {
    idempotency_key:
      "clawsweeper-repair:openclaw/openclaw:74499:991122:2026-07-12T20:00:00Z:automerge",
    comment_id: "991122",
    comment_updated_at: "2026-07-12T20:00:00Z",
  };
  const forcedCommand = (attemptId: string) => ({
    ...baseCommand,
    ...forcedReplayCommandFields(
      readCommentRouterConfig({
        ...baseArgs,
        "force-reprocess": true,
        "attempt-id": attemptId,
      }),
    ),
  });

  const first = forcedCommand("forced-replay-41001");
  const firstRetry = forcedCommand("forced-replay-41001");
  const second = forcedCommand("forced-replay-41002");
  assert.deepEqual(dispatchClaimLookupKeys(first), dispatchClaimLookupKeys(firstRetry));
  assert.equal(routerDispatchReceiptKey(first, null), routerDispatchReceiptKey(firstRetry, null));
  assert.deepEqual(
    dispatchClaimLookupKeys(first).filter((key) => dispatchClaimLookupKeys(second).includes(key)),
    [],
  );
  assert.notEqual(routerDispatchReceiptKey(first, null), routerDispatchReceiptKey(second, null));

  const normalReplay = { ...baseCommand, processed_at: "2026-07-12T20:05:00Z" };
  assert.deepEqual(dispatchClaimLookupKeys(baseCommand), dispatchClaimLookupKeys(normalReplay));
  assert.equal(
    routerDispatchReceiptKey(baseCommand, null),
    routerDispatchReceiptKey(normalReplay, null),
  );
});

test("synthetic dispatch attempt replaces its durable claim in the ledger", () => {
  const ledger = { updated_at: null, commands: [] };
  const base = {
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:automerge:74499",
    comment_id: "repair-loop-label-sweep:automerge:74499",
    comment_version_key: null,
    automation_source: "repair_loop_label_sweep",
    repo: "openclaw/openclaw",
    issue_number: 74499,
    intent: "automerge",
    attempt_id: "synthetic-attempt-1",
    attempt_sequence: 1,
  };

  assert.equal(
    appendLedger(ledger, [
      {
        ...base,
        comment_updated_at: "2026-04-29T03:01:00Z",
        processed_at: "2026-04-29T03:01:01Z",
        status: "claimed",
      },
    ]),
    true,
  );
  assert.equal(
    appendLedger(ledger, [
      {
        ...base,
        comment_updated_at: "2026-04-29T03:06:00Z",
        processed_at: "2026-04-29T03:01:01Z",
        status: "executed",
      },
    ]),
    true,
  );
  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0]?.status, "executed");
  assert.equal(ledger.commands[0]?.attempt_sequence, 1);
});

test("edited and deleted staged comment versions resolve terminally before dispatch", () => {
  const staged = {
    idempotency_key: "comment-router:openclaw/openclaw:42:123:old:re_review",
    comment_id: "123",
    comment_version_key: "123:2026-07-12T20:00:00Z",
    comment_updated_at: "2026-07-12T20:00:00Z",
    comment_body_sha256: commentBodySha256("@clawsweeper re-review"),
    repo: "openclaw/openclaw",
    issue_number: 42,
    intent: "re_review",
    status: "waiting",
    actions: [{ action: "dispatch_clawsweeper", status: "waiting" }],
  };
  const edited = {
    id: 123,
    updated_at: "2026-07-12T20:05:00Z",
    body: "never mind",
  };
  const editedResolution = reconcileDurableCommentVersions({
    commands: [staged],
    liveComments: new Map([["123", edited]]),
    repo: "openclaw/openclaw",
    itemNumbers: new Set([42]),
    processedAt: "2026-07-12T20:06:00Z",
  });

  assert.deepEqual(editedResolution.pendingComments, []);
  assert.deepEqual(editedResolution.suppressedCommentIds, ["123"]);
  assert.equal(editedResolution.resolutions[0]?.status, "skipped");
  assert.equal(
    editedResolution.resolutions[0]?.resolution_reason,
    EDITED_DURABLE_COMMENT_VERSION_REASON,
  );
  assert.equal(editedResolution.resolutions[0]?.actions[0]?.status, "skipped");

  const ledger = { updated_at: null, commands: [] };
  appendLedger(ledger, [staged]);
  appendLedger(ledger, editedResolution.resolutions);
  assert.equal(ledger.commands[0]?.status, "skipped");
  assert.equal(ledger.commands[0]?.resolution_reason, EDITED_DURABLE_COMMENT_VERSION_REASON);

  const current = {
    ...staged,
    idempotency_key: "comment-router:openclaw/openclaw:42:123:current:re_review",
    comment_version_key: "123:2026-07-12T20:05:00Z",
    comment_updated_at: "2026-07-12T20:05:00Z",
    comment_body_sha256: commentBodySha256("never mind"),
  };
  const currentResolution = reconcileDurableCommentVersions({
    commands: [...ledger.commands, current],
    liveComments: new Map([["123", edited]]),
    repo: "openclaw/openclaw",
    itemNumbers: new Set([42]),
  });
  assert.deepEqual(currentResolution.pendingComments, [edited]);
  assert.deepEqual(currentResolution.resolutions, []);
  assert.deepEqual(currentResolution.suppressedCommentIds, []);

  const deleted = reconcileDurableCommentVersions({
    commands: [{ ...staged, comment_id: "124", comment_version_key: "124:old" }],
    liveComments: new Map([["124", null]]),
    repo: "openclaw/openclaw",
    itemNumbers: new Set([42]),
    processedAt: "2026-07-12T20:07:00Z",
  });
  assert.equal(deleted.resolutions[0]?.status, "skipped");
  assert.equal(deleted.resolutions[0]?.resolution_reason, DELETED_DURABLE_COMMENT_VERSION_REASON);
  assert.deepEqual(deleted.suppressedCommentIds, ["124"]);
});

test("coalesced same-item forced replays recover every durable pending comment", () => {
  const command = (commentId: string, updatedAt: string) => ({
    idempotency_key: `comment-router:openclaw/openclaw:74499:${commentId}:${updatedAt}:re_review`,
    comment_id: commentId,
    comment_version_key: `${commentId}:${updatedAt}`,
    comment_updated_at: updatedAt,
    repo: "openclaw/openclaw",
    issue_number: 74499,
    status: "ready",
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "planned" }],
  });
  const first = { updated_at: null, commands: [] };
  const second = { updated_at: null, commands: [] };
  appendLedger(
    first,
    stageForcedReplayCommands([command("101", "2026-07-12T20:01:00Z")], "forced-replay-41001"),
  );
  appendLedger(
    second,
    stageForcedReplayCommands([command("102", "2026-07-12T20:02:00Z")], "forced-replay-41002"),
  );

  const merged = mergeCommentRouterLedgers(first, second);
  assert.deepEqual(routerPendingItemNumbers(merged.commands, "openclaw/openclaw"), [74499]);
  assert.deepEqual(
    durableForcedReplayCommentIds({
      commands: merged.commands,
      repo: "openclaw/openclaw",
      itemNumbers: new Set([74499]),
    }),
    ["101", "102"],
  );
  assert.deepEqual(
    merged.commands.map((entry) => [
      entry.comment_id,
      entry.status,
      entry.forced_replay,
      entry.attempt_id,
      entry.actions[0]?.status,
    ]),
    [
      ["101", "waiting", true, "forced-replay-41001", "waiting"],
      ["102", "waiting", true, "forced-replay-41002", "waiting"],
    ],
  );
});

test("selected fanout commands are staged durably and idempotently before dispatch", () => {
  const commands = [42, 43, 44].map((issueNumber) => ({
    idempotency_key: `command-${issueNumber}`,
    comment_id: String(1000 + issueNumber),
    comment_version_key: `${1000 + issueNumber}:2026-07-12T20:00:00Z`,
    comment_updated_at: "2026-07-12T20:00:00Z",
    status_comment_id: 2000 + issueNumber,
    repo: "openclaw/openclaw",
    issue_number: issueNumber,
    status: "ready",
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "planned" }],
  }));
  const ledger = { updated_at: null, commands: [] };
  const staged = stageSelectedRouterCommands({
    commands,
    selectedItemNumbers: new Set([42, 43]),
    processedAt: "2026-07-12T20:01:00Z",
    dispatchContext: {
      target_branch: "main",
      runner: "blacksmith-4vcpu-ubuntu-2404",
      execution_runner: "blacksmith-16vcpu-ubuntu-2404",
      since: "2026-07-12T19:00:00Z",
    },
  });

  assert.deepEqual(
    staged.map((entry) => [entry.issue_number, entry.status, entry.actions[0]?.status]),
    [
      [42, "waiting", "waiting"],
      [43, "waiting", "waiting"],
    ],
  );
  assert.equal(appendLedger(ledger, staged), true);
  assert.equal(appendLedger(ledger, staged), false);
  assert.deepEqual(routerPendingItemNumbers(ledger.commands, "openclaw/openclaw"), [42, 43]);
  assert.deepEqual(ledger.commands[0].dispatch_context, {
    target_branch: "main",
    runner: "blacksmith-4vcpu-ubuntu-2404",
    execution_runner: "blacksmith-16vcpu-ubuntu-2404",
    since: "2026-07-12T19:00:00Z",
  });
  assert.equal(ledger.commands[0].status_comment_id, 2042);
});

test("restaging preserves an existing dispatch claim and its recovery timestamp", () => {
  const command = {
    idempotency_key: "command-42",
    comment_id: "1042",
    comment_version_key: "1042:2026-07-12T20:00:00Z",
    comment_updated_at: "2026-07-12T20:00:00Z",
    repo: "openclaw/openclaw",
    issue_number: 42,
    status: "ready",
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "planned" }],
  };
  const claim = {
    ...command,
    status: "claimed",
    processed_at: "2026-07-12T20:01:00Z",
    dispatch_receipt: "router-receipt",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };

  const [staged] = stageSelectedRouterCommands({
    commands: [command],
    selectedItemNumbers: new Set([42]),
    claimedCommands: [claim],
    processedAt: "2026-07-12T20:05:00Z",
  });

  assert.deepEqual(staged, claim);
});

test("continuation staging cannot downgrade an exact-lane terminal result", () => {
  const command = {
    idempotency_key: "command-42",
    comment_id: "1042",
    comment_version_key: "1042:2026-07-12T20:00:00Z",
    comment_updated_at: "2026-07-12T20:00:00Z",
    repo: "openclaw/openclaw",
    issue_number: 42,
    status: "ready",
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "planned" }],
  };
  const continuation = { updated_at: null, commands: [] };
  const exactLane = { updated_at: null, commands: [] };
  appendLedger(
    continuation,
    stageSelectedRouterCommands({
      commands: [command],
      selectedItemNumbers: new Set([42]),
      forcedReplay: true,
      attemptId: "forced-replay-41001",
      processedAt: "2026-07-12T20:05:00Z",
    }),
  );
  appendLedger(exactLane, [
    {
      ...command,
      status: "executed",
      processed_at: "2026-07-12T20:04:00Z",
      actions: [{ action: "dispatch_clawsweeper", status: "executed" }],
    },
  ]);

  const merged = mergeCommentRouterLedgers(continuation, exactLane);
  assert.equal(merged.commands[0]?.status, "executed");
  assert.equal(merged.commands[0]?.actions[0]?.status, "executed");
});

test("forced replay staging fails closed without a durable attempt id", () => {
  assert.throws(
    () =>
      stageSelectedRouterCommands({
        commands: [],
        selectedItemNumbers: new Set(),
        forcedReplay: true,
      }),
    /requires an attempt id/,
  );
});

test("new forced replay attempts survive terminal history for the same comment version", () => {
  const command = {
    idempotency_key: "command-42",
    comment_id: "1042",
    comment_version_key: "1042:2026-07-12T20:00:00Z",
    comment_updated_at: "2026-07-12T20:00:00Z",
    repo: "openclaw/openclaw",
    issue_number: 42,
    status: "ready",
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "planned" }],
  };
  const terminal = { updated_at: null, commands: [] };
  const forcedReplay = { updated_at: null, commands: [] };
  appendLedger(terminal, [
    {
      ...command,
      status: "executed",
      processed_at: "2026-07-12T20:04:00Z",
      actions: [{ action: "dispatch_clawsweeper", status: "executed" }],
    },
  ]);
  appendLedger(
    forcedReplay,
    stageSelectedRouterCommands({
      commands: [command],
      selectedItemNumbers: new Set([42]),
      forcedReplay: true,
      processedAt: "2026-07-12T20:05:00Z",
      attemptId: "forced-attempt-2",
    }),
  );

  const merged = mergeCommentRouterLedgers(terminal, forcedReplay);
  assert.deepEqual(
    merged.commands.map((entry) => [entry.status, entry.attempt_id ?? null]),
    [
      ["executed", null],
      ["waiting", "forced-attempt-2"],
    ],
  );
  assert.deepEqual(
    durableForcedReplayCommentIds({
      commands: merged.commands,
      repo: "openclaw/openclaw",
      itemNumbers: new Set([42]),
    }),
    ["1042"],
  );
});

test("one coalesced forced execution completes every pending attempt identity", () => {
  const ledger = { updated_at: null, commands: [] };
  appendLedger(ledger, [
    {
      idempotency_key: "command-42",
      comment_id: "1042",
      comment_version_key: "1042:2026-07-12T20:00:00Z",
      comment_updated_at: "2026-07-12T20:00:00Z",
      repo: "openclaw/openclaw",
      issue_number: 42,
      status: "executed",
      intent: "re_review",
      forced_replay: true,
      attempt_id: "forced-attempt-2",
      forced_replay_attempt_ids: ["forced-attempt-1", "forced-attempt-2"],
      actions: [{ action: "dispatch_clawsweeper", status: "executed" }],
    },
  ]);

  assert.deepEqual(
    ledger.commands.map((entry) => [entry.status, entry.attempt_id]),
    [
      ["executed", "forced-attempt-1"],
      ["executed", "forced-attempt-2"],
    ],
  );
});

test("comment router ledger merge preserves disjoint claims and terminal progress", () => {
  const firstClaim = {
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:autofix:101",
    comment_id: "repair-loop-label-sweep:autofix:101",
    comment_version_key: null,
    automation_source: "repair_loop_label_sweep",
    issue_number: 101,
    attempt_id: "autofix-attempt-1",
    attempt_sequence: 1,
    status: "claimed",
    processed_at: "2026-07-12T20:00:00Z",
  };
  const secondClaim = {
    ...firstClaim,
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:automerge:202",
    comment_id: "repair-loop-label-sweep:automerge:202",
    issue_number: 202,
  };
  const executedFirstClaim = { ...firstClaim, status: "executed" };
  const nextFirstAttempt = {
    ...firstClaim,
    attempt_id: "autofix-attempt-2",
    attempt_sequence: 2,
    status: "claimed",
    processed_at: "2026-07-12T21:00:00Z",
  };
  const left = {
    updated_at: "2026-07-12T20:01:00Z",
    commands: [firstClaim, secondClaim],
  };
  const right = {
    updated_at: "2026-07-12T21:01:00Z",
    commands: [executedFirstClaim, nextFirstAttempt],
  };

  const merged = mergeCommentRouterLedgers(left, right);
  const reversed = mergeCommentRouterLedgers(right, left);

  assert.deepEqual(merged, reversed);
  assert.equal(merged.updated_at, "2026-07-12T21:01:00Z");
  assert.deepEqual(
    merged.commands.map((entry) => [
      entry.issue_number,
      entry.status,
      entry.attempt_id,
      entry.processed_at,
    ]),
    [
      [101, "executed", "autofix-attempt-1", "2026-07-12T20:00:00Z"],
      [202, "claimed", "autofix-attempt-1", "2026-07-12T20:00:00Z"],
      [101, "claimed", "autofix-attempt-2", "2026-07-12T21:00:00Z"],
    ],
  );
  assert.equal(
    mergeCommentRouterLedgers(left, {
      updated_at: "2026-07-12T20:02:00Z",
      commands: [executedFirstClaim],
    }).commands.find((entry) => entry.issue_number === 101)?.status,
    "executed",
  );
});

test("ledger append trims terminal history before active commands", () => {
  const waiting = routerLedgerEntry(0, "waiting");
  const terminal = Array.from({ length: COMMENT_ROUTER_LEDGER_ENTRY_LIMIT - 1 }, (_, index) =>
    routerLedgerEntry(index + 1, "executed"),
  );
  const ledger = {
    updated_at: null,
    commands: [waiting, ...terminal],
  };
  const newestTerminal = routerLedgerEntry(COMMENT_ROUTER_LEDGER_ENTRY_LIMIT, "executed");

  assert.equal(appendLedger(ledger, [newestTerminal]), true);
  assert.equal(ledger.commands.length, COMMENT_ROUTER_LEDGER_ENTRY_LIMIT);
  assert.equal(
    ledger.commands.some((entry) => entry.comment_id === waiting.comment_id),
    true,
  );
  assert.equal(
    ledger.commands.some((entry) => entry.comment_id === terminal[0]?.comment_id),
    false,
  );
  assert.equal(
    ledger.commands.some((entry) => entry.comment_id === newestTerminal.comment_id),
    true,
  );
});

test("ledger merge trims terminal history before active commands", () => {
  const waiting = routerLedgerEntry(0, "claimed");
  const terminal = Array.from({ length: COMMENT_ROUTER_LEDGER_ENTRY_LIMIT - 1 }, (_, index) =>
    routerLedgerEntry(index + 1, "executed"),
  );
  const newestTerminal = routerLedgerEntry(COMMENT_ROUTER_LEDGER_ENTRY_LIMIT, "executed");

  const merged = mergeCommentRouterLedgers(
    { updated_at: null, commands: [waiting, ...terminal] },
    { updated_at: null, commands: [newestTerminal] },
  );

  assert.equal(merged.commands.length, COMMENT_ROUTER_LEDGER_ENTRY_LIMIT);
  assert.equal(
    merged.commands.some((entry) => entry.comment_id === waiting.comment_id),
    true,
  );
  assert.equal(
    merged.commands.some((entry) => entry.comment_id === terminal[0]?.comment_id),
    false,
  );
  assert.equal(
    merged.commands.some((entry) => entry.comment_id === newestTerminal.comment_id),
    true,
  );
});

test("active-only ledger capacity fails closed without dropping work", () => {
  const active = Array.from({ length: COMMENT_ROUTER_LEDGER_ENTRY_LIMIT }, (_, index) =>
    routerLedgerEntry(index, index % 2 === 0 ? "waiting" : "claimed"),
  );
  const terminal = routerLedgerEntry(COMMENT_ROUTER_LEDGER_ENTRY_LIMIT, "executed");
  const appended = { updated_at: null, commands: structuredClone(active) };

  assert.equal(appendLedger(appended, [terminal]), true);
  assert.equal(appended.commands.length, COMMENT_ROUTER_LEDGER_ENTRY_LIMIT);
  assert.equal(
    appended.commands.every((entry) => entry.status !== "executed"),
    true,
  );

  const merged = mergeCommentRouterLedgers(
    { updated_at: null, commands: active },
    { updated_at: null, commands: [terminal] },
  );
  assert.equal(merged.commands.length, COMMENT_ROUTER_LEDGER_ENTRY_LIMIT);
  assert.equal(
    merged.commands.every((entry) => entry.status !== "executed"),
    true,
  );

  const overflow = routerLedgerEntry(COMMENT_ROUTER_LEDGER_ENTRY_LIMIT, "waiting");
  const appendOverflow = { updated_at: null, commands: structuredClone(active) };
  assert.throws(
    () => appendLedger(appendOverflow, [overflow]),
    /comment router ledger has 1001 active commands; maximum is 1000/,
  );
  assert.equal(appendOverflow.updated_at, null);
  assert.deepEqual(appendOverflow.commands, active);
  assert.throws(
    () =>
      mergeCommentRouterLedgers(
        { updated_at: null, commands: active },
        { updated_at: null, commands: [overflow] },
      ),
    /comment router ledger has 1001 active commands; maximum is 1000/,
  );
});

test("newer re-review commands supersede older retries from the same requester", () => {
  const commands = [
    {
      repo: "openclaw/gogcli",
      issue_number: 749,
      author_id: 58493,
      intent: "re_review",
      comment_id: "4679061453",
      comment_version_key: "4679061453:2026-06-11T09:20:23Z",
      comment_updated_at: "2026-06-11T09:20:23Z",
    },
    {
      repo: "openclaw/gogcli",
      issue_number: 749,
      author_id: 58493,
      intent: "re_review",
      comment_id: "4679167308",
      comment_version_key: "4679167308:2026-06-11T09:33:21Z",
      comment_updated_at: "2026-06-11T09:33:21Z",
    },
    {
      repo: "openclaw/gogcli",
      issue_number: 749,
      author_id: 999,
      intent: "re_review",
      comment_id: "4679167400",
      comment_version_key: "4679167400:2026-06-11T09:34:00Z",
      comment_updated_at: "2026-06-11T09:34:00Z",
    },
  ];

  assert.deepEqual(
    [...supersededReReviewCommentVersions(commands)],
    ["4679061453:2026-06-11T09:20:23Z"],
  );
});

test("superseded re-review commands become terminal ledger entries", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "superseded",
        comment_id: "4679061453",
        comment_version_key: "4679061453:2026-06-11T09:20:23Z",
        comment_updated_at: "2026-06-11T09:20:23Z",
        status: "skipped",
        reason: SUPERSEDED_RE_REVIEW_REASON,
        intent: "re_review",
        issue_number: 749,
        repo: "openclaw/gogcli",
      },
    ]),
    true,
  );
  assert.equal(ledger.commands.length, 1);
});

test("appendLedger keeps edited comment versions separate", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "first",
      comment_id: "123",
      comment_version_key: "123:2026-04-29T01:00:00Z",
      comment_updated_at: "2026-04-29T01:00:00Z",
      status: "executed",
      intent: "clawsweeper_auto_repair",
      issue_number: 74075,
      repo: "openclaw/openclaw",
    },
    {
      idempotency_key: "second",
      comment_id: "123",
      comment_version_key: "123:2026-04-29T02:00:00Z",
      comment_updated_at: "2026-04-29T02:00:00Z",
      status: "executed",
      intent: "clawsweeper_auto_repair",
      issue_number: 74075,
      repo: "openclaw/openclaw",
    },
  ]);

  assert.equal(ledger.commands.length, 2);
  assert.deepEqual(
    ledger.commands.map((entry) => entry.comment_version_key),
    ["123:2026-04-29T01:00:00Z", "123:2026-04-29T02:00:00Z"],
  );
});

test("appendLedger records waiting commands without making them terminal", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "transient",
        comment_id: "124",
        comment_version_key: "124:2026-04-29T03:00:00Z",
        comment_updated_at: "2026-04-29T03:00:00Z",
        status: "waiting",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].status, "waiting");
  assert.equal(shouldSuppressProcessedCommentVersion(ledger.commands[0]), false);
});

test("appendLedger records claimed dispatch commands as recoverable idempotency claims", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "claim-before-dispatch",
        comment_id: "125",
        comment_version_key: "125:2026-04-29T03:01:00Z",
        comment_updated_at: "2026-04-29T03:01:00Z",
        status: "claimed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
        actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].status, "claimed");
  assert.equal(shouldSuppressProcessedCommentVersion(ledger.commands[0]), false);
  assert.deepEqual(ledger.commands[0].actions, [
    {
      action: "dispatch_clawsweeper",
      status: "claimed",
      label: null,
      job_path: null,
    },
  ]);
});

test("forced replay claims survive ledger interruption without cross-attempt aliases", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const processedAt = "2026-07-12T20:05:00Z";
  const base = {
    idempotency_key:
      "clawsweeper-repair:openclaw/openclaw:74499:991122:2026-07-12T20:00:00Z:automerge",
    comment_id: "991122",
    comment_version_key: "991122:2026-07-12T20:00:00Z",
    comment_updated_at: "2026-07-12T20:00:00Z",
    repo: "openclaw/openclaw",
    issue_number: 74499,
    status: "claimed",
    processed_at: processedAt,
    intent: "automerge",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  const firstAttempt = {
    ...base,
    forced_replay: true,
    attempt_id: "forced-replay-41001",
  };
  const ledger = { updated_at: null, commands: [] };
  assert.equal(appendLedger(ledger, [firstAttempt]), true);
  writeLedger(ledgerPath, ledger);

  const restored = readLedger(ledgerPath);
  assert.equal(restored.commands.length, 1);
  assert.equal(restored.commands[0]?.forced_replay, true);
  assert.equal(restored.commands[0]?.attempt_id, firstAttempt.attempt_id);

  const priorClaims = new Map<string, unknown>();
  for (const claim of restored.commands) {
    for (const key of dispatchClaimLookupKeys(claim)) priorClaims.set(key, claim);
  }
  const claimFor = (command: typeof firstAttempt) =>
    dispatchClaimLookupKeys(command)
      .map((key) => priorClaims.get(key))
      .find(Boolean) ?? null;

  const recoveredClaim = claimFor(firstAttempt);
  assert.equal(recoveredClaim, restored.commands[0]);
  assert.equal(claimFor({ ...base, forced_replay: false, attempt_id: undefined }), null);
  assert.deepEqual(
    dispatchClaimDecision({
      claim: recoveredClaim,
      runs: [],
      expectedTitle: `Review event item openclaw/openclaw#74499 [${routerDispatchReceiptKey(
        firstAttempt,
        recoveredClaim,
      )}]`,
      nowMs: Date.parse("2026-07-12T20:06:00Z"),
    }),
    { action: "wait", run: null },
  );

  assert.equal(
    appendLedger(restored, [{ ...firstAttempt, attempt_id: "forced-replay-41002" }]),
    true,
  );
  assert.equal(restored.commands.length, 2);
  assert.deepEqual(
    restored.commands.map((command) => command.attempt_id),
    ["forced-replay-41001", "forced-replay-41002"],
  );
});

test("refreshed forced replay claims survive bounded ledger trimming and restart", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const commentUpdatedAt = "2026-07-12T20:00:00Z";
  const commands = Array.from({ length: 1000 }, (_, index) => ({
    idempotency_key: `command-${index}`,
    comment_id: String(index),
    comment_version_key: `${index}:${commentUpdatedAt}`,
    comment_updated_at: commentUpdatedAt,
    repo: "openclaw/openclaw",
    issue_number: 74000 + index,
    status: "executed",
    processed_at: "2026-07-12T20:01:00Z",
  }));
  const forcedClaim = {
    ...commands[0],
    status: "claimed",
    processed_at: "2026-07-12T20:05:00Z",
    forced_replay: true,
    attempt_id: "forced-replay-41001",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  const freshClaim = {
    idempotency_key: "command-1000",
    comment_id: "1000",
    comment_version_key: `1000:${commentUpdatedAt}`,
    comment_updated_at: commentUpdatedAt,
    repo: "openclaw/openclaw",
    issue_number: 75000,
    status: "claimed",
    processed_at: "2026-07-12T20:05:00Z",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  const ledger = { updated_at: null, commands };

  assert.equal(appendLedger(ledger, [forcedClaim, freshClaim]), true);
  assert.equal(ledger.commands.length, 1000);
  assert.equal(
    ledger.commands.some((entry) => entry.comment_id === "1"),
    false,
  );
  assert.deepEqual(
    ledger.commands.slice(-2).map((entry) => entry.comment_id),
    ["0", "1000"],
  );
  writeLedger(ledgerPath, ledger);

  const restored = readLedger(ledgerPath);
  const forcedKeys = new Set(dispatchClaimLookupKeys(forcedClaim));
  const recoveredClaim =
    restored.commands.find((entry) =>
      dispatchClaimLookupKeys(entry).some((key) => forcedKeys.has(key)),
    ) ?? null;
  assert.equal(recoveredClaim?.attempt_id, forcedClaim.attempt_id);
  assert.deepEqual(
    dispatchClaimDecision({
      claim: recoveredClaim,
      runs: [],
      expectedTitle: `Review event item openclaw/openclaw#74000 [${routerDispatchReceiptKey(
        forcedClaim,
        recoveredClaim,
      )}]`,
      nowMs: Date.parse("2026-07-12T20:06:00Z"),
    }),
    { action: "wait", run: null },
  );
});

test("atomic ledger writes preserve the previous forced claim across interruption", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const forcedClaim = {
    idempotency_key: "claim-before-dispatch",
    comment_id: "125",
    comment_version_key: "125:2026-07-12T20:00:00Z",
    comment_updated_at: "2026-07-12T20:00:00Z",
    repo: "openclaw/openclaw",
    issue_number: 74499,
    status: "claimed",
    processed_at: "2026-07-12T20:05:00Z",
    forced_replay: true,
    attempt_id: "forced-replay-41001",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  writeLedger(ledgerPath, { updated_at: forcedClaim.processed_at, commands: [forcedClaim] });

  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = (() => {
    throw new Error("simulated interrupted ledger write");
  }) as typeof fs.fsyncSync;
  try {
    assert.throws(
      () => writeLedger(ledgerPath, { updated_at: null, commands: [] }),
      /simulated interrupted ledger write/,
    );
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  fs.writeFileSync(
    path.join(directory, ".comment-router.json.interrupted.tmp"),
    '{"updated_at":null,"commands":[',
  );

  const restored = readLedger(ledgerPath);
  assert.equal(restored.commands.length, 1);
  assert.equal(restored.commands[0]?.attempt_id, forcedClaim.attempt_id);
  assert.deepEqual(
    dispatchClaimDecision({
      claim: restored.commands[0],
      runs: [],
      expectedTitle: `Review event item openclaw/openclaw#74499 [${routerDispatchReceiptKey(
        forcedClaim,
        restored.commands[0],
      )}]`,
      nowMs: Date.parse("2026-07-12T20:06:00Z"),
    }),
    { action: "wait", run: null },
  );
});

test("readLedger initializes only missing files and fails closed on torn state", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.deepEqual(readLedger(ledgerPath), { updated_at: null, commands: [] });

  fs.writeFileSync(ledgerPath, '{"updated_at":null,"commands":[');
  assert.throws(() => readLedger(ledgerPath), /failed to parse comment router ledger/);

  fs.writeFileSync(ledgerPath, "[]");
  assert.throws(() => readLedger(ledgerPath), /ledger must be an object/);

  fs.writeFileSync(ledgerPath, '{"updated_at":null}');
  assert.throws(() => readLedger(ledgerPath), /ledger commands must be an array/);
});

test("readLedger rejects malformed forced replay identity", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = {
    idempotency_key: "claim-before-dispatch",
    comment_id: "125",
    comment_updated_at: "2026-07-12T20:00:00Z",
    status: "claimed",
    processed_at: "2026-07-12T20:05:00Z",
  };

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, forced_replay: true }],
  });
  assert.throws(() => readLedger(ledgerPath), /attempt_id must be a non-empty token/);

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, attempt_id: "forced-replay-41001" }],
  });
  assert.throws(() => readLedger(ledgerPath), /requires forced_replay=true/);

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, forced_replay: "true", attempt_id: "forced-replay-41001" }],
  });
  assert.throws(() => readLedger(ledgerPath), /requires forced_replay=true/);
});

test("readLedger fails closed on malformed claimed state before restart dispatch", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  writeLedger(ledgerPath, {
    updated_at: "2026-07-12T20:05:00Z",
    commands: [
      {
        status: "claimed",
        processed_at: "2026-07-12T20:05:00Z",
        forced_replay: true,
        attempt_id: "forced-replay-41001",
        actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
      },
    ],
  });

  let dispatchReached = false;
  assert.throws(() => {
    const restored = readLedger(ledgerPath);
    dispatchReached = true;
    dispatchClaimDecision({
      claim: restored.commands[0] ?? null,
      runs: [],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
    });
  }, /requires a durable lookup identity/);
  assert.equal(dispatchReached, false);
});

test("readLedger validates compact command entry structure", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "clawsweeper-comment-router-ledger-"));
  const ledgerPath = path.join(directory, "comment-router.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = {
    idempotency_key: "claim-before-dispatch",
    status: "claimed",
    processed_at: "2026-07-12T20:05:00Z",
  };

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, status: "ready" }],
  });
  assert.throws(() => readLedger(ledgerPath), /command status is invalid/);

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, processed_at: "not-a-timestamp" }],
  });
  assert.throws(() => readLedger(ledgerPath), /processed_at must be a valid timestamp/);

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, actions: {} }],
  });
  assert.throws(() => readLedger(ledgerPath), /actions must be an array of objects/);

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [{ ...base, target: [] }],
  });
  assert.throws(() => readLedger(ledgerPath), /target must be an object or null/);

  writeLedger(ledgerPath, {
    updated_at: null,
    commands: [
      base,
      {
        comment_id: "125",
        comment_updated_at: "2026-07-12T20:00:00Z",
        status: "claimed",
        processed_at: "2026-07-12T20:05:00Z",
      },
    ],
  });
  assert.equal(readLedger(ledgerPath).commands.length, 2);
});

test("fresh dispatch claims wait for the Actions receipt visibility window", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
      nowMs: Date.parse("2026-04-29T03:04:00Z"),
    }),
    { action: "wait", run: null },
  );
});

test("dispatch claims recover the exact Actions receipt created after the claim", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };
  const matchingRun = {
    id: 991,
    display_title: "Review event item openclaw/openclaw#74499 [router-abc]",
    created_at: "2026-04-29T03:01:02Z",
    status: "completed",
    conclusion: "success",
  };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [
        {
          id: 990,
          display_title: matchingRun.display_title,
          created_at: "2026-04-29T02:59:00Z",
        },
        matchingRun,
      ],
      expectedTitle: matchingRun.display_title,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "recover", run: matchingRun },
  );
});

test("dispatch claims wait for active receipts and retry terminal failures", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };
  const expectedTitle = "Review event item openclaw/openclaw#74499 [router-abc]";
  const run = {
    id: 991,
    display_title: expectedTitle,
    created_at: "2026-04-29T03:01:02Z",
  };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [{ ...run, status: "in_progress", conclusion: null }],
      expectedTitle,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "wait", run: null },
  );
  for (const conclusion of ["cancelled", "failure", "skipped", "timed_out"]) {
    assert.deepEqual(
      dispatchClaimDecision({
        claim,
        runs: [{ ...run, status: "completed", conclusion }],
        expectedTitle,
        nowMs: Date.parse("2026-04-29T03:10:00Z"),
      }),
      { action: "dispatch", run: null },
    );
  }
});

test("dispatch claim recovery prefers an older success over a newer cancelled duplicate", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };
  const expectedTitle = "Review event item openclaw/openclaw#74499 [router-abc]";
  const successfulRun = {
    id: 991,
    display_title: expectedTitle,
    created_at: "2026-04-29T03:01:02Z",
    status: "completed",
    conclusion: "success",
  };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [
        {
          ...successfulRun,
          id: 992,
          created_at: "2026-04-29T03:02:00Z",
          conclusion: "cancelled",
        },
        successfulRun,
      ],
      expectedTitle,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "recover", run: successfulRun },
  );
});

test("dispatch claims ignore receipt-only duplicate successes", () => {
  const expectedTitle = "Assist openclaw/openclaw#74499 [router-abc]";
  assert.deepEqual(
    dispatchClaimDecision({
      claim: { processed_at: "2026-04-29T03:01:00Z" },
      runs: [
        {
          id: 991,
          display_title: expectedTitle,
          created_at: "2026-04-29T03:01:02Z",
          status: "completed",
          conclusion: "failure",
        },
        {
          id: 992,
          display_title: expectedTitle,
          created_at: "2026-04-29T03:02:00Z",
          status: "completed",
          conclusion: "success",
          dispatch_execution_verified: false,
        },
      ],
      expectedTitle,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
      graceMs: 300_000,
    }),
    { action: "dispatch", run: null },
  );
});

test("dispatch execution verification requires the real worker job to succeed", () => {
  assert.equal(
    hasSuccessfulDispatchExecutionJob(
      [
        { name: "Deduplicate command dispatch receipt", conclusion: "success" },
        { name: "assist", conclusion: "skipped" },
      ],
      "assist",
    ),
    false,
  );
  assert.equal(
    hasSuccessfulDispatchExecutionJob(
      [
        { name: "Deduplicate command dispatch receipt", conclusion: "success" },
        { name: "assist", conclusion: "success" },
      ],
      "assist",
    ),
    true,
  );
});

test("appendLedger refreshes a stale dispatch claim before retry", () => {
  const ledger = { updated_at: null, commands: [] };
  const base = {
    idempotency_key: "claim-before-dispatch",
    comment_id: "125",
    comment_version_key: "125:2026-04-29T03:01:00Z",
    status: "claimed",
    intent: "clawsweeper_re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  appendLedger(ledger, [{ ...base, processed_at: "2026-04-29T03:01:00Z" }]);
  appendLedger(ledger, [{ ...base, processed_at: "2026-04-29T03:10:00Z" }]);

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0]?.processed_at, "2026-04-29T03:10:00Z");
});

test("stale dispatch claims without an exact receipt become retryable", () => {
  assert.deepEqual(
    dispatchClaimDecision({
      claim: { processed_at: "2026-04-29T03:01:00Z" },
      runs: [
        {
          id: 990,
          display_title: "Review event item openclaw/openclaw#74499 [router-other]",
          created_at: "2026-04-29T03:01:02Z",
        },
      ],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
      graceMs: Number.NaN,
    }),
    { action: "dispatch", run: null },
  );
});

test("dispatch claims with malformed timestamps fail closed", () => {
  assert.deepEqual(
    dispatchClaimDecision({
      claim: { processed_at: "not-a-timestamp" },
      runs: [
        {
          id: 991,
          display_title: "Review event item openclaw/openclaw#74499 [router-abc]",
          created_at: "2026-04-29T03:01:02Z",
        },
      ],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "wait", run: null },
  );
});

test("appendLedger preserves the original timestamp while a claim waits", () => {
  const ledger = { updated_at: null, commands: [] };
  const processedAt = "2026-04-29T03:01:00Z";

  appendLedger(ledger, [
    {
      idempotency_key: "claim-before-dispatch",
      comment_id: "125",
      comment_version_key: "125:2026-04-29T03:01:00Z",
      status: "claimed",
      intent: "clawsweeper_re_review",
      processed_at: processedAt,
      actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
    },
  ]);

  assert.equal(ledger.commands[0].processed_at, processedAt);
});

test("appendLedger upgrades claimed dispatch commands after execution", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "claim-before-dispatch",
      comment_id: "125",
      comment_version_key: "125:2026-04-29T03:01:00Z",
      comment_updated_at: "2026-04-29T03:01:00Z",
      status: "claimed",
      intent: "clawsweeper_re_review",
      issue_number: 74499,
      repo: "openclaw/openclaw",
      actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
    },
  ]);

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "claim-before-dispatch",
        comment_id: "125",
        comment_version_key: "125:2026-04-29T03:01:00Z",
        comment_updated_at: "2026-04-29T03:01:00Z",
        status: "executed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
        actions: [{ action: "dispatch_clawsweeper", status: "executed" }],
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].status, "executed");
  assert.deepEqual(ledger.commands[0].actions, [
    {
      action: "dispatch_clawsweeper",
      status: "executed",
      label: null,
      job_path: null,
    },
  ]);
});

test("appendLedger ignores no-op skipped command versions", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "already-processed",
        comment_id: "124",
        comment_version_key: "124:2026-04-29T03:00:00Z",
        comment_updated_at: "2026-04-29T03:00:00Z",
        status: "skipped",
        reason: "comment version already processed in ledger",
        intent: "automerge",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    false,
  );

  assert.equal(ledger.commands.length, 0);
});

test("appendLedger reports compact executed writes", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "processed",
        comment_id: "125",
        comment_version_key: "125:2026-04-29T03:01:00Z",
        comment_updated_at: "2026-04-29T03:01:00Z",
        comment_body_sha256: commentBodySha256("@clawsweeper re-review"),
        status: "executed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].comment_body_sha256, commentBodySha256("@clawsweeper re-review"));
});

test("appendLedger preserves maintainer identity fields for automerge attribution", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "automerge-opt-in",
      comment_id: "126",
      comment_version_key: "126:2026-04-29T03:02:00Z",
      comment_updated_at: "2026-04-29T03:02:00Z",
      status: "executed",
      intent: "automerge",
      issue_number: 74499,
      repo: "openclaw/openclaw",
      author: "maintainer-user",
      author_id: 123456,
      author_name: "Maintainer User",
    },
  ]);

  assert.equal(ledger.commands[0].author, "maintainer-user");
  assert.equal(ledger.commands[0].author_id, 123456);
  assert.equal(ledger.commands[0].author_name, "Maintainer User");
});

test("appendLedger preserves compact executed actions for repair caps", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "automerge-pass-repair",
      comment_id: "125",
      comment_version_key: "125:2026-04-30T01:12:00Z",
      comment_updated_at: "2026-04-30T01:12:00Z",
      status: "executed",
      intent: "clawsweeper_auto_merge",
      issue_number: 74506,
      repo: "openclaw/openclaw",
      actions: [
        {
          action: "dispatch_repair",
          status: "executed",
          job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-74506.md",
          workflow: "repair-cluster-worker.yml",
          ignored_detail: "not persisted",
        },
      ],
    },
  ]);

  assert.deepEqual(ledger.commands[0].actions, [
    {
      action: "dispatch_repair",
      status: "executed",
      label: null,
      job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-74506.md",
    },
  ]);
});

function exactVersionLedger({
  status,
  body,
  actions = [],
}: {
  status: string;
  body: string;
  actions?: Array<Record<string, string>>;
}) {
  return {
    updated_at: "2026-07-12T20:00:01Z",
    commands: [
      {
        repo: "openclaw/openclaw",
        comment_id: "456",
        comment_version_key: "456:2026-07-12T20:00:00Z",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: commentBodySha256(body),
        status,
        intent: "re_review",
        actions,
      },
    ],
  };
}

test("sortCommentsForRouting prioritizes edited durable review comments", () => {
  const sorted = sortCommentsForRouting([
    {
      id: 2,
      body: "@clawsweeper rebase",
      created_at: "2026-04-30T03:40:00Z",
      updated_at: "2026-04-30T03:40:00Z",
    },
    {
      id: 1,
      body: "<!-- clawsweeper-verdict:pass item=74742 sha=abc confidence=high -->",
      created_at: "2026-04-30T02:00:00Z",
      updated_at: "2026-04-30T03:45:00Z",
    },
  ]);

  assert.deepEqual(
    sorted.map((comment) => comment.id),
    [1, 2],
  );
});

test("selectCommentsForRouting caps durable history from the preselected item window", () => {
  const selected = selectCommentsForRouting({
    maxComments: 1,
    recentComments: [
      {
        id: 2,
        issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/74742",
        body: "@clawsweeper status",
        created_at: "2026-04-30T03:40:00Z",
        updated_at: "2026-04-30T03:40:00Z",
      },
      {
        id: 3,
        issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/74742",
        body: "@clawsweeper rebase",
        created_at: "2026-04-30T03:39:00Z",
        updated_at: "2026-04-30T03:39:00Z",
      },
    ],
    durableComments: [
      {
        id: 1,
        issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/74742",
        body: "<!-- clawsweeper-verdict:pass item=74742 sha=abc confidence=high -->",
        created_at: "2026-04-30T02:00:00Z",
        updated_at: "2026-04-30T03:45:00Z",
      },
    ],
  });

  assert.deepEqual(
    selected.map((comment) => comment.id),
    [1],
  );
});

test("selectCommentsForRouting reserves the cap for exact pending comments", () => {
  const pending = {
    id: 1,
    issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/74742",
    body: "@clawsweeper re-review",
    created_at: "2026-04-30T01:00:00Z",
    updated_at: "2026-04-30T01:00:00Z",
  };
  const selected = selectCommentsForRouting({
    maxComments: 1,
    recentComments: [
      {
        id: 2,
        issue_url: pending.issue_url,
        body: "@clawsweeper status",
        created_at: "2026-04-30T03:40:00Z",
        updated_at: "2026-04-30T03:40:00Z",
      },
    ],
    durableComments: [],
    priorityComments: [pending],
  });

  assert.deepEqual(
    selected.map((comment) => comment.id),
    [1],
  );
});

test("selectCommentsForRouting reserves one candidate for every cursor-selected item", () => {
  const issueUrl = (number: number) =>
    `https://api.github.com/repos/openclaw/openclaw/issues/${number}`;
  const selected = selectCommentsForRouting({
    maxComments: 2,
    reservedItemNumbers: [42, 43],
    recentComments: [
      {
        id: 4202,
        issue_url: issueUrl(42),
        body: "@clawsweeper status",
        updated_at: "2026-07-12T03:42:00Z",
      },
      {
        id: 4201,
        issue_url: issueUrl(42),
        body: "@clawsweeper rebase",
        updated_at: "2026-07-12T03:41:00Z",
      },
      {
        id: 4301,
        issue_url: issueUrl(43),
        body: "@clawsweeper re-review",
        updated_at: "2026-07-12T03:40:00Z",
      },
    ],
    durableComments: [],
  });

  assert.deepEqual(
    selected.map((comment) => comment.id),
    [4202, 4301],
  );
});

test("summarizeChecks ignores cancelled default non-gating checks", () => {
  const checks = summarizeChecks([
    {
      name: "auto-response",
      workflowName: "Auto response",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
    {
      name: "dispatch",
      workflowName: "ClawSweeper Dispatch",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
    {
      name: "notify",
      workflowName: "notify",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
    {
      name: "CI",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
  ]);

  assert.equal(checks.total, 4);
  assert.equal(checks.gatingTotal, 1);
  assert.deepEqual(checks.blockers, []);
  assert.equal(checks.counts.CANCELLED, 3);
});

test("summarizeChecks still blocks cancelled required checks", () => {
  const checks = summarizeChecks([
    {
      name: "required-build",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
  ]);

  assert.deepEqual(checks.blockers, ["required-build:CANCELLED"]);
  assert.deepEqual(checks.pending, []);
  assert.deepEqual(checks.terminalBlockers, ["required-build:CANCELLED"]);
});

test("summarizeChecks waits for a cancelled real behavior proof replacement", () => {
  const checks = summarizeChecks([
    {
      name: "Real behavior proof",
      workflowName: "Real behavior proof",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
  ]);

  assert.deepEqual(checks.blockers, ["Real behavior proof:CANCELLED"]);
  assert.deepEqual(checks.pending, ["Real behavior proof:CANCELLED"]);
  assert.deepEqual(checks.terminalBlockers, []);
});

test("summarizeChecks separates pending checks from terminal blockers", () => {
  const checks = summarizeChecks([
    {
      name: "slow-required",
      workflowName: "CI",
      status: "IN_PROGRESS",
      conclusion: "",
    },
    {
      name: "failed-required",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "FAILURE",
    },
  ]);

  assert.deepEqual(checks.blockers, ["slow-required:IN_PROGRESS", "failed-required:FAILURE"]);
  assert.deepEqual(checks.pending, ["slow-required:IN_PROGRESS"]);
  assert.deepEqual(checks.terminalBlockers, ["failed-required:FAILURE"]);
});

test("summarizeChecks marks Vercel authorization checks as external action required", () => {
  const checks = summarizeChecks([
    {
      context: "Vercel – clawhub",
      state: "FAILURE",
      targetUrl: "https://vercel.com/git/authorize?team=OpenClaw&type=github",
    },
  ]);

  assert.deepEqual(checks.blockers, ["Vercel – clawhub:ACTION_REQUIRED"]);
  assert.deepEqual(checks.pending, []);
  assert.deepEqual(checks.terminalBlockers, ["Vercel – clawhub:ACTION_REQUIRED"]);
  assert.deepEqual(checks.externalBlockers, ["Vercel – clawhub:ACTION_REQUIRED"]);
  assert.equal(checks.counts.ACTION_REQUIRED, 1);
});

test("summarizeChecks uses the latest run for duplicate check names", () => {
  const checks = summarizeChecks([
    {
      name: "Real behavior proof",
      workflowName: "Real behavior proof",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-05-10T06:01:06Z",
    },
    {
      name: "Real behavior proof",
      workflowName: "Real behavior proof",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-05-11T00:53:06Z",
    },
    {
      name: "CI",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-05-11T00:53:10Z",
    },
  ]);

  assert.equal(checks.total, 2);
  assert.deepEqual(checks.blockers, []);
  assert.equal(checks.counts.SUCCESS, 2);
});

test("skipped automerge ledger entries stay retryable", () => {
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "skipped",
      intent: "clawsweeper_auto_merge",
    }),
    false,
  );
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "skipped",
      intent: "maintainer_approve_automerge",
    }),
    false,
  );
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "executed",
      intent: "clawsweeper_auto_merge",
    }),
    true,
  );
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "skipped",
      intent: "clawsweeper_re_review",
    }),
    true,
  );
});

test("mutation actor guard accepts only trusted bot identities", () => {
  const trustedBots = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);

  assert.equal(normalizeGitHubActor("ClawSweeper[bot]"), "clawsweeper");
  assert.equal(isAllowedMutationActor("ClawSweeper[bot]", trustedBots), true);
  assert.equal(isAllowedMutationActor("clawsweeper[bot]", trustedBots), true);
  assert.equal(isAllowedMutationActor("clawsweeper", trustedBots), false);
  assert.equal(isAllowedMutationActor("openclaw-clawsweeper[bot]", trustedBots), true);
  assert.equal(isAllowedMutationActor("steipete", trustedBots), false);
  assert.equal(isAllowedMutationActor("github-actions[bot]", trustedBots), false);
});

test("mutation actor guard recognizes GitHub App integration auth shape", () => {
  assert.equal(
    isGitHubAppIntegrationAuthError("gh: Resource not accessible by integration (HTTP 403)"),
    true,
  );
  assert.equal(
    isGitHubAppIntegrationAuthError(
      '{"message":"Resource not accessible by integration","status":"403"}',
    ),
    true,
  );
  assert.equal(
    isGitHubAppIntegrationAuthError(
      '{"message":"Resource not accessible by integration","status": "403"}',
    ),
    true,
  );
  assert.equal(isGitHubAppIntegrationAuthError("gh: Resource not accessible (HTTP 403)"), false);
  assert.equal(isGitHubAppIntegrationAuthError("Resource not accessible by integration"), false);
});
