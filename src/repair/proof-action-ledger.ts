import crypto from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEvent,
  type ActionEventEvidence,
} from "../action-ledger.js";
import { recordWorkflowPhaseEvent, workflowActionEventsEnabled } from "../action-ledger-runtime.js";
import type { LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";
import type { StagedProofPlanArtifact, StagedProofTrace } from "./staged-proof-gates.js";

export type ProofActionLedgerContext = {
  repository: string;
  clusterId: string;
  source: LooseRecord;
  dispatchKey?: string | null;
  authorizationSha256: string;
  executionManifestSha256: string;
  executionIntentSha256: string;
  actionIdentitySha256: string;
  preparedPublicationSha256: string;
  repairDeltaBaseSha: string;
  validatedHeadSha: string;
  validatedBaseSha: string;
};

type ProofStageInput = {
  context: ProofActionLedgerContext;
  plan: StagedProofPlanArtifact;
  trace?: StagedProofTrace | null;
  proof?: LooseRecord | null;
};

const PROOF_PRIVACY = {
  classification: "internal" as const,
  redactionVersion: "v1",
  fieldsDropped: ["proof.command_output", "proof.error_message", "receipt.body"],
};

export function recordProofStageCompleted(input: ProofStageInput): ActionEvent | null {
  if (!input.trace || !input.proof) {
    throw new Error("completed proof stage evidence requires a trace and proof bundle");
  }
  return recordProofStage(input, {
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    retryable: false,
    failureKind: null,
  });
}

export function recordProofStageFailed(
  input: ProofStageInput & { error: unknown },
): ActionEvent | null {
  return recordProofStage(input, {
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.validationFailed,
    retryable: true,
    failureKind: machineIdentity(
      input.error instanceof Error ? input.error.name : typeof input.error,
    ),
  });
}

export function recordProofBindingCompleted({
  context,
  plan,
  proof,
  receiptSha256,
  parentEventId,
}: {
  context: ProofActionLedgerContext;
  plan: StagedProofPlanArtifact;
  proof: LooseRecord;
  receiptSha256: string;
  parentEventId?: string | null;
}): ActionEvent | null {
  if (!workflowActionEventsEnabled()) return null;
  const operationIdentity = proofOperationIdentity(context);
  const proofSha256 = digest(proof);
  return recordWorkflowPhaseEvent(proofActionLedgerRoot(), {
    phase: ACTION_EVENT_TYPES.proofBinding,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    retryable: false,
    mutation: false,
    identity: {
      slot: "validation_receipt_binding",
      planId: plan.plan_id,
      proofSha256,
      receiptSha256,
    },
    operation: "repair",
    operationIdentity,
    attemptIdentity: proofAttemptIdentity(context),
    parentEventId: parentEventId ?? null,
    phaseSeq: 2,
    idempotencyIdentity: {
      operationIdentity,
      slot: "validation_receipt_binding",
      receiptSha256,
    },
    component: "repair_validation",
    subject: proofSubject(context, operationIdentity),
    evidence: [
      ...commonProofEvidence(context),
      proofArtifactEvidence("proof_plan", plan, plan.plan_id),
      proofArtifactEvidence("proof_bundle", proof, plan.plan_id),
      {
        kind: "validation_receipt",
        sha256: requireDigest(receiptSha256, "validation receipt digest"),
        snapshotId: plan.plan_id,
      },
    ],
    attributes: {
      publication_kind: "validation_receipt",
      validation_kind: "independent_staged",
      state: "bound",
      validation_count: plan.commands.length,
    },
    privacy: PROOF_PRIVACY,
  });
}

function recordProofStage(
  input: ProofStageInput,
  disposition: {
    status: "completed" | "failed";
    reasonCode: "completed" | "validation_failed";
    retryable: boolean;
    failureKind: string | null;
  },
): ActionEvent | null {
  if (!workflowActionEventsEnabled()) return null;
  const operationIdentity = proofOperationIdentity(input.context);
  const traceSha256 = input.trace ? digest(input.trace) : null;
  const proofSha256 = input.proof ? digest(input.proof) : null;
  const evidence: ActionEventEvidence[] = [
    ...commonProofEvidence(input.context),
    proofArtifactEvidence("proof_plan", input.plan, input.plan.plan_id),
  ];
  if (input.trace) {
    evidence.push(proofArtifactEvidence("proof_trace", input.trace, input.plan.plan_id));
  }
  if (input.proof) {
    evidence.push(proofArtifactEvidence("proof_bundle", input.proof, input.plan.plan_id));
  }
  return recordWorkflowPhaseEvent(proofActionLedgerRoot(), {
    phase: ACTION_EVENT_TYPES.proofStage,
    status: disposition.status,
    reasonCode: disposition.reasonCode,
    retryable: disposition.retryable,
    mutation: false,
    identity: {
      slot: "independent_proof_stage",
      planId: input.plan.plan_id,
      status: disposition.status,
      traceSha256,
      proofSha256,
      failureKind: disposition.failureKind,
    },
    operation: "repair",
    operationIdentity,
    attemptIdentity: proofAttemptIdentity(input.context),
    phaseSeq: 1,
    idempotencyIdentity: {
      operationIdentity,
      slot: "independent_proof_stage",
      planId: input.plan.plan_id,
      status: disposition.status,
      traceSha256,
      proofSha256,
    },
    component: "repair_validation",
    subject: proofSubject(input.context, operationIdentity),
    evidence,
    attributes: {
      validation_kind: "independent_staged",
      validation_count: input.trace?.commands.length ?? input.plan.commands.length,
      state: disposition.status,
      failed_count: disposition.status === ACTION_EVENT_STATUSES.failed ? 1 : 0,
    },
    privacy: PROOF_PRIVACY,
  });
}

function proofOperationIdentity(context: ProofActionLedgerContext) {
  return {
    repository: context.repository.toLowerCase(),
    clusterId: context.clusterId,
    source: proofSourceIdentity(context),
    actionIdentitySha256: requireDigest(context.actionIdentitySha256, "repair action digest"),
  };
}

function proofAttemptIdentity(context: ProofActionLedgerContext) {
  return {
    repository: String(process.env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    runId: String(process.env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    job: String(process.env.GITHUB_JOB ?? "").trim(),
    invocation: String(process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default").trim(),
    dispatchKey: dispatchIdentity(context.dispatchKey),
    authorizationSha256: requireDigest(
      context.authorizationSha256,
      "execution authorization digest",
    ),
    executionManifestSha256: requireDigest(
      context.executionManifestSha256,
      "execution manifest digest",
    ),
  };
}

function proofSubject(
  context: ProofActionLedgerContext,
  operationIdentity: ReturnType<typeof proofOperationIdentity>,
) {
  return {
    repository: context.repository,
    kind: "commit" as const,
    subjectId: `repair-proof-${digest(operationIdentity).slice(0, 24)}`,
    clusterId: context.clusterId,
    sourceRevision: context.validatedHeadSha,
  };
}

function commonProofEvidence(context: ProofActionLedgerContext): ActionEventEvidence[] {
  const source = proofSourceIdentity(context);
  const evidence: ActionEventEvidence[] = [
    {
      kind: "repair_source",
      sha256: digest(source),
      ...(source.revision ? { snapshotId: source.revision } : {}),
    },
    {
      kind: "execution_authorization",
      sha256: requireDigest(context.authorizationSha256, "execution authorization digest"),
    },
    {
      kind: "execution_manifest",
      sha256: requireDigest(context.executionManifestSha256, "execution manifest digest"),
    },
    {
      kind: "execution_intent",
      sha256: requireDigest(context.executionIntentSha256, "execution intent digest"),
    },
    {
      kind: "repair_action",
      sha256: requireDigest(context.actionIdentitySha256, "repair action digest"),
    },
    {
      kind: "prepared_publication",
      sha256: requireDigest(context.preparedPublicationSha256, "prepared publication digest"),
    },
    revisionEvidence("repair_delta_base", context.repairDeltaBaseSha),
    revisionEvidence("validated_head", context.validatedHeadSha),
    revisionEvidence("validated_base", context.validatedBaseSha),
  ];
  const dispatchKey = context.dispatchKey?.trim();
  if (dispatchKey) {
    evidence.push({
      kind: "command_dispatch",
      sha256: digest(dispatchKey),
      ...(machineIdentity(dispatchKey) ? { snapshotId: dispatchKey } : {}),
    });
  }
  return evidence;
}

function proofSourceIdentity(context: ProofActionLedgerContext) {
  const revision =
    machineIdentity(context.source.expected_head_sha) ??
    machineIdentity(context.source.expected_revision_sha256) ??
    machineIdentity(context.source.revision_sha256);
  const number = Number(context.source.number);
  return {
    repository: String(context.source.repo ?? context.repository)
      .trim()
      .toLowerCase(),
    kind: machineIdentity(context.source.kind) ?? "unknown",
    number: Number.isSafeInteger(number) && number > 0 ? number : null,
    revision,
  };
}

function proofArtifactEvidence(
  kind: string,
  value: unknown,
  snapshotId: string,
): ActionEventEvidence {
  return { kind, sha256: digest(value), snapshotId };
}

function revisionEvidence(kind: string, revision: string): ActionEventEvidence {
  const normalized = machineIdentity(revision);
  if (!normalized) throw new Error(`${kind} must be a machine-readable revision`);
  return { kind, sha256: digest(normalized), snapshotId: normalized };
}

function proofActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function requireDigest(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} must be a SHA-256 digest`);
  return normalized;
}

function machineIdentity(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(normalized) ? normalized : null;
}

function dispatchIdentity(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return machineIdentity(normalized) ?? `sha256:${digest(normalized)}`;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
