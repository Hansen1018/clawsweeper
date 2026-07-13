import assert from "node:assert/strict";
import test from "node:test";

import { resolveRunArtifact } from "../../dist/repair/run-artifact.js";
import { readText } from "../helpers.ts";

const digest = "1".repeat(64);

test("repair result fallback resolves and verifies one exact current-attempt artifact", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const download = workflow.slice(
    workflow.indexOf("- name: Resolve exact worker result artifact"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(download, /CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT: "0"/);
  assert.match(download, /--current-attempt "\$RUN_ATTEMPT"/);
  assert.match(download, /--prefix clawsweeper-repair/);
  assert.match(download, /--fallback-prefix clawsweeper-repair-worker/);
  assert.match(download, /artifact-ids: \$\{\{ steps\.result-artifact\.outputs\.artifact_id \}\}/);
  assert.match(download, /if \[ "\$PRODUCER_ATTEMPT" != "\$RUN_ATTEMPT" \]; then[\s\S]*exit 1/);
  assert.match(download, /findResultPaths\("artifacts"\)/);
  assert.match(download, /if \[ ! -s "\$result_paths_file" \]; then/);
  assert.match(download, /pnpm run repair:review-results -- "\$\{result_paths\[@\]\}"/);
  assert.doesNotMatch(download, /gh run download "\$RUN_ID"[\s\S]*--dir artifacts/);
});

test("repair result fallback rejects a stale prior-attempt artifact", () => {
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

test("repair result fallback rejects an ambiguous current-attempt artifact", () => {
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
