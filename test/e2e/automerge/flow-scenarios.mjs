import fs from "node:fs";
import path from "node:path";

import { assertCandidateIdentityUnchanged, candidateIdentity } from "./candidate-revision.mjs";
import { digestStrings, writeProofSummary } from "./proof-bundle.mjs";
import { runAutomergeE2E } from "./run.mjs";
import { scenarioManifest } from "./scenarios.mjs";

export function runFlowScenario({
  candidateRoot,
  outputRoot,
  scenario,
  expectedOutcome = "success",
  mode = "candidate",
  keep = false,
}) {
  const manifest = scenarioManifest(scenario);
  if (manifest.kind !== "flow") throw new Error(`${scenario} is not a flow scenario`);
  const startedAtMs = Date.now();
  const artifacts = path.resolve(outputRoot, scenario);
  try {
    const candidate = candidateIdentity(candidateRoot);
    const result = runAutomergeE2E({
      candidateRoot,
      outputRoot,
      scenario,
      expectedOutcome,
      keep,
    });
    assertCandidateIdentityUnchanged(candidateRoot, candidate);
    if (result.status !== "passed") {
      throw new Error(`legacy flow did not reach its asserted terminal status: ${result.status}`);
    }
    const legacySummary = JSON.parse(fs.readFileSync(path.join(artifacts, "summary.json"), "utf8"));
    fs.writeFileSync(
      path.join(artifacts, "flow-summary.json"),
      `${JSON.stringify(legacySummary, null, 2)}\n`,
    );
    const terminalState = flowTerminalState(legacySummary);
    const productViolation = terminalState !== manifest.expectedProductOutcome;
    const summary = writeProofSummary({
      artifacts,
      manifest,
      mode,
      startedAtMs,
      observed: {
        productViolation,
        clawsweeperSha: candidate.clawsweeperSha,
        candidateDependencyDigest: candidate.candidateDependencyDigest,
        candidateExecutableDigest: candidate.candidateExecutableDigest,
        fixtureDigest: digestStrings([
          manifest.fixture,
          scenario,
          expectedOutcome,
          JSON.stringify(legacySummary),
        ]),
        eventSequence: flowEventSequence(scenario),
        phase: manifest.phase,
        actualOutcome: terminalState,
        terminalProductState: terminalState,
        mergeCallCount: legacySummary.merge_commit ? 1 : 0,
        invariant: flowInvariant(scenario),
      },
    });
    return { ...result, summary };
  } catch (error) {
    fs.mkdirSync(artifacts, { recursive: true });
    const summary = writeProofSummary({
      artifacts,
      manifest,
      mode,
      startedAtMs,
      observed: {
        harnessError: true,
        actualOutcome: "harness-error",
        terminalProductState: "unknown",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    });
    return { status: "failed", scenario, artifacts, summary };
  }
}

function flowTerminalState(legacySummary) {
  return legacySummary.merge_commit ? "merged" : "blocked";
}

function flowEventSequence(scenario) {
  return [
    "production-plan-review",
    "artifact-handoff",
    "production-execute-publish",
    scenario === "pending-checks" ? "pending-check-observation" : "exact-head-observation",
    "production-router-replay",
    "product-terminal-state-oracle",
  ];
}

function flowInvariant(scenario) {
  if (scenario.includes("drift")) return "stale exact-head work must stop before merge mutation";
  if (scenario === "pending-checks") return "pending checks wait before exactly one eventual merge";
  if (scenario === "dependency-setup-mutation")
    return "setup identity drift stops before Codex or push";
  return "the production flow converges with one logical terminal mutation";
}
