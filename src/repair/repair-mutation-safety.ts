import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionIdempotencyKey,
  type ActionEvent,
  type ActionEventStatus,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  recordWorkflowActionEvent,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import {
  MAX_REVIEWED_PR_ACTIVITY,
  REVIEWED_PR_ACTIVITY_THREADS_QUERY,
  ReviewedPrActivityChangedDuringReadError,
  createReviewedPrActivityCursor,
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  reviewedPrActivityThreadsPageFromGraphql,
} from "../review-activity-cursor.js";
import { ghJsonWithRetry as ghJson, ghPagedLimitWithRetry as ghPagedLimit } from "./github-cli.js";
import { repoRoot } from "./paths.js";

export type RepairMutationTargetKind = "issue" | "pull_request";
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
  refreshAfterAcceptedMutation: (mutationKind: string) => void;
};

type RepairMutationFreshnessOptions = {
  repository: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  expectedUpdatedAt?: string | null;
  expectedReviewActivityCursor?: string | null;
  readUpdatedAt: () => unknown;
  readReviewActivityCursor?: () => string | null;
};

type RepairMutationOptions<T> = {
  kind: string;
  identity: unknown;
  freshness: RepairMutationFreshnessGuard;
  operation: () => T;
  knownNoMutation?: (error: unknown) => boolean;
  outcome?: (result: T) => RepairMutationOutcome;
  refreshAfterAcceptedMutation?: boolean;
};

type RepairMutationChain = {
  parentEventId: string | null;
  phaseSeq: number;
};

type RepairMutationIdentity = {
  operation: ReturnType<typeof repairMutationOperationIdentity>;
  mutation: string;
  requestSha256: string;
};

const mutationChains = new Map<string, RepairMutationChain>();

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
  let expectedUpdatedAt =
    normalizedTimestamp(options.expectedUpdatedAt) ??
    readRequiredUpdatedAt(options.readUpdatedAt, "freshness baseline");
  const readReviewActivityCursor =
    options.readReviewActivityCursor ??
    (() => fetchStableRepairReviewActivityCursor(options.repository, options.number));
  const expectedReviewActivityCursor =
    options.targetKind === "pull_request"
      ? initialReviewActivityCursor(options.expectedReviewActivityCursor, readReviewActivityCursor)
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
      const currentUpdatedAt = readRequiredUpdatedAt(options.readUpdatedAt, mutationKind);
      if (currentUpdatedAt !== expectedUpdatedAt) {
        throw new RepairMutationFreshnessError(
          mutationKind,
          "target activity changed after repair validation",
          false,
        );
      }
      assertReviewActivityFresh(mutationKind);
    },
    refreshAfterAcceptedMutation(mutationKind: string) {
      assertReviewActivityFresh(mutationKind);
      expectedUpdatedAt = readRequiredUpdatedAt(options.readUpdatedAt, mutationKind);
    },
  };
}

export function runRepairMutation<T>(
  context: RepairMutationContext,
  options: RepairMutationOptions<T>,
): T {
  const kind = machineState(options.kind, "github_mutation");
  options.freshness.assertFresh(kind);

  const mutationIdentity = {
    operation: repairMutationOperationIdentity(context),
    mutation: kind,
    requestSha256: actionIdempotencyKey(options.identity),
  };
  const attempt = recordRepairMutationEvent(context, {
    kind,
    mutationIdentity,
    outcome: "attempted",
  });

  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    const outcome = knownRejectedOutcome(options.knownNoMutation, error);
    recordRepairMutationOutcome(context, mutationIdentity, kind, outcome, attempt);
    if (outcome === "unknown") {
      throw new RepairMutationOutcomeUnknownError(kind, error);
    }
    throw error;
  }

  let outcome: RepairMutationOutcome;
  try {
    outcome = options.outcome?.(result) ?? "accepted";
  } catch (error) {
    recordRepairMutationOutcome(context, mutationIdentity, kind, "unknown", attempt);
    throw new RepairMutationOutcomeUnknownError(kind, error);
  }
  recordRepairMutationOutcome(context, mutationIdentity, kind, outcome, attempt);
  if (outcome === "unknown") {
    throw new RepairMutationOutcomeUnknownError(kind, new Error("mutation result was ambiguous"));
  }
  if (outcome === "rejected") {
    throw new Error(`GitHub rejected ${kind} before mutation`);
  }
  if (options.refreshAfterAcceptedMutation) {
    options.freshness.refreshAfterAcceptedMutation(kind);
  }
  return result;
}

export async function flushRepairMutationActionEvents(): Promise<string[]> {
  return flushWorkflowActionEvents(repairMutationActionLedgerRoot());
}

export function fetchStableRepairReviewActivityCursor(
  repository: string,
  number: number,
): string | null {
  return readStableReviewedPrActivityCursor(() =>
    fetchRepairReviewActivityCursorOnce(repository, number),
  );
}

function fetchRepairReviewActivityCursorOnce(repository: string, number: number): string | null {
  let remaining = MAX_REVIEWED_PR_ACTIVITY;
  const reviews = ghPagedLimit<unknown>(
    `repos/${repository}/pulls/${number}/reviews`,
    remaining + 1,
  );
  if (reviews.length > remaining) return null;
  remaining -= reviews.length;
  const inlineComments = ghPagedLimit<unknown>(
    `repos/${repository}/pulls/${number}/comments`,
    remaining + 1,
  );
  if (inlineComments.length > remaining) return null;
  remaining -= inlineComments.length;
  const reviewThreads =
    inlineComments.length === 0 ? [] : fetchRepairReviewThreads(repository, number, remaining + 1);
  if (reviewThreads.length > remaining) return null;
  return createReviewedPrActivityCursor({ reviews, inlineComments, reviewThreads });
}

function fetchRepairReviewThreads(repository: string, number: number, limit: number): unknown[] {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new Error("repair review activity repository is invalid");
  const max = Math.max(0, Math.floor(limit));
  const threads: unknown[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  while (threads.length < max) {
    const args = [
      "api",
      "graphql",
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
      "-f",
      `query=${REVIEWED_PR_ACTIVITY_THREADS_QUERY}`,
    ];
    if (after) args.push("-f", `after=${after}`);
    const page = reviewedPrActivityThreadsPageFromGraphql(ghJson<unknown>(args));
    if (!page) throw new Error("repair review thread response is malformed");
    threads.push(...page.threads);
    if (!page.hasNextPage) break;
    if (!page.endCursor || seenCursors.has(page.endCursor) || page.threads.length === 0) {
      throw new Error("repair review thread pagination did not advance");
    }
    seenCursors.add(page.endCursor);
    after = page.endCursor;
  }
  return threads.slice(0, max);
}

function initialReviewActivityCursor(
  expected: string | null | undefined,
  readCurrent: () => string | null,
): string {
  if (expected !== undefined && expected !== null) {
    if (!isReviewedPrActivityCursor(expected)) {
      throw new RepairMutationFreshnessError(
        "freshness_baseline",
        "stored repair review activity cursor is invalid",
        false,
      );
    }
    return expected;
  }
  let current: string | null;
  try {
    current = readCurrent();
  } catch (error) {
    throw new RepairMutationFreshnessError(
      "freshness_baseline",
      error instanceof ReviewedPrActivityChangedDuringReadError
        ? "pull request review activity changed while the repair baseline was captured"
        : "pull request review activity baseline could not be captured",
      true,
    );
  }
  if (!current) {
    throw new RepairMutationFreshnessError(
      "freshness_baseline",
      "pull request review activity exceeds the bounded repair cursor",
      false,
    );
  }
  return current;
}

function recordRepairMutationOutcome(
  context: RepairMutationContext,
  mutationIdentity: RepairMutationIdentity,
  kind: string,
  outcome: RepairMutationOutcome,
  attempt: ActionEvent | null,
): void {
  try {
    recordRepairMutationEvent(context, {
      kind,
      mutationIdentity,
      outcome,
      parentEventId: attempt?.event_id ?? null,
    });
  } catch (error) {
    throw new RepairMutationOutcomeUnknownError(kind, error);
  }
}

function recordRepairMutationEvent(
  context: RepairMutationContext,
  options: {
    kind: string;
    mutationIdentity: RepairMutationIdentity;
    outcome: RepairMutationOutcome | "attempted";
    parentEventId?: string | null;
  },
): ActionEvent | null {
  if (!workflowActionEventsEnabled()) return null;
  const chain = repairMutationChain(context);
  const phaseSeq = chain.phaseSeq + 1;
  const eventType =
    context.phase === "apply_result"
      ? ACTION_EVENT_TYPES.repairExecute
      : ACTION_EVENT_TYPES.repairPostflight;
  const status = mutationOutcomeStatus(options.outcome);
  const event = recordWorkflowActionEvent(repairMutationActionLedgerRoot(), {
    scope: eventType,
    identity: {
      kind: options.kind,
      requestSha256: options.mutationIdentity.requestSha256,
      outcome: options.outcome,
    },
    operation: "repair",
    operationIdentity: options.mutationIdentity.operation,
    attemptIdentity: repairMutationAttemptIdentity(context),
    parentEventId: options.parentEventId ?? chain.parentEventId,
    phaseSeq,
    idempotencyIdentity: options.mutationIdentity,
    type: eventType,
    component: context.phase,
    subject: {
      repository: context.repository,
      kind: context.targetKind,
      number: context.number,
      clusterId: machineState(context.clusterId, "repair"),
      ...(machineRevision(context.sourceRevision)
        ? { sourceRevision: machineRevision(context.sourceRevision)! }
        : {}),
    },
    action: {
      name: eventType,
      status,
      reasonCode: mutationOutcomeReason(options.outcome),
      retryable: options.outcome === "attempted" || options.outcome === "unknown",
      mutation: options.outcome === "accepted" || options.outcome === "unknown",
    },
    attributes: {
      phase: context.phase,
      state: `mutation_${options.outcome}`,
      completion_reason:
        options.outcome === "attempted"
          ? "mutation_attempted"
          : options.outcome === "accepted"
            ? "mutation_accepted"
            : options.outcome === "rejected"
              ? "mutation_rejected"
              : "mutation_outcome_unknown",
    },
    privacy: {
      classification: "internal",
      redactionVersion: "repair-mutation-v1",
      fieldsDropped: ["body", "comment", "diff", "log", "payload", "review"],
    },
  });
  if (event) {
    chain.parentEventId = event.event_id;
    chain.phaseSeq = phaseSeq;
  }
  return event;
}

function repairMutationOperationIdentity(context: RepairMutationContext) {
  return {
    repository: context.repository.trim().toLowerCase(),
    clusterIdSha256: digestText(context.clusterId),
    number: context.number,
    targetKind: context.targetKind,
    phase: context.phase,
    operationKeySha256: digestText(context.operationKey),
  };
}

function repairMutationAttemptIdentity(context: RepairMutationContext) {
  return {
    repository: String(process.env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    runId: String(process.env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    action: String(process.env.GITHUB_ACTION ?? "process").trim(),
    invocation: String(process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default").trim(),
    phase: context.phase,
  };
}

function repairMutationChain(context: RepairMutationContext): RepairMutationChain {
  const key = actionIdempotencyKey({
    operation: repairMutationOperationIdentity(context),
    attempt: repairMutationAttemptIdentity(context),
  });
  const existing = mutationChains.get(key);
  if (existing) return existing;
  const created = { parentEventId: null, phaseSeq: 0 };
  mutationChains.set(key, created);
  return created;
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

function mutationOutcomeStatus(outcome: RepairMutationOutcome | "attempted"): ActionEventStatus {
  if (outcome === "attempted") return ACTION_EVENT_STATUSES.started;
  if (outcome === "accepted") return ACTION_EVENT_STATUSES.executed;
  if (outcome === "rejected") return ACTION_EVENT_STATUSES.skipped;
  return ACTION_EVENT_STATUSES.failed;
}

function mutationOutcomeReason(outcome: RepairMutationOutcome | "attempted") {
  if (outcome === "attempted") return ACTION_EVENT_REASON_CODES.selected;
  if (outcome === "accepted") return ACTION_EVENT_REASON_CODES.completed;
  if (outcome === "rejected") return ACTION_EVENT_REASON_CODES.notApplicable;
  return ACTION_EVENT_REASON_CODES.unavailable;
}

function readRequiredUpdatedAt(readUpdatedAt: () => unknown, mutationKind: string): string {
  let value: unknown;
  try {
    value = readUpdatedAt();
  } catch {
    throw new RepairMutationFreshnessError(
      mutationKind,
      "target activity could not be refreshed",
      true,
    );
  }
  const normalized = normalizedTimestamp(value);
  if (!normalized) {
    throw new RepairMutationFreshnessError(
      mutationKind,
      "target activity timestamp is unavailable",
      true,
    );
  }
  return normalized;
}

function normalizedTimestamp(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function repairMutationActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function machineState(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function machineRevision(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(normalized) ? normalized : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function digestText(value: unknown): string {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}
