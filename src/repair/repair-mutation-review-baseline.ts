import { createHash } from "node:crypto";

import { MAX_REVIEWED_PR_ACTIVITY, isReviewedPrActivityCursor } from "../review-activity-cursor.js";
import {
  normalizeRepairTargetActivitySnapshot,
  repairTargetActivityDigest,
  repairTargetActivitySnapshotFromTarget,
  type RepairMutationTargetKind,
  type RepairTargetActivitySnapshot,
} from "./repair-mutation-activity.js";

export type RepairMutationReviewAuthorization = "merge" | "close";

export type RepairMutationReviewAuthorizationSnapshot = {
  version: 1;
  repository: string;
  number: number;
  target_kind: "pull_request";
  authorization: RepairMutationReviewAuthorization;
  verdict: "pass" | "close";
  head_sha: string;
  reviewed_updated_at: string;
  observed_updated_at: string;
  reviewed_at: string;
  review_activity_cursor: string;
  source_revision: string;
  target_activity_digest: string;
  provenance: {
    kind: "trusted_comment";
    comment_id: string;
    author: string;
    comment_updated_at: string;
    body_sha256: string;
  };
  snapshot_sha256: string;
};

type MintRepairMutationReviewAuthorizationOptions = {
  repository: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  target: unknown;
  comments: unknown[];
  expectedHeadSha?: unknown;
  reviewedBefore?: unknown;
};

type ValidateRepairMutationReviewAuthorizationOptions = {
  snapshot: unknown;
  repository: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  authorization: RepairMutationReviewAuthorization;
  expectedHeadSha?: unknown;
  expectedReviewedUpdatedAt?: unknown;
  reviewedBefore?: unknown;
  targetActivity: RepairTargetActivitySnapshot;
  comments: unknown[];
};

type ValidateRepairMutationReviewAuthorizationProvenanceOptions = Omit<
  ValidateRepairMutationReviewAuthorizationOptions,
  "targetActivity"
>;

type ValidateRepairMutationReviewAuthorizationAfterMergeOptions =
  ValidateRepairMutationReviewAuthorizationProvenanceOptions & {
    targetActivity: RepairTargetActivitySnapshot;
    reviewActivityCursor: unknown;
  };

const DEFAULT_TRUSTED_REVIEW_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ].filter((value): value is string => typeof value === "string" && value.length > 0),
);
const AUTHORIZED_REVIEW_VERDICTS: Record<RepairMutationReviewAuthorization, ReadonlySet<string>> = {
  merge: new Set(["pass"]),
  close: new Set(["close"]),
};

export function mintRepairMutationReviewAuthorizations(
  options: MintRepairMutationReviewAuthorizationOptions,
): RepairMutationReviewAuthorizationSnapshot[] {
  if (options.targetKind !== "pull_request") return [];
  if (options.comments.length > MAX_REVIEWED_PR_ACTIVITY) return [];
  const expectedHeadSha = stringValue(options.expectedHeadSha);
  const reviewedBefore = timestamp(options.reviewedBefore);
  if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha) || reviewedBefore === null) return [];

  let targetActivity: RepairTargetActivitySnapshot;
  try {
    targetActivity = repairTargetActivitySnapshotFromTarget(
      options.target,
      options.comments,
      options.targetKind,
    );
  } catch {
    return [];
  }

  const candidates = options.comments
    .flatMap((comment) =>
      snapshotFromTrustedComment({
        comment,
        repository: options.repository,
        number: options.number,
        expectedHeadSha,
        reviewedBefore,
        targetActivity,
      }),
    )
    .sort((left, right) => timestamp(right.reviewed_at)! - timestamp(left.reviewed_at)!);

  const snapshots: RepairMutationReviewAuthorizationSnapshot[] = [];
  for (const authorization of ["merge", "close"] as const) {
    const candidate = candidates.find((entry) => entry.authorization === authorization);
    if (candidate) snapshots.push(candidate);
  }
  return snapshots;
}

export function validateRepairMutationReviewAuthorization(
  options: ValidateRepairMutationReviewAuthorizationOptions,
): string {
  const snapshot = validateRepairMutationReviewAuthorizationProvenance(options);
  const targetActivity = normalizeRepairTargetActivitySnapshot(options.targetActivity);
  if (
    snapshot.observed_updated_at !== targetActivity.updatedAt ||
    repairTargetActivityDigest(targetActivity, snapshot.provenance.comment_id) !==
      snapshot.target_activity_digest
  ) {
    throw new Error("trusted repair review authorization is unavailable or stale");
  }
  return snapshot.review_activity_cursor;
}

export function validateRepairMutationReviewAuthorizationProvenance(
  options: ValidateRepairMutationReviewAuthorizationProvenanceOptions,
): RepairMutationReviewAuthorizationSnapshot {
  const snapshot = parseSnapshot(options.snapshot);
  const expectedHeadSha = stringValue(options.expectedHeadSha);
  const expectedReviewedUpdatedAt = stringValue(options.expectedReviewedUpdatedAt);
  const reviewedBefore = timestamp(options.reviewedBefore);
  const currentComment = options.comments
    .map(record)
    .find((comment) => scalarId(comment.id) === snapshot.provenance.comment_id);
  const currentBody = typeof currentComment?.body === "string" ? currentComment.body : "";
  const currentAuthor = stringValue(record(currentComment?.user).login);
  const currentCommentUpdatedAt = stringValue(
    currentComment?.updated_at ?? currentComment?.updatedAt,
  );
  const marker = trustedVerdictMarker(currentBody, options.number);
  const attributes = marker ? markerAttributes(marker.attributes) : {};

  if (
    options.comments.length > MAX_REVIEWED_PR_ACTIVITY ||
    snapshot.version !== 1 ||
    snapshot.repository !== options.repository ||
    snapshot.number !== options.number ||
    options.targetKind !== "pull_request" ||
    snapshot.target_kind !== options.targetKind ||
    snapshot.authorization !== options.authorization ||
    !isAuthorizedReviewVerdict(snapshot.authorization, snapshot.verdict) ||
    !/^[a-f0-9]{40}$/i.test(expectedHeadSha) ||
    snapshot.head_sha !== expectedHeadSha ||
    (expectedReviewedUpdatedAt && snapshot.reviewed_updated_at !== expectedReviewedUpdatedAt) ||
    reviewedBefore === null ||
    timestamp(snapshot.reviewed_at) === null ||
    timestamp(snapshot.reviewed_at)! > reviewedBefore ||
    timestamp(snapshot.observed_updated_at) === null ||
    !isReviewedPrActivityCursor(snapshot.review_activity_cursor) ||
    !/^[a-f0-9]{64}$/.test(snapshot.source_revision) ||
    !/^[a-f0-9]{64}$/.test(snapshot.target_activity_digest) ||
    snapshot.snapshot_sha256 !== snapshotDigest(snapshot) ||
    snapshot.provenance.kind !== "trusted_comment" ||
    !DEFAULT_TRUSTED_REVIEW_AUTHORS.has(snapshot.provenance.author) ||
    currentAuthor !== snapshot.provenance.author ||
    currentCommentUpdatedAt !== snapshot.provenance.comment_updated_at ||
    digestText(currentBody) !== snapshot.provenance.body_sha256 ||
    !marker ||
    marker.verdict !== snapshot.verdict ||
    attributes.item !== String(options.number) ||
    attributes.sha !== snapshot.head_sha ||
    attributes.updated_at !== snapshot.reviewed_updated_at ||
    attributes.reviewed_at !== snapshot.reviewed_at ||
    attributes.source_revision !== snapshot.source_revision ||
    attributes.review_activity_cursor !== snapshot.review_activity_cursor ||
    attributes.target_activity_digest !== snapshot.target_activity_digest
  ) {
    throw new Error("trusted repair review authorization is unavailable or stale");
  }
  return snapshot;
}

export function validateRepairMutationReviewAuthorizationAfterMerge(
  options: ValidateRepairMutationReviewAuthorizationAfterMergeOptions,
): string {
  const snapshot = validateRepairMutationReviewAuthorizationProvenance(options);
  const targetActivity = normalizeRepairTargetActivitySnapshot(options.targetActivity);
  const reviewActivityCursor = stringValue(options.reviewActivityCursor);
  const preMergeActivity = { ...targetActivity, state: "open" };
  if (
    targetActivity.state !== "closed" ||
    reviewActivityCursor !== snapshot.review_activity_cursor ||
    repairTargetActivityDigest(preMergeActivity, snapshot.provenance.comment_id) !==
      snapshot.target_activity_digest
  ) {
    throw new Error("trusted repair review authorization is unavailable or stale");
  }
  return snapshot.review_activity_cursor;
}

export function repairMutationReviewAuthorizationSnapshotDigest(
  value: Omit<RepairMutationReviewAuthorizationSnapshot, "snapshot_sha256">,
): string {
  return digestText(JSON.stringify(value));
}

function snapshotFromTrustedComment(options: {
  comment: unknown;
  repository: string;
  number: number;
  expectedHeadSha: string;
  reviewedBefore: number;
  targetActivity: RepairTargetActivitySnapshot;
}): RepairMutationReviewAuthorizationSnapshot[] {
  const comment = record(options.comment);
  const commentId = scalarId(comment.id);
  const author = stringValue(record(comment.user).login);
  const body = typeof comment.body === "string" ? comment.body : "";
  const marker = trustedVerdictMarker(body, options.number);
  if (!commentId || !DEFAULT_TRUSTED_REVIEW_AUTHORS.has(author) || !marker) return [];
  const attributes = markerAttributes(marker.attributes);
  const reviewedAt = timestamp(attributes.reviewed_at);
  const reviewedUpdatedAt = stringValue(attributes.updated_at);
  const reviewedAtValue = stringValue(attributes.reviewed_at);
  const reviewActivityCursor = stringValue(attributes.review_activity_cursor);
  const sourceRevision = stringValue(attributes.source_revision);
  const targetActivityDigest = stringValue(attributes.target_activity_digest);
  const commentUpdatedAt = stringValue(comment.updated_at ?? comment.updatedAt);
  const authorization = authorizationForVerdict(marker.verdict);
  const targetActivityComment = options.targetActivity.comments.find(
    (entry) => entry.id === commentId,
  );
  if (
    !authorization ||
    attributes.item !== String(options.number) ||
    attributes.sha !== options.expectedHeadSha ||
    timestamp(reviewedUpdatedAt) === null ||
    reviewedAt === null ||
    reviewedAt > options.reviewedBefore ||
    !/^[a-f0-9]{64}$/.test(sourceRevision) ||
    !isReviewedPrActivityCursor(reviewActivityCursor) ||
    !/^[a-f0-9]{64}$/.test(targetActivityDigest) ||
    !commentUpdatedAt ||
    targetActivityComment?.author !== author ||
    targetActivityComment.bodySha256 !== digestText(body) ||
    repairTargetActivityDigest(options.targetActivity, commentId) !== targetActivityDigest
  ) {
    return [];
  }

  const unsigned = {
    version: 1 as const,
    repository: options.repository,
    number: options.number,
    target_kind: "pull_request" as const,
    authorization,
    verdict: marker.verdict as "pass" | "close",
    head_sha: options.expectedHeadSha,
    reviewed_updated_at: reviewedUpdatedAt,
    observed_updated_at: options.targetActivity.updatedAt,
    reviewed_at: reviewedAtValue,
    review_activity_cursor: reviewActivityCursor,
    source_revision: sourceRevision,
    target_activity_digest: targetActivityDigest,
    provenance: {
      kind: "trusted_comment" as const,
      comment_id: commentId,
      author,
      comment_updated_at: commentUpdatedAt,
      body_sha256: digestText(body),
    },
  };
  return [
    { ...unsigned, snapshot_sha256: repairMutationReviewAuthorizationSnapshotDigest(unsigned) },
  ];
}

function parseSnapshot(value: unknown): RepairMutationReviewAuthorizationSnapshot {
  const snapshot = record(value);
  const provenance = record(snapshot.provenance);
  return {
    version: snapshot.version === 1 ? 1 : (0 as 1),
    repository: stringValue(snapshot.repository),
    number: Number(snapshot.number),
    target_kind: stringValue(snapshot.target_kind) as "pull_request",
    authorization: stringValue(snapshot.authorization) as RepairMutationReviewAuthorization,
    verdict: stringValue(snapshot.verdict) as "pass" | "close",
    head_sha: stringValue(snapshot.head_sha),
    reviewed_updated_at: stringValue(snapshot.reviewed_updated_at),
    observed_updated_at: stringValue(snapshot.observed_updated_at),
    reviewed_at: stringValue(snapshot.reviewed_at),
    review_activity_cursor: stringValue(snapshot.review_activity_cursor),
    source_revision: stringValue(snapshot.source_revision),
    target_activity_digest: stringValue(snapshot.target_activity_digest),
    provenance: {
      kind: stringValue(provenance.kind) as "trusted_comment",
      comment_id: stringValue(provenance.comment_id),
      author: stringValue(provenance.author),
      comment_updated_at: stringValue(provenance.comment_updated_at),
      body_sha256: stringValue(provenance.body_sha256),
    },
    snapshot_sha256: stringValue(snapshot.snapshot_sha256),
  };
}

function snapshotDigest(snapshot: RepairMutationReviewAuthorizationSnapshot): string {
  const { snapshot_sha256: _snapshotSha256, ...unsigned } = snapshot;
  return repairMutationReviewAuthorizationSnapshotDigest(unsigned);
}

function trustedVerdictMarker(
  body: string,
  number: number,
): { verdict: string; attributes: string } | null {
  if (!new RegExp(`<!--\\s*clawsweeper-review\\s+item=${number}\\s*-->`, "i").test(body)) {
    return null;
  }
  const match = body.match(/<!--\s*clawsweeper-verdict:([a-z-]+)\b([^>]*)-->/i);
  if (!match) return null;
  return {
    verdict: String(match[1] ?? "")
      .trim()
      .toLowerCase(),
    attributes: match[2] ?? "",
  };
}

function authorizationForVerdict(verdict: string): RepairMutationReviewAuthorization | null {
  for (const authorization of ["merge", "close"] as const) {
    if (isAuthorizedReviewVerdict(authorization, verdict)) return authorization;
  }
  return null;
}

function isAuthorizedReviewVerdict(
  authorization: RepairMutationReviewAuthorization,
  verdict: string,
): boolean {
  return AUTHORIZED_REVIEW_VERDICTS[authorization].has(verdict.trim().toLowerCase());
}

function markerAttributes(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of input.matchAll(/([a-z0-9_-]+)=("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const raw = match[2] ?? "";
    values[(match[1] ?? "").toLowerCase()] = raw.replace(/^["']|["']$/g, "");
  }
  return values;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scalarId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
