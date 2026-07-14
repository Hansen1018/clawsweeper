import type { ActionEvent } from "../action-ledger.js";
import {
  ReviewedPrActivityChangedDuringReadError,
  isReviewedPrActivityCursor,
} from "../review-activity-cursor.js";
import {
  fetchStableRepairReviewActivityCursor,
  fetchStableRepairTargetActivity,
  normalizeRepairTargetActivitySnapshot,
  repairCreatedCommentChange,
  repairTargetActivityMatchesOwnedChange,
  sameRepairTargetActivity,
  type RepairMutationOwnedChange,
  type RepairMutationTargetKind,
  type RepairTargetActivitySnapshot,
} from "./repair-mutation-activity.js";
import {
  ensureRepairMutationActionLedger,
  flushRepairMutationReceipts,
  recordRepairMutationReceipt,
  repairMutationReceiptIdentity,
  type RepairMutationReceiptIdentity,
} from "./repair-mutation-receipts.js";

export { repairCreatedCommentChange };
export type { RepairMutationOwnedChange, RepairMutationTargetKind, RepairTargetActivitySnapshot };

export type RepairMutationPhase = "apply_result" | "post_flight";
export type RepairMutationOutcome = "accepted" | "rejected" | "unknown";

export type RepairMutationContext = {
  phase: RepairMutationPhase;
  repository: string;
  clusterId: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  operationKey: string;
  sourceRevision?: string | null;
};

export type RepairMutationFreshnessGuard = {
  assertFresh: (mutationKind: string) => void;
  acceptOwnedMutation: (mutationKind: string, change: RepairMutationOwnedChange) => void;
};

type RepairMutationFreshnessOptions = {
  repository: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  expectedUpdatedAt?: string | null;
  expectedReviewActivityCursor?: string | null;
  readTargetActivity?: () => RepairTargetActivitySnapshot | null;
  readReviewActivityCursor?: () => string | null;
};

type RepairMutationOptions<T> = {
  kind: string;
  identity: unknown;
  freshness: RepairMutationFreshnessGuard;
  operation: () => T;
  knownNoMutation?: (error: unknown) => boolean;
  outcome?: (result: T) => RepairMutationOutcome;
  acceptedChange?: (result: T) => RepairMutationOwnedChange;
};

export class RepairMutationFreshnessError extends Error {
  readonly mutationKind: string;
  readonly retryable: boolean;

  constructor(mutationKind: string, reason: string, retryable: boolean) {
    super(`${reason} before ${mutationKind}`);
    this.name = "RepairMutationFreshnessError";
    this.mutationKind = mutationKind;
    this.retryable = retryable;
  }
}

export class RepairMutationOutcomeUnknownError extends Error {
  readonly mutationKind: string;

  constructor(mutationKind: string, cause: unknown) {
    super(`GitHub mutation outcome is unknown for ${mutationKind}`, { cause });
    this.name = "RepairMutationOutcomeUnknownError";
    this.mutationKind = mutationKind;
  }
}

export function createRepairMutationFreshnessGuard(
  options: RepairMutationFreshnessOptions,
): RepairMutationFreshnessGuard {
  const readTargetActivity =
    options.readTargetActivity ??
    (() => fetchStableRepairTargetActivity(options.repository, options.number, options.targetKind));
  let expectedTargetActivity = readRequiredTargetActivity(readTargetActivity, "freshness baseline");
  const expectedUpdatedAt = normalizedTimestamp(options.expectedUpdatedAt);
  if (expectedUpdatedAt && expectedUpdatedAt !== expectedTargetActivity.updatedAt) {
    throw new RepairMutationFreshnessError(
      "freshness_baseline",
      "target activity changed after repair validation",
      false,
    );
  }
  const readReviewActivityCursor =
    options.readReviewActivityCursor ??
    (() => fetchStableRepairReviewActivityCursor(options.repository, options.number));
  const expectedReviewActivityCursor =
    options.targetKind === "pull_request"
      ? requiredReviewActivityCursor(options.expectedReviewActivityCursor)
      : null;

  const assertReviewActivityFresh = (mutationKind: string) => {
    if (options.targetKind !== "pull_request") return;
    let current: string | null;
    try {
      current = readReviewActivityCursor();
    } catch (error) {
      throw new RepairMutationFreshnessError(
        mutationKind,
        error instanceof ReviewedPrActivityChangedDuringReadError
          ? "pull request review activity changed while it was being refreshed"
          : "pull request review activity could not be refreshed",
        true,
      );
    }
    if (!current) {
      throw new RepairMutationFreshnessError(
        mutationKind,
        "pull request review activity exceeds the bounded repair cursor",
        false,
      );
    }
    if (current !== expectedReviewActivityCursor) {
      throw new RepairMutationFreshnessError(
        mutationKind,
        "pull request review activity changed after repair validation",
        false,
      );
    }
  };

  return {
    assertFresh(mutationKind: string) {
      const current = readRequiredTargetActivity(readTargetActivity, mutationKind);
      if (!sameRepairTargetActivity(current, expectedTargetActivity)) {
        throw new RepairMutationFreshnessError(
          mutationKind,
          "target activity changed after repair validation",
          false,
        );
      }
      assertReviewActivityFresh(mutationKind);
    },
    acceptOwnedMutation(mutationKind: string, change: RepairMutationOwnedChange) {
      const current = readRequiredTargetActivity(readTargetActivity, mutationKind);
      if (!repairTargetActivityMatchesOwnedChange(expectedTargetActivity, current, change)) {
        throw new RepairMutationFreshnessError(
          mutationKind,
          "target activity changed concurrently with the ClawSweeper mutation",
          false,
        );
      }
      assertReviewActivityFresh(mutationKind);
      expectedTargetActivity = current;
    },
  };
}

export function runRepairMutation<T>(
  context: RepairMutationContext,
  options: RepairMutationOptions<T>,
): T {
  ensureRepairMutationActionLedger();
  const kind = machineState(options.kind, "github_mutation");
  options.freshness.assertFresh(kind);
  const mutationIdentity = repairMutationReceiptIdentity(context, kind, options.identity);
  const attempt = recordRepairMutationReceipt(context, {
    kind,
    mutationIdentity,
    outcome: "attempted",
  });

  try {
    options.freshness.assertFresh(kind);
  } catch (error) {
    recordRepairMutationOutcome(context, mutationIdentity, kind, "rejected", attempt);
    throw error;
  }

  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    const outcome = knownRejectedOutcome(options.knownNoMutation, error);
    recordRepairMutationOutcome(context, mutationIdentity, kind, outcome, attempt);
    if (outcome === "unknown") throw new RepairMutationOutcomeUnknownError(kind, error);
    throw error;
  }

  let outcome: RepairMutationOutcome;
  let acceptedChange: RepairMutationOwnedChange | null = null;
  try {
    outcome = options.outcome?.(result) ?? "accepted";
    acceptedChange =
      outcome === "accepted" && options.acceptedChange ? options.acceptedChange(result) : null;
  } catch (error) {
    recordRepairMutationOutcome(context, mutationIdentity, kind, "unknown", attempt);
    throw new RepairMutationOutcomeUnknownError(kind, error);
  }
  recordRepairMutationOutcome(context, mutationIdentity, kind, outcome, attempt);
  if (outcome === "unknown") {
    throw new RepairMutationOutcomeUnknownError(kind, new Error("mutation result was ambiguous"));
  }
  if (outcome === "rejected") throw new Error(`GitHub rejected ${kind} before mutation`);
  if (acceptedChange) options.freshness.acceptOwnedMutation(kind, acceptedChange);
  return result;
}

export async function flushRepairMutationActionEvents(): Promise<string[]> {
  return flushRepairMutationReceipts();
}

function recordRepairMutationOutcome(
  context: RepairMutationContext,
  mutationIdentity: RepairMutationReceiptIdentity,
  kind: string,
  outcome: RepairMutationOutcome,
  attempt: ActionEvent | null,
): void {
  try {
    recordRepairMutationReceipt(context, {
      kind,
      mutationIdentity,
      outcome,
      parentEventId: attempt?.event_id ?? null,
    });
  } catch (error) {
    throw new RepairMutationOutcomeUnknownError(kind, error);
  }
}

function readRequiredTargetActivity(
  readTargetActivity: () => RepairTargetActivitySnapshot | null,
  mutationKind: string,
): RepairTargetActivitySnapshot {
  let value: RepairTargetActivitySnapshot | null;
  try {
    value = readTargetActivity();
  } catch {
    throw new RepairMutationFreshnessError(
      mutationKind,
      "target activity snapshot could not be refreshed",
      true,
    );
  }
  if (!value) {
    throw new RepairMutationFreshnessError(
      mutationKind,
      "target activity exceeds the bounded repair snapshot",
      false,
    );
  }
  try {
    return normalizeRepairTargetActivitySnapshot(value);
  } catch {
    throw new RepairMutationFreshnessError(
      mutationKind,
      "target activity snapshot is malformed",
      true,
    );
  }
}

function requiredReviewActivityCursor(expected: string | null | undefined): string {
  if (!expected) {
    throw new RepairMutationFreshnessError(
      "freshness_baseline",
      "reviewed pull request activity cursor is unavailable",
      false,
    );
  }
  if (!isReviewedPrActivityCursor(expected)) {
    throw new RepairMutationFreshnessError(
      "freshness_baseline",
      "stored repair review activity cursor is invalid",
      false,
    );
  }
  return expected;
}

function knownRejectedOutcome(
  predicate: ((error: unknown) => boolean) | undefined,
  error: unknown,
): RepairMutationOutcome {
  if (!predicate) return "unknown";
  try {
    return predicate(error) ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizedTimestamp(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function machineState(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}
