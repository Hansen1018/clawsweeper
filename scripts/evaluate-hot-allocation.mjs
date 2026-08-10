#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { allocateAdaptiveHotReviewCapacity } from "../dist/repair/adaptive-hot-allocation.js";

const fixturePath = resolve(
  process.argv[2] ?? "test/fixtures/adaptive-hot-allocation/scenarios.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const evaluation =
  fixture?.schemaVersion === "adaptive-hot-review-replay-input/v1"
    ? evaluateReplay(fixture)
    : evaluateScenarios(fixture);

process.stdout.write(
  `${JSON.stringify(
    {
      ...evaluation,
      fixture: relative(process.cwd(), fixturePath).replaceAll("\\", "/"),
    },
    null,
    2,
  )}\n`,
);

function evaluateScenarios(value) {
  if (
    value == null ||
    typeof value !== "object" ||
    value.schemaVersion !== "adaptive-hot-allocation-fixtures/v1" ||
    !Array.isArray(value.scenarios)
  ) {
    throw new Error(`unsupported adaptive hot-allocation fixture: ${fixturePath}`);
  }
  const scenarios = value.scenarios.map((scenario, index) => {
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
  return { schemaVersion: "adaptive-hot-allocation-evaluation/v1", scenarios };
}

function evaluateReplay(value) {
  if (
    !Number.isSafeInteger(value.nowMs) ||
    !Number.isSafeInteger(value.cursor) ||
    !Number.isSafeInteger(value.probeCursor) ||
    !Array.isArray(value.repositories) ||
    value.snapshot?.schemaVersion !== "adaptive-hot-review-control-snapshot/v1" ||
    !Array.isArray(value.snapshot.observations) ||
    value.facts == null ||
    typeof value.facts !== "object"
  ) {
    throw new Error(`malformed adaptive hot-review replay input: ${fixturePath}`);
  }
  const observations = new Map(
    value.snapshot.observations
      .filter((observation) => observation?.lane === "hot_intake")
      .map((observation) => [String(observation.targetRepo).toLowerCase(), observation]),
  );
  const circuits = Array.isArray(value.facts.activeCredentialCircuits)
    ? value.facts.activeCredentialCircuits
    : [];
  const globalCircuit = circuits.some((circuit) => circuit?.scope === "repository_actions");
  const decision = allocateAdaptiveHotReviewCapacity({
    nowMs: value.nowMs,
    cursor: value.cursor,
    probeCursor: value.probeCursor,
    queueCapabilityAvailable: value.facts.queueCapabilityAvailable === true,
    availableCandidateCapacity: value.facts.availableCandidateCapacity,
    globalTokenBalance: value.facts.globalTokenBalance,
    hotTokenBalance: value.facts.hotTokenBalance,
    scheduledAdmissionThrottled: value.facts.scheduledAdmissionThrottled === true || globalCircuit,
    repositoryObservationsAvailable: value.facts.repositoryObservationsAvailable === true,
    repositories: value.repositories.map((repository, index) => {
      const targetRepo = String(repository?.targetRepo || "").toLowerCase();
      if (!targetRepo.includes("/")) throw new Error(`repositories[${index}] is invalid`);
      const observed = observations.get(targetRepo);
      return {
        targetRepo,
        observation: observed
          ? {
              observedAtMs: Date.parse(observed.observedAt),
              eligibleDue: observed.eligibleDue,
              sourceNovelDue: observed.sourceNovelDue,
              oldestDueAtMs: optionalTimestamp(observed.oldestDueAt),
              oldestUnservedAtMs: optionalTimestamp(observed.oldestUnservedAt),
              lastAdmittedAtMs: optionalTimestamp(observed.lastAdmittedAt),
              reviewRuntimeMs:
                observed.executionSamples > 0
                  ? Math.floor(observed.reviewRuntimeMs / observed.executionSamples)
                  : null,
            }
          : null,
        credentialBlocked:
          repository?.credentialBlocked === true ||
          circuits.some(
            (circuit) =>
              circuit?.scope === "target_app" &&
              String(circuit.targetOwner || "").toLowerCase() === targetRepo.split("/", 1)[0],
          ),
      };
    }),
    ...(value.policy == null ? {} : { policy: value.policy }),
  });
  return {
    schemaVersion: "adaptive-hot-review-replay-output/v1",
    inputSnapshotGeneratedAt: value.snapshot.generatedAt,
    decision,
    comparison:
      value.expectedDecision == null
        ? null
        : {
            expectedStatus: value.expectedDecision.status ?? null,
            replayStatus: decision.status,
            expectedAllocations: value.expectedDecision.allocations ?? [],
            replayAllocations: decision.allocations,
            allocationsMatch:
              JSON.stringify(value.expectedDecision.allocations ?? []) ===
              JSON.stringify(decision.allocations),
          },
  };
}

function optionalTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}
