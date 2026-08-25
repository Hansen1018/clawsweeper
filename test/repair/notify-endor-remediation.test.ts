import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  advanceEndorRemediationReview,
  classifyEndorPreparationFailure,
  deliverEndorRemediationEvent,
  endorDeliveryLedgerPath,
  prepareEndorRemediationReview,
  type EndorReviewEvidence,
} from "../../dist/repair/notify-endor-remediation.js";

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const ENDOR_BODY = `<h1>Endor Labs Automated Dependency Update</h1>

## Summary

| Dependency Name | Update Version (From ➡️ To) | Update Risk |
|---|---|---|
| \`example-package\` | \`1.0.0\` ➡️ \`1.0.1\` | \`LOW\` |

## Security Impact

| Severity | Count |
|---|---|
| High | 1 |

GHSA-aaaa-bbbb-cccc is reachable.`;

test("Endor preparation distinguishes retryable GitHub failures from invalid evidence", () => {
  assert.deepEqual(
    classifyEndorPreparationFailure(new Error("GitHub item returned HTTP 503: unavailable")),
    { kind: "github_transient", retryAt: null },
  );
  const rateLimit = classifyEndorPreparationFailure(
    new Error("GitHub item returned HTTP 429: retry-after: 60"),
  );
  assert.equal(rateLimit.kind, "github_rate_limit");
  assert.match(rateLimit.retryAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(classifyEndorPreparationFailure(new Error("invalid repository")), {
    kind: "permanent",
    retryAt: null,
  });
});

test("only the authoritative Endor App PR with a current durable review qualifies", async () => {
  const comment = reviewComment(HEAD, "clean", "review-1");
  const prepared = await prepareEndorRemediationReview(preparationInput(comment), {
    fetch: githubFixture({ comment }),
  });

  assert.equal(prepared.status, "eligible");
  if (prepared.status !== "eligible") return;
  assert.equal(prepared.evidence.reviewedHeadSha, HEAD);
  assert.equal(prepared.evidence.verdict, "clean");
  assert.match(prepared.evidence.findingSummary, /example-package/);
  assert.match(prepared.evidence.findingSummary, /High: 1/);
  assert.match(prepared.evidence.findingSummary, /GHSA-aaaa-bbbb-cccc/);

  for (const spoof of [
    { authorId: 99 },
    { authorLogin: "endor-labs-pro" },
    { authorType: "User" },
    { authorUrl: "https://github.com/endor-labs-pro" },
  ]) {
    const rejected = await prepareEndorRemediationReview(preparationInput(comment), {
      fetch: githubFixture({ comment, ...spoof }),
    });
    assert.deepEqual(rejected, {
      status: "skipped",
      reason: "pull request is not Endor-authored",
    });
  }

  const issue = await prepareEndorRemediationReview(preparationInput(comment), {
    fetch: githubFixture({ comment, isPullRequest: false }),
  });
  assert.deepEqual(issue, { status: "skipped", reason: "reviewed item is not a pull request" });

  const closed = await prepareEndorRemediationReview(preparationInput(comment), {
    fetch: githubFixture({ comment, state: "closed" }),
  });
  assert.deepEqual(closed, { status: "skipped", reason: "pull request is not open" });

  const merged = await prepareEndorRemediationReview(preparationInput(comment), {
    fetch: githubFixture({ comment, state: "closed", merged: true }),
  });
  assert.deepEqual(merged, { status: "skipped", reason: "pull request is merged" });
});

test("stale digests and reviewed-head mismatches cannot advance the streak", async () => {
  const comment = reviewComment(HEAD, "clean", "review-1");
  await assert.rejects(
    prepareEndorRemediationReview(
      { ...preparationInput(comment), reviewCommentDigest: "0".repeat(64) },
      { fetch: githubFixture({ comment }) },
    ),
    /durable review comment digest mismatch/,
  );

  const stale = await prepareEndorRemediationReview(preparationInput(comment), {
    fetch: githubFixture({ comment, headSha: NEXT_HEAD }),
  });
  assert.deepEqual(stale, {
    status: "skipped",
    reason: "durable review does not cover the current pull request head",
  });

  const visibleHeadOnly = comment.replace(/\n<!-- clawsweeper-review-version\b[^>]* -->/, "");
  const incomplete = await prepareEndorRemediationReview(preparationInput(visibleHeadOnly), {
    fetch: githubFixture({ comment: visibleHeadOnly }),
  });
  assert.deepEqual(incomplete, {
    status: "skipped",
    reason: "durable review does not contain one authoritative full-head marker",
  });
});

test("three distinct clean reviews on one exact head are required", () => {
  const root = temporaryRoot();
  const first = advanceEndorRemediationReview(evidence("clean", HEAD, "review-1"), { root });
  const second = advanceEndorRemediationReview(evidence("clean", HEAD, "review-2"), { root });
  const replay = advanceEndorRemediationReview(evidence("clean", HEAD, "review-2"), { root });
  const third = advanceEndorRemediationReview(evidence("clean", HEAD, "review-3"), { root });

  assert.deepEqual(progress(first), { action: "requeue", cycles: 1, cleanStreak: 1 });
  assert.deepEqual(progress(second), { action: "requeue", cycles: 2, cleanStreak: 2 });
  assert.deepEqual(progress(replay), { action: "requeue", cycles: 2, cleanStreak: 2 });
  assert.equal(third.action, "notify");
  assert.equal(third.cycles, 3);
  assert.equal(third.cleanStreak, 3);
  assert.equal(third.event.outcome, "ready");
  assert.equal(
    third.event.idempotencyKey,
    `clawsweeper.endor_remediation_reviewed:openclaw/openclaw:123:${HEAD}:ready`,
  );
});

test("identical rendered reviews advance through distinct publication generations", () => {
  const root = temporaryRoot();
  const sameReview = evidence("clean", HEAD, "same-comment-digest");
  const first = advanceEndorRemediationReview(
    { ...sameReview, reviewGeneration: "lease-1:1" },
    { root },
  );
  const second = advanceEndorRemediationReview(
    { ...sameReview, reviewGeneration: "lease-2:1" },
    { root },
  );
  const third = advanceEndorRemediationReview(
    { ...sameReview, reviewGeneration: "lease-3:1" },
    { root },
  );

  assert.deepEqual(progress(first), { action: "requeue", cycles: 1, cleanStreak: 1 });
  assert.deepEqual(progress(second), { action: "requeue", cycles: 2, cleanStreak: 2 });
  assert.equal(third.action, "notify");
  assert.equal(third.cleanStreak, 3);
});

test("different Endor PRs persist convergence and delivery receipts in disjoint files", async () => {
  const root = temporaryRoot();
  const secondPrEvidence = (reviewDigest: string) => ({
    ...evidence("clean", HEAD, reviewDigest),
    prNumber: 124,
    prUrl: "https://github.com/openclaw/openclaw/pull/124",
    reviewUrl: "https://github.com/openclaw/openclaw/pull/124#issuecomment-457",
  });

  advanceEndorRemediationReview(evidence("clean", HEAD, "pr-123-review-1"), { root });
  advanceEndorRemediationReview(secondPrEvidence("pr-124-review-1"), { root });

  const firstPrRoot = path.join(
    root,
    "notifications/endor-remediation/openclaw/openclaw/pulls/123",
  );
  const secondPrRoot = path.join(
    root,
    "notifications/endor-remediation/openclaw/openclaw/pulls/124",
  );
  assert.equal(fs.existsSync(path.join(firstPrRoot, "review-state.json")), true);
  assert.equal(fs.existsSync(path.join(secondPrRoot, "review-state.json")), true);

  advanceEndorRemediationReview(evidence("clean", HEAD, "pr-123-review-2"), { root });
  const firstEvent = advanceEndorRemediationReview(evidence("clean", HEAD, "pr-123-review-3"), {
    root,
  });
  advanceEndorRemediationReview(secondPrEvidence("pr-124-review-2"), { root });
  const secondEvent = advanceEndorRemediationReview(secondPrEvidence("pr-124-review-3"), {
    root,
  });
  assert.equal(firstEvent.action, "notify");
  assert.equal(secondEvent.action, "notify");
  if (firstEvent.action !== "notify" || secondEvent.action !== "notify") return;

  let requests = 0;
  const runtime = {
    root,
    env: hermitEnv(),
    log: () => undefined,
    fetch: deliveryFixtureFetch({
      onHook: async () => {
        requests += 1;
        return new Response(JSON.stringify({ delivered: true, messageId: `message-${requests}` }), {
          status: 200,
        });
      },
    }),
  };
  assert.equal((await deliverEndorRemediationEvent(firstEvent.event, runtime)).sent, 1);
  assert.equal((await deliverEndorRemediationEvent(secondEvent.event, runtime)).sent, 1);
  assert.equal(requests, 2);
  assert.equal(fs.existsSync(path.join(firstPrRoot, `notifications/${HEAD}/ready.json`)), true);
  assert.equal(fs.existsSync(path.join(secondPrRoot, `notifications/${HEAD}/ready.json`)), true);
});

test("findings and a new head reset clean progress", () => {
  const root = temporaryRoot();
  advanceEndorRemediationReview(evidence("clean", HEAD, "review-1"), { root });
  advanceEndorRemediationReview(evidence("clean", HEAD, "review-2"), { root });

  const finding = advanceEndorRemediationReview(evidence("has_findings", HEAD, "review-3"), {
    root,
  });
  assert.equal(finding.action, "notify");
  assert.equal(finding.cleanStreak, 0);
  assert.equal(finding.event.outcome, "needs_attention");
  assert.match(finding.event.reviewSummary, /lockfile contains an unrelated change/);

  const unchangedHead = advanceEndorRemediationReview(
    evidence("clean", HEAD, "review-after-finding"),
    { root },
  );
  assert.equal(unchangedHead.action, "notify");
  assert.equal(unchangedHead.event.outcome, "needs_attention");
  assert.match(unchangedHead.event.reviewSummary, /requires a new reviewed head/);

  const newHead = advanceEndorRemediationReview(evidence("clean", NEXT_HEAD, "review-4"), {
    root,
  });
  assert.deepEqual(progress(newHead), { action: "requeue", cycles: 1, cleanStreak: 1 });
  assert.equal(newHead.resetReason, "head_changed");
});

test("ambiguous reviews never count and stop honestly at six cycles", () => {
  const root = temporaryRoot();
  let result = advanceEndorRemediationReview(evidence("ambiguous", HEAD, "review-1"), { root });
  assert.deepEqual(progress(result), { action: "requeue", cycles: 1, cleanStreak: 0 });
  for (let cycle = 2; cycle <= 6; cycle += 1) {
    result = advanceEndorRemediationReview(evidence("ambiguous", HEAD, `review-${cycle}`), {
      root,
    });
  }
  assert.equal(result.action, "notify");
  assert.equal(result.cycles, 6);
  assert.equal(result.cleanStreak, 0);
  assert.equal(result.event.outcome, "needs_attention");
  assert.match(result.event.reviewSummary, /six-review safety cap/i);
});

test("an ambiguous review breaks a consecutive clean streak", () => {
  const root = temporaryRoot();
  advanceEndorRemediationReview(evidence("clean", HEAD, "review-1"), { root });
  const ambiguous = advanceEndorRemediationReview(evidence("ambiguous", HEAD, "review-2"), {
    root,
  });
  const nextClean = advanceEndorRemediationReview(evidence("clean", HEAD, "review-3"), { root });
  const secondClean = advanceEndorRemediationReview(evidence("clean", HEAD, "review-4"), {
    root,
  });
  const thirdClean = advanceEndorRemediationReview(evidence("clean", HEAD, "review-5"), { root });

  assert.equal(ambiguous.cleanStreak, 0);
  assert.deepEqual(progress(nextClean), { action: "requeue", cycles: 3, cleanStreak: 1 });
  assert.deepEqual(progress(secondClean), { action: "requeue", cycles: 4, cleanStreak: 2 });
  assert.equal(thirdClean.action, "notify");
  assert.equal(thirdClean.cleanStreak, 3);
});

test("ready, attention, and unknown outcomes retain the exact review evidence", () => {
  const ready = advanceThreeClean({ checks: "passing", mergeState: "clean" });
  const unknown = advanceThreeClean({ checks: "unknown", mergeState: "unknown" });
  const attention = advanceEndorRemediationReview(evidence("has_findings", HEAD, "finding"), {
    root: temporaryRoot(),
  });
  assert.equal(ready.event.outcome, "ready");
  assert.equal(unknown.event.outcome, "unknown");
  assert.equal(attention.event.outcome, "needs_attention");

  for (const result of [ready, unknown, attention]) {
    assert.equal(result.event.reviewedHeadSha, HEAD);
    assert.equal(
      result.event.reviewUrl,
      "https://github.com/openclaw/openclaw/pull/123#issuecomment-456",
    );
    assert.equal(result.event.prUrl, "https://github.com/openclaw/openclaw/pull/123");
  }
});

test("strict delivery sends the structured event to Hermit, deduplicates replay, and retries safely", async () => {
  const root = temporaryRoot();
  const event = advanceThreeClean({ root }).event;
  const requests: Array<Record<string, unknown>> = [];
  let liveHead = HEAD;
  const runtime = {
    root,
    env: hermitEnv(),
    log: () => undefined,
    now: () => new Date("2026-08-21T00:00:00Z"),
    fetch: deliveryFixtureFetch({
      head: () => liveHead,
      onHook: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ delivered: true, messageId: `message-${requests.length}` }),
          { status: 200 },
        );
      },
    }),
  };
  const first = await deliverEndorRemediationEvent(event, runtime);
  const replay = await deliverEndorRemediationEvent(event, runtime);
  assert.equal(first.sent, 1);
  assert.equal(replay.skipped, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    ...event,
    checks: { state: "passing", total: 2, summary: "2 gating checks passed" },
  });

  const nextHeadEvent = advanceThreeClean({ head: NEXT_HEAD }).event;
  liveHead = NEXT_HEAD;
  const nextHead = await deliverEndorRemediationEvent(nextHeadEvent, runtime);
  assert.equal(nextHead.sent, 1);
  assert.equal(requests.length, 2);
  assert.notEqual(event.idempotencyKey, nextHeadEvent.idempotencyKey);

  const missing = await deliverEndorRemediationEvent(event, {
    root: temporaryRoot(),
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "legacy-secret",
    },
    fetch: deliveryFixtureFetch({
      onHook: async () => jsonResponse({ delivered: true, messageId: "must-not-send" }),
    }),
  });
  assert.equal(missing.failed, 1);
  assert.match(missing.reason ?? "", /CLAWSWEEPER_HERMIT_URL/);

  const retryRoot = temporaryRoot();
  const failed = await deliverEndorRemediationEvent(event, {
    root: retryRoot,
    log: () => undefined,
    env: { ...hermitEnv(), CLAWSWEEPER_HERMIT_RETRY_ATTEMPTS: "1" },
    fetch: deliveryFixtureFetch({
      onHook: async () => new Response("unavailable", { status: 500 }),
    }),
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.failureKind, "hermit_transient");
  assert.equal(fs.existsSync(path.join(retryRoot, endorDeliveryLedgerPath(event))), false);
  const retried = await deliverEndorRemediationEvent(event, {
    root: retryRoot,
    log: () => undefined,
    env: hermitEnv(),
    fetch: deliveryFixtureFetch({
      onHook: async () =>
        new Response(JSON.stringify({ delivered: true, messageId: "retry-ok" }), { status: 200 }),
    }),
  });
  assert.equal(retried.sent, 1);
});

test("delivery requeues the live PR head instead of notifying a stale reviewed head", async () => {
  const event = advanceThreeClean().event;
  let hookRequests = 0;
  const result = await deliverEndorRemediationEvent(event, {
    root: temporaryRoot(),
    env: hermitEnv(),
    log: () => undefined,
    fetch: async (input, init) => {
      if (String(input).includes("api.github.com")) {
        return jsonResponse({
          head: { sha: NEXT_HEAD },
          user: {
            id: 179191674,
            login: "endor-labs-pro[bot]",
            type: "Bot",
            html_url: "https://github.com/apps/endor-labs-pro",
          },
          state: "open",
          merged: false,
          merged_at: null,
          mergeable: true,
          mergeable_state: "clean",
          updated_at: "2026-08-24T00:03:00Z",
        });
      }
      if (init?.method === "POST") hookRequests += 1;
      return jsonResponse({ delivered: true, messageId: "must-not-send" });
    },
  });

  assert.equal(result.action, "requeue");
  assert.equal(result.sent, 0);
  assert.equal(result.requeueHeadSha, NEXT_HEAD);
  assert.equal(hookRequests, 0);
});

test("transient delivery-time GitHub failures remain retryable without notifying", async () => {
  const event = advanceThreeClean().event;
  let hookRequests = 0;
  const result = await deliverEndorRemediationEvent(event, {
    root: temporaryRoot(),
    env: hermitEnv(),
    log: () => undefined,
    fetch: async (input, init) => {
      if (String(input).includes("api.github.com")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (init?.method === "POST") hookRequests += 1;
      return jsonResponse({ delivered: true, messageId: "must-not-send" });
    },
  });

  assert.equal(result.failed, 1);
  assert.equal(result.failureKind, "github_transient");
  assert.equal(result.sent, 0);
  assert.equal(hookRequests, 0);
});

test("delivery-time GitHub revalidation uses the target token", async () => {
  const event = advanceThreeClean().event;
  const authorization: Array<string | null> = [];
  const result = await deliverEndorRemediationEvent(event, {
    root: temporaryRoot(),
    env: { ...hermitEnv(), GH_TOKEN: "target-token" },
    log: () => undefined,
    fetch: deliveryFixtureFetch({
      onGithub: (_input, init) => {
        authorization.push(new Headers(init?.headers).get("authorization"));
      },
      onHook: async () => jsonResponse({ delivered: true, messageId: "authenticated-delivery" }),
    }),
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(authorization, [
    "Bearer target-token",
    "Bearer target-token",
    "Bearer target-token",
  ]);
});

test("closed or merged PRs complete delivery without notifying or requeueing", async () => {
  const event = advanceThreeClean().event;
  for (const pull of [
    { state: "closed", merged: false, reason: "pull request is not open" },
    { state: "closed", merged: true, reason: "pull request is merged" },
  ]) {
    const root = temporaryRoot();
    let hookRequests = 0;
    const result = await deliverEndorRemediationEvent(event, {
      root,
      env: {},
      log: () => undefined,
      fetch: deliveryFixtureFetch({
        state: () => pull.state,
        merged: () => pull.merged,
        onHook: async () => {
          hookRequests += 1;
          return jsonResponse({ delivered: true, messageId: "must-not-send" });
        },
      }),
    });

    assert.equal(result.action, "complete");
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, pull.reason);
    assert.equal(result.sent, 0);
    assert.equal(result.requeueKey, null);
    assert.equal(hookRequests, 0);
    assert.equal(fs.existsSync(path.join(root, endorDeliveryLedgerPath(event))), false);
  }
});

test(
  "accepted delivery without a durable ledger remains failed and retryable",
  { skip: process.platform === "win32" ? "requires POSIX write permissions" : false },
  async () => {
    const root = temporaryRoot();
    const event = advanceThreeClean().event;
    const ledgerPath = path.join(root, endorDeliveryLedgerPath(event));
    const ledgerDirectory = path.dirname(ledgerPath);
    fs.mkdirSync(ledgerDirectory, { recursive: true });
    fs.chmodSync(ledgerDirectory, 0o555);
    let requests = 0;
    const runtime = {
      root,
      env: hermitEnv(),
      log: () => undefined,
      fetch: deliveryFixtureFetch({
        onHook: async () => {
          requests += 1;
          return new Response(
            JSON.stringify({ delivered: true, messageId: `message-${requests}` }),
            { status: 200 },
          );
        },
      }),
    };

    const failed = await deliverEndorRemediationEvent(event, runtime);
    assert.equal(failed.failed, 1);
    assert.match(failed.reason ?? "", /permission denied|EACCES/i);
    assert.equal(requests, 1);
    assert.equal(fs.existsSync(ledgerPath), false);

    fs.chmodSync(ledgerDirectory, 0o755);
    const retried = await deliverEndorRemediationEvent(event, runtime);
    assert.equal(retried.sent, 1);
    assert.equal(requests, 2);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).notification.idempotencyKey,
      event.idempotencyKey,
    );
  },
);

function preparationInput(comment: string) {
  return {
    repo: "openclaw/openclaw",
    itemNumber: 123,
    reviewCommentId: 456,
    reviewCommentDigest: sha256(comment.trim()),
    reviewGeneration: "publisher-lease:1",
  };
}

function evidence(
  verdict: EndorReviewEvidence["verdict"],
  reviewedHeadSha: string,
  reviewDigest: string,
): EndorReviewEvidence {
  return {
    version: 1,
    repo: "openclaw/openclaw",
    prNumber: 123,
    prUrl: "https://github.com/openclaw/openclaw/pull/123",
    title: "Bump example-package from 1.0.0 to 1.0.1",
    findingSummary: "example-package; fixed findings: High: 1; advisories: GHSA-aaaa-bbbb-cccc",
    reviewedHeadSha,
    reviewDigest,
    reviewGeneration: reviewDigest,
    verdict,
    reviewSummary:
      verdict === "has_findings"
        ? "The lockfile contains an unrelated change."
        : verdict === "clean"
          ? "No actionable findings remain."
          : "The review result was ambiguous.",
    reviewUrl: "https://github.com/openclaw/openclaw/pull/123#issuecomment-456",
    checks: { state: "passing", total: 2, summary: "2 gating checks passed" },
    mergeState: "clean",
  };
}

function advanceThreeClean({
  root = temporaryRoot(),
  head = HEAD,
  checks = "passing",
  mergeState = "clean",
}: {
  root?: string;
  head?: string;
  checks?: EndorReviewEvidence["checks"]["state"];
  mergeState?: EndorReviewEvidence["mergeState"];
} = {}) {
  for (let cycle = 1; cycle < 3; cycle += 1) {
    advanceEndorRemediationReview(evidence("clean", head, `review-${cycle}`), { root });
  }
  const finalEvidence = evidence("clean", head, "review-3");
  finalEvidence.checks = {
    state: checks,
    total: checks === "passing" ? 2 : null,
    summary: `${checks}`,
  };
  finalEvidence.mergeState = mergeState;
  const result = advanceEndorRemediationReview(finalEvidence, { root });
  assert.equal(result.action, "notify");
  return result;
}

function progress(result: ReturnType<typeof advanceEndorRemediationReview>) {
  return { action: result.action, cycles: result.cycles, cleanStreak: result.cleanStreak };
}

function reviewComment(head: string, verdict: "clean" | "attention" | "unknown", nonce: string) {
  const readiness =
    verdict === "clean"
      ? "✅ **Ready for maintainer review**\n\nNo actionable findings remain."
      : verdict === "attention"
        ? "⚠️ **Needs maintainer attention - 1 item remains**\n\nThe lockfile contains an unrelated change."
        : "Review result was published.";
  return `# ClawSweeper review

## Merge readiness

${readiness}

**Reviewed head:** \`${head.slice(0, 12)}\`

<!-- clawsweeper-review-version item=123 reviewed_at=2026-08-24T00:00:00.000Z sha=${head} source_revision=source-${nonce} lease_owner=unknown lease_comment_id=unknown v=1 -->
<!-- review-nonce:${nonce} -->`;
}

function githubFixture({
  comment,
  authorId = 179191674,
  authorLogin = "endor-labs-pro[bot]",
  authorType = "Bot",
  authorUrl = "https://github.com/apps/endor-labs-pro",
  headSha = HEAD,
  isPullRequest = true,
  state = "open",
  merged = false,
}: {
  comment: string;
  authorId?: number;
  authorLogin?: string;
  authorType?: string;
  authorUrl?: string;
  headSha?: string;
  isPullRequest?: boolean;
  state?: "open" | "closed";
  merged?: boolean;
}): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/issues/123")) {
      return jsonResponse(isPullRequest ? { pull_request: { url: "pull" } } : {});
    }
    if (url.endsWith("/pulls/123")) {
      return jsonResponse({
        number: 123,
        title: "Endor Labs Version Upgrade: Bump example-package from 1.0.0 to 1.0.1",
        body: ENDOR_BODY,
        html_url: "https://github.com/openclaw/openclaw/pull/123",
        head: { sha: headSha },
        user: { id: authorId, login: authorLogin, type: authorType, html_url: authorUrl },
        state,
        merged,
        merged_at: merged ? "2026-08-24T00:04:00Z" : null,
        mergeable: true,
        mergeable_state: "clean",
      });
    }
    if (url.endsWith("/issues/comments/456")) {
      return jsonResponse({
        body: comment,
        html_url: "https://github.com/openclaw/openclaw/pull/123#issuecomment-456",
      });
    }
    if (url.includes("/check-runs")) {
      return jsonResponse({
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "success" },
        ],
      });
    }
    if (url.endsWith("/status?per_page=100")) return jsonResponse({ statuses: [] });
    return new Response("missing fixture", { status: 404 });
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deliveryFixtureFetch({
  head = () => HEAD,
  state = () => "open",
  merged = () => false,
  onGithub = () => undefined,
  onHook,
}: {
  head?: () => string;
  state?: () => string;
  merged?: () => boolean;
  onGithub?: (input: URL | RequestInfo, init?: RequestInit) => void;
  onHook: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("api.github.com")) onGithub(input, init);
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return jsonResponse({
        head: { sha: head() },
        user: {
          id: 179191674,
          login: "endor-labs-pro[bot]",
          type: "Bot",
          html_url: "https://github.com/apps/endor-labs-pro",
        },
        state: state(),
        merged: merged(),
        merged_at: merged() ? "2026-08-24T00:04:00Z" : null,
        mergeable: true,
        mergeable_state: "clean",
        updated_at: "2026-08-24T00:03:00Z",
      });
    }
    if (url.includes("/check-runs")) {
      return jsonResponse({
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "success" },
        ],
      });
    }
    if (url.endsWith("/status?per_page=100")) return jsonResponse({ statuses: [] });
    return onHook(input, init);
  };
}

function hermitEnv(): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_HERMIT_URL: "https://hermit.example",
    CLAWSWEEPER_HERMIT_TOKEN: "secret",
    CLAWSWEEPER_HERMIT_RETRY_ATTEMPTS: "1",
  };
}

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "endor-remediation-"));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
