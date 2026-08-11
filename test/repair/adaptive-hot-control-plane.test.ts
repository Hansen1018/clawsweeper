import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  fetchAdaptiveHotControlPlane,
  publishAdaptiveHotDecision,
} from "../../dist/repair/adaptive-hot-control-plane.js";

test("adaptive control plane combines queue, token, throttle, and circuit facts", async () => {
  const secret = "control-plane-secret";
  const result = await fetchAdaptiveHotControlPlane({
    queueUrl: "https://queue.example",
    webhookSecret: secret,
    policyVersion: "adaptive-hot-v1",
    targetRepositories: ["openclaw/clawsweeper"],
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/adaptive-hot-review/control-plane") {
        const body = String(init?.body);
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(body), {
          policyVersion: "adaptive-hot-v1",
          lane: "hot_intake",
          targetRepositories: ["openclaw/clawsweeper"],
        });
        assert.equal(
          new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
          `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        );
        return Response.json({ ok: true, adaptive_hot_review: emptySnapshot() });
      }
      return Response.json({
        lanes: {
          review: { capacity: 30, active: 8, pending: 7 },
          publication: {
            credential_circuits: [
              {
                active: true,
                scope: "target_app",
                target_owner: "OpenClaw",
                blocked_until: "2099-01-01T00:00:00Z",
              },
              {
                active: true,
                scope: "repository_actions",
                blocked_until: "2099-01-01T00:00:00Z",
              },
              { active: false, scope: "target_app", target_owner: "ignored" },
            ],
            github_request_metrics: { updated_at: "2026-08-10T12:00:00Z" },
          },
        },
        scheduled_feed: {
          token_balance: 24,
          throttle_recovery_at: "2099-01-01T00:00:00Z",
          lanes: { hot_intake: { token_balance: 9 } },
        },
      });
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.facts, {
    queueCapabilityAvailable: true,
    availableCandidateCapacity: 15,
    globalTokenBalance: 24,
    hotTokenBalance: 9,
    scheduledAdmissionThrottled: true,
    repositoryObservationsAvailable: false,
    activeCredentialCircuits: [
      {
        scope: "target_app",
        targetOwner: "openclaw",
        blockedUntil: "2099-01-01T00:00:00.000Z",
      },
      {
        scope: "repository_actions",
        targetOwner: null,
        blockedUntil: "2099-01-01T00:00:00.000Z",
      },
    ],
    githubRequestMetricsUpdatedAt: "2026-08-10T12:00:00.000Z",
  });
});

test("adaptive allocator uses the signed fleet view beyond the public partition cap", async () => {
  const targetRepositories = Array.from(
    { length: 101 },
    (_, index) => `example/repo-${String(index).padStart(3, "0")}`,
  );
  const observations = targetRepositories.map((targetRepo) => ({ targetRepo }));
  const result = await fetchAdaptiveHotControlPlane({
    queueUrl: "https://queue.example",
    webhookSecret: "fleet-view-secret",
    policyVersion: "adaptive-hot-v1",
    targetRepositories,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/adaptive-hot-review/control-plane") {
        return Response.json({
          ok: true,
          adaptive_hot_review: { ...emptySnapshot(), observations },
        });
      }
      return Response.json({
        lanes: {
          review: { capacity: 300, active: 0, pending: 0 },
          publication: { credential_circuits: [], github_request_metrics: null },
        },
        scheduled_feed: {
          token_balance: 300,
          throttle_recovery_at: null,
          lanes: { hot_intake: { token_balance: 300 } },
        },
        adaptive_hot_review: {
          ...emptySnapshot(),
          observations: observations.slice(0, 100),
        },
      });
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.observations.length, 101);
  assert.equal(result.snapshot.observations.at(-1)?.targetRepo, "example/repo-100");
  assert.equal(result.facts.repositoryObservationsAvailable, true);
});

test("adaptive decision writes use the existing signed queue boundary", async () => {
  const secret = "decision-secret";
  let captured: { url: string; body: string; signature: string } | null = null;
  const decision = {
    schemaVersion: "adaptive-hot-review-decision-record/v1" as const,
    decisionId: "300:1:hot-intake",
    runId: "300",
    runAttempt: 1,
    observedAt: "2026-08-10T12:00:00.000Z",
    requestedMode: "shadow" as const,
    effectiveMode: "shadow" as const,
    status: "planned" as const,
    policyVersion: "adaptive-hot-v1",
    killSwitch: false,
    activationApproval: "none" as const,
    rolloutPercent: 100 as const,
    canaryRepositories: [],
    reason: "shadow_comparison",
    legacyCursor: { input: 0, next: 1 },
    adaptiveCursor: { input: 0, next: 1 },
    adaptiveProbeCursor: { input: 0, next: 0 },
    actual: [],
    proposed: allocationDecision(),
    control: {
      queueCapabilityAvailable: true,
      availableCandidateCapacity: 1,
      globalTokenBalance: 1,
      hotTokenBalance: 1,
      scheduledAdmissionThrottled: false,
      repositoryObservationsAvailable: false,
      activeCredentialCircuits: [],
      githubRequestMetricsUpdatedAt: null,
    },
    comparison: decisionComparison(),
  };
  await publishAdaptiveHotDecision({
    queueUrl: "https://queue.example/",
    webhookSecret: secret,
    decision,
    fetchImpl: async (input, init) => {
      captured = {
        url: String(input),
        body: String(init?.body),
        signature: new Headers(init?.headers).get("x-clawsweeper-exact-review-signature") ?? "",
      };
      return Response.json({ ok: true, accepted: true }, { status: 202 });
    },
  });
  assert.ok(captured);
  assert.equal(captured.url, "https://queue.example/internal/adaptive-hot-review/decision");
  assert.equal(captured.body, JSON.stringify(decision));
  assert.equal(
    captured.signature,
    `sha256=${createHmac("sha256", secret).update(captured.body).digest("hex")}`,
  );
  await assert.rejects(
    publishAdaptiveHotDecision({
      queueUrl: "http://queue.example",
      webhookSecret: secret,
      decision,
    }),
    /must use HTTPS/,
  );
});

function emptySnapshot() {
  return {
    schemaVersion: "adaptive-hot-review-control-snapshot/v1",
    generatedAt: "2026-08-10T12:00:00.000Z",
    observations: [],
    recentDecisions: [],
    readiness: {
      policyVersion: null,
      shadow: { firstDispatchedAt: null, lastDispatchedAt: null, dispatchedCycles: 0 },
      canary: { firstDispatchedAt: null, lastDispatchedAt: null, dispatchedCycles: 0 },
      full10: { firstDispatchedAt: null, lastDispatchedAt: null, dispatchedCycles: 0 },
      full50: { firstDispatchedAt: null, lastDispatchedAt: null, dispatchedCycles: 0 },
    },
  };
}

function allocationDecision() {
  return {
    schemaVersion: "adaptive-hot-allocation-decision/v1" as const,
    policyVersion: "adaptive-hot-v1",
    status: "no_eligible_demand" as const,
    serviceCapacity: 1,
    offerBudget: 1,
    perRepositoryLimit: 1,
    repositoryLimit: 20,
    repositoriesConsidered: 0,
    credentialBlockedRepositories: 0,
    unknownProbeCount: 0,
    allocations: [],
    allocationTrace: [],
    unusedOfferBudget: 1,
    inputCursor: 0,
    nextCursor: 0,
    cursorAdvanced: false,
    inputProbeCursor: 0,
    nextProbeCursor: 0,
    probeCursorAdvanced: false,
  };
}

function decisionComparison() {
  return {
    legacyRepositoryCount: 1,
    legacyOfferBudget: 50,
    adaptiveRepositoryCount: 0,
    adaptiveOfferBudget: 0,
    predictedOfferReduction: 50,
    observedPlannerSamples: 0,
    observedAttempted: 0,
    observedDedupedOrShed: 0,
    estimatedAvoidedDedupeOrShed: null,
    overdueRepositoriesBefore: 0,
    overdueRepositoriesSelected: 0,
    oldestUnservedAgeBeforeMs: null,
    oldestUnservedAgeAfterProposalMs: null,
  };
}
