import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptiveHotRolloutCohort,
  assertAdaptiveHotActivationReady,
  readAdaptiveHotRuntimePolicy,
  resolveAdaptiveHotRuntimeOptions,
  selectAdaptiveHotActualAllocations,
} from "../../dist/repair/adaptive-hot-runtime.js";

const now = Date.parse("2026-08-10T12:00:00Z");

test("adaptive hot-review defaults preserve legacy fanout behind the kill switch", () => {
  const policy = readAdaptiveHotRuntimePolicy();
  const defaults = resolveAdaptiveHotRuntimeOptions({ policy });
  assert.deepEqual(defaults, {
    requestedMode: "legacy",
    effectiveMode: "legacy",
    killSwitch: true,
    activationApproval: "none",
    rolloutPercent: 100,
    canaryRepositories: [],
  });

  const rollback = resolveAdaptiveHotRuntimeOptions({
    policy,
    mode: "full",
    killSwitch: "1",
    activationApproval: "full",
  });
  assert.equal(rollback.requestedMode, "full");
  assert.equal(rollback.effectiveMode, "legacy");
});

test("adaptive activation requires bounded canaries, explicit approval, and durable windows", () => {
  const policy = readAdaptiveHotRuntimePolicy();
  assert.throws(
    () =>
      resolveAdaptiveHotRuntimeOptions({
        policy,
        mode: "canary",
        killSwitch: false,
        canaryRepositories: "openclaw/a,openclaw/b",
      }),
    /three to five repositories/,
  );
  const runtime = resolveAdaptiveHotRuntimeOptions({
    policy,
    mode: "canary",
    killSwitch: false,
    activationApproval: "canary",
    canaryRepositories: "openclaw/a,openclaw/b,openclaw/c",
  });
  assert.doesNotThrow(() =>
    assertAdaptiveHotActivationReady({
      runtime,
      policy,
      control: controlSnapshot({
        shadow: {
          firstDispatchedAt: new Date(now - policy.shadowMinDurationMs).toISOString(),
          lastDispatchedAt: new Date(now).toISOString(),
          dispatchedCycles: policy.shadowMinCycles,
        },
      }),
      nowMs: now,
    }),
  );
  assert.throws(
    () =>
      assertAdaptiveHotActivationReady({
        runtime: { ...runtime, activationApproval: "none" },
        policy,
        control: controlSnapshot(),
        nowMs: now,
      }),
    /explicit canary approval/,
  );
  assert.throws(
    () =>
      assertAdaptiveHotActivationReady({
        runtime,
        policy,
        control: controlSnapshot({
          policyVersion: "adaptive-hot-v0",
          shadow: {
            firstDispatchedAt: new Date(now - policy.shadowMinDurationMs).toISOString(),
            lastDispatchedAt: new Date(now).toISOString(),
            dispatchedCycles: policy.shadowMinCycles,
          },
        }),
        nowMs: now,
      }),
    /readiness evidence is not for policy adaptive-hot-v1/,
  );
  assert.throws(
    () =>
      assertAdaptiveHotActivationReady({
        runtime,
        policy,
        control: controlSnapshot({
          shadow: {
            firstDispatchedAt: new Date(now - policy.shadowMinDurationMs - 60_000).toISOString(),
            lastDispatchedAt: new Date(now - policy.shadowMinDurationMs + 60_000).toISOString(),
            dispatchedCycles: policy.shadowMinCycles,
          },
        }),
        nowMs: now,
      }),
    /shadow readiness requires/,
  );
});

test("shadow compares without dispatch changes and canary replaces allowlisted slots only", () => {
  const legacy = ["openclaw/a", "openclaw/b", "openclaw/c", "openclaw/d"].map((targetRepo) => ({
    targetRepo,
    candidateCapacity: 50,
  }));
  const proposed = [
    { targetRepo: "openclaw/c", candidateCapacity: 4 },
    { targetRepo: "openclaw/b", candidateCapacity: 2 },
    { targetRepo: "openclaw/e", candidateCapacity: 1 },
  ];
  assert.deepEqual(
    selectAdaptiveHotActualAllocations({
      runtime: runtime("shadow"),
      legacy,
      proposed,
    }),
    legacy.map((repository) => ({ ...repository, source: "legacy" })),
  );
  assert.deepEqual(
    selectAdaptiveHotActualAllocations({
      runtime: {
        ...runtime("canary"),
        activationApproval: "canary",
        canaryRepositories: ["openclaw/b", "openclaw/c", "openclaw/e"],
      },
      legacy,
      proposed,
    }),
    [
      { ...legacy[0]!, source: "legacy" },
      { targetRepo: "openclaw/c", candidateCapacity: 4, source: "adaptive" },
      { targetRepo: "openclaw/b", candidateCapacity: 2, source: "adaptive" },
      { ...legacy[3]!, source: "legacy" },
    ],
  );
});

test("percentage cohorts are stable and case-insensitive", () => {
  assert.equal(
    adaptiveHotRolloutCohort("OpenClaw/ClawSweeper", 10),
    adaptiveHotRolloutCohort("openclaw/clawsweeper", 10),
  );
  assert.equal(adaptiveHotRolloutCohort("openclaw/clawsweeper", 100), true);
});

test("full rollout cannot skip the 10 and 50 percent observation windows", () => {
  const policy = readAdaptiveHotRuntimePolicy();
  const full50 = {
    ...runtime("full"),
    activationApproval: "full" as const,
    rolloutPercent: 50 as const,
  };
  assert.throws(
    () =>
      assertAdaptiveHotActivationReady({
        runtime: full50,
        policy,
        control: controlSnapshot(),
        nowMs: now,
      }),
    /full-10-percent readiness/,
  );
  assert.doesNotThrow(() =>
    assertAdaptiveHotActivationReady({
      runtime: full50,
      policy,
      control: controlSnapshot({
        full10: {
          firstDispatchedAt: new Date(now - policy.canaryMinDurationMs).toISOString(),
          lastDispatchedAt: new Date(now).toISOString(),
          dispatchedCycles: policy.canaryMinCycles,
        },
      }),
      nowMs: now,
    }),
  );
  assert.throws(
    () =>
      assertAdaptiveHotActivationReady({
        runtime: { ...full50, rolloutPercent: 100 },
        policy,
        control: controlSnapshot({
          full10: {
            firstDispatchedAt: new Date(now - policy.canaryMinDurationMs).toISOString(),
            lastDispatchedAt: new Date(now).toISOString(),
            dispatchedCycles: policy.canaryMinCycles,
          },
        }),
        nowMs: now,
      }),
    /full-50-percent readiness/,
  );
});

function runtime(effectiveMode: "legacy" | "shadow" | "canary" | "full") {
  return {
    requestedMode: effectiveMode,
    effectiveMode,
    killSwitch: false,
    activationApproval: "none" as const,
    rolloutPercent: 100 as const,
    canaryRepositories: [],
  };
}

function controlSnapshot(
  overrides: {
    policyVersion?: string | null;
    shadow?: {
      firstDispatchedAt: string | null;
      lastDispatchedAt: string | null;
      dispatchedCycles: number;
    };
    canary?: {
      firstDispatchedAt: string | null;
      lastDispatchedAt: string | null;
      dispatchedCycles: number;
    };
    full10?: {
      firstDispatchedAt: string | null;
      lastDispatchedAt: string | null;
      dispatchedCycles: number;
    };
    full50?: {
      firstDispatchedAt: string | null;
      lastDispatchedAt: string | null;
      dispatchedCycles: number;
    };
  } = {},
) {
  const empty = { firstDispatchedAt: null, lastDispatchedAt: null, dispatchedCycles: 0 };
  return {
    schemaVersion: "adaptive-hot-review-control-snapshot/v1" as const,
    generatedAt: new Date(now).toISOString(),
    observations: [],
    recentDecisions: [],
    readiness: {
      policyVersion: overrides.policyVersion ?? "adaptive-hot-v1",
      shadow: overrides.shadow ?? empty,
      canary: overrides.canary ?? empty,
      full10: overrides.full10 ?? empty,
      full50: overrides.full50 ?? empty,
    },
  };
}
