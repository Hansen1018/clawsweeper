import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEvent,
  type ActionEventEvidence,
  readActionEventShardAt,
  readAllSpooledActionEvents,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  importActionEventShards,
  recordWorkflowPhaseEvent,
  workflowActionProducer,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import { verifiedProofActionLedgerInput } from "./execution-handoff.js";
import type { LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";
import type { StagedProofPlanArtifact, StagedProofTrace } from "./staged-proof-gates.js";

export type ProofActionLedgerContext = {
  repository: string;
  clusterId: string;
  source: LooseRecord;
  dispatchKey?: string | null | undefined;
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
  ledgerRoot?: string;
};

export type ProofActionLedgerArtifactManifest = {
  schema_version: 1;
  authorization_sha256: string;
  validation_receipt_sha256: string;
  paths: string[];
  events: ActionEvent[];
  identity_sha256: string;
};

const PROOF_LEDGER_ARTIFACT_LIMITS = {
  maxFiles: 4,
  maxDirectories: 12,
  maxRelativePathBytes: 4_096,
} as const;

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
  ledgerRoot,
}: {
  context: ProofActionLedgerContext;
  plan: StagedProofPlanArtifact;
  proof: LooseRecord;
  receiptSha256: string;
  parentEventId?: string | null;
  ledgerRoot?: string;
}): ActionEvent | null {
  if (!workflowActionEventsEnabled()) return null;
  const operationIdentity = proofOperationIdentity(context);
  const proofSha256 = digest(proof);
  return recordWorkflowPhaseEvent(proofActionLedgerRoot(ledgerRoot), {
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
  return recordWorkflowPhaseEvent(proofActionLedgerRoot(input.ledgerRoot), {
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

export async function createProofActionLedgerArtifact({
  root,
  receiptPath,
  expectedAuthorizationSha256,
  expectedReceiptSha256,
  dispatchKey,
  ledgerRoot,
  outputRoot,
}: {
  root: string;
  receiptPath: string;
  expectedAuthorizationSha256: string;
  expectedReceiptSha256: string;
  dispatchKey?: string | null | undefined;
  ledgerRoot: string;
  outputRoot: string;
}): Promise<ProofActionLedgerArtifactManifest> {
  if (readAllSpooledActionEvents(ledgerRoot).length > 0) {
    throw new Error("trusted proof action ledger root already contains action events");
  }
  if (proofLedgerShardPaths(outputRoot).length > 0) {
    throw new Error("trusted proof action ledger output already contains event shards");
  }
  const input = verifiedProofActionLedgerInput({
    root,
    receiptPath,
    expectedAuthorizationSha256,
    expectedReceiptSha256,
    dispatchKey,
  });
  const stage = recordProofStageCompleted({
    context: input.context,
    plan: input.plan,
    trace: input.trace,
    proof: input.proof,
    ledgerRoot,
  });
  if (!stage) throw new Error("trusted proof stage event emission is disabled");
  const binding = recordProofBindingCompleted({
    context: input.context,
    plan: input.plan,
    proof: input.proof,
    receiptSha256: input.receiptSha256,
    parentEventId: stage.event_id,
    ledgerRoot,
  });
  if (!binding) throw new Error("trusted proof binding event emission is disabled");
  const paths = await flushWorkflowActionEvents(ledgerRoot, { outputRoot });
  const identity = {
    schema_version: 1 as const,
    authorization_sha256: requireDigest(
      expectedAuthorizationSha256,
      "execution authorization digest",
    ),
    validation_receipt_sha256: requireDigest(expectedReceiptSha256, "validation receipt digest"),
    paths,
    events: [stage, binding],
  };
  const manifest = { ...identity, identity_sha256: digest(identity) };
  validateProofActionLedgerArtifact({
    sourceRoot: outputRoot,
    manifest,
    expectedAuthorizationSha256,
    expectedReceiptSha256,
    expected: input,
  });
  return manifest;
}

export function publishProofActionLedgerArtifact({
  root,
  receiptPath,
  expectedAuthorizationSha256,
  expectedReceiptSha256,
  dispatchKey,
  sourceRoot,
  stateRoot,
  manifest,
}: {
  root: string;
  receiptPath: string;
  expectedAuthorizationSha256: string;
  expectedReceiptSha256: string;
  dispatchKey?: string | null;
  sourceRoot: string;
  stateRoot: string;
  manifest: ProofActionLedgerArtifactManifest;
}) {
  const expected = verifiedProofActionLedgerInput({
    root,
    receiptPath,
    expectedAuthorizationSha256,
    expectedReceiptSha256,
    dispatchKey,
  });
  validateProofActionLedgerArtifact({
    sourceRoot,
    manifest,
    expectedAuthorizationSha256,
    expectedReceiptSha256,
    expected,
  });
  return importActionEventShards(sourceRoot, stateRoot);
}

export function validateProofActionLedgerArtifact({
  sourceRoot,
  manifest,
  expectedAuthorizationSha256,
  expectedReceiptSha256,
  expected,
}: {
  sourceRoot: string;
  manifest: ProofActionLedgerArtifactManifest;
  expectedAuthorizationSha256: string;
  expectedReceiptSha256: string;
  expected?: ReturnType<typeof verifiedProofActionLedgerInput>;
}): ActionEvent[] {
  const { identity_sha256: identitySha256, ...identity } = manifest;
  if (
    manifest.schema_version !== 1 ||
    identitySha256 !== digest(identity) ||
    manifest.authorization_sha256 !==
      requireDigest(expectedAuthorizationSha256, "execution authorization digest") ||
    manifest.validation_receipt_sha256 !==
      requireDigest(expectedReceiptSha256, "validation receipt digest") ||
    !Array.isArray(manifest.paths) ||
    !Array.isArray(manifest.events)
  ) {
    throw new Error("trusted proof action ledger manifest identity is invalid");
  }
  const discoveredPaths = proofLedgerShardPaths(sourceRoot);
  if (JSON.stringify(discoveredPaths) !== JSON.stringify(manifest.paths)) {
    throw new Error("trusted proof action ledger contains an unexpected shard set");
  }
  const events = discoveredPaths.flatMap((relativePath) =>
    readActionEventShardAt(sourceRoot, relativePath),
  );
  if (
    events.length !== 2 ||
    manifest.events.length !== 2 ||
    JSON.stringify(events) !== JSON.stringify(manifest.events)
  ) {
    throw new Error("trusted proof action ledger must contain exactly the expected event pair");
  }
  const [stage, binding] = events;
  if (
    stage?.event_type !== ACTION_EVENT_TYPES.proofStage ||
    binding?.event_type !== ACTION_EVENT_TYPES.proofBinding ||
    stage.action.status !== ACTION_EVENT_STATUSES.completed ||
    binding.action.status !== ACTION_EVENT_STATUSES.completed ||
    stage.phase_seq !== 1 ||
    binding.phase_seq !== 2 ||
    stage.parent_event_id !== null ||
    binding.parent_event_id !== stage.event_id ||
    binding.operation_id !== stage.operation_id ||
    binding.attempt_id !== stage.attempt_id
  ) {
    throw new Error("trusted proof action ledger lifecycle is invalid");
  }
  assertTrustedProofProducer(stage, binding);
  if (expected) assertTrustedProofEvidence(stage, binding, expected);
  return events;
}

function assertTrustedProofProducer(stage: ActionEvent, binding: ActionEvent): void {
  if (JSON.stringify(stage.producer) !== JSON.stringify(binding.producer)) {
    throw new Error("trusted proof action ledger events have different producers");
  }
  const producer = stage.producer;
  const expected = workflowActionProducer("repair_validation");
  if (
    producer.repository !== expected.repository ||
    producer.sha !== expected.sha ||
    producer.workflow !== expected.workflow ||
    producer.run_id !== expected.runId ||
    producer.run_attempt !== expected.runAttempt ||
    producer.job !== expected.job ||
    !producer.component.startsWith("repair_validation.")
  ) {
    throw new Error("trusted proof action ledger producer identity is invalid");
  }
}

function assertTrustedProofEvidence(
  stage: ActionEvent,
  binding: ActionEvent,
  expected: ReturnType<typeof verifiedProofActionLedgerInput>,
): void {
  const expectedCommon = new Map(
    commonProofEvidence(expected.context).map((entry) => [entry.kind, entry]),
  );
  const stageEvidence = new Map((stage.evidence ?? []).map((entry) => [entry.kind, entry]));
  const bindingEvidence = new Map((binding.evidence ?? []).map((entry) => [entry.kind, entry]));
  for (const [kind, evidence] of expectedCommon) {
    if (
      JSON.stringify(stageEvidence.get(kind)) !== JSON.stringify(evidence) ||
      JSON.stringify(bindingEvidence.get(kind)) !== JSON.stringify(evidence)
    ) {
      throw new Error(`trusted proof action ledger ${kind} evidence is invalid`);
    }
  }
  const expectedStageArtifacts = [
    proofArtifactEvidence("proof_plan", expected.plan, expected.plan.plan_id),
    proofArtifactEvidence("proof_trace", expected.trace, expected.plan.plan_id),
    proofArtifactEvidence("proof_bundle", expected.proof, expected.plan.plan_id),
  ];
  for (const evidence of expectedStageArtifacts) {
    if (JSON.stringify(stageEvidence.get(evidence.kind)) !== JSON.stringify(evidence)) {
      throw new Error(`trusted proof action ledger ${evidence.kind} evidence is invalid`);
    }
  }
  const receiptEvidence = {
    kind: "validation_receipt",
    sha256: requireDigest(expected.receiptSha256, "validation receipt digest"),
    snapshotId: expected.plan.plan_id,
  };
  if (
    JSON.stringify(bindingEvidence.get("validation_receipt")) !== JSON.stringify(receiptEvidence)
  ) {
    throw new Error("trusted proof action ledger validation receipt evidence is invalid");
  }
}

function proofLedgerShardPaths(root: string): string[] {
  const ledgerRoot = path.join(root, "ledger");
  if (!fs.existsSync(ledgerRoot)) return [];
  const ledgerStat = fs.lstatSync(ledgerRoot);
  if (ledgerStat.isSymbolicLink() || !ledgerStat.isDirectory()) {
    throw new Error("trusted proof action ledger root must be a real directory");
  }
  const paths: string[] = [];
  let directories = 0;
  const visit = (directory: string) => {
    directories += 1;
    if (directories > PROOF_LEDGER_ARTIFACT_LIMITS.maxDirectories) {
      throw new Error("trusted proof action ledger exceeds its directory budget");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error("trusted proof action ledger contains a symbolic link");
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("trusted proof action ledger contains a non-file entry");
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        !relative.endsWith(".jsonl") ||
        Buffer.byteLength(relative, "utf8") > PROOF_LEDGER_ARTIFACT_LIMITS.maxRelativePathBytes
      ) {
        throw new Error("trusted proof action ledger contains an unexpected file");
      }
      paths.push(relative);
      if (paths.length > PROOF_LEDGER_ARTIFACT_LIMITS.maxFiles) {
        throw new Error("trusted proof action ledger exceeds its file budget");
      }
    }
  };
  visit(ledgerRoot);
  return paths.sort();
}

function proofActionLedgerRoot(override?: string): string {
  return override?.trim() || process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
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
