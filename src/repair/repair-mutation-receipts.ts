import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionIdempotencyKey,
  writeActionEventShards,
  type ActionEvent,
  type ActionEventShardIdentity,
  type ActionEventStatus,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  importActionEventShards,
  recordWorkflowActionEvent,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import { publishMainCommit } from "./git-publish.js";
import { ghJson as ghJsonOneShot } from "./github-cli.js";
import { repoRoot } from "./paths.js";
import type { RepairMutationTargetKind } from "./repair-mutation-activity.js";

export type RepairMutationReceiptOutcome = "accepted" | "rejected" | "unknown";
export type RepairMutationReceiptContext = {
  phase: "apply_result" | "post_flight";
  repository: string;
  clusterId: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  operationKey: string;
  sourceRevision?: string | null;
};

export type RepairMutationReceiptIdentity = {
  operation: ReturnType<typeof repairMutationOperationIdentity>;
  mutation: string;
  requestSha256: string;
};

type RepairMutationChain = {
  parentEventId: string | null;
  phaseSeq: number;
};

const mutationChains = new Map<string, RepairMutationChain>();
const durableReceiptPaths = new Set<string>();

export function ensureRepairMutationActionLedger(): void {
  if (repairMutationTestProcess() || repairMutationActionLedgerReady()) return;
  if (process.env.GITHUB_ACTIONS !== "true") {
    if (workflowActionEventsEnabled()) return;
    throw new Error("repair mutation action ledger context is required before GitHub writes");
  }
  if (process.env.CLAWSWEEPER_ACTION_LEDGER_DISABLED === "1") {
    throw new Error("repair mutation action ledger cannot be disabled for GitHub writes");
  }
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const runnerTemp = requiredEnvironment("RUNNER_TEMP");
  requiredEnvironment("CLAWSWEEPER_STATE_DIR");
  let runStartedAt = String(process.env.GITHUB_RUN_STARTED_AT ?? "").trim();
  if (!runStartedAt) {
    const run = record(
      ghJsonOneShot<unknown>(["api", `repos/${repository}/actions/runs/${runId}`]),
    );
    runStartedAt = String(run.created_at ?? run.createdAt ?? "").trim();
  }
  if (!validIsoTimestamp(runStartedAt)) {
    throw new Error("repair mutation action ledger run creation time is unavailable");
  }
  const outputRoot = path.join(
    runnerTemp,
    "clawsweeper-action-ledger",
    runId,
    requiredEnvironment("GITHUB_RUN_ATTEMPT"),
    requiredEnvironment("GITHUB_JOB"),
  );
  fs.mkdirSync(outputRoot, { recursive: true });
  process.env.CLAWSWEEPER_ACTION_LEDGER_FORCE = "1";
  process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT = fs.realpathSync(outputRoot);
  process.env.GITHUB_RUN_STARTED_AT = runStartedAt;
  process.env.CLAWSWEEPER_REPAIR_MUTATION_LEDGER_DURABLE = "1";
  process.env.CLAWSWEEPER_REPAIR_MUTATION_LEDGER_READY = "1";
}

export function repairMutationReceiptIdentity(
  context: RepairMutationReceiptContext,
  mutation: string,
  identity: unknown,
): RepairMutationReceiptIdentity {
  return {
    operation: repairMutationOperationIdentity(context),
    mutation,
    requestSha256: actionIdempotencyKey(identity),
  };
}

export function recordRepairMutationReceipt(
  context: RepairMutationReceiptContext,
  options: {
    kind: string;
    mutationIdentity: RepairMutationReceiptIdentity;
    outcome: RepairMutationReceiptOutcome | "attempted";
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
    component: `${context.phase}.${options.kind}.${options.outcome}.${options.mutationIdentity.requestSha256.slice(0, 12)}`,
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
      status: mutationOutcomeStatus(options.outcome),
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
    publishRepairMutationReceipt(event);
  }
  return event;
}

export async function flushRepairMutationReceipts(): Promise<string[]> {
  if (repairMutationDurableReceiptsEnabled()) return [...durableReceiptPaths].sort();
  return flushWorkflowActionEvents(repairMutationActionLedgerRoot());
}

function publishRepairMutationReceipt(event: ActionEvent): void {
  if (!repairMutationDurableReceiptsEnabled()) return;
  const outputRoot = requiredEnvironment("CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT");
  const stateRoot = fs.realpathSync(requiredEnvironment("CLAWSWEEPER_STATE_DIR"));
  const partitionDate = requiredEnvironment("GITHUB_RUN_STARTED_AT").slice(0, 10);
  const identity: ActionEventShardIdentity = {
    repository: event.producer.repository,
    sha: event.producer.sha,
    producer: event.producer.component,
    workflow: event.producer.workflow,
    job: event.producer.job,
    runId: event.producer.run_id,
    runAttempt: event.producer.run_attempt,
    partitionDate,
  };
  const shardPaths = writeActionEventShards(outputRoot, identity, [event]).map(
    (result) => result.relativePath,
  );
  const imported = importActionEventShards(outputRoot, stateRoot, {
    expectedProducer: {
      repository: event.producer.repository,
      sha: event.producer.sha,
      workflow: event.producer.workflow,
      job: event.producer.job,
      runId: event.producer.run_id,
      runAttempt: event.producer.run_attempt,
    },
    expectedEventPaths: shardPaths,
  });
  for (const relativePath of imported.paths) {
    const source = path.join(stateRoot, relativePath);
    const destination = path.resolve(relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  publishMainCommit({
    message: "chore: append repair mutation action ledger",
    paths: imported.paths,
    rebaseStrategy: "normal",
  });
  for (const relativePath of imported.paths) durableReceiptPaths.add(relativePath);
}

function repairMutationOperationIdentity(context: RepairMutationReceiptContext) {
  return {
    repository: context.repository.trim().toLowerCase(),
    clusterIdSha256: digestText(context.clusterId),
    number: context.number,
    targetKind: context.targetKind,
    phase: context.phase,
    operationKeySha256: digestText(context.operationKey),
  };
}

function repairMutationAttemptIdentity(context: RepairMutationReceiptContext) {
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

function repairMutationChain(context: RepairMutationReceiptContext): RepairMutationChain {
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

function mutationOutcomeStatus(
  outcome: RepairMutationReceiptOutcome | "attempted",
): ActionEventStatus {
  if (outcome === "attempted") return ACTION_EVENT_STATUSES.started;
  if (outcome === "accepted") return ACTION_EVENT_STATUSES.executed;
  if (outcome === "rejected") return ACTION_EVENT_STATUSES.skipped;
  return ACTION_EVENT_STATUSES.failed;
}

function mutationOutcomeReason(outcome: RepairMutationReceiptOutcome | "attempted") {
  if (outcome === "attempted") return ACTION_EVENT_REASON_CODES.selected;
  if (outcome === "accepted") return ACTION_EVENT_REASON_CODES.completed;
  if (outcome === "rejected") return ACTION_EVENT_REASON_CODES.notApplicable;
  return ACTION_EVENT_REASON_CODES.unavailable;
}

function repairMutationActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function repairMutationActionLedgerReady(): boolean {
  if (process.env.GITHUB_ACTIONS !== "true") return workflowActionEventsEnabled();
  return (
    process.env.CLAWSWEEPER_REPAIR_MUTATION_LEDGER_READY === "1" &&
    workflowActionEventsEnabled() &&
    repairMutationDurableReceiptsEnabled()
  );
}

function repairMutationDurableReceiptsEnabled(): boolean {
  return process.env.CLAWSWEEPER_REPAIR_MUTATION_LEDGER_DURABLE === "1";
}

function repairMutationTestProcess(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) && !workflowActionEventsEnabled();
}

function requiredEnvironment(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required for repair mutation receipts`);
  return value;
}

function validIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
