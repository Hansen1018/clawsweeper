#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { renderReviewCommentFromReport } from "../dist/clawsweeper.js";

export const REVIEW_STATE_FIXTURE_ITEM = 120232;
export const REVIEW_STATE_FIXTURE_HEAD = "522ac4a03828a827c5c266194459d995b9982ff9";
export const REVIEW_STATE_FIXTURE_STALE_HEAD = "1".repeat(40);

const FIXED_REVIEWED_AT = "2026-08-07T16:24:47.603Z";
const FIXED_UPDATED_AT = "2026-08-07T16:23:02Z";
const FIXED_SOURCE_REVISION = "9cdf151523f6e744086a69e5e1f0e4f856158a4c34f4b17b077284e48e60fb5c";

function reportFrontMatter(values) {
  return `---
${Object.entries(values)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n")}
---
`;
}

function prRatingReportSection({ overallTier, patchTier, summary }) {
  return `## PR Rating

Overall tier: ${overallTier}

Proof tier: NA

Patch tier: ${patchTier}

Overall label: fixture

Proof label: fixture

Patch label: fixture

Summary: ${summary}

Next rank-up steps:

- none
`;
}

export function reviewStateContractReport({ state, headSha = REVIEW_STATE_FIXTURE_HEAD }) {
  const frontMatter = {
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: String(REVIEW_STATE_FIXTURE_ITEM),
    author: "vincentkoc",
    author_association: "MEMBER",
    decision: "keep_open",
    close_reason: "none",
    action_taken: "kept_open",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify([]),
    work_candidate: state === "needs-changes" ? "queue_fix_pr" : "none",
    pull_head_sha: headSha,
    item_updated_at: FIXED_UPDATED_AT,
    reviewed_at: FIXED_REVIEWED_AT,
    item_source_revision: FIXED_SOURCE_REVISION,
    review_lease_owner: "fixture-run",
    review_lease_comment_id: "1059",
    config_surface_change: "false",
    config_surface_keys: JSON.stringify([]),
    data_model_change: state === "blocked" ? "true" : "false",
    data_model_surfaces:
      state === "blocked"
        ? JSON.stringify(["database schema: packages/database/schema.ts"])
        : JSON.stringify([]),
  };

  const summary =
    state === "ready"
      ? "This exact-head review has no remaining merge blocker."
      : state === "blocked"
        ? "This exact-head review is blocked until data-model compatibility proof is recorded."
        : "This exact-head review needs a producer repair before merge.";
  const bestSolution =
    state === "ready"
      ? "Proceed with normal maintainer review."
      : state === "blocked"
        ? "Record migration or upgrade compatibility proof before merge."
        : "Fix the durable comment replacement defect and re-run the review.";
  const findings =
    state === "needs-changes"
      ? `## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.99

Full review comments:

- **[P1] Replace the stale durable state marker:** \`src/clawsweeper-review-comment-automation.ts:123\`
  - body: The durable comment must contain only the marker for the current exact head.
  - confidence: 0.99`
      : `## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.99

Full review comments:

- none`;
  const rating = prRatingReportSection({
    overallTier: state === "ready" ? "A" : "D",
    patchTier: state === "needs-changes" ? "D" : "A",
    summary,
  });

  return `${reportFrontMatter(frontMatter)}

## Summary

${summary}

## What This Changes

Publishes exact-head durable review state independently from automation policy.

## Best Possible Solution

${bestSolution}

${findings}

${rating}
`;
}

function renderedCase(state, headSha = REVIEW_STATE_FIXTURE_HEAD) {
  const comment = renderReviewCommentFromReport(
    reviewStateContractReport({ state, headSha }),
    "none",
  );
  const stateMarkers = comment.match(/<!-- clawsweeper-review-state:[^>]+-->/g) ?? [];
  const identityMarkers = comment.match(/<!-- clawsweeper-review-version[^>]+-->/g) ?? [];
  return {
    state,
    item: REVIEW_STATE_FIXTURE_ITEM,
    headSha,
    version: 1,
    stateMarkers,
    identityMarkers,
    comment,
  };
}

export function createReviewStateContractFixture() {
  const cases = [renderedCase("ready"), renderedCase("blocked"), renderedCase("needs-changes")];
  const previous = renderedCase("ready", REVIEW_STATE_FIXTURE_STALE_HEAD);
  return {
    contract: "openclaw.clawsweeper-review-state",
    version: 1,
    identityMarker: "clawsweeper-review-version",
    stateMarker: "clawsweeper-review-state",
    cases,
    staleReplacement: {
      previous,
      replacementState: "needs-changes",
      replacementHeadSha: REVIEW_STATE_FIXTURE_HEAD,
    },
  };
}

function main() {
  const fixture = `${JSON.stringify(createReviewStateContractFixture(), null, 2)}\n`;
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex === -1) {
    process.stdout.write(fixture);
    return;
  }
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath) throw new Error("--output requires a path");
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, fixture, "utf8");
  process.stdout.write(`${resolved}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
