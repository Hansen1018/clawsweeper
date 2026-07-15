import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attachPullBaseDriftMetricForTest,
  compactPullRequestForTest,
  pullBaseDriftFromComparisonForTest,
  renderReviewContextBudgetForTest,
  reviewContextLedgerForTest,
  reviewDecisionSchemaText,
  reviewPromptForTest,
  reviewPromptTelemetryForTest,
  reviewPromptTemplate,
} from "../dist/clawsweeper.js";
import { parseArgs as parseClawsweeperArgs } from "../dist/clawsweeper-args.js";
import { closeDecision, git, item } from "./helpers.ts";

test("review prompt assets match tracked files", () => {
  assert.equal(reviewPromptTemplate(), readFileSync("prompts/review-item.md", "utf8"));
  assert.deepEqual(
    JSON.parse(reviewDecisionSchemaText()),
    JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8")),
  );
});

test("sweep apply jobs wire the default-off product direction policy gate", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  assert.equal(
    workflow.match(/CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED:/g)?.length,
    2,
  );
  assert.match(
    workflow,
    /vars\.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED \|\| 'false'/,
  );
});

test("main CLI args ignore package-manager double dash separators", () => {
  assert.deepEqual(parseClawsweeperArgs(["apply-decisions", "--", "--dry-run"]), {
    _: ["apply-decisions"],
    dry_run: true,
  });
  assert.deepEqual(parseClawsweeperArgs(["apply-decisions", "--limit", "1", "--", "--dry-run"]), {
    _: ["apply-decisions"],
    limit: "1",
    dry_run: true,
  });
});

test("review prompt telemetry records durable cost proxies", () => {
  const context = {
    issue: { number: 123, title: "Sample item" },
    comments: [{ author: "contributor", body: "This still reproduces." }],
    timeline: [],
    counts: { comments: 1, timeline: 0 },
  };

  const telemetry = reviewPromptTelemetryForTest(
    item({ title: "Telemetry regression" }),
    context,
    git,
    "keep extra instructions visible",
  );

  assert.ok(telemetry.staticPromptChars > 1000);
  assert.ok(telemetry.schemaChars > 1000);
  assert.ok(telemetry.contextChars >= JSON.stringify(context, null, 2).length);
  assert.ok(telemetry.promptChars > telemetry.staticPromptChars + telemetry.contextChars);
  assert.equal(telemetry.additionalPromptChars, "keep extra instructions visible".length);
});

test("review prompt includes compact previous review state without raw durable review body", () => {
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [{ author: "contributor", body: "After-fix proof is attached." }],
    timeline: [],
    previousClawSweeperReview: {
      status: "found issues before merge.",
      reviewedSha: "abc123",
      summary: "Prior review found one blocker.",
    },
    counts: { comments: 3, commentsIncluded: 1, commentsFiltered: 2, timeline: 0 },
  };

  const prompt = reviewPromptForTest(item({ kind: "pull_request", number: 123 }), context, git);

  assert.match(prompt, /"previousClawSweeperReview"/);
  assert.match(prompt, /Prior review found one blocker/);
  assert.match(prompt, /"commentsFiltered": 2/);
  assert.doesNotMatch(prompt, /How this review workflow works/);
});

test("review prompt excludes full semantic-cache patches", () => {
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [],
    timeline: [],
    pullFiles: [{ filename: "src/cache.ts", patch: "prompt-sized patch" }],
    semanticPullFiles: [
      { filename: "src/cache.ts", patch: "FULL_SEMANTIC_CACHE_PATCH_MUST_STAY_PRIVATE" },
    ],
    counts: { comments: 0, timeline: 0, pullFiles: 1 },
  };

  const prompt = reviewPromptForTest(item({ kind: "pull_request", number: 123 }), context, git);

  assert.match(prompt, /prompt-sized patch/);
  assert.doesNotMatch(prompt, /FULL_SEMANTIC_CACHE_PATCH_MUST_STAY_PRIVATE/);
});

test("review prompt includes merge state and guards clean behind-branch drift", () => {
  const compactPullRequest = compactPullRequestForTest({
    number: 123,
    title: "Sample PR",
    html_url: "https://github.com/openclaw/openclaw/pull/123",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "feature", sha: "head123" },
    base: { ref: "main", sha: "base123" },
    user: { login: "contributor" },
    additions: 10,
    deletions: 2,
    changed_files: 1,
  });
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [],
    timeline: [],
    pullRequest: compactPullRequest,
    counts: { comments: 0, timeline: 0 },
  };

  const prompt = reviewPromptForTest(item({ kind: "pull_request", number: 123 }), context, git);

  assert.deepEqual((compactPullRequest as { mergeableState?: unknown }).mergeableState, "clean");
  assert.match(prompt, /"mergeableState": "clean"/);
  assert.match(prompt, /Do not treat a branch being behind the current base as proof/);
  assert.match(prompt, /Ordinary\s+`behind` state is\s+not a contributor blocker/);
  assert.match(prompt, /do not claim that rebasing will fix a failing check/);
  assert.match(
    prompt,
    /Only ask the contributor to rebase or resolve the base when GitHub reports a/,
  );
  assert.match(prompt, /concrete merge-result evidence shows an integration failure/);
});

test("base drift becomes stale after seven days", () => {
  const nowMs = Date.parse("2026-07-15T00:00:00Z");
  const comparison = (mergeBaseAt: string) => ({
    behind_by: 1200,
    merge_base_commit: {
      sha: "base123",
      commit: { committer: { date: mergeBaseAt } },
    },
  });

  assert.deepEqual(pullBaseDriftFromComparisonForTest(comparison("2026-07-13T00:00:00Z"), nowMs), {
    status: "behind",
    behindCommits: 1200,
    mergeBaseSha: "base123",
    mergeBaseAt: "2026-07-13T00:00:00Z",
    baseAgeDays: 2,
    stale: false,
    staleAfterDays: 7,
    contributorActionRequired: false,
  });
  assert.equal(
    (
      pullBaseDriftFromComparisonForTest(comparison("2026-07-05T00:00:00Z"), nowMs) as {
        stale: boolean;
      }
    ).stale,
    true,
  );
});

test("stale base drift adds a non-blocking maintainer metric", () => {
  const decision = attachPullBaseDriftMetricForTest(closeDecision(), {
    issue: {},
    comments: [],
    timeline: [],
    pullBaseDrift: { status: "behind", baseAgeDays: 10, stale: true },
  });

  assert.deepEqual(decision.reviewMetrics.at(-1), {
    label: "Base freshness",
    value: "10 days since merge base",
    reason:
      "Maintainers or merge automation should refresh validation before landing; no contributor action is required.",
  });
  assert.deepEqual(decision.risks, []);
  assert.deepEqual(decision.prRating.nextSteps, []);
});

test("fresh base drift does not add a review metric", () => {
  const decision = closeDecision();

  assert.deepEqual(
    attachPullBaseDriftMetricForTest(decision, {
      issue: {},
      comments: [],
      timeline: [],
      pullBaseDrift: { status: "behind", baseAgeDays: 6, stale: false },
    }),
    decision,
  );
});

test("review context ledger records ordered section budgets", () => {
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [{ author: "alice", body: "Please review this." }],
    timeline: [{ event: "committed", sha: "abc123" }],
    previousClawSweeperReview: {
      status: "found issues before merge.",
      reviewedSha: "abc123",
      summary: "Prior review found one blocker.",
    },
    relatedItems: [{ number: 122, title: "Related issue" }],
    pullRequest: { number: 123, additions: 12 },
    pullBaseDrift: { status: "behind", baseAgeDays: 10, stale: true },
    pullFiles: [
      { filename: "src/example.ts", patch: "line\n".repeat(20) },
      { filename: "test/example.test.ts", patch: "test\n".repeat(20) },
    ],
    pullCommits: [{ sha: "abc123", message: "fix example" }],
    pullReviewComments: [],
    counts: {
      comments: 10,
      commentsHydrated: 1,
      commentsTruncated: true,
      timeline: 1,
      timelineHydrated: 1,
      timelineTruncated: false,
      relatedItems: 1,
      pullFiles: 120,
      pullFilesHydrated: 2,
      pullFilesTruncated: true,
      pullCommits: 1,
      pullCommitsHydrated: 1,
      pullCommitsTruncated: false,
      pullReviewComments: 0,
      pullReviewCommentsHydrated: 0,
      pullReviewCommentsTruncated: false,
    },
  };

  const ledger = reviewContextLedgerForTest(context);

  assert.deepEqual(
    ledger.map(({ section, entries, total, hydrated, truncated }) => [
      section,
      entries,
      total,
      hydrated,
      truncated,
    ]),
    [
      ["issue", 1, undefined, undefined, undefined],
      ["comments", 1, 10, 1, true],
      ["timeline", 1, 1, 1, false],
      ["previousClawSweeperReview", 1, undefined, undefined, undefined],
      ["relatedItems", 1, 1, undefined, undefined],
      ["pullRequest", 1, undefined, undefined, undefined],
      ["pullFiles", 2, 120, 2, true],
      ["pullCommits", 1, 1, 1, false],
      ["pullBaseDrift", 1, undefined, undefined, undefined],
      ["counts", 16, undefined, undefined, undefined],
    ],
  );
  assert.equal(
    ledger.find((entry) => entry.section === "pullFiles")?.chars,
    JSON.stringify(context.pullFiles, null, 2).length,
  );
  assert.match(
    renderReviewContextBudgetForTest(context),
    /- PR files: 2\/120 hydrated, truncated, \d+ chars/,
  );
  assert.match(renderReviewContextBudgetForTest(context), /- timeline events: 1\/1 hydrated/);
  assert.match(renderReviewContextBudgetForTest(context), /- previous ClawSweeper review: 1 entry/);
});
