import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionAttemptId,
  actionIdempotencyKey,
  actionOperationId,
  readSpooledActionEvents,
  type ActionEvent,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "./action-ledger.js";
import {
  flushWorkflowActionEvents,
  interruptOpenWorkflowActionEvents,
  recordWorkflowActionEvent,
  workflowActionEventsEnabled,
} from "./action-ledger-runtime.js";
import {
  actionLedgerRecoveryEnvironment,
  actionLedgerRecoveryRoot,
  mutationRecoveryPath,
  readMutationRecoveries,
  removeMutationRecovery,
  writeMutationRecovery,
} from "./action-ledger-recovery.js";

export type CommitLifecycleInput = {
  repository: string;
  sha: string;
};

const COMMIT_REVIEW_SUCCESS_RESULTS = new Set([
  "nothing_found",
  "findings",
  "inconclusive",
  "skipped_non_code",
]);

export function commitReviewLifecycleSucceeded(options: {
  reviewOutcome: string;
  checkOutcome: string;
  checksRequested: boolean;
  reportResult: string;
}): boolean {
  const reviewOutcome = options.reviewOutcome.trim().toLowerCase();
  const checkOutcome = options.checkOutcome.trim().toLowerCase();
  const reportResult = options.reportResult.trim().toLowerCase();
  return (
    reviewOutcome === "success" &&
    COMMIT_REVIEW_SUCCESS_RESULTS.has(reportResult) &&
    (!options.checksRequested || checkOutcome === "success")
  );
}

type CommitLifecycleEvent = {
  type: string;
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  component: string;
  state: string;
  parentEventId?: string | null;
  completionReason?: string;
  reviewMode?: string;
  publicationKind?: string;
  logKind?: string;
  eventIdentity?: unknown;
  idempotencyIdentity?: unknown;
  retryable?: boolean;
  evidence?: Array<{ kind: string; sha256?: string }>;
};

type CommitActionLedgerContext = {
  root: string;
  recoveryRoot: string;
  env: NodeJS.ProcessEnv;
};

export function recordCommitLifecycleEvent(
  input: CommitLifecycleInput,
  event: CommitLifecycleEvent,
  context?: CommitActionLedgerContext,
): ActionEvent | null {
  const env = context?.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return null;
  const root = context?.root ?? commitActionLedgerRoot(env);
  const operationIdentity = commitOperationIdentity(input);
  const operationId = actionOperationId(input.repository, "commit_review", operationIdentity);
  const attemptIdentity = workflowAttemptIdentity(env);
  const attemptId = actionAttemptId(operationId, attemptIdentity);
  const previous = latestCommitEvent(
    readSpooledActionEvents(root, input.repository).filter(
      (candidate) => candidate.operation_id === operationId && candidate.attempt_id === attemptId,
    ),
  );
  const phaseSeq = (previous?.phase_seq ?? 0) + 1;
  return recordWorkflowActionEvent(
    root,
    {
      scope: event.type,
      identity: {
        operation: operationIdentity,
        state: event.state,
        event: event.eventIdentity ?? null,
      },
      operation: "commit_review",
      operationIdentity,
      attemptIdentity,
      parentEventId:
        event.parentEventId !== undefined ? event.parentEventId : (previous?.event_id ?? null),
      phaseSeq,
      ...(event.idempotencyIdentity !== undefined
        ? { idempotencyIdentity: event.idempotencyIdentity }
        : event.mutation
          ? {
              idempotencyIdentity: {
                operation: operationIdentity,
                slot: event.type,
              },
            }
          : {}),
      type: event.type,
      component: event.component,
      subject: {
        repository: input.repository,
        kind: "commit",
        subjectId: `commit-${input.sha}`,
        sourceRevision: input.sha,
      },
      action: {
        name: event.type,
        status: event.status,
        reasonCode: event.reasonCode,
        retryable: event.retryable ?? false,
        mutation: event.mutation,
      },
      ...(event.evidence?.length ? { evidence: event.evidence } : {}),
      attributes: {
        state: event.state,
        ...(event.completionReason ? { completion_reason: event.completionReason } : {}),
        ...(event.reviewMode ? { review_mode: event.reviewMode } : {}),
        ...(event.publicationKind ? { publication_kind: event.publicationKind } : {}),
        ...(event.logKind ? { log_kind: event.logKind } : {}),
      },
    },
    { env },
  );
}

export function recordCommitWorkflowEvent(
  input: CommitLifecycleInput,
  phase: "started" | "completed" | "failed" | "finalized",
  error?: unknown,
): void {
  recordCommitLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.workflowAttempt,
    status:
      phase === "started"
        ? ACTION_EVENT_STATUSES.started
        : phase === "failed"
          ? ACTION_EVENT_STATUSES.failed
          : ACTION_EVENT_STATUSES.completed,
    reasonCode:
      phase === "started"
        ? ACTION_EVENT_REASON_CODES.selected
        : phase === "failed"
          ? ACTION_EVENT_REASON_CODES.exception
          : ACTION_EVENT_REASON_CODES.completed,
    mutation: commitMutationState(input).observed,
    retryable: commitMutationState(input).unknown,
    component: "commit_review",
    state: phase,
    completionReason:
      phase === "failed"
        ? commitFailureReason(input)
        : phase === "finalized"
          ? "workflow_finalized"
          : `workflow_${phase}`,
    eventIdentity: {
      phase,
      ...(error === undefined
        ? {}
        : { errorKind: error instanceof Error ? error.name : typeof error }),
    },
  });
}

export function recordCommitArtifactPrepared(
  input: CommitLifecycleInput,
  options: {
    path: string;
    kind: string;
    logKind?: string;
  },
): void {
  if (!existsSync(options.path) || !statSync(options.path).isFile()) return;
  const sha256 = createHash("sha256").update(readFileSync(options.path)).digest("hex");
  recordCommitLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.reviewLogPublication,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: "commit_review",
    state: "prepared",
    publicationKind: options.kind,
    ...(options.logKind ? { logKind: options.logKind } : {}),
    eventIdentity: { kind: options.kind, sha256, state: "prepared" },
    evidence: [{ kind: options.kind, sha256 }],
  });
}

export function runCommitMutation<T>(
  input: CommitLifecycleInput,
  options: {
    kind: string;
    identity: unknown;
    operation: () => T;
    knownNoMutation?: (error: unknown) => boolean;
  },
): T {
  const ledgerContext = commitActionLedgerContext();
  const requestSha256 = stableDigest(options.identity);
  const idempotencyIdentity = {
    operation: commitOperationIdentity(input),
    mutation: options.kind,
    requestSha256,
  };
  const requestAttempt = nextRequestAttempt(input, idempotencyIdentity, ledgerContext);
  const attemptEvent = recordCommitLifecycleEvent(
    input,
    {
      type: ACTION_EVENT_TYPES.publicationLifecycle,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      mutation: false,
      retryable: true,
      component: "commit_review",
      state: "mutation_attempted",
      completionReason: "mutation_attempted",
      publicationKind: options.kind,
      eventIdentity: { kind: options.kind, requestSha256, requestAttempt, outcome: "attempted" },
      idempotencyIdentity,
    },
    ledgerContext,
  );
  const recovery = attemptEvent
    ? beginCommitMutationRecovery(ledgerContext, attemptEvent.event_id, {
        input,
        kind: options.kind,
        requestSha256,
        requestAttempt,
        idempotencyIdentity,
        parentEventId: attemptEvent.event_id,
        outcome: "unknown",
      })
    : null;
  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    let outcome: "rejected" | "unknown" = "unknown";
    try {
      if (options.knownNoMutation?.(error) === true) outcome = "rejected";
    } catch {
      outcome = "unknown";
    }
    recordCommitMutationOutcomeSafely(
      input,
      options.kind,
      requestSha256,
      requestAttempt,
      idempotencyIdentity,
      outcome,
      attemptEvent?.event_id ?? null,
      ledgerContext,
      recovery,
    );
    throw error;
  }
  recordCommitMutationOutcomeWithRecovery(
    recovery,
    input,
    options.kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    "accepted",
    attemptEvent?.event_id ?? null,
    ledgerContext,
  );
  return result;
}

function recordCommitMutationOutcome(
  input: CommitLifecycleInput,
  kind: string,
  requestSha256: string,
  requestAttempt: number,
  idempotencyIdentity: unknown,
  outcome: "accepted" | "rejected" | "unknown",
  parentEventId: string | null,
  context?: CommitActionLedgerContext,
): void {
  recordCommitLifecycleEvent(
    input,
    {
      type: ACTION_EVENT_TYPES.publicationLifecycle,
      status:
        outcome === "accepted"
          ? ACTION_EVENT_STATUSES.published
          : outcome === "rejected"
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.failed,
      reasonCode:
        outcome === "accepted"
          ? ACTION_EVENT_REASON_CODES.published
          : outcome === "rejected"
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.unavailable,
      mutation: outcome !== "rejected",
      retryable: outcome === "unknown",
      component: "commit_review",
      parentEventId,
      state: `mutation_${outcome}`,
      completionReason:
        outcome === "accepted"
          ? "mutation_accepted"
          : outcome === "rejected"
            ? "mutation_rejected"
            : "mutation_outcome_unknown",
      publicationKind: kind,
      eventIdentity: { kind, requestSha256, requestAttempt, outcome },
      idempotencyIdentity,
    },
    context,
  );
}

function recordCommitMutationOutcomeSafely(
  input: CommitLifecycleInput,
  kind: string,
  requestSha256: string,
  requestAttempt: number,
  idempotencyIdentity: unknown,
  outcome: "rejected" | "unknown",
  parentEventId: string | null,
  context?: CommitActionLedgerContext,
  recovery?: CommitMutationRecovery | null,
): boolean {
  updateCommitMutationRecoverySafely(recovery, {
    input,
    kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    parentEventId,
    outcome,
  });
  try {
    recordCommitMutationOutcome(
      input,
      kind,
      requestSha256,
      requestAttempt,
      idempotencyIdentity,
      outcome,
      parentEventId,
      context,
    );
    removeCommitMutationRecoverySafely(recovery);
    return true;
  } catch (receiptError) {
    console.error(
      `[action-ledger] failed to record ${kind} ${outcome} outcome after the primary failure: ${
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      }`,
    );
    return false;
  }
}

type CommitMutationOutcome = "accepted" | "rejected" | "unknown";

type CommitMutationRecoveryPayload = {
  context: {
    root: string;
    env: Record<string, string>;
  };
  input: CommitLifecycleInput;
  kind: string;
  requestSha256: string;
  requestAttempt: number;
  idempotencyIdentity: unknown;
  parentEventId: string | null;
  outcome: CommitMutationOutcome;
};

type CommitMutationRecovery = {
  key: string;
  recoveryRoot: string;
  context: CommitActionLedgerContext;
};

function beginCommitMutationRecovery(
  context: CommitActionLedgerContext,
  key: string,
  outcome: Omit<CommitMutationRecoveryPayload, "context">,
): CommitMutationRecovery {
  const recovery = { key, recoveryRoot: context.recoveryRoot, context };
  writeCommitMutationRecovery(recovery, outcome);
  return recovery;
}

function recordCommitMutationOutcomeWithRecovery(
  recovery: CommitMutationRecovery | null,
  input: CommitLifecycleInput,
  kind: string,
  requestSha256: string,
  requestAttempt: number,
  idempotencyIdentity: unknown,
  outcome: CommitMutationOutcome,
  parentEventId: string | null,
  context: CommitActionLedgerContext,
): void {
  updateCommitMutationRecoverySafely(recovery, {
    input,
    kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    parentEventId,
    outcome,
  });
  recordCommitMutationOutcome(
    input,
    kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    outcome,
    parentEventId,
    context,
  );
  removeCommitMutationRecoverySafely(recovery);
}

export function recoverCommitMutationOutcomes(): void {
  const current = commitActionLedgerContext();
  for (const recovery of readMutationRecoveries<CommitMutationRecoveryPayload>(
    current.recoveryRoot,
    "commit",
  )) {
    const payload = recovery.payload;
    const context: CommitActionLedgerContext = {
      root: payload.context.root,
      recoveryRoot: current.recoveryRoot,
      env: { ...process.env, ...payload.context.env },
    };
    if (commitMutationOutcomeRecorded(payload, context)) {
      removeMutationRecovery(recovery.path);
      continue;
    }
    recordCommitMutationOutcome(
      payload.input,
      payload.kind,
      payload.requestSha256,
      payload.requestAttempt,
      payload.idempotencyIdentity,
      payload.outcome,
      payload.parentEventId,
      context,
    );
    removeMutationRecovery(recovery.path);
  }
}

export async function flushCommitActionEvents(): Promise<string[]> {
  const root = commitActionLedgerRoot();
  recoverCommitMutationOutcomes();
  interruptOpenWorkflowActionEvents(root);
  return flushWorkflowActionEvents(root);
}

function writeCommitMutationRecovery(
  recovery: CommitMutationRecovery,
  outcome: Omit<CommitMutationRecoveryPayload, "context">,
): void {
  writeMutationRecovery(recovery.recoveryRoot, "commit", recovery.key, {
    context: {
      root: recovery.context.root,
      env: actionLedgerRecoveryEnvironment(recovery.context.env),
    },
    ...outcome,
  });
}

function updateCommitMutationRecoverySafely(
  recovery: CommitMutationRecovery | null | undefined,
  outcome: Omit<CommitMutationRecoveryPayload, "context">,
): void {
  if (!recovery) return;
  try {
    writeCommitMutationRecovery(recovery, outcome);
  } catch (error) {
    console.error(
      `[action-ledger] failed to persist ${outcome.kind} ${outcome.outcome} recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function removeCommitMutationRecoverySafely(
  recovery: CommitMutationRecovery | null | undefined,
): void {
  if (!recovery) return;
  try {
    removeMutationRecovery(mutationRecoveryPath(recovery.recoveryRoot, "commit", recovery.key));
  } catch (error) {
    console.error(
      `[action-ledger] failed to clear ${recovery.key} recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function commitMutationOutcomeRecorded(
  payload: CommitMutationRecoveryPayload,
  context: CommitActionLedgerContext,
): boolean {
  return commitEvents(payload.input, context).some(
    (event) =>
      event.parent_event_id === payload.parentEventId &&
      event.event_type === ACTION_EVENT_TYPES.publicationLifecycle &&
      String(event.attributes?.completion_reason ?? "").startsWith("mutation_"),
  );
}

function commitOperationIdentity(input: CommitLifecycleInput) {
  return {
    repository: input.repository.trim().toLowerCase(),
    sha: input.sha.trim().toLowerCase(),
  };
}

function workflowAttemptIdentity(env: NodeJS.ProcessEnv = process.env) {
  return {
    repository: String(env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    workflow: String(env.GITHUB_WORKFLOW_REF ?? env.GITHUB_WORKFLOW ?? "").trim(),
    runId: String(env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT),
  };
}

function commitActionLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || process.cwd();
}

function commitActionLedgerContext(): CommitActionLedgerContext {
  const env = { ...process.env };
  return {
    root: commitActionLedgerRoot(env),
    recoveryRoot: actionLedgerRecoveryRoot(env, commitActionLedgerRoot(env)),
    env,
  };
}

function commitEvents(
  input: CommitLifecycleInput,
  context: CommitActionLedgerContext = commitActionLedgerContext(),
): ActionEvent[] {
  const operationId = actionOperationId(
    input.repository,
    "commit_review",
    commitOperationIdentity(input),
  );
  const attemptId = actionAttemptId(operationId, workflowAttemptIdentity(context.env));
  return readSpooledActionEvents(context.root, input.repository).filter(
    (event) => event.operation_id === operationId && event.attempt_id === attemptId,
  );
}

function latestCommitEvent(events: readonly ActionEvent[]): ActionEvent | null {
  return [...events].sort((left, right) => left.phase_seq - right.phase_seq).at(-1) ?? null;
}

function nextRequestAttempt(
  input: CommitLifecycleInput,
  idempotencyIdentity: unknown,
  context: CommitActionLedgerContext,
): number {
  const idempotencyKey = actionIdempotencyKey(idempotencyIdentity);
  return (
    commitEvents(input, context).filter(
      (event) =>
        event.action.status === ACTION_EVENT_STATUSES.started &&
        event.idempotency_key_sha256 === idempotencyKey,
    ).length + 1
  );
}

function commitMutationState(input: CommitLifecycleInput): { observed: boolean; unknown: boolean } {
  let observed = false;
  let unknown = false;
  for (const event of commitEvents(input)) {
    const reason = String(event.attributes?.completion_reason ?? "");
    if (reason === "mutation_accepted" || reason === "mutation_outcome_unknown") observed = true;
    if (reason === "mutation_outcome_unknown") unknown = true;
  }
  return { observed, unknown };
}

function commitFailureReason(input: CommitLifecycleInput): string {
  const state = commitMutationState(input);
  return state.unknown
    ? "mutation_outcome_unknown"
    : state.observed
      ? "mutation_observed"
      : "failed";
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
