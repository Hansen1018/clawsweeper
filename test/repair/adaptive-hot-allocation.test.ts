import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION,
  allocateAdaptiveHotReviewCapacity,
  type AdaptiveHotAllocationInput,
  type AdaptiveHotRepositoryInput,
} from "../../dist/repair/adaptive-hot-allocation.js";

const NOW_MS = 1_800_000_000_000;

function observation(
  overrides: Partial<NonNullable<AdaptiveHotRepositoryInput["observation"]>> = {},
): NonNullable<AdaptiveHotRepositoryInput["observation"]> {
  return {
    observedAtMs: NOW_MS - 60_000,
    eligibleDue: 4,
    sourceNovelDue: 0,
    oldestDueAtMs: NOW_MS - 60 * 60_000,
    oldestUnservedAtMs: NOW_MS - 60 * 60_000,
    lastAdmittedAtMs: NOW_MS - 60 * 60_000,
    ...overrides,
  };
}

function allocationInput(
  overrides: Partial<AdaptiveHotAllocationInput> = {},
): AdaptiveHotAllocationInput {
  return {
    nowMs: NOW_MS,
    cursor: 0,
    queueCapabilityAvailable: true,
    availableCandidateCapacity: 10,
    globalTokenBalance: 10,
    hotTokenBalance: 10,
    scheduledAdmissionThrottled: false,
    repositoryObservationsAvailable: true,
    repositories: [{ targetRepo: "example/repository", observation: observation() }],
    ...overrides,
  };
}

test("adaptive hot-allocation fixtures pass through the offline evaluator", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/evaluate-hot-allocation.mjs", "test/fixtures/adaptive-hot-allocation/scenarios.json"],
    { encoding: "utf8" },
  );
  const evaluation = JSON.parse(output) as {
    schemaVersion: string;
    scenarios: Array<{ name: string; status: string }>;
  };

  assert.equal(evaluation.schemaVersion, "adaptive-hot-allocation-evaluation/v1");
  assert.deepEqual(
    evaluation.scenarios.map((scenario) => [scenario.name, scenario.status]),
    [
      ["capacity-bounds-twenty-repositories", "allocated"],
      ["priority-rounds-and-bounded-probes", "allocated"],
      ["dominant-repository-is-capped", "allocated"],
      ["unavailable-observations-use-cursor-fallback", "observation_fallback"],
    ],
  );
});

test("adaptive hot allocation bounds every cycle before repository planning", () => {
  const repositories = Array.from({ length: 30 }, (_, index) => ({
    targetRepo: `example/repo-${String(index + 1).padStart(2, "0")}`,
    observation: observation({ eligibleDue: 100 }),
  }));

  for (const serviceCapacity of [1, 2, 3, 4, 10, 20, 100]) {
    const decision = allocateAdaptiveHotReviewCapacity(
      allocationInput({
        availableCandidateCapacity: serviceCapacity,
        hotTokenBalance: serviceCapacity,
        repositories,
      }),
    );
    const allocated = decision.allocations.reduce(
      (total, repository) => total + repository.candidateCapacity,
      0,
    );

    assert.equal(decision.schemaVersion, ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION);
    assert.ok(decision.offerBudget <= 30);
    assert.ok(allocated <= decision.offerBudget);
    assert.ok(decision.allocations.length <= 20);
    assert.ok(
      decision.allocations.every(
        (repository) =>
          repository.candidateCapacity >= 1 &&
          repository.candidateCapacity <= decision.perRepositoryLimit &&
          repository.candidateCapacity <= 10,
      ),
    );
  }
});

test("global scheduled-feed balance constrains capacity before the hot-lane balance", () => {
  const decision = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      availableCandidateCapacity: 128,
      globalTokenBalance: 3,
      hotTokenBalance: 10,
      repositories: Array.from({ length: 20 }, (_, index) => ({
        targetRepo: `example/repo-${String(index + 1).padStart(2, "0")}`,
        observation: observation({ eligibleDue: 10 }),
      })),
    }),
  );

  assert.equal(decision.serviceCapacity, 3);
  assert.equal(decision.offerBudget, 5);
  assert.equal(
    decision.allocations.reduce((total, allocation) => total + allocation.candidateCapacity, 0),
    5,
  );
});

test("cursor rotation serves equal-ranked demand across consecutive bounded cycles", () => {
  const repositories = Array.from({ length: 30 }, (_, index) => ({
    targetRepo: `example/repo-${String(index + 1).padStart(2, "0")}`,
    observation: observation({ eligibleDue: 100 }),
  }));
  const first = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      availableCandidateCapacity: 10,
      hotTokenBalance: 10,
      repositories,
    }),
  );
  const second = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      cursor: first.nextCursor,
      availableCandidateCapacity: 10,
      hotTokenBalance: 10,
      repositories,
    }),
  );

  assert.equal(first.nextCursor, 15);
  assert.deepEqual(
    new Set(
      [...first.allocations, ...second.allocations].map((allocation) => allocation.targetRepo),
    ),
    new Set(repositories.map((repository) => repository.targetRepo)),
  );
});

test("cursor advancement follows sparse selected positions rather than allocation count", () => {
  const repositories = Array.from({ length: 50 }, (_, index) => ({
    targetRepo: `example/repo-${String(index + 1).padStart(2, "0")}`,
    observation: observation({ eligibleDue: [0, 20, 40].includes(index) ? 100 : 0 }),
  }));
  const first = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      availableCandidateCapacity: 2,
      hotTokenBalance: 2,
      repositories,
      policy: { maxRepositories: 2 },
    }),
  );
  const second = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      cursor: first.nextCursor,
      availableCandidateCapacity: 2,
      hotTokenBalance: 2,
      repositories,
      policy: { maxRepositories: 2 },
    }),
  );

  assert.deepEqual(
    first.allocations.map((allocation) => allocation.targetRepo),
    ["example/repo-01", "example/repo-21"],
  );
  assert.equal(first.nextCursor, 21);
  assert.equal(second.allocations[0]?.targetRepo, "example/repo-41");
});

test("priority selections cannot reset ordinary fairness progress", () => {
  const repositories = Array.from({ length: 30 }, (_, index) => ({
    targetRepo: `example/repo-${String(index + 1).padStart(2, "0")}`,
    observation: observation({
      eligibleDue: 100,
      oldestUnservedAtMs: index === 0 ? NOW_MS - 48 * 60 * 60_000 : NOW_MS - 60 * 60_000,
    }),
  }));
  const ordinaryRepositories = new Set(
    repositories.slice(1).map((repository) => repository.targetRepo),
  );
  const servedOrdinaryRepositories = new Set<string>();
  let cursor = 1;

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const decision = allocateAdaptiveHotReviewCapacity(
      allocationInput({
        cursor,
        availableCandidateCapacity: 10,
        globalTokenBalance: 10,
        hotTokenBalance: 10,
        repositories,
      }),
    );

    assert.notEqual(decision.nextCursor, cursor);
    for (const allocation of decision.allocations) {
      if (allocation.initialReason === "ordinary_demand") {
        servedOrdinaryRepositories.add(allocation.targetRepo);
      }
    }
    cursor = decision.nextCursor;
  }

  assert.deepEqual(servedOrdinaryRepositories, ordinaryRepositories);
});

test("priority rounds preserve the final constrained-cycle slot for ordinary demand", () => {
  const repositories = [
    ...Array.from({ length: 3 }, (_, index) => ({
      targetRepo: `example/overdue-${index + 1}`,
      observation: observation({
        eligibleDue: 10,
        oldestUnservedAtMs: NOW_MS - 48 * 60 * 60_000,
      }),
    })),
    {
      targetRepo: "example/ordinary",
      observation: observation({
        eligibleDue: 10,
        oldestUnservedAtMs: NOW_MS - 60 * 60_000,
      }),
    },
  ];

  const decision = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      availableCandidateCapacity: 2,
      globalTokenBalance: 2,
      hotTokenBalance: 2,
      repositories,
    }),
  );

  assert.equal(decision.offerBudget, 3);
  assert.deepEqual(
    decision.allocations.map(({ targetRepo, initialReason }) => ({
      targetRepo,
      initialReason,
    })),
    [
      { targetRepo: "example/overdue-1", initialReason: "overdue_fairness" },
      { targetRepo: "example/overdue-2", initialReason: "overdue_fairness" },
      { targetRepo: "example/ordinary", initialReason: "ordinary_demand" },
    ],
  );
});

test("unknown probes advance independently from fresh-demand cursor ties", () => {
  const repositories = [
    { targetRepo: "example/unknown-a", observation: null },
    { targetRepo: "example/unknown-b", observation: null },
    { targetRepo: "example/unknown-c", observation: null },
    { targetRepo: "example/zz-fresh", observation: observation({ eligibleDue: 10 }) },
  ];
  const first = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      availableCandidateCapacity: 3,
      hotTokenBalance: 3,
      repositories,
    }),
  );
  const second = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      cursor: first.nextCursor,
      probeCursor: first.nextProbeCursor,
      availableCandidateCapacity: 3,
      hotTokenBalance: 3,
      repositories,
    }),
  );

  assert.deepEqual(
    first.allocations
      .filter((allocation) => allocation.initialReason === "unknown_probe")
      .map((allocation) => allocation.targetRepo),
    ["example/unknown-a", "example/unknown-b"],
  );
  assert.equal(first.nextProbeCursor, 2);
  assert.equal(first.nextCursor, 0);
  assert.equal(
    second.allocations.find(
      (allocation) =>
        allocation.targetRepo === "example/unknown-c" &&
        allocation.initialReason === "unknown_probe",
    )?.candidateCapacity,
    1,
  );
});

test("unknown probes cannot consume every tiny-cycle offer ahead of fresh demand", () => {
  const repositories = [
    { targetRepo: "example/known", observation: observation({ eligibleDue: 5 }) },
    { targetRepo: "example/unknown-a", observation: null },
    { targetRepo: "example/unknown-b", observation: null },
  ];
  let cursor = 0;
  let probeCursor = 0;
  const probed = new Set<string>();

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const decision = allocateAdaptiveHotReviewCapacity(
      allocationInput({
        cursor,
        probeCursor,
        availableCandidateCapacity: 1,
        globalTokenBalance: 1,
        hotTokenBalance: 1,
        repositories,
      }),
    );

    assert.equal(decision.offerBudget, 2);
    assert.equal(
      decision.allocations.find(
        (allocation) =>
          allocation.targetRepo === "example/known" &&
          allocation.initialReason === "ordinary_demand",
      )?.candidateCapacity,
      1,
    );
    const probe = decision.allocations.find(
      (allocation) => allocation.initialReason === "unknown_probe",
    );
    assert.ok(probe);
    probed.add(probe.targetRepo);
    cursor = decision.nextCursor;
    probeCursor = decision.nextProbeCursor;
  }

  assert.deepEqual(probed, new Set(["example/unknown-a", "example/unknown-b"]));
});

test("one candidate remains the explicit integer minimum for tiny cycles", () => {
  const decision = allocateAdaptiveHotReviewCapacity(
    allocationInput({ availableCandidateCapacity: 1, hotTokenBalance: 1 }),
  );

  assert.equal(decision.offerBudget, 2);
  assert.equal(decision.perRepositoryLimit, 1);
  assert.equal(decision.allocations[0]?.candidateCapacity, 1);
  assert.equal(decision.unusedOfferBudget, 1);
});

test("queue and scheduled-admission gates fail closed without advancing the cursor", () => {
  const cases = [
    {
      expected: "queue_unavailable",
      overrides: { queueCapabilityAvailable: false },
    },
    {
      expected: "scheduled_throttle",
      overrides: { scheduledAdmissionThrottled: true },
    },
    {
      expected: "no_capacity",
      overrides: { hotTokenBalance: 0 },
    },
  ] as const;

  for (const entry of cases) {
    const decision = allocateAdaptiveHotReviewCapacity(
      allocationInput({ cursor: 7, ...entry.overrides }),
    );
    assert.equal(decision.status, entry.expected);
    assert.equal(decision.offerBudget, 0);
    assert.deepEqual(decision.allocations, []);
    assert.equal(decision.nextCursor, decision.inputCursor);
    assert.equal(decision.cursorAdvanced, false);
    assert.equal(decision.nextProbeCursor, decision.inputProbeCursor);
    assert.equal(decision.probeCursorAdvanced, false);
  }
});

test("credential circuits defer only their repositories without erasing healthy work", () => {
  const decision = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      availableCandidateCapacity: 2,
      hotTokenBalance: 2,
      repositories: [
        {
          targetRepo: "example/blocked",
          credentialBlocked: true,
          observation: observation({ oldestUnservedAtMs: NOW_MS - 48 * 60 * 60_000 }),
        },
        { targetRepo: "example/healthy", observation: observation() },
      ],
    }),
  );

  assert.equal(decision.credentialBlockedRepositories, 1);
  assert.deepEqual(
    decision.allocations.map((allocation) => allocation.targetRepo),
    ["example/healthy"],
  );
});

test("missing, stale, and malformed observations share the bounded probe lane", () => {
  const decision = allocateAdaptiveHotReviewCapacity(
    allocationInput({
      cursor: 0,
      availableCandidateCapacity: 4,
      hotTokenBalance: 4,
      repositories: [
        { targetRepo: "example/missing", observation: null },
        {
          targetRepo: "example/stale",
          observation: observation({ observedAtMs: NOW_MS - 7 * 60 * 60_000 }),
        },
        {
          targetRepo: "example/malformed",
          observation: observation({ eligibleDue: 1, sourceNovelDue: 2 }),
        },
      ],
    }),
  );

  assert.equal(decision.unknownProbeCount, 2);
  assert.deepEqual(
    decision.allocations.map((allocation) => [
      allocation.targetRepo,
      allocation.observationStatus,
      allocation.candidateCapacity,
    ]),
    [
      ["example/malformed", "malformed", 1],
      ["example/missing", "missing", 1],
    ],
  );
  assert.equal(decision.unusedOfferBudget, 4);
});

test("equal input is byte-stable and priority is only an explicit final tie-break", () => {
  const input = allocationInput({
    availableCandidateCapacity: 2,
    hotTokenBalance: 2,
    repositories: [
      { targetRepo: "example/a", priorityTier: 0, observation: observation() },
      { targetRepo: "example/b", priorityTier: 1, observation: observation() },
      { targetRepo: "example/c", priorityTier: 0, observation: observation() },
    ],
  });

  const first = allocateAdaptiveHotReviewCapacity(input);
  const second = allocateAdaptiveHotReviewCapacity(input);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(
    first.allocations.map((allocation) => allocation.targetRepo),
    ["example/b", "example/a", "example/c"],
  );
});

test("repository identity is case-insensitively unique", () => {
  assert.throws(
    () =>
      allocateAdaptiveHotReviewCapacity(
        allocationInput({
          repositories: [
            { targetRepo: "OpenClaw/ClawSweeper", observation: observation() },
            { targetRepo: "openclaw/clawsweeper", observation: observation() },
          ],
        }),
      ),
    /duplicate repository/,
  );
});

test("adaptive allocation is wired through the signed planner, queue, and fanout boundaries", () => {
  assert.match(
    readFileSync("src/repair/target-fanout.ts", "utf8"),
    /allocateAdaptiveHotReviewCapacity/,
  );
  assert.match(
    readFileSync("src/repair/scheduled-review-enqueue.ts", "utf8"),
    /publishAdaptiveHotPlannerObservation/,
  );
  assert.match(
    readFileSync("dashboard/exact-review-queue.ts", "utf8"),
    /adaptive-hot-review\/decision/,
  );
  assert.match(
    readFileSync("dashboard/worker.ts", "utf8"),
    /internal\/adaptive-hot-review\/observation/,
  );
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  assert.match(workflow, /CLAWSWEEPER_ADAPTIVE_HOT_MODE/);
  assert.match(workflow, /CLAWSWEEPER_ADAPTIVE_HOT_KILL_SWITCH/);
});

test("adaptive hot-review telemetry replays without a live queue or GitHub mutation", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/evaluate-hot-allocation.mjs", "test/fixtures/adaptive-hot-allocation/replay.json"],
    { encoding: "utf8" },
  );
  const replay = JSON.parse(output) as {
    schemaVersion: string;
    decision: { status: string; allocations: Array<{ targetRepo: string }> };
  };
  assert.equal(replay.schemaVersion, "adaptive-hot-review-replay-output/v1");
  assert.equal(replay.decision.status, "allocated");
  assert.deepEqual(
    replay.decision.allocations.map((allocation) => allocation.targetRepo),
    ["example/active", "example/unknown"],
  );
});
