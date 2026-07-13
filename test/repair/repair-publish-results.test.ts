import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("repair result fallback rejects ledger-only artifacts and verifies selected result payloads", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const download = workflow.slice(
    workflow.indexOf("- name: Download worker artifacts"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(download, /final_artifact="clawsweeper-repair-\$\{RUN_ID\}-\$\{RUN_ATTEMPT:-1\}"/);
  assert.match(download, /findResultPaths\("artifacts"\)/);
  assert.match(download, /if \[ ! -s "\$result_paths_file" \]; then/);
  assert.match(download, /pnpm run repair:review-results -- "\$\{result_paths\[@\]\}"/);
  assert.doesNotMatch(download, /find artifacts -type f -print -quit/);
});
