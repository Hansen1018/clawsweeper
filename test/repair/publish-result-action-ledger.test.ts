import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { reviewedResultRevision } from "../../dist/repair/publish-result-source.js";

test("published repair receipts use production-valid result and plan revision fields", () => {
  const result = productionResult({
    canonical: "#42",
    canonical_pr: "#42",
  });
  const plan = {
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    mode: "autonomous",
    source_job: "jobs/openclaw/repair-pr-42.md",
    items: [
      {
        repo: "openclaw/openclaw",
        ref: "#41",
        number: 41,
        kind: "pull_request",
        pull_request: { head_sha: "a".repeat(40) },
      },
      {
        repo: "openclaw/openclaw",
        ref: "#42",
        number: 42,
        kind: "pull_request",
        pull_request: { head_sha: "b".repeat(40) },
      },
    ],
  };
  const schema = JSON.parse(fs.readFileSync("schema/repair/codex-result.schema.json", "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.ok(Object.keys(result).every((key) => key in schema.properties));
  assert.equal(
    reviewedResultRevision(result, plan, { expected_head_sha: "b".repeat(40) }),
    "b".repeat(40),
  );
  assert.equal(reviewedResultRevision(result, plan, { expected_head_sha: "c".repeat(40) }), null);
});

test("published repair receipts bind issue and commit workflow source revisions", () => {
  assert.equal(
    reviewedResultRevision(productionResult({ canonical: "#42", canonical_issue: "#42" }), null, {
      source_issue_revision_sha256: "d".repeat(64),
    }),
    "d".repeat(64),
  );
  assert.equal(
    reviewedResultRevision(productionResult({ canonical: null }), null, {
      source: "clawsweeper_commit",
      commit_sha: "e".repeat(40),
    }),
    "e".repeat(40),
  );
});

test("published repair receipts ignore schema-invalid legacy revision shapes", () => {
  assert.equal(
    reviewedResultRevision(
      {
        reviewed_sha: "b".repeat(40),
        head_sha: "c".repeat(40),
        canonical: { pull_request: { head_sha: "d".repeat(40) } },
      },
      {
        expected_head_sha: "e".repeat(40),
        source_revision: "f".repeat(40),
      },
    ),
    null,
  );
});

function productionResult(overrides: Record<string, unknown>) {
  return {
    status: "planned",
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    mode: "autonomous",
    summary: "Reviewed the exact repair target.",
    actions: [],
    needs_human: [],
    canonical: null,
    canonical_issue: null,
    canonical_pr: null,
    merge_preflight: [],
    fix_artifact: null,
    ...overrides,
  };
}
