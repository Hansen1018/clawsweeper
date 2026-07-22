import fs from "node:fs";

import { candidateIdentity } from "./candidate-revision.mjs";
import { artifactDirectory, digestStrings, writeProofSummary } from "./proof-bundle.mjs";
import { scenarioManifest } from "./scenarios.mjs";
import { evaluateStateModel } from "./state-model.mjs";

export function runModelScenario({ candidateRoot, outputRoot, scenario, mode = "candidate" }) {
  const manifest = scenarioManifest(scenario);
  if (manifest.kind !== "model") throw new Error(`${scenario} is not a model scenario`);
  const startedAtMs = Date.now();
  const artifacts = artifactDirectory(outputRoot, scenario);
  try {
    const state = evaluateStateModel(scenario);
    fs.writeFileSync(
      `${artifacts}/event-sequence.json`,
      `${JSON.stringify(state.eventSequence, null, 2)}\n`,
    );
    const summary = writeProofSummary({
      artifacts,
      manifest,
      mode,
      startedAtMs,
      observed: {
        evidenceOnly: true,
        productViolation: false,
        ...candidateIdentity(candidateRoot),
        fixtureDigest: digestStrings([scenario, ...state.eventSequence]),
        eventSequence: state.eventSequence,
        actualOutcome: state.actualOutcome,
        terminalProductState: state.terminalProductState,
        mergeCallCount: state.mergeCallCount,
        invariant: state.invariant,
      },
    });
    return { summary, artifacts };
  } catch (error) {
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
    return { summary, artifacts };
  }
}
