import assert from "node:assert/strict";
import test from "node:test";

import { resolveRunArtifact } from "../../dist/repair/run-artifact.js";
import { readText } from "../helpers.ts";

const digest = "1".repeat(64);

test("repair result publication treats a missing current artifact as an explicit empty outcome", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const current = workflow.slice(
    workflow.indexOf("- name: Resolve current worker result artifact"),
    workflow.indexOf("- name: Resolve verified prior worker result cohort"),
  );
  const verify = workflow.slice(
    workflow.indexOf("- name: Verify selected worker result artifact"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(current, /resolveOptionalRunArtifact/);
  assert.match(current, /prefix: "clawsweeper-repair"/);
  assert.match(current, /fallbackPrefixes: \["clawsweeper-repair-worker"\]/);
  assert.match(current, /allowPriorAttempts: false/);
  assert.match(current, /artifact_found: "0"/);
  assert.match(verify, /if \[ "\$ARTIFACT_FOUND" != "1" \]; then/);
  assert.match(verify, /echo "has_artifacts=0" >> "\$GITHUB_OUTPUT"/);
  assert.match(verify, /exit 0/);
});

test("repair result reruns reuse only a verified prior final provenance cohort", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const prior = workflow.slice(
    workflow.indexOf("- name: Resolve verified prior worker result cohort"),
    workflow.indexOf("- name: Select worker result artifact"),
  );
  const download = workflow.slice(
    workflow.indexOf("- name: Select worker result artifact"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(prior, /steps\.current-result-artifact\.outputs\.artifact_found != '1'/);
  assert.match(prior, /attempts\/\$\{RUN_ATTEMPT\}\/jobs\?per_page=100/);
  assert.match(prior, /allowsPriorResultArtifactCohort/);
  assert.match(prior, /prefix: "clawsweeper-repair"/);
  assert.match(prior, /requiredPrefixes: \["clawsweeper-repair-provenance"\]/);
  assert.match(prior, /maxProducerAttempt: currentAttempt - 1/);
  assert.match(prior, /allowPriorAttempts: true/);
  assert.doesNotMatch(prior, /fallbackPrefixes/);
  assert.match(download, /artifact-ids: \$\{\{ steps\.result-artifact\.outputs\.artifact_id \}\}/);
  assert.match(
    download,
    /artifact-ids: \$\{\{ steps\.result-artifact\.outputs\.provenance_artifact_id \}\}/,
  );
  assert.match(download, /provenanceFiles\.length !== 1/);
  assert.match(download, /verifyPriorResultArtifactCohort/);
  assert.match(download, /resultArtifactId: process\.env\.ARTIFACT_ID/);
  assert.match(download, /resultArtifactDigest: process\.env\.ARTIFACT_DIGEST/);
  assert.match(download, /provenanceArtifactId: process\.env\.PROVENANCE_ARTIFACT_ID/);
  assert.match(download, /provenanceArtifactDigest: process\.env\.PROVENANCE_ARTIFACT_DIGEST/);
  assert.match(download, /findResultPaths\("artifacts"\)/);
  assert.match(download, /if \[ ! -s "\$result_paths_file" \]; then/);
  assert.match(download, /pnpm run repair:review-results -- "\$\{result_paths\[@\]\}"/);
  assert.doesNotMatch(download, /gh run download "\$RUN_ID"[\s\S]*--dir artifacts/);
});

test("repair result current-attempt selection rejects a stale prior artifact", () => {
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [workerArtifact(101, 1)],
        prefix: "clawsweeper-repair",
        fallbackPrefixes: ["clawsweeper-repair-worker"],
        runId: "9001",
        currentAttempt: 2,
        allowPriorAttempts: false,
      }),
    /current producer attempt did not publish/,
  );
});

test("repair result current-attempt selection rejects ambiguity", () => {
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [workerArtifact(201, 2), workerArtifact(202, 2)],
        prefix: "clawsweeper-repair",
        fallbackPrefixes: ["clawsweeper-repair-worker"],
        runId: "9001",
        currentAttempt: 2,
        allowPriorAttempts: false,
      }),
    /selection is ambiguous/,
  );
});

test("repair result publication rejects untrusted worker heads before minting write credentials", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const classification = workflow.slice(
    workflow.indexOf("- name: Classify trusted worker artifact contract"),
    workflow.indexOf("- name: Create GitHub App token"),
  );

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.ok(
    workflow.indexOf("- name: Classify trusted worker artifact contract") <
      workflow.indexOf("- name: Create GitHub App token"),
  );
  assert.match(
    workflow,
    /uses: \.\/\.github\/actions\/setup-state[\s\S]*?token: \$\{\{ steps\.state-token\.outputs\.token \}\}[\s\S]*?fetch-depth: 0/,
  );
  for (const block of workflow.matchAll(
    /uses: actions\/download-artifact@v8\n\s+with:\n([\s\S]*?)(?=\n\s{6}- (?:name|uses):|\n\n)/g,
  )) {
    assert.match(block[1] ?? "", /github-token: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(block[1] ?? "", /steps\.app_token\.outputs\.token/);
  }
  assert.match(
    classification,
    /if \[\[ ! "\$WORKER_HEAD_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]; then[\s\S]*exit 1/,
  );
  assert.match(classification, /! git merge-base --is-ancestor "\$WORKER_HEAD_SHA"[\s\S]*exit 1/);
});

function workerArtifact(id: number, attempt: number) {
  return {
    id,
    name: `clawsweeper-repair-worker-9001-${attempt}`,
    digest,
    expired: false,
  };
}
