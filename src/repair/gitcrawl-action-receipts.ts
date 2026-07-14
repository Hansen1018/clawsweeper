import {
  ACTION_EVENT_PHASE_TYPES,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  type ActionEvent,
  type ActionEventEvidence,
  type ActionEventReasonCode,
  type ActionEventSubject,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  prepareWorkflowPhaseEvent,
  recordWorkflowPhaseEvent,
  type PreparedWorkflowActionEvent,
  type WorkflowActionEventOptions,
} from "../action-ledger-runtime.js";
import {
  GITCRAWL_QUERY_CONTRACT_VERSION,
  GITCRAWL_QUERY_NAMES,
  assertSha256,
  assertSnapshotId,
  sha256Canonical,
  type GitcrawlProvider,
  type GitcrawlQueryName,
} from "./gitcrawl-evidence-contract.js";

export const GITCRAWL_ACTION_RECEIPT_VERSION = "gitcrawl-action-receipt-v1";
export const GITCRAWL_ACTION_RECEIPT_LIMITS = {
  maxCapabilities: 64,
} as const;

export const GITCRAWL_FAILURE_CLASSES = [
  "authentication",
  "availability",
  "capability",
  "contract",
  "coverage",
  "pagination",
  "parity",
  "privacy",
  "snapshot",
  "validation",
  "unknown",
] as const;

export type GitcrawlFailureClass = (typeof GITCRAWL_FAILURE_CLASSES)[number];
export type GitcrawlReceiptPhase = "snapshot" | "query" | "binding";

type GitcrawlReceiptBase = {
  repository: string;
  provider: GitcrawlProvider;
  phaseSeq?: number;
};

export type GitcrawlSnapshotReceiptInput = GitcrawlReceiptBase & {
  receipt: "snapshot";
  snapshotId: string;
  paritySnapshotId?: string;
  capabilities: readonly string[];
  coverageSha256: string;
  coverageDatasetCount: number;
  coverageComplete: boolean;
};

export type GitcrawlQueryReceiptInput = GitcrawlReceiptBase & {
  receipt: "query";
  snapshotId: string;
  paritySnapshotId?: string;
  queryName: GitcrawlQueryName;
  queryArgsSha256: string;
  resultSha256: string;
  parityResultSha256?: string;
  rowCount: number;
  claimCount: number;
  coverageComplete: boolean;
};

export type GitcrawlCoverageReceiptInput = GitcrawlReceiptBase & {
  receipt: "binding";
  binding: "coverage";
  snapshotId: string;
  paritySnapshotId?: string;
  coverageSha256: string;
  datasetCount: number;
  rowCount: number;
  eligibleCount: number;
  coveredCount: number;
  complete: boolean;
};

export type GitcrawlParityReceiptInput = GitcrawlReceiptBase & {
  receipt: "binding";
  binding: "parity";
  snapshotId: string;
  paritySnapshotId: string;
  paritySha256: string;
  queryCount: number;
  primaryCount: number;
  parityCount: number;
  matched: boolean;
};

export type GitcrawlFailureReceiptInput = GitcrawlReceiptBase & {
  receipt: "failure";
  phase: GitcrawlReceiptPhase;
  snapshotId?: string;
  paritySnapshotId?: string;
  queryName?: GitcrawlQueryName;
  error: unknown;
};

export type GitcrawlActionReceiptInput =
  | GitcrawlSnapshotReceiptInput
  | GitcrawlQueryReceiptInput
  | GitcrawlCoverageReceiptInput
  | GitcrawlParityReceiptInput
  | GitcrawlFailureReceiptInput;

type GitcrawlReceiptEvent = {
  phase: (typeof ACTION_EVENT_PHASE_TYPES)[
    | "gitcrawlSnapshot"
    | "gitcrawlQuery"
    | "gitcrawlBinding"];
  status: (typeof ACTION_EVENT_STATUSES)[keyof typeof ACTION_EVENT_STATUSES];
  reasonCode: ActionEventReasonCode;
  retryable: boolean;
  identity: Record<string, unknown>;
  phaseSeq: number;
  evidence: ActionEventEvidence[];
  attributes: Record<string, string | number | boolean | readonly string[]>;
};

const GITCRAWL_RECEIPT_DROPPED_FIELDS = [
  "bodies",
  "local_paths",
  "logs",
  "prompts",
  "query_args",
  "query_rows",
  "sql",
  "tokens",
] as const;

export function prepareGitcrawlActionReceipt(
  root: string,
  input: GitcrawlActionReceiptInput,
  options: WorkflowActionEventOptions = {},
): PreparedWorkflowActionEvent {
  const event = gitcrawlReceiptEvent(input, options.env ?? process.env);
  return prepareWorkflowPhaseEvent(
    root,
    {
      phase: event.phase,
      status: event.status,
      reasonCode: event.reasonCode,
      retryable: event.retryable,
      mutation: false,
      identity: event.identity,
      operation: "gitcrawl_receipt",
      operationIdentity: gitcrawlOperationIdentity(input),
      phaseSeq: event.phaseSeq,
      component: "gitcrawl_receipts",
      subject: gitcrawlReceiptSubject(input),
      evidence: event.evidence,
      attributes: event.attributes,
      privacy: {
        classification: "internal",
        redactionVersion: GITCRAWL_ACTION_RECEIPT_VERSION,
        fieldsDropped: GITCRAWL_RECEIPT_DROPPED_FIELDS,
      },
    },
    options,
  );
}

export function recordGitcrawlActionReceipt(
  root: string,
  input: GitcrawlActionReceiptInput,
  options: WorkflowActionEventOptions = {},
): ActionEvent | null {
  const event = gitcrawlReceiptEvent(input, options.env ?? process.env);
  return recordWorkflowPhaseEvent(
    root,
    {
      phase: event.phase,
      status: event.status,
      reasonCode: event.reasonCode,
      retryable: event.retryable,
      mutation: false,
      identity: event.identity,
      operation: "gitcrawl_receipt",
      operationIdentity: gitcrawlOperationIdentity(input),
      phaseSeq: event.phaseSeq,
      component: "gitcrawl_receipts",
      subject: gitcrawlReceiptSubject(input),
      evidence: event.evidence,
      attributes: event.attributes,
      privacy: {
        classification: "internal",
        redactionVersion: GITCRAWL_ACTION_RECEIPT_VERSION,
        fieldsDropped: GITCRAWL_RECEIPT_DROPPED_FIELDS,
      },
    },
    options,
  );
}

export async function flushGitcrawlActionReceipts(
  root: string,
  options: Parameters<typeof flushWorkflowActionEvents>[1] = {},
): Promise<string[]> {
  return flushWorkflowActionEvents(root, options);
}

export function classifyGitcrawlActionFailure(error: unknown): GitcrawlFailureClass {
  const message = errorText(error).toLowerCase();
  if (
    /(?:\bauth(?:entication|orization)?\b|\bcredential\b|\baccess token\b|\b401\b|\b403\b)/.test(
      message,
    )
  ) {
    return "authentication";
  }
  if (/\bparity\b/.test(message)) return "parity";
  if (/\bcoverage\b/.test(message)) return "coverage";
  if (/(?:\bsnapshot\b|\bprovenance\b|\bstale\b|\bgeneration\b)/.test(message)) {
    return "snapshot";
  }
  if (/\bcapabilit(?:y|ies)\b/.test(message)) return "capability";
  if (/(?:\bcontract\b|\bunsupported query\b|\bincompatible\b)/.test(message)) {
    return "contract";
  }
  if (/(?:\bcursor\b|\bpagination\b|\bpage limit\b)/.test(message)) return "pagination";
  if (/(?:\bprivacy\b|\bhtml comment\b|\bsecret\b|(?:^|[\\/])[Uu]sers[\\/])/.test(message)) {
    return "privacy";
  }
  if (
    /(?:\btimeout\b|\btimed out\b|\bunavailable\b|\bnetwork\b|\bfetch\b|\bredirect\b)/.test(message)
  ) {
    return "availability";
  }
  if (/(?:\binvalid\b|\bmalformed\b|\bmismatch\b|\bincomplete\b|\bexceeded\b)/.test(message)) {
    return "validation";
  }
  return "unknown";
}

function gitcrawlReceiptEvent(
  input: GitcrawlActionReceiptInput,
  env: NodeJS.ProcessEnv,
): GitcrawlReceiptEvent {
  assertRepository(input.repository);
  assertProvider(input.provider);
  assertReceiptVariant(input);
  assertParityTopology(input);
  assertCanonicalSnapshotIds(input);
  const runEvidence = workflowRunEvidence(env);
  if (input.receipt === "snapshot") {
    const capabilities = normalizedCapabilities(input.capabilities);
    for (const queryName of GITCRAWL_QUERY_NAMES) {
      if (!capabilities.includes(queryName)) {
        throw new Error(`Gitcrawl receipt snapshot is missing capability ${queryName}`);
      }
    }
    assertSha256(input.coverageSha256, "Gitcrawl receipt coverage sha256");
    const snapshotEvidence = gitcrawlSnapshotEvidence(input.snapshotId, input.paritySnapshotId);
    const selectionSha256 = sha256Canonical({
      provider: input.provider,
      snapshot_id: input.snapshotId,
      ...(input.paritySnapshotId === undefined
        ? {}
        : { parity_snapshot_id: input.paritySnapshotId }),
      capabilities,
      coverage_sha256: input.coverageSha256,
    });
    return {
      phase: ACTION_EVENT_PHASE_TYPES.gitcrawlSnapshot,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      identity: { receipt: "snapshot", selectionSha256 },
      phaseSeq: input.phaseSeq ?? 1,
      evidence: [
        ...snapshotEvidence,
        { kind: "gitcrawl_selection", sha256: selectionSha256 },
        { kind: "gitcrawl_coverage", sha256: input.coverageSha256 },
        ...runEvidence,
      ],
      attributes: {
        provider: input.provider,
        capability: capabilities,
        query_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        result_count: capabilities.length,
        item_count: nonNegativeCount(input.coverageDatasetCount, "coverage dataset count"),
        coverage_complete: input.coverageComplete,
      },
    };
  }
  if (input.receipt === "query") {
    assertQueryName(input.queryName);
    assertSha256(input.queryArgsSha256, "Gitcrawl receipt query arguments sha256");
    assertSha256(input.resultSha256, "Gitcrawl receipt result sha256");
    if (input.parityResultSha256 !== undefined) {
      assertSha256(input.parityResultSha256, "Gitcrawl receipt parity result sha256");
    }
    if ((input.provider === "parity") !== (input.parityResultSha256 !== undefined)) {
      throw new Error("Gitcrawl query receipt parity digest does not match its provider");
    }
    const bindingSha256 = sha256Canonical({
      provider: input.provider,
      snapshot_id: input.snapshotId,
      ...(input.paritySnapshotId === undefined
        ? {}
        : { parity_snapshot_id: input.paritySnapshotId }),
      query_name: input.queryName,
      query_args_sha256: input.queryArgsSha256,
      result_sha256: input.resultSha256,
      ...(input.parityResultSha256 === undefined
        ? {}
        : { parity_result_sha256: input.parityResultSha256 }),
    });
    return {
      phase: ACTION_EVENT_PHASE_TYPES.gitcrawlQuery,
      status: ACTION_EVENT_STATUSES.validated,
      reasonCode: ACTION_EVENT_REASON_CODES.accepted,
      retryable: false,
      identity: {
        receipt: "query",
        queryName: input.queryName,
        bindingSha256,
      },
      phaseSeq: input.phaseSeq ?? 10 + GITCRAWL_QUERY_NAMES.indexOf(input.queryName),
      evidence: [
        ...gitcrawlSnapshotEvidence(input.snapshotId, input.paritySnapshotId),
        { kind: "gitcrawl_query_args", sha256: input.queryArgsSha256 },
        { kind: "gitcrawl_query_result", sha256: input.resultSha256 },
        ...(input.parityResultSha256 === undefined
          ? []
          : [{ kind: "gitcrawl_parity_result", sha256: input.parityResultSha256 }]),
        { kind: "gitcrawl_query_binding", sha256: bindingSha256 },
        ...runEvidence,
      ],
      attributes: {
        provider: input.provider,
        query_name: input.queryName,
        query_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        result_count: nonNegativeCount(input.rowCount, "query row count"),
        item_count: nonNegativeCount(input.claimCount, "query claim count"),
        coverage_complete: input.coverageComplete,
      },
    };
  }
  if (input.receipt === "binding") {
    if (input.binding === "coverage") {
      assertSha256(input.coverageSha256, "Gitcrawl receipt coverage sha256");
      const eligibleCount = nonNegativeCount(input.eligibleCount, "coverage eligible count");
      const coveredCount = nonNegativeCount(input.coveredCount, "coverage covered count");
      if (coveredCount > eligibleCount) {
        throw new Error("Gitcrawl receipt covered count exceeds eligible count");
      }
      if (input.complete && coveredCount !== eligibleCount) {
        throw new Error("Gitcrawl receipt complete coverage must cover every eligible item");
      }
      const ratio = eligibleCount === 0 ? 1 : coveredCount / eligibleCount;
      return {
        phase: ACTION_EVENT_PHASE_TYPES.gitcrawlBinding,
        status: input.complete ? ACTION_EVENT_STATUSES.validated : ACTION_EVENT_STATUSES.failed,
        reasonCode: input.complete
          ? ACTION_EVENT_REASON_CODES.completed
          : ACTION_EVENT_REASON_CODES.validationFailed,
        retryable: false,
        identity: {
          receipt: "binding",
          binding: "coverage",
          coverageSha256: input.coverageSha256,
        },
        phaseSeq: input.phaseSeq ?? 100,
        evidence: [
          ...gitcrawlSnapshotEvidence(input.snapshotId, input.paritySnapshotId),
          { kind: "gitcrawl_coverage", sha256: input.coverageSha256 },
          ...runEvidence,
        ],
        attributes: {
          provider: input.provider,
          validation_kind: "coverage",
          query_version: GITCRAWL_QUERY_CONTRACT_VERSION,
          item_count: nonNegativeCount(input.datasetCount, "coverage dataset count"),
          result_count: nonNegativeCount(input.rowCount, "coverage row count"),
          candidate_count: eligibleCount,
          processed_count: coveredCount,
          coverage_complete: input.complete,
          coverage_ratio: ratio,
        },
      };
    }
    if (input.provider !== "parity") {
      throw new Error("Gitcrawl parity receipts require the parity provider");
    }
    assertSha256(input.paritySha256, "Gitcrawl receipt parity sha256");
    const queryCount = nonNegativeCount(input.queryCount, "parity query count");
    const primaryCount = nonNegativeCount(input.primaryCount, "parity primary count");
    const parityCount = nonNegativeCount(input.parityCount, "parity comparison count");
    if (
      input.matched &&
      (queryCount !== GITCRAWL_QUERY_NAMES.length || primaryCount !== parityCount)
    ) {
      throw new Error(
        "Gitcrawl receipt matched parity requires all queries and equal result counts",
      );
    }
    return {
      phase: ACTION_EVENT_PHASE_TYPES.gitcrawlBinding,
      status: input.matched ? ACTION_EVENT_STATUSES.validated : ACTION_EVENT_STATUSES.failed,
      reasonCode: input.matched
        ? ACTION_EVENT_REASON_CODES.accepted
        : ACTION_EVENT_REASON_CODES.validationFailed,
      retryable: false,
      identity: {
        receipt: "binding",
        binding: "parity",
        paritySha256: input.paritySha256,
      },
      phaseSeq: input.phaseSeq ?? 101,
      evidence: [
        ...gitcrawlSnapshotEvidence(input.snapshotId, input.paritySnapshotId),
        { kind: "gitcrawl_parity", sha256: input.paritySha256 },
        ...runEvidence,
      ],
      attributes: {
        provider: input.provider,
        validation_kind: "parity",
        query_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        item_count: queryCount,
        result_count: primaryCount,
        validation_count: parityCount,
        coverage_complete: input.matched,
      },
    };
  }

  if (input.queryName !== undefined) assertQueryName(input.queryName);
  const failureClass = classifyGitcrawlActionFailure(input.error);
  const failureSha256 = sha256Canonical({
    name: errorName(input.error),
    message: errorText(input.error),
  });
  const failure = failureDisposition(failureClass);
  return {
    phase: phaseEventType(input.phase),
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: failure.reasonCode,
    retryable: failure.retryable,
    identity: {
      receipt: "failure",
      phase: input.phase,
      failureClass,
      failureSha256,
      ...(input.queryName === undefined ? {} : { queryName: input.queryName }),
    },
    phaseSeq: input.phaseSeq ?? failurePhaseSeq(input.phase, input.queryName),
    evidence: [
      ...gitcrawlSnapshotEvidence(input.snapshotId, input.paritySnapshotId),
      { kind: "gitcrawl_failure", sha256: failureSha256 },
      ...runEvidence,
    ],
    attributes: {
      provider: input.provider,
      failure_class: failureClass,
      validation_kind: input.phase,
      query_version: GITCRAWL_QUERY_CONTRACT_VERSION,
      failed_count: 1,
      ...(input.queryName === undefined ? {} : { query_name: input.queryName }),
    },
  };
}

function gitcrawlOperationIdentity(input: GitcrawlActionReceiptInput): Record<string, unknown> {
  return {
    repository: input.repository,
    provider: input.provider,
    ...(input.snapshotId === undefined
      ? {}
      : { snapshotSha256: snapshotIdentifierSha256(input.snapshotId) }),
    ...(input.paritySnapshotId === undefined
      ? {}
      : { paritySnapshotSha256: snapshotIdentifierSha256(input.paritySnapshotId) }),
  };
}

function gitcrawlSnapshotEvidence(
  snapshotId: string | undefined,
  paritySnapshotId: string | undefined,
): ActionEventEvidence[] {
  const evidence: ActionEventEvidence[] = [];
  if (snapshotId !== undefined) {
    assertSnapshotId(snapshotId);
    evidence.push({
      kind: "gitcrawl_snapshot",
      sha256: snapshotIdentifierSha256(snapshotId),
      snapshotId,
    });
  }
  if (paritySnapshotId !== undefined) {
    assertSnapshotId(paritySnapshotId);
    evidence.push({
      kind: "gitcrawl_parity_snapshot",
      sha256: snapshotIdentifierSha256(paritySnapshotId),
      snapshotId: paritySnapshotId,
    });
  }
  return evidence;
}

function snapshotIdentifierSha256(snapshotId: string): string {
  return sha256Canonical({ snapshot_id: snapshotId });
}

function gitcrawlReceiptSubject(input: GitcrawlActionReceiptInput): ActionEventSubject {
  return {
    repository: input.repository,
    kind: "repository",
    ...(input.snapshotId === undefined
      ? {}
      : { sourceRevision: snapshotIdentifierSha256(input.snapshotId) }),
  };
}

function workflowRunEvidence(env: NodeJS.ProcessEnv): ActionEventEvidence[] {
  const repository = String(env.GITHUB_REPOSITORY ?? "").trim();
  const runId = String(env.GITHUB_RUN_ID ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[1-9][0-9]*$/.test(runId)) {
    return [];
  }
  return [
    {
      kind: "workflow_run",
      runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    },
  ];
}

function normalizedCapabilities(capabilities: readonly string[]): string[] {
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error("Gitcrawl receipt capabilities must be strings");
  }
  const normalized = [...new Set(capabilities.map((capability) => capability.trim()))].sort();
  if (normalized.length > GITCRAWL_ACTION_RECEIPT_LIMITS.maxCapabilities) {
    throw new Error(
      `Gitcrawl receipt capabilities exceed ${GITCRAWL_ACTION_RECEIPT_LIMITS.maxCapabilities} entries`,
    );
  }
  if (normalized.some((capability) => !capability)) {
    throw new Error("Gitcrawl receipt capability is empty");
  }
  return normalized;
}

function phaseEventType(phase: GitcrawlReceiptPhase): GitcrawlReceiptEvent["phase"] {
  if (phase === "snapshot") return ACTION_EVENT_PHASE_TYPES.gitcrawlSnapshot;
  if (phase === "query") return ACTION_EVENT_PHASE_TYPES.gitcrawlQuery;
  return ACTION_EVENT_PHASE_TYPES.gitcrawlBinding;
}

function failureDisposition(failureClass: GitcrawlFailureClass): {
  reasonCode: ActionEventReasonCode;
  retryable: boolean;
} {
  if (failureClass === "authentication") {
    return { reasonCode: ACTION_EVENT_REASON_CODES.authorizationFailed, retryable: false };
  }
  if (failureClass === "availability") {
    return { reasonCode: ACTION_EVENT_REASON_CODES.unavailable, retryable: true };
  }
  if (failureClass === "unknown") {
    return { reasonCode: ACTION_EVENT_REASON_CODES.exception, retryable: false };
  }
  return { reasonCode: ACTION_EVENT_REASON_CODES.validationFailed, retryable: false };
}

function failurePhaseSeq(
  phase: GitcrawlReceiptPhase,
  queryName: GitcrawlQueryName | undefined,
): number {
  if (phase === "snapshot") return 200;
  if (phase === "binding") return 220;
  return (
    210 +
    (queryName === undefined
      ? GITCRAWL_QUERY_NAMES.length
      : GITCRAWL_QUERY_NAMES.indexOf(queryName))
  );
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertQueryName(queryName: GitcrawlQueryName): void {
  if (!GITCRAWL_QUERY_NAMES.includes(queryName)) {
    throw new Error(`unsupported Gitcrawl query receipt: ${queryName}`);
  }
}

function assertProvider(provider: GitcrawlProvider): void {
  if (provider !== "local" && provider !== "cloud" && provider !== "parity") {
    throw new Error(`unsupported Gitcrawl receipt provider: ${String(provider)}`);
  }
}

function assertReceiptVariant(input: GitcrawlActionReceiptInput): void {
  const value = input as unknown as {
    receipt?: unknown;
    binding?: unknown;
    phase?: unknown;
  };
  if (
    value.receipt !== "snapshot" &&
    value.receipt !== "query" &&
    value.receipt !== "binding" &&
    value.receipt !== "failure"
  ) {
    throw new Error(`unsupported Gitcrawl action receipt: ${String(value.receipt)}`);
  }
  if (value.receipt === "binding" && value.binding !== "coverage" && value.binding !== "parity") {
    throw new Error(`unsupported Gitcrawl binding receipt: ${String(value.binding)}`);
  }
  if (
    value.receipt === "failure" &&
    value.phase !== "snapshot" &&
    value.phase !== "query" &&
    value.phase !== "binding"
  ) {
    throw new Error(`unsupported Gitcrawl failure receipt phase: ${String(value.phase)}`);
  }
}

function assertParityTopology(input: GitcrawlActionReceiptInput): void {
  if (input.provider !== "parity" && input.paritySnapshotId !== undefined) {
    throw new Error("Gitcrawl non-parity receipts cannot include a parity snapshot");
  }
  if (
    input.provider === "parity" &&
    input.receipt !== "failure" &&
    input.paritySnapshotId === undefined
  ) {
    throw new Error("Gitcrawl parity receipts require a parity snapshot");
  }
}

function assertCanonicalSnapshotIds(input: GitcrawlActionReceiptInput): void {
  for (const snapshotId of [input.snapshotId, input.paritySnapshotId]) {
    if (snapshotId === undefined) continue;
    assertSnapshotId(snapshotId);
    if (snapshotId !== snapshotId.trim()) {
      throw new Error("Gitcrawl receipt snapshot id must not contain surrounding whitespace");
    }
  }
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid Gitcrawl receipt repository: ${repository}`);
  }
}

function nonNegativeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Gitcrawl receipt ${label} must be a non-negative integer`);
  }
  return value;
}
