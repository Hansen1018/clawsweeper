import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AdaptiveHotAllocationPolicy } from "./adaptive-hot-allocation.js";
import type {
  AdaptiveHotActivationApproval,
  AdaptiveHotActualAllocation,
  AdaptiveHotControlSnapshot,
  AdaptiveHotMode,
} from "./adaptive-hot-review-contract.js";
import {
  isAdaptiveHotActivationApproval,
  isAdaptiveHotMode,
  isAdaptiveHotRepositorySlug,
} from "./adaptive-hot-review-contract.js";
import { repoRoot } from "./lib.js";

type JsonRecord = Record<string, unknown>;

export interface AdaptiveHotRuntimePolicy {
  allocation: AdaptiveHotAllocationPolicy;
  defaultMode: AdaptiveHotMode;
  killSwitchDefault: boolean;
  shadowMinDurationMs: number;
  shadowMinCycles: number;
  canaryMinDurationMs: number;
  canaryMinCycles: number;
  decisionRetentionMs: number;
  decisionRetentionMax: number;
}

export interface AdaptiveHotRuntimeOptions {
  requestedMode: AdaptiveHotMode;
  effectiveMode: AdaptiveHotMode;
  killSwitch: boolean;
  activationApproval: AdaptiveHotActivationApproval;
  rolloutPercent: 10 | 50 | 100;
  canaryRepositories: string[];
}

export interface AdaptiveHotLegacyRepository {
  targetRepo: string;
  candidateCapacity: number;
}

export interface AdaptiveHotProposedRepository {
  targetRepo: string;
  candidateCapacity: number;
}

export function readAdaptiveHotRuntimePolicy(
  filePath = join(repoRoot(), "config", "automation-limits.json"),
): AdaptiveHotRuntimePolicy {
  const root = record(JSON.parse(readFileSync(filePath, "utf8")), "automation limits");
  const scheduled = record(root.scheduled_review, "scheduled_review");
  const adaptive = record(scheduled.adaptive_hot, "scheduled_review.adaptive_hot");
  return {
    allocation: {
      policyVersion: nonEmptyString(adaptive.policy_version, "policy_version"),
      fairnessObjectiveMs: positiveInteger(adaptive.fairness_objective_ms, "fairness_objective_ms"),
      observationMaxAgeMs: positiveInteger(
        adaptive.observation_max_age_ms,
        "observation_max_age_ms",
      ),
      overOfferNumerator: positiveInteger(adaptive.over_offer_numerator, "over_offer_numerator"),
      overOfferDenominator: positiveInteger(
        adaptive.over_offer_denominator,
        "over_offer_denominator",
      ),
      maxOfferBudget: positiveInteger(adaptive.max_offer_budget, "max_offer_budget"),
      maxRepositories: positiveInteger(adaptive.max_repositories, "max_repositories"),
      unknownProbeLimit: positiveInteger(adaptive.unknown_probe_limit, "unknown_probe_limit"),
      unavailableObservationFallbackLimit: positiveInteger(
        adaptive.unavailable_observation_fallback_limit,
        "unavailable_observation_fallback_limit",
      ),
      repositoryShareNumerator: positiveInteger(
        adaptive.repository_share_numerator,
        "repository_share_numerator",
      ),
      repositoryShareDenominator: positiveInteger(
        adaptive.repository_share_denominator,
        "repository_share_denominator",
      ),
      maxRepositoryCandidates: positiveInteger(
        adaptive.max_repository_candidates,
        "max_repository_candidates",
      ),
    },
    defaultMode: adaptiveHotMode(adaptive.default_mode, "default_mode"),
    killSwitchDefault: booleanValue(adaptive.kill_switch_default, "kill_switch_default"),
    shadowMinDurationMs: positiveInteger(adaptive.shadow_min_duration_ms, "shadow_min_duration_ms"),
    shadowMinCycles: positiveInteger(adaptive.shadow_min_cycles, "shadow_min_cycles"),
    canaryMinDurationMs: positiveInteger(adaptive.canary_min_duration_ms, "canary_min_duration_ms"),
    canaryMinCycles: positiveInteger(adaptive.canary_min_cycles, "canary_min_cycles"),
    decisionRetentionMs: positiveInteger(adaptive.decision_retention_ms, "decision_retention_ms"),
    decisionRetentionMax: positiveInteger(
      adaptive.decision_retention_max,
      "decision_retention_max",
    ),
  };
}

export function resolveAdaptiveHotRuntimeOptions(options: {
  policy: AdaptiveHotRuntimePolicy;
  mode?: unknown;
  killSwitch?: unknown;
  activationApproval?: unknown;
  rolloutPercent?: unknown;
  canaryRepositories?: unknown;
}): AdaptiveHotRuntimeOptions {
  const requestedMode =
    options.mode == null || String(options.mode).trim() === ""
      ? options.policy.defaultMode
      : adaptiveHotMode(options.mode, "adaptive mode");
  const killSwitch = optionalBoolean(
    options.killSwitch,
    options.policy.killSwitchDefault,
    "adaptive kill switch",
  );
  const approvalRaw =
    options.activationApproval == null || String(options.activationApproval).trim() === ""
      ? "none"
      : String(options.activationApproval).trim().toLowerCase();
  if (!isAdaptiveHotActivationApproval(approvalRaw)) {
    throw new Error("adaptive activation approval must be none, canary, or full");
  }
  const rolloutPercent = rolloutPercentage(options.rolloutPercent);
  const canaryRepositories = repositoryList(options.canaryRepositories);
  const effectiveMode = killSwitch ? "legacy" : requestedMode;
  if (
    effectiveMode === "canary" &&
    (canaryRepositories.length < 3 || canaryRepositories.length > 5)
  ) {
    throw new Error("adaptive canary mode requires three to five repositories");
  }
  return {
    requestedMode,
    effectiveMode,
    killSwitch,
    activationApproval: approvalRaw,
    rolloutPercent,
    canaryRepositories,
  };
}

export function assertAdaptiveHotActivationReady(options: {
  runtime: AdaptiveHotRuntimeOptions;
  policy: AdaptiveHotRuntimePolicy;
  control: AdaptiveHotControlSnapshot;
  nowMs: number;
}): void {
  const { runtime, policy, control, nowMs } = options;
  if (runtime.effectiveMode === "legacy" || runtime.effectiveMode === "shadow") return;
  if (
    runtime.effectiveMode === "canary" &&
    runtime.activationApproval !== "canary" &&
    runtime.activationApproval !== "full"
  ) {
    throw new Error("adaptive canary activation requires explicit canary approval");
  }
  if (runtime.effectiveMode === "full" && runtime.activationApproval !== "full") {
    throw new Error("adaptive full activation requires explicit full approval");
  }
  if (control.readiness.policyVersion !== policy.allocation.policyVersion) {
    throw new Error(
      `adaptive readiness evidence is not for policy ${policy.allocation.policyVersion}`,
    );
  }
  if (runtime.effectiveMode === "canary") {
    assertReadinessWindow({
      label: "shadow",
      facts: control.readiness.shadow,
      nowMs,
      minDurationMs: policy.shadowMinDurationMs,
      minCycles: policy.shadowMinCycles,
    });
  } else if (runtime.rolloutPercent === 10) {
    assertReadinessWindow({
      label: "canary",
      facts: control.readiness.canary,
      nowMs,
      minDurationMs: policy.canaryMinDurationMs,
      minCycles: policy.canaryMinCycles,
    });
  } else {
    const previous =
      runtime.rolloutPercent === 50 ? control.readiness.full10 : control.readiness.full50;
    assertReadinessWindow({
      label: runtime.rolloutPercent === 50 ? "full-10-percent" : "full-50-percent",
      facts: previous,
      nowMs,
      minDurationMs: policy.canaryMinDurationMs,
      minCycles: policy.canaryMinCycles,
    });
  }
}

export function selectAdaptiveHotActualAllocations(options: {
  runtime: AdaptiveHotRuntimeOptions;
  legacy: readonly AdaptiveHotLegacyRepository[];
  proposed: readonly AdaptiveHotProposedRepository[];
}): AdaptiveHotActualAllocation[] {
  const { runtime } = options;
  if (runtime.effectiveMode === "legacy" || runtime.effectiveMode === "shadow") {
    return options.legacy.map((repository) => ({ ...repository, source: "legacy" }));
  }
  if (runtime.effectiveMode === "full" && runtime.rolloutPercent === 100) {
    return options.proposed.map((repository) => ({ ...repository, source: "adaptive" }));
  }
  const cohort = (targetRepo: string) =>
    runtime.effectiveMode === "canary"
      ? runtime.canaryRepositories.includes(targetRepo.toLowerCase())
      : adaptiveHotRolloutCohort(targetRepo, runtime.rolloutPercent);
  const slots = options.legacy.filter((repository) => cohort(repository.targetRepo)).length;
  const replacements = options.proposed
    .filter((repository) => cohort(repository.targetRepo))
    .slice(0, slots);
  let replacementIndex = 0;
  return options.legacy.flatMap<AdaptiveHotActualAllocation>((repository) => {
    if (!cohort(repository.targetRepo)) return [{ ...repository, source: "legacy" as const }];
    const replacement = replacements[replacementIndex++];
    return replacement ? [{ ...replacement, source: "adaptive" as const }] : [];
  });
}

export function adaptiveHotRolloutCohort(targetRepo: string, percent: 10 | 50 | 100): boolean {
  if (percent === 100) return true;
  let hash = 2_166_136_261;
  for (const character of targetRepo.toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % 100 < percent;
}

function assertReadinessWindow(options: {
  label: string;
  facts: {
    firstDispatchedAt: string | null;
    lastDispatchedAt: string | null;
    dispatchedCycles: number;
  };
  nowMs: number;
  minDurationMs: number;
  minCycles: number;
}) {
  const first = options.facts.firstDispatchedAt
    ? Date.parse(options.facts.firstDispatchedAt)
    : Number.NaN;
  const last = options.facts.lastDispatchedAt
    ? Date.parse(options.facts.lastDispatchedAt)
    : Number.NaN;
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    first > last ||
    last > options.nowMs ||
    last - first < options.minDurationMs ||
    options.facts.dispatchedCycles < options.minCycles
  ) {
    throw new Error(
      `adaptive ${options.label} readiness requires ${options.minCycles} dispatched cycles across ${options.minDurationMs}ms`,
    );
  }
}

function rolloutPercentage(value: unknown): 10 | 50 | 100 {
  const parsed = value == null || String(value).trim() === "" ? 100 : Number(value);
  if (parsed === 10 || parsed === 50 || parsed === 100) return parsed;
  throw new Error("adaptive rollout percent must be 10, 50, or 100");
}

function repositoryList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const repositories = entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  if (repositories.some((repository) => !isAdaptiveHotRepositorySlug(repository))) {
    throw new Error("adaptive canary repositories must be owner/repository slugs");
  }
  return [...new Set(repositories)].sort();
}

function adaptiveHotMode(value: unknown, label: string): AdaptiveHotMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!isAdaptiveHotMode(normalized))
    throw new Error(`${label} must be legacy, shadow, canary, or full`);
  return normalized;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false`);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}
