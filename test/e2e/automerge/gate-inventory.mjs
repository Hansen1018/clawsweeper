import fs from "node:fs";
import path from "node:path";

import { gateExitCode } from "./proof-bundle.mjs";

export function writeGateInventory({ mode, outputRoot, results }) {
  const grouped = Map.groupBy(results, (result) => result.summary.scenario_id);
  const scenarios = [...grouped.entries()].map(([scenarioId, attempts]) => {
    const summaries = attempts.map(({ summary }) => summary);
    const signatures = new Set(summaries.map(stabilitySignature));
    return {
      scenario_id: scenarioId,
      attempts: summaries.length,
      stable: signatures.size === 1,
      gate_status: signatures.size === 1 ? summaries[0].gate_status : "unstable",
      phase: signatures.size === 1 ? summaries[0].phase : null,
      failure_fingerprint: signatures.size === 1 ? summaries[0].failure_fingerprint : null,
      clawsweeper_sha: [...new Set(summaries.map(({ clawsweeper_sha }) => clawsweeper_sha))],
      candidate_dependency_digest: [
        ...new Set(summaries.map(({ candidate_dependency_digest }) => candidate_dependency_digest)),
      ],
      candidate_executable_digest: [
        ...new Set(summaries.map(({ candidate_executable_digest }) => candidate_executable_digest)),
      ],
      wall_time_ms: summaries.reduce((total, summary) => total + summary.wall_time_ms, 0),
    };
  });
  const stable = scenarios.every((scenario) => scenario.stable);
  const exitCode = stable && results.every(({ summary }) => gateExitCode(summary) === 0) ? 0 : 1;
  const inventory = {
    schema_version: 1,
    gate_mode: mode,
    gate_status: inventoryGateStatus({ exitCode, scenarios, stable }),
    gate_exit_code: exitCode,
    scenarios,
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  const file = path.join(outputRoot, "failure-inventory.json");
  fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
  return { inventory, file };
}

function inventoryGateStatus({ exitCode, scenarios, stable }) {
  if (!stable) return "unstable";
  if (scenarios.every(({ gate_status }) => gate_status === "evidence-only")) {
    return "evidence-only";
  }
  if (exitCode === 0) return "passed";
  if (scenarios.some(({ gate_status }) => gate_status === "harness-error")) return "harness-error";
  return "candidate-red";
}

function stabilitySignature(summary) {
  return JSON.stringify({
    gate_status: summary.gate_status,
    phase: summary.phase,
    failure_fingerprint: summary.failure_fingerprint,
    clawsweeper_sha: summary.clawsweeper_sha,
    candidate_dependency_digest: summary.candidate_dependency_digest,
    candidate_executable_digest: summary.candidate_executable_digest,
    openclaw_base_sha: summary.openclaw_base_sha,
    openclaw_head_sha: summary.openclaw_head_sha,
    fixture_digest: summary.fixture_digest,
    event_sequence: summary.event_sequence,
    expected_outcome: summary.expected_outcome,
    actual_outcome: summary.actual_outcome,
    terminal_product_state: summary.terminal_product_state,
    merge_call_count: summary.merge_call_count,
    git_refs_and_tree_digest: summary.git_refs_and_tree_digest,
    child_process_snapshot: summary.child_process_snapshot,
    error: normalizeErrorIdentity(summary.error),
  });
}

function normalizeErrorIdentity(error) {
  return String(error ?? "")
    .replaceAll(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replaceAll(/\/tmp\/[^\s:)]+/g, "<tmp>")
    .replaceAll(/clawsweeper-[A-Za-z0-9_.-]+/g, "clawsweeper-<id>")
    .trim();
}
