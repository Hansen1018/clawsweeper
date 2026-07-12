import {
  ACTION_EVENT_PHASE_TYPES,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  type ActionEvent,
  type ActionEventEvidence,
  type ActionEventSubject,
} from "../action-ledger.js";
import {
  recordWorkflowPhaseEvent,
  type WorkflowActionEventOptions,
} from "../action-ledger-runtime.js";
import {
  GITCRAWL_QUERY_VERSION,
  sha256Canonical,
  type GitcrawlCoverageRow,
  type GitcrawlEvidenceClaim,
  type GitcrawlProvider,
  type GitcrawlQueryName,
} from "./gitcrawl-evidence-contract.js";
import type { GitcrawlEvidencePacket } from "./gitcrawl-evidence-graph.js";

const DURABLE_SNAPSHOT_ID =
  /^(?:[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|snapshot-[A-Za-z0-9_.+-]{1,240})$/;
const REDACTED_GITCRAWL_FIELDS = [
  "query_args",
  "query_rows",
  "sql",
  "raw_payload",
  "prompt",
  "logs",
] as const;

export type GitcrawlActionLedger = {
  operationIdentity: {
    repository: string;
    consumer: string;
    provider: GitcrawlProvider;
    snapshotSha256: string;
    paritySnapshotSha256?: string;
  };
  snapshotEventId: string | null;
  recordQuery(input: {
    queryName: GitcrawlQueryName;
    phaseSeq: number;
    identity: unknown;
    rowCount: number;
    claims: readonly GitcrawlEvidenceClaim[];
    subject?: ActionEventSubject;
    parentEventId?: string | null;
  }): ActionEvent | null;
  recordBinding(input: {
    phaseSeq: number;
    identity: unknown;
    packet: GitcrawlEvidencePacket;
    recordPath?: string;
    itemCount: number;
    subject: ActionEventSubject;
    parentEventId?: string | null;
  }): ActionEvent | null;
};

export function beginGitcrawlActionLedger(
  root: string,
  input: {
    repository: string;
    consumer: string;
    provider: GitcrawlProvider;
    snapshotId: string;
    paritySnapshotId?: string;
    coverage: readonly GitcrawlCoverageRow[];
  },
  options: WorkflowActionEventOptions = {},
): GitcrawlActionLedger {
  const snapshotSha256 = snapshotDigest(input.snapshotId);
  const paritySnapshotSha256 =
    input.paritySnapshotId === undefined ? undefined : snapshotDigest(input.paritySnapshotId);
  const operationIdentity = {
    repository: input.repository,
    consumer: input.consumer,
    provider: input.provider,
    snapshotSha256,
    ...(paritySnapshotSha256 === undefined ? {} : { paritySnapshotSha256 }),
  };
  const coverage = coverageSummary(input.coverage);
  const snapshotEvidence = gitcrawlSnapshotEvidence(input.snapshotId, "gitcrawl_snapshot");
  const parityEvidence =
    input.paritySnapshotId === undefined
      ? []
      : [gitcrawlSnapshotEvidence(input.paritySnapshotId, "gitcrawl_parity_snapshot")];
  const snapshotEvent = recordWorkflowPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_PHASE_TYPES.gitcrawlSnapshot,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: false,
      identity: {
        slot: "snapshot",
        snapshotSha256,
        ...(paritySnapshotSha256 === undefined ? {} : { paritySnapshotSha256 }),
      },
      operation: "gitcrawl_evidence",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "snapshot" },
      component: `gitcrawl_${input.consumer}`,
      subject: {
        repository: input.repository,
        kind: "repository",
        sourceRevision: snapshotSha256,
      },
      evidence: [
        snapshotEvidence,
        ...parityEvidence,
        {
          kind: "gitcrawl_coverage",
          sha256: sha256Canonical(input.coverage),
        },
      ],
      attributes: {
        coverage_complete: coverage.complete,
        coverage_ratio: coverage.ratio,
        query_version: GITCRAWL_QUERY_VERSION,
        result_count: input.coverage.length,
        work_kind: input.consumer,
      },
      privacy: gitcrawlLedgerPrivacy(),
    },
    options,
  );

  return {
    operationIdentity,
    snapshotEventId: snapshotEvent?.event_id ?? null,
    recordQuery(queryInput) {
      const claimDigests = sortedClaimDigests(queryInput.claims);
      const claimSetSha256 = sha256Canonical(claimDigests);
      const querySha256 = sha256Canonical({
        version: GITCRAWL_QUERY_VERSION,
        provider: input.provider,
        snapshotSha256,
        ...(paritySnapshotSha256 === undefined ? {} : { paritySnapshotSha256 }),
        queryName: queryInput.queryName,
        identity: queryInput.identity,
        claimDigests,
      });
      return recordWorkflowPhaseEvent(
        root,
        {
          phase: ACTION_EVENT_PHASE_TYPES.gitcrawlQuery,
          status: ACTION_EVENT_STATUSES.completed,
          reasonCode: ACTION_EVENT_REASON_CODES.completed,
          retryable: false,
          mutation: false,
          identity: {
            slot: "query",
            queryName: queryInput.queryName,
            querySha256,
          },
          operation: "gitcrawl_evidence",
          operationIdentity,
          parentEventId: queryInput.parentEventId ?? snapshotEvent?.event_id ?? null,
          phaseSeq: queryInput.phaseSeq,
          idempotencyIdentity: { operationIdentity, querySha256 },
          component: `gitcrawl_${input.consumer}`,
          subject: queryInput.subject ?? {
            repository: input.repository,
            kind: "repository",
          },
          evidence: [
            snapshotEvidence,
            ...parityEvidence,
            {
              kind: "gitcrawl_query",
              sha256: querySha256,
            },
            {
              kind: "gitcrawl_claim_set",
              sha256: claimSetSha256,
            },
          ],
          attributes: {
            coverage_complete: coverage.complete,
            coverage_ratio: coverage.ratio,
            query_version: GITCRAWL_QUERY_VERSION,
            result_count: queryInput.rowCount,
            item_count: queryInput.claims.length,
            work_kind: input.consumer,
          },
          privacy: gitcrawlLedgerPrivacy(),
        },
        options,
      );
    },
    recordBinding(bindingInput) {
      const claimDigests = sortedClaimDigests(bindingInput.packet.claims);
      return recordWorkflowPhaseEvent(
        root,
        {
          phase: ACTION_EVENT_PHASE_TYPES.gitcrawlBinding,
          status: ACTION_EVENT_STATUSES.published,
          reasonCode: ACTION_EVENT_REASON_CODES.published,
          retryable: false,
          mutation: false,
          identity: {
            slot: "binding",
            packetSha256: bindingInput.packet.sha256,
            identity: bindingInput.identity,
          },
          operation: "gitcrawl_evidence",
          operationIdentity,
          parentEventId: bindingInput.parentEventId ?? snapshotEvent?.event_id ?? null,
          phaseSeq: bindingInput.phaseSeq,
          idempotencyIdentity: {
            operationIdentity,
            packetSha256: bindingInput.packet.sha256,
            ...(bindingInput.recordPath === undefined
              ? {}
              : { recordPath: bindingInput.recordPath }),
          },
          component: `gitcrawl_${input.consumer}`,
          subject: {
            ...bindingInput.subject,
            ...(bindingInput.recordPath === undefined
              ? {}
              : { recordPath: bindingInput.recordPath }),
          },
          evidence: [
            snapshotEvidence,
            ...parityEvidence,
            {
              kind: "gitcrawl_claim_set",
              sha256: sha256Canonical(claimDigests),
            },
            {
              kind: "gitcrawl_evidence_packet",
              sha256: bindingInput.packet.sha256,
              ...(bindingInput.recordPath === undefined
                ? {}
                : { reportPath: bindingInput.recordPath }),
            },
          ],
          attributes: {
            item_count: bindingInput.itemCount,
            publication_kind: "gitcrawl_evidence_packet",
            query_version: GITCRAWL_QUERY_VERSION,
            result_count: bindingInput.packet.claims.length,
            work_kind: input.consumer,
          },
          privacy: gitcrawlLedgerPrivacy(),
        },
        options,
      );
    },
  };
}

function coverageSummary(coverage: readonly GitcrawlCoverageRow[]): {
  complete: boolean;
  ratio: number;
} {
  const eligible = coverage.reduce((total, row) => total + row.eligible_count, 0);
  const covered = coverage.reduce(
    (total, row) => total + Math.min(row.covered_count, row.eligible_count),
    0,
  );
  return {
    complete: coverage.every((row) => row.complete && row.covered_count >= row.eligible_count),
    ratio: eligible === 0 ? 1 : covered / eligible,
  };
}

function sortedClaimDigests(claims: readonly GitcrawlEvidenceClaim[]): string[] {
  return claims.map((claim) => claim.sha256).sort();
}

function snapshotDigest(snapshotId: string): string {
  return sha256Canonical({ snapshotId });
}

function gitcrawlSnapshotEvidence(snapshotId: string, kind: string): ActionEventEvidence {
  return {
    kind,
    sha256: snapshotDigest(snapshotId),
    ...(DURABLE_SNAPSHOT_ID.test(snapshotId) ? { snapshotId } : {}),
  };
}

function gitcrawlLedgerPrivacy() {
  return {
    classification: "internal" as const,
    redactionVersion: "gitcrawl-v1",
    fieldsDropped: REDACTED_GITCRAWL_FIELDS,
  };
}
