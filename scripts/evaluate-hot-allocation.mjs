#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { allocateAdaptiveHotReviewCapacity } from "../dist/repair/adaptive-hot-allocation.js";

const fixturePath = resolve(
  process.argv[2] ?? "test/fixtures/adaptive-hot-allocation/scenarios.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
if (
  fixture == null ||
  typeof fixture !== "object" ||
  fixture.schemaVersion !== "adaptive-hot-allocation-fixtures/v1" ||
  !Array.isArray(fixture.scenarios)
) {
  throw new Error(`unsupported adaptive hot-allocation fixture: ${fixturePath}`);
}

const scenarios = fixture.scenarios.map((scenario, index) => {
  if (scenario == null || typeof scenario !== "object" || typeof scenario.name !== "string") {
    throw new Error(`scenarios[${index}] must have a name`);
  }
  const decision = allocateAdaptiveHotReviewCapacity(scenario.input);
  const allocatedCandidates = decision.allocations.reduce(
    (total, allocation) => total + allocation.candidateCapacity,
    0,
  );
  const summary = {
    name: scenario.name,
    status: decision.status,
    serviceCapacity: decision.serviceCapacity,
    offerBudget: decision.offerBudget,
    perRepositoryLimit: decision.perRepositoryLimit,
    allocatedCandidates,
    unusedOfferBudget: decision.unusedOfferBudget,
    maxRepositoryCandidates: Math.max(
      0,
      ...decision.allocations.map((allocation) => allocation.candidateCapacity),
    ),
    selectedRepositories: decision.allocations.map((allocation) => allocation.targetRepo),
    allocationOrder: decision.allocationTrace.map((allocation) => allocation.targetRepo),
    unknownProbeCount: decision.unknownProbeCount,
    inputCursor: decision.inputCursor,
    nextCursor: decision.nextCursor,
    inputProbeCursor: decision.inputProbeCursor,
    nextProbeCursor: decision.nextProbeCursor,
  };
  if (scenario.expect != null) {
    for (const [field, expected] of Object.entries(scenario.expect)) {
      assert.deepEqual(summary[field], expected, `${scenario.name}.${field}`);
    }
  }
  return summary;
});

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: "adaptive-hot-allocation-evaluation/v1",
      fixture: relative(process.cwd(), fixturePath).replaceAll("\\", "/"),
      scenarios,
    },
    null,
    2,
  )}\n`,
);
