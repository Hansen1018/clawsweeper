import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  recordWorkflowActionEvent,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import { repoRoot } from "./paths.js";

export type RepairLifecycleInput = {
  repository: string;
  workKey: string;
  clusterId?: string | null;
  number?: number | null;
  sourceRevision?: string | null;
  recordPath?: string | null;
};

export type RepairLifecycleEvent = {
  type: string;
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  component: string;
  operation?: string;
  state?: string;
  phase?: string;
  workKind?: string;
  publicationKind?: string;
  statusKind?: string;
  retryable?: boolean;
  eventIdentity?: unknown;
  idempotencySlot?: string;
};

type RepairEventChain = {
  parentEventId: string | null;
  phaseSeq: number;
};

const eventChains = new Map<string, RepairEventChain>();

export function recordRepairLifecycleEvent(
  input: RepairLifecycleInput,
  event: RepairLifecycleEvent,
): void {
  if (!workflowActionEventsEnabled()) return;
  const operationIdentity = {
    repository: input.repository.trim().toLowerCase(),
    workKey: input.workKey.trim(),
    sourceRevision: machineRevision(input.sourceRevision),
  };
  const attemptIdentity = workflowAttemptIdentity();
  const chainKey = stableDigest({ operationIdentity, attemptIdentity, operation: event.operation });
  const chain = eventChains.get(chainKey) ?? { parentEventId: null, phaseSeq: 0 };
  const phaseSeq = chain.phaseSeq + 1;
  const recorded = recordWorkflowActionEvent(repairActionLedgerRoot(), {
    scope: event.type,
    identity: {
      operation: operationIdentity,
      state: event.state ?? event.status,
      phase: event.phase ?? null,
      event: event.eventIdentity ?? null,
    },
    operation: event.operation ?? "repair",
    operationIdentity,
    attemptIdentity,
    parentEventId: chain.parentEventId,
    phaseSeq,
    ...(event.mutation
      ? {
          idempotencyIdentity: {
            operation: operationIdentity,
            slot: event.idempotencySlot ?? event.type,
          },
        }
      : {}),
    type: event.type,
    component: event.component,
    subject: repairSubject(input, event),
    action: {
      name: event.type,
      status: event.status,
      reasonCode: event.reasonCode,
      retryable: event.retryable ?? event.status === ACTION_EVENT_STATUSES.waiting,
      mutation: event.mutation,
    },
    attributes: {
      state: machineText(event.state ?? event.status, "unknown"),
      ...(event.phase ? { phase: machineText(event.phase, "unknown") } : {}),
      ...(event.workKind ? { work_kind: machineText(event.workKind, "unknown") } : {}),
      ...(event.publicationKind
        ? { publication_kind: machineText(event.publicationKind, "unknown") }
        : {}),
      ...(event.statusKind ? { status_kind: machineText(event.statusKind, "unknown") } : {}),
    },
  });
  if (!recorded) return;
  eventChains.set(chainKey, { parentEventId: recorded.event_id, phaseSeq });
}

export function recordRepairLifecycleFailure(
  input: RepairLifecycleInput,
  options: {
    component: string;
    operation?: string;
    phase?: string;
    workKind?: string;
    error: unknown;
  },
): void {
  recordRepairLifecycleEvent(input, {
    type: "repair.failed",
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.exception,
    mutation: false,
    component: options.component,
    state: "failed",
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.workKind ? { workKind: options.workKind } : {}),
    eventIdentity: {
      errorKind: options.error instanceof Error ? options.error.name : typeof options.error,
    },
  });
}

export async function flushRepairActionEvents(): Promise<string[]> {
  return flushWorkflowActionEvents(repairActionLedgerRoot());
}

function repairSubject(input: RepairLifecycleInput, event: RepairLifecycleEvent) {
  const sourceRevision = machineRevision(input.sourceRevision);
  const recordPath = input.recordPath?.trim() || null;
  const subjectId = `repair-${stableDigest({
    repository: input.repository,
    workKey: input.workKey,
  }).slice(0, 24)}`;
  if (input.number && input.number > 0) {
    return {
      repository: input.repository,
      kind: "issue",
      subjectId,
      number: input.number,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(recordPath ? { recordPath } : {}),
    } as const;
  }
  if (event.operation === "publication") {
    return {
      repository: input.repository,
      kind: "publication",
      subjectId,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(recordPath ? { recordPath } : {}),
    } as const;
  }
  return {
    repository: input.repository,
    kind: input.clusterId ? "cluster" : "workflow",
    subjectId,
    ...(input.clusterId ? { clusterId: machineText(input.clusterId, "unknown") } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(recordPath ? { recordPath } : {}),
  } as const;
}

function workflowAttemptIdentity() {
  return {
    repository: String(process.env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    runId: String(process.env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    job: String(process.env.GITHUB_JOB ?? "").trim(),
    action: String(process.env.GITHUB_ACTION ?? "process").trim(),
    invocation: String(process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default").trim(),
  };
}

function repairActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function machineRevision(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(normalized) ? normalized : null;
}

function machineText(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
