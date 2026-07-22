import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGateInventory } from "./gate-inventory.mjs";

test("gate inventory rejects phase or fingerprint instability", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-inventory-"));
  const base = {
    scenario_id: "known-red",
    gate_status: "reproducer-confirmed",
    failure_fingerprint: "state.sibling-lost",
    clawsweeper_sha: "a".repeat(40),
    candidate_executable_digest: `sha256:${"b".repeat(64)}`,
    fixture_digest: `sha256:${"c".repeat(64)}`,
    event_sequence: ["publish"],
    expected_outcome: "preserved",
    actual_outcome: "lost",
    terminal_product_state: "blocked",
    merge_call_count: 0,
    git_refs_and_tree_digest: `sha256:${"d".repeat(64)}`,
    child_process_snapshot: [],
    wall_time_ms: 1,
  };
  const { inventory } = writeGateInventory({
    mode: "reproducer",
    outputRoot,
    results: [
      { summary: { ...base, phase: "publish" } },
      { summary: { ...base, phase: "different-phase" } },
    ],
  });
  assert.equal(inventory.gate_status, "unstable");
  assert.equal(inventory.gate_exit_code, 1);
});

test("gate inventory rejects oracle output instability", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-inventory-"));
  const base = {
    scenario_id: "known-red",
    gate_status: "reproducer-confirmed",
    phase: "publish",
    failure_fingerprint: "state.sibling-lost",
    clawsweeper_sha: "a".repeat(40),
    candidate_executable_digest: `sha256:${"b".repeat(64)}`,
    fixture_digest: `sha256:${"c".repeat(64)}`,
    event_sequence: ["publish"],
    expected_outcome: "preserved",
    actual_outcome: "lost",
    terminal_product_state: "blocked",
    merge_call_count: 0,
    git_refs_and_tree_digest: `sha256:${"d".repeat(64)}`,
    child_process_snapshot: [],
    wall_time_ms: 1,
  };
  const { inventory } = writeGateInventory({
    mode: "reproducer",
    outputRoot,
    results: [
      { summary: base },
      { summary: { ...base, git_refs_and_tree_digest: `sha256:${"e".repeat(64)}` } },
    ],
  });
  assert.equal(inventory.gate_status, "unstable");
  assert.equal(inventory.gate_exit_code, 1);
});
