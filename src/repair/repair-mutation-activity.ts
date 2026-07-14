import { createHash } from "node:crypto";

import { actionIdempotencyKey } from "../action-ledger.js";
import {
  MAX_REVIEWED_PR_ACTIVITY,
  REVIEWED_PR_ACTIVITY_THREADS_QUERY,
  createReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  reviewedPrActivityThreadsPageFromGraphql,
} from "../review-activity-cursor.js";
import { ghJsonWithRetry as ghJson, ghPagedLimitWithRetry as ghPagedLimit } from "./github-cli.js";

export type RepairMutationTargetKind = "issue" | "pull_request";

export type RepairMutationOwnedChange =
  | {
      kind: "comment_create";
      commentId: string;
      bodySha256: string;
    }
  | {
      kind: "label_add";
      label: string;
    };

type RepairTargetActivityComment = {
  id: string;
  author: string | null;
  authorAssociation: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  bodySha256: string;
  metadataSha256: string;
};

export type RepairTargetActivitySnapshot = {
  updatedAt: string;
  state: string;
  labels: string[];
  metadataSha256: string;
  comments: RepairTargetActivityComment[];
};

const MAX_REPAIR_TARGET_COMMENTS = 1_000;

export function repairCreatedCommentChange(
  value: unknown,
  expectedBodySha256: string,
): RepairMutationOwnedChange {
  const response = record(value);
  const commentId = scalarId(response.id);
  const body = typeof response.body === "string" ? response.body : null;
  if (
    !commentId ||
    !/^[a-f0-9]{64}$/.test(expectedBodySha256) ||
    body === null ||
    digestText(body) !== expectedBodySha256
  ) {
    throw new Error("created comment response could not be bound to the requested body");
  }
  return {
    kind: "comment_create",
    commentId,
    bodySha256: expectedBodySha256,
  };
}

export function fetchStableRepairTargetActivity(
  repository: string,
  number: number,
  targetKind: RepairMutationTargetKind = "issue",
): RepairTargetActivitySnapshot | null {
  const first = fetchRepairTargetActivityOnce(repository, number, targetKind);
  const second = fetchRepairTargetActivityOnce(repository, number, targetKind);
  if (actionIdempotencyKey(first) !== actionIdempotencyKey(second)) {
    throw new Error("target activity changed while the bounded repair snapshot was captured");
  }
  return second;
}

export function fetchStableRepairReviewActivityCursor(
  repository: string,
  number: number,
): string | null {
  return readStableReviewedPrActivityCursor(() =>
    fetchRepairReviewActivityCursorOnce(repository, number),
  );
}

export function normalizeRepairTargetActivitySnapshot(
  value: RepairTargetActivitySnapshot,
): RepairTargetActivitySnapshot {
  const updatedAt = normalizedTimestamp(value.updatedAt);
  const state = String(value.state ?? "")
    .trim()
    .toLowerCase();
  const metadataSha256 = String(value.metadataSha256 ?? "").trim();
  if (!updatedAt || !state || !/^[a-f0-9]{64}$/.test(metadataSha256)) {
    throw new Error("target activity snapshot is malformed");
  }
  const labels = [...new Set(value.labels.map(normalizeLabel).filter(Boolean))].sort(codeUnitOrder);
  const comments = value.comments
    .map((comment) => ({
      id: scalarId(comment.id),
      author: scalar(comment.author),
      authorAssociation: scalar(comment.authorAssociation),
      createdAt: scalar(comment.createdAt),
      updatedAt: scalar(comment.updatedAt),
      bodySha256: String(comment.bodySha256 ?? "").trim(),
      metadataSha256: String(comment.metadataSha256 ?? "").trim(),
    }))
    .sort((left, right) => codeUnitOrder(left.id, right.id));
  if (
    comments.some(
      (comment) =>
        !comment.id ||
        !/^[a-f0-9]{64}$/.test(comment.bodySha256) ||
        !/^[a-f0-9]{64}$/.test(comment.metadataSha256),
    ) ||
    new Set(comments.map((comment) => comment.id)).size !== comments.length
  ) {
    throw new Error("target comment activity snapshot is malformed");
  }
  return { updatedAt, state, labels, metadataSha256, comments };
}

export function sameRepairTargetActivity(
  left: RepairTargetActivitySnapshot,
  right: RepairTargetActivitySnapshot,
): boolean {
  return actionIdempotencyKey(left) === actionIdempotencyKey(right);
}

export function repairTargetActivityMatchesOwnedChange(
  before: RepairTargetActivitySnapshot,
  after: RepairTargetActivitySnapshot,
  change: RepairMutationOwnedChange,
): boolean {
  if (before.state !== after.state || before.metadataSha256 !== after.metadataSha256) {
    return false;
  }
  if (change.kind === "label_add") {
    const expectedLabels = [
      ...new Set([...before.labels, normalizeLabel(change.label)].filter(Boolean)),
    ].sort(codeUnitOrder);
    return (
      actionIdempotencyKey(expectedLabels) === actionIdempotencyKey(after.labels) &&
      actionIdempotencyKey(before.comments) === actionIdempotencyKey(after.comments)
    );
  }
  if (actionIdempotencyKey(before.labels) !== actionIdempotencyKey(after.labels)) return false;
  const beforeById = new Map(before.comments.map((comment) => [comment.id, comment]));
  const added = after.comments.filter((comment) => !beforeById.has(comment.id));
  if (
    added.length !== 1 ||
    added[0]?.id !== change.commentId ||
    added[0]?.bodySha256 !== change.bodySha256
  ) {
    return false;
  }
  const retained = after.comments.filter((comment) => beforeById.has(comment.id));
  return actionIdempotencyKey(retained) === actionIdempotencyKey(before.comments);
}

function fetchRepairTargetActivityOnce(
  repository: string,
  number: number,
  targetKind: RepairMutationTargetKind,
): RepairTargetActivitySnapshot | null {
  const endpoint =
    targetKind === "pull_request"
      ? `repos/${repository}/pulls/${number}`
      : `repos/${repository}/issues/${number}`;
  const issue = record(ghJson<unknown>(["api", endpoint]));
  const updatedAt = normalizedTimestamp(issue.updated_at ?? issue.updatedAt);
  if (!updatedAt) throw new Error("target activity timestamp is unavailable");
  const comments = ghPagedLimit<unknown>(
    `repos/${repository}/issues/${number}/comments`,
    MAX_REPAIR_TARGET_COMMENTS + 1,
  );
  if (comments.length > MAX_REPAIR_TARGET_COMMENTS) return null;
  return normalizeRepairTargetActivitySnapshot({
    updatedAt,
    state: String(issue.state ?? "")
      .trim()
      .toLowerCase(),
    labels: normalizeLabels(issue.labels),
    metadataSha256: actionIdempotencyKey({
      titleSha256: digestScalar(issue.title),
      bodySha256: digestScalar(issue.body),
      locked: issue.locked === true,
      stateReason: scalar(issue.state_reason ?? issue.stateReason),
      authorAssociation: scalar(issue.author_association ?? issue.authorAssociation),
      assignees: normalizeActors(issue.assignees),
      milestone: compactMilestone(issue.milestone),
      pullRequest: compactPullRequest(issue.pull_request ?? issue.pullRequest),
    }),
    comments: comments.map(compactTargetComment),
  });
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

function compactTargetComment(value: unknown): RepairTargetActivityComment {
  const comment = record(value);
  const user = record(comment.user);
  return {
    id: scalarId(comment.id),
    author: scalar(user.login),
    authorAssociation: scalar(comment.author_association ?? comment.authorAssociation),
    createdAt: scalar(comment.created_at ?? comment.createdAt),
    updatedAt: scalar(comment.updated_at ?? comment.updatedAt),
    bodySha256: digestScalar(comment.body),
    metadataSha256: actionIdempotencyKey({
      nodeId: scalar(comment.node_id ?? comment.nodeId),
      htmlUrl: scalar(comment.html_url ?? comment.htmlUrl),
      issueUrl: scalar(comment.issue_url ?? comment.issueUrl),
      performedViaGithubApp: compactActor(comment.performed_via_github_app),
      reactions: comment.reactions ?? null,
    }),
  };
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const label = record(entry);
      return normalizeLabel(typeof entry === "string" ? entry : label.name);
    })
    .filter(Boolean)
    .sort(codeUnitOrder);
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeActors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => scalar(record(entry).login))
    .filter((entry): entry is string => entry !== null)
    .sort(codeUnitOrder);
}

function compactActor(value: unknown) {
  const actor = record(value);
  return {
    id: scalar(actor.id),
    slug: scalar(actor.slug),
  };
}

function compactMilestone(value: unknown) {
  const milestone = record(value);
  return {
    id: scalar(milestone.id),
    number: scalar(milestone.number),
    state: scalar(milestone.state),
    titleSha256: digestScalar(milestone.title),
  };
}

function compactPullRequest(value: unknown) {
  const pull = record(value);
  return {
    url: scalar(pull.url),
    mergedAt: scalar(pull.merged_at ?? pull.mergedAt),
    diffUrl: scalar(pull.diff_url ?? pull.diffUrl),
    patchUrl: scalar(pull.patch_url ?? pull.patchUrl),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function scalarId(value: unknown): string {
  return scalar(value)?.trim() ?? "";
}

function normalizedTimestamp(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function digestScalar(value: unknown): string {
  return digestText(scalar(value) ?? "");
}

function digestText(value: unknown): string {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}

function codeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
