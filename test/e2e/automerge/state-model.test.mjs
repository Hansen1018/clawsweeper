import assert from "node:assert/strict";
import test from "node:test";

import { evaluateStateModel } from "./state-model.mjs";

const scenarios = [
  "pending-run-replacement",
  "duplicate-command-replay",
  "crash-after-intent",
  "crash-after-merge-before-outcome",
  "head-drift-before-mutation",
  "base-drift-before-mutation",
  "check-drift-before-mutation",
  "review-drift-before-mutation",
  "permission-drift-before-mutation",
  "protected-label-drift-before-mutation",
];

for (const scenario of scenarios) {
  test(`${scenario} preserves its deterministic invariant`, () => {
    const result = evaluateStateModel(scenario);
    assert.ok(result.invariant);
    assert.ok(result.eventSequence.length >= 2);
  });
}
