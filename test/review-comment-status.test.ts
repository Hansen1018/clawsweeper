import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDurableReviewStatusProjection,
  renderDurableReviewRefreshProjection,
  renderInterruptedDurableReviewProjection,
} from "../dist/review-comment-status.js";

const options = {
  itemNumber: 74453,
  targetRevision: "0123456789abcdef0123456789abcdef01234567",
  startedAt: "2026-07-17T03:50:00.000Z",
  leaseOwner: "github-run-123-1",
  leaseCommentId: 987,
  previousReviewedAt: "2026-07-16T12:00:00.000Z",
  previousSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workflowUrl: "https://github.com/openclaw/clawsweeper/actions/runs/123",
};

function previousReview(): string {
  return [
    "Codex review: needs changes before merge.",
    "",
    "**Review findings**",
    "- [P1] Fix the stale cache",
    "",
    "<details>",
    "<summary>Review history (1 earlier review cycle)</summary>",
    "",
    "<!-- clawsweeper-review-history v=1 total=1 -->",
    "- reviewed 2026-07-15T10:00:00.000Z sha bbb222 :: passed. :: none",
    "",
    "</details>",
    "",
    "<!-- clawsweeper-verdict:needs-changes item=74453 sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
    "<!-- clawsweeper-action:fix-required item=74453 -->",
    "<!-- clawsweeper-security:security-sensitive item=74453 -->",
    "<!-- clawsweeper-review-version item=74453 reviewed_at=2026-07-16T12:00:00.000Z v=1 -->",
    "<!-- clawsweeper-review item=74453 -->",
  ].join("\n");
}

test("refresh projection visibly stales the previous review without actionable markers", () => {
  const body = renderDurableReviewRefreshProjection(previousReview(), options);
  assert.ok(body);
  assert.match(body, /Fresh ClawSweeper review in progress/);
  assert.match(body, /Previous review \(stale while refresh runs\)/);
  assert.match(body, /Started 2026-07-17T03:50:00.000Z/);
  assert.match(body, /View workflow/);
  assert.match(body, /clawsweeper-review-history/);
  assert.doesNotMatch(body, /clawsweeper-verdict:/);
  assert.doesNotMatch(body, /clawsweeper-action:/);
  assert.doesNotMatch(body, /clawsweeper-security:/);
  assert.doesNotMatch(body, /clawsweeper-review-version/);
  assert.equal(body.match(/<!-- clawsweeper-review item=74453 -->/g)?.length, 1);

  const parsed = parseDurableReviewStatusProjection(body, 74453);
  assert.equal(parsed?.state, "refreshing");
  assert.equal(parsed?.previousReviewedAt, options.previousReviewedAt);
  assert.equal(parsed?.previousSha, options.previousSha);
});

test("refresh projection unwraps an existing projection instead of nesting it", () => {
  const first = renderDurableReviewRefreshProjection(previousReview(), options);
  assert.ok(first);
  const second = renderDurableReviewRefreshProjection(first, {
    ...options,
    targetRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    leaseCommentId: 988,
  });
  assert.ok(second);
  assert.equal(second.match(/clawsweeper-review-previous:start/g)?.length, 1);
  assert.equal(
    parseDurableReviewStatusProjection(second)?.previousDigest,
    parseDurableReviewStatusProjection(first)?.previousDigest,
  );
});

test("parser rejects malformed, mismatched, and forged projections", () => {
  const body = renderDurableReviewRefreshProjection(previousReview(), options);
  assert.ok(body);
  assert.equal(parseDurableReviewStatusProjection(body, 1), null);
  assert.equal(
    parseDurableReviewStatusProjection(body.replace("Fix the stale cache", "Forged")),
    null,
  );
  assert.equal(parseDurableReviewStatusProjection("ordinary prose"), null);
});

test("marker-like prior prose cannot forge projection delimiters", () => {
  const body = renderDurableReviewRefreshProjection(
    `${previousReview()}\n\nSpoof <!-- clawsweeper-review-previous:end v=1 -->`,
    options,
  );
  assert.ok(body);
  assert.equal(body.match(/clawsweeper-review-previous:end/g)?.length, 1);
  assert.ok(parseDurableReviewStatusProjection(body));
});

test("interrupted transition is tuple-bound and keeps the stale prior review inert", () => {
  const refreshing = renderDurableReviewRefreshProjection(previousReview(), options);
  assert.ok(refreshing);
  assert.equal(
    renderInterruptedDurableReviewProjection(refreshing, {
      itemNumber: options.itemNumber,
      leaseOwner: options.leaseOwner,
      leaseCommentId: 999,
      targetRevision: options.targetRevision,
    }),
    null,
  );
  const interrupted = renderInterruptedDurableReviewProjection(refreshing, options);
  assert.ok(interrupted);
  assert.match(interrupted, /was interrupted/);
  assert.equal(parseDurableReviewStatusProjection(interrupted)?.state, "interrupted");
  assert.doesNotMatch(interrupted, /clawsweeper-verdict:/);
});

test("over-limit prior reviews produce a bounded inert projection", () => {
  const body = renderDurableReviewRefreshProjection(
    `Codex review: passed.\n${"x".repeat(70_000)}\n<!-- clawsweeper-verdict:pass -->`,
    options,
  );
  assert.ok(body);
  assert.ok(Buffer.byteLength(body, "utf8") <= 65_536);
  assert.match(body, /Previous review truncated/);
  assert.doesNotMatch(body, /clawsweeper-verdict:/);
  assert.ok(parseDurableReviewStatusProjection(body));
});
