import type { AdaptiveHotAllocationDecision } from "./adaptive-hot-allocation.js";

export const ADAPTIVE_HOT_PLANNER_OBSERVATION_SCHEMA_VERSION =
  "adaptive-hot-review-planner-observation/v1";
export const ADAPTIVE_HOT_DECISION_RECORD_SCHEMA_VERSION = "adaptive-hot-review-decision-record/v1";
export const ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION =
  "adaptive-hot-review-control-snapshot/v1";

export type AdaptiveHotMode = "legacy" | "shadow" | "canary" | "full";
export type AdaptiveHotActivationApproval = "none" | "canary" | "full";
export type AdaptiveHotDecisionStatus = "planned" | "dispatched";

export type AdaptiveHotPlannerLane = "hot_intake" | "normal_backfill";

export interface AdaptiveHotPlannerObservation {
  schemaVersion: typeof ADAPTIVE_HOT_PLANNER_OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  policyVersion: string;
  runId: string;
  runAttempt: number;
  targetRepo: string;
  lane: AdaptiveHotPlannerLane;
  observedAt: string;
  windowStartedAt: string;
  eligibleDue: number;
  selected: number;
  offered: number;
  attempted: number;
  admitted: number;
  deduped: number;
  shed: number;
  deferred: number;
  rejected: number;
  throttled: number;
  sourceNovelDue: number;
  oldestDueAt: string | null;
  oldestUnservedAt: string | null;
}

export interface AdaptiveHotExecutionObservation {
  earlyNoop: boolean;
  structuralHit: number;
  semanticHit: number;
  contentHit: number;
  hydrated: number;
  reviewRuntimeMs: number;
}

export interface AdaptiveHotActualAllocation {
  targetRepo: string;
  candidateCapacity: number;
  source: "legacy" | "adaptive";
}

export interface AdaptiveHotControlFacts {
  queueCapabilityAvailable: boolean;
  availableCandidateCapacity: number;
  globalTokenBalance: number;
  hotTokenBalance: number;
  scheduledAdmissionThrottled: boolean;
  repositoryObservationsAvailable: boolean;
  activeCredentialCircuits: Array<{
    scope: "repository_actions" | "target_app";
    targetOwner: string | null;
    blockedUntil: string;
  }>;
  githubRequestMetricsUpdatedAt: string | null;
}

export interface AdaptiveHotDecisionRecord {
  schemaVersion: typeof ADAPTIVE_HOT_DECISION_RECORD_SCHEMA_VERSION;
  decisionId: string;
  runId: string;
  runAttempt: number;
  observedAt: string;
  requestedMode: AdaptiveHotMode;
  effectiveMode: AdaptiveHotMode;
  status: AdaptiveHotDecisionStatus;
  policyVersion: string;
  killSwitch: boolean;
  activationApproval: AdaptiveHotActivationApproval;
  rolloutPercent: 10 | 50 | 100;
  canaryRepositories: string[];
  reason: string;
  legacyCursor: { input: number; next: number };
  adaptiveCursor: { input: number; next: number };
  adaptiveProbeCursor: { input: number; next: number };
  actual: AdaptiveHotActualAllocation[];
  proposed: AdaptiveHotAllocationDecision;
  control: AdaptiveHotControlFacts;
  comparison: {
    legacyRepositoryCount: number;
    legacyOfferBudget: number;
    adaptiveRepositoryCount: number;
    adaptiveOfferBudget: number;
    predictedOfferReduction: number;
    observedPlannerSamples: number;
    observedAttempted: number;
    observedDedupedOrShed: number;
    estimatedAvoidedDedupeOrShed: number | null;
    overdueRepositoriesBefore: number;
    overdueRepositoriesSelected: number;
    oldestUnservedAgeBeforeMs: number | null;
    oldestUnservedAgeAfterProposalMs: number | null;
  };
}

export interface AdaptiveHotRepositoryObservationSnapshot {
  targetRepo: string;
  lane: AdaptiveHotPlannerLane;
  policyVersion: string;
  observedAt: string;
  windowStartedAt: string;
  eligibleDue: number;
  selected: number;
  offered: number;
  attempted: number;
  admitted: number;
  deduped: number;
  shed: number;
  deferred: number;
  rejected: number;
  throttled: number;
  sourceNovelDue: number;
  oldestDueAt: string | null;
  oldestUnservedAt: string | null;
  lastAdmittedAt: string | null;
  lastSuccessfulAt: string | null;
  plannerSamples: number;
  executionSamples: number;
  earlyNoop: number;
  structuralHit: number;
  semanticHit: number;
  contentHit: number;
  hydrated: number;
  successful: number;
  retried: number;
  failed: number;
  reviewRuntimeMs: number;
}

export interface AdaptiveHotReadinessFacts {
  policyVersion: string | null;
  shadow: {
    firstDispatchedAt: string | null;
    lastDispatchedAt: string | null;
    dispatchedCycles: number;
  };
  canary: {
    firstDispatchedAt: string | null;
    lastDispatchedAt: string | null;
    dispatchedCycles: number;
  };
  full10: {
    firstDispatchedAt: string | null;
    lastDispatchedAt: string | null;
    dispatchedCycles: number;
  };
  full50: {
    firstDispatchedAt: string | null;
    lastDispatchedAt: string | null;
    dispatchedCycles: number;
  };
}

export interface AdaptiveHotControlSnapshot {
  schemaVersion: typeof ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  observations: AdaptiveHotRepositoryObservationSnapshot[];
  recentDecisions: AdaptiveHotDecisionRecord[];
  readiness: AdaptiveHotReadinessFacts;
}

export function isAdaptiveHotMode(value: unknown): value is AdaptiveHotMode {
  return value === "legacy" || value === "shadow" || value === "canary" || value === "full";
}

export function isAdaptiveHotActivationApproval(
  value: unknown,
): value is AdaptiveHotActivationApproval {
  return value === "none" || value === "canary" || value === "full";
}

export function isAdaptiveHotRepositorySlug(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
