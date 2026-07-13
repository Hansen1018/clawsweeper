import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { resultPublicationSourceRevision } from "../../dist/repair/publish-result.js";
import { reviewedResultRevision } from "../../dist/repair/publish-result-source.js";
import { readText } from "../helpers.ts";

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

test("result publication accepts production blocked and generic issue-only results without fake revisions", () => {
  const blocked = productionResult({
    status: "blocked",
    summary: { reason: "manual repair required" },
    actions: [],
    needs_human: ["manual repair required"],
  });
  assert.equal(
    resultPublicationSourceRevision(blocked, null, {
      source: "clawsweeper",
      job_intent: "repair_cluster",
    }),
    null,
  );

  const issueOnly = productionResult({
    canonical: "#42",
    canonical_issue: "#42",
  });
  assert.equal(
    resultPublicationSourceRevision(issueOnly, null, {
      source: "clawsweeper",
      job_intent: "repair_cluster",
    }),
    null,
  );
});

test("result publication keeps exact revision requirements for live source-bound work", () => {
  const result = productionResult({ canonical: "#42" });
  for (const source of [
    { source: "issue_implementation" },
    { source: "clawsweeper_commit" },
    { source: "pr-repair-intake" },
    { source: "pr_automerge" },
  ]) {
    assert.throws(
      () => resultPublicationSourceRevision(result, null, source),
      /missing one exact reviewed target revision/,
    );
  }
  assert.throws(
    () =>
      resultPublicationSourceRevision(
        productionResult({ status: "blocked", canonical: "#42", canonical_pr: "#42" }),
        null,
        { source: "clawsweeper" },
      ),
    /missing one exact reviewed target revision/,
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

test("result publication resolves the source job recorded in the cluster plan", () => {
  const publisher = readText("src/repair/publish-result.ts");
  const resolver = publisher.slice(
    publisher.indexOf("function readPublishedSourceContext"),
    publisher.indexOf("function updateDashboard"),
  );

  assert.match(publisher, /readPublishedSourceContext\(clusterPlan\)/);
  assert.match(resolver, /clusterPlan\?\.source_job/);
  assert.match(resolver, /path\.resolve\(root, sourceJob\)/);
  assert.doesNotMatch(resolver, /runDir,\s*"\.\.",\s*"job\.md"/);
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
