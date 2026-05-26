import assert from "node:assert/strict";
import test from "node:test";

import { CLAWSWEEPER_CO_AUTHOR_TRAILER } from "../../dist/repair/co-author-credit.js";
import {
  coAuthorTrailers,
  pullRequestCloseoutDriftBlockReason,
  pullRequestFileContextBlockReason,
  pullRequestIssueCommentContextBlockReason,
  pullRequestReviewContextBlockReason,
  pullRequestReviewCommentContextBlockReason,
  sourcePullRequestSecurityBlockReason,
} from "../../dist/repair/execute-fix-github.js";

test("replacement co-author trailers include contributor and ClawSweeper credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "Mona Octocat",
        email: "1+octocat@users.noreply.github.com",
      },
    ]),
    [
      "Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>",
      CLAWSWEEPER_CO_AUTHOR_TRAILER,
    ],
  );
});

test("replacement co-author trailers dedupe ClawSweeper credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "clawsweeper[bot]",
        email: "274271284+clawsweeper[bot]@users.noreply.github.com",
      },
    ]),
    [CLAWSWEEPER_CO_AUTHOR_TRAILER],
  );
});

test("replacement source PR security gate allows ordinary source PRs", () => {
  assert.equal(
    sourcePullRequestSecurityBlockReason({
      title: "Fix stale activity test",
      body: "Regular bug fix.",
      labels: [{ name: "bug" }],
      comments: [{ body: "Looks good." }],
    }),
    "",
  );
});

test("replacement source PR security gate blocks labels and comments", () => {
  assert.match(
    sourcePullRequestSecurityBlockReason({
      title: "Fix auth bypass",
      body: "Regular body.",
      labels: [{ name: "security" }],
      comments: [],
    }),
    /security-sensitive source PR/,
  );
  assert.match(
    sourcePullRequestSecurityBlockReason({
      title: "Fix auth bypass",
      body: "Regular body.",
      labels: [],
      comments: [{ body: "clawsweeper-security:security" }],
    }),
    /security-sensitive source PR/,
  );
  assert.match(
    sourcePullRequestSecurityBlockReason({
      title: "Fix auth bypass",
      body: "Regular body.",
      labels: [],
      comments: [],
      reviews: [{ body: "clawsweeper-security:security" }],
      reviewComments: [],
    }),
    /security-sensitive source PR/,
  );
  assert.match(
    sourcePullRequestSecurityBlockReason({
      title: "Fix auth bypass",
      body: "Regular body.",
      labels: [],
      comments: [],
      reviewComments: [{ body: "clawsweeper-security:security" }],
    }),
    /security-sensitive source PR/,
  );
});

test("replacement source PR file context blocks truncated file lists", () => {
  assert.equal(
    pullRequestFileContextBlockReason({
      changedFiles: 2,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    }),
    "",
  );
  assert.match(
    pullRequestFileContextBlockReason({
      changedFiles: 101,
      files: Array.from({ length: 100 }, (_, index) => ({ path: `src/${index}.ts` })),
    }),
    /file context is truncated/,
  );
});

test("replacement source PR review comment context blocks missing or truncated comments", () => {
  assert.equal(
    pullRequestReviewCommentContextBlockReason({
      reviewComments: [{ body: "Keep this unique test." }],
    }),
    "",
  );
  assert.match(
    pullRequestReviewCommentContextBlockReason({
      reviewComments: [],
      reviewCommentsTruncated: true,
    }),
    /review comment context is truncated/,
  );
  assert.match(pullRequestReviewCommentContextBlockReason({}), /review comment context is missing/);
});

test("replacement source PR review context blocks missing or truncated reviews", () => {
  assert.equal(
    pullRequestReviewContextBlockReason({
      reviews: [{ body: "Changes requested: keep this unique test." }],
    }),
    "",
  );
  assert.match(
    pullRequestReviewContextBlockReason({
      reviews: [],
      reviewsTruncated: true,
    }),
    /review context is truncated/,
  );
  assert.match(pullRequestReviewContextBlockReason({}), /review context is missing/);
});

test("replacement source PR issue comment context blocks missing or truncated comments", () => {
  assert.equal(
    pullRequestIssueCommentContextBlockReason({
      comments: [{ body: "Keep this unique proof." }],
    }),
    "",
  );
  assert.match(
    pullRequestIssueCommentContextBlockReason({
      comments: [],
      commentsTruncated: true,
    }),
    /comment context is truncated/,
  );
  assert.match(pullRequestIssueCommentContextBlockReason({}), /comment context is missing/);
});

test("replacement source PR closeout blocks post-proof drift", () => {
  assert.match(
    pullRequestCloseoutDriftBlockReason(
      { state: "OPEN", updatedAt: "2026-05-01T00:00:00Z", files: [], reviewComments: [] },
      { state: "OPEN", updatedAt: "2026-05-01T00:01:00Z", files: [], reviewComments: [] },
    ),
    /changed during replacement closeout proof/,
  );
  assert.match(
    pullRequestCloseoutDriftBlockReason(
      { state: "OPEN", updatedAt: "2026-05-01T00:00:00Z", files: [] },
      {
        state: "OPEN",
        updatedAt: "2026-05-01T00:00:00Z",
        files: [],
        reviews: [],
        reviewComments: [],
        comments: [{ body: "<!-- clawsweeper-security:security-sensitive item=1 sha=abc -->" }],
      },
    ),
    /security-sensitive source PR/,
  );
  assert.match(
    pullRequestCloseoutDriftBlockReason(
      {
        state: "OPEN",
        updatedAt: "2026-05-01T00:00:00Z",
        headRefOid: "old-head",
        files: [],
        reviews: [],
        reviewComments: [],
      },
      {
        state: "OPEN",
        updatedAt: "2026-05-01T00:00:00Z",
        headRefOid: "new-head",
        files: [],
        reviews: [],
        reviewComments: [],
      },
      "replacement PR",
    ),
    /replacement PR changed during replacement closeout proof/,
  );
});

test("replacement source PR closeout blocks truncated issue comments", () => {
  assert.match(
    pullRequestCloseoutDriftBlockReason(
      {
        state: "OPEN",
        updatedAt: "2026-05-01T00:00:00Z",
        files: [],
        reviewComments: [],
      },
      {
        state: "OPEN",
        updatedAt: "2026-05-01T00:00:00Z",
        files: [],
        comments: [{ body: "Visible comment." }],
        commentsTruncated: true,
        reviews: [],
        reviewComments: [],
      },
    ),
    /comment context is truncated/,
  );
});
