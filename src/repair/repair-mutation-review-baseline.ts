import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MAX_REVIEWED_PR_ACTIVITY, isReviewedPrActivityCursor } from "../review-activity-cursor.js";
import { ghPagedLimitWithRetry as ghPagedLimit } from "./github-cli.js";
import type { RepairMutationTargetKind } from "./repair-mutation-activity.js";

export const EMPTY_REPAIR_REVIEW_ACTIVITY_CURSOR = `v2:0:${createHash("sha256")
  .update("[]")
  .digest("hex")}`;

type RepairMutationReviewBaselineOptions = {
  repository: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  authorization: RepairMutationReviewAuthorization;
  explicitCursor?: unknown;
  explicitVerdict?: unknown;
  expectedUpdatedAt?: unknown;
  expectedHeadSha?: unknown;
  reviewedBefore?: unknown;
  stateRoot?: string | null;
  readIssueComments?: () => unknown[];
};

export type RepairMutationReviewAuthorization = "merge" | "close";

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

export function resolveRepairMutationReviewActivityCursor(
  options: RepairMutationReviewBaselineOptions,
): string | null {
  if (options.targetKind !== "pull_request") return null;

  const explicitCursor = stringValue(options.explicitCursor);
  if (
    explicitCursor &&
    isAuthorizedReviewVerdict(options.authorization, stringValue(options.explicitVerdict))
  ) {
    return explicitCursor;
  }

  if (stringValue(options.expectedHeadSha)) {
    return trustedRepairReviewActivityCursor(options);
  }

  const storedCursor = storedRepairReviewActivityCursor(options);
  return storedCursor ?? EMPTY_REPAIR_REVIEW_ACTIVITY_CURSOR;
}

function storedRepairReviewActivityCursor(
  options: RepairMutationReviewBaselineOptions,
): string | null {
  const stateRoot = stringValue(options.stateRoot ?? process.env.CLAWSWEEPER_STATE_DIR);
  const expectedUpdatedAt = stringValue(options.expectedUpdatedAt);
  const reviewedBefore = timestamp(options.reviewedBefore);
  if (!stateRoot || !expectedUpdatedAt || reviewedBefore === null) return null;

  const slug = repositorySlug(options.repository);
  const records = [
    path.join(stateRoot, "records", slug, "items", `${options.number}.md`),
    path.join(stateRoot, "records", slug, "items", `${slug}-${options.number}.md`),
  ];
  for (const recordPath of records) {
    const cursor = cursorFromStateRecord({
      recordPath,
      repository: options.repository,
      number: options.number,
      authorization: options.authorization,
      expectedUpdatedAt,
      reviewedBefore,
    });
    if (cursor) return cursor;
  }
  return null;
}

function cursorFromStateRecord(options: {
  recordPath: string;
  repository: string;
  number: number;
  authorization: RepairMutationReviewAuthorization;
  expectedUpdatedAt: string;
  reviewedBefore: number;
}): string | null {
  let markdown: string;
  try {
    markdown = fs.readFileSync(options.recordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const frontmatter = parseFrontmatter(markdown);
  const reviewedAt = timestamp(frontmatter.reviewed_at);
  const cursor = frontmatter.review_activity_cursor;
  if (
    frontmatter.repository !== options.repository ||
    frontmatter.number !== String(options.number) ||
    frontmatter.type !== "pull_request" ||
    frontmatter.state_at_review !== "open" ||
    frontmatter.item_updated_at !== options.expectedUpdatedAt ||
    frontmatter.review_status !== "complete" ||
    frontmatter.review_terminal_failure !== "false" ||
    frontmatter.local_checkout_access !== "verified" ||
    !isAuthorizedReviewVerdict(options.authorization, stringValue(frontmatter.review_verdict)) ||
    reviewedAt === null ||
    reviewedAt > options.reviewedBefore ||
    !isReviewedPrActivityCursor(cursor)
  ) {
    return null;
  }
  return cursor;
}

function trustedRepairReviewActivityCursor(
  options: RepairMutationReviewBaselineOptions,
): string | null {
  const expectedHeadSha = stringValue(options.expectedHeadSha);
  const expectedUpdatedAt = stringValue(options.expectedUpdatedAt);
  const reviewedBefore = timestamp(options.reviewedBefore);
  if (
    !/^[a-f0-9]{40}$/i.test(expectedHeadSha) ||
    timestamp(expectedUpdatedAt) === null ||
    reviewedBefore === null
  )
    return null;
  let comments: unknown[];
  try {
    comments =
      options.readIssueComments?.() ??
      ghPagedLimit<unknown>(
        `repos/${options.repository}/issues/${options.number}/comments`,
        MAX_REVIEWED_PR_ACTIVITY + 1,
      );
  } catch {
    return null;
  }
  if (comments.length > MAX_REVIEWED_PR_ACTIVITY) return null;

  const candidates = comments
    .map(trustedVerdictCursor)
    .filter(
      (
        candidate,
      ): candidate is {
        cursor: string;
        reviewedAt: number;
      } => Boolean(candidate),
    )
    .filter((candidate) => candidate.reviewedAt <= reviewedBefore)
    .sort((left, right) => right.reviewedAt - left.reviewedAt);
  return candidates.find((candidate) => candidate.cursor)?.cursor ?? null;

  function trustedVerdictCursor(value: unknown): {
    cursor: string;
    reviewedAt: number;
  } | null {
    const comment = record(value);
    const author = stringValue(record(comment.user).login);
    if (!DEFAULT_TRUSTED_REVIEW_AUTHORS.has(author)) return null;
    const body = typeof comment.body === "string" ? comment.body : "";
    const marker = body.match(/<!--\s*clawsweeper-verdict:([a-z-]+)\b([^>]*)-->/i);
    if (!marker) return null;
    const verdict = (marker[1] ?? "").toLowerCase();
    if (!isAuthorizedReviewVerdict(options.authorization, verdict)) return null;
    const attributes = markerAttributes(marker[2] ?? "");
    const reviewedAt = timestamp(attributes.reviewed_at);
    const reviewedUpdatedAt = timestamp(attributes.updated_at);
    const expectedUpdatedAtMs = timestamp(expectedUpdatedAt);
    const trustedCommentUpdatedAt = stringValue(comment.updated_at ?? comment.created_at);
    const updatedAtMatches =
      attributes.updated_at === expectedUpdatedAt ||
      (reviewedUpdatedAt !== null &&
        expectedUpdatedAtMs !== null &&
        reviewedUpdatedAt < expectedUpdatedAtMs &&
        trustedCommentUpdatedAt === expectedUpdatedAt);
    if (
      attributes.item !== String(options.number) ||
      attributes.sha !== expectedHeadSha ||
      !updatedAtMatches ||
      reviewedAt === null ||
      !isReviewedPrActivityCursor(attributes.review_activity_cursor)
    ) {
      return null;
    }
    return { cursor: attributes.review_activity_cursor, reviewedAt };
  }
}

function isAuthorizedReviewVerdict(
  authorization: RepairMutationReviewAuthorization,
  verdict: string,
): boolean {
  return AUTHORIZED_REVIEW_VERDICTS[authorization].has(verdict.trim().toLowerCase());
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) continue;
    const raw = (entry[2] ?? "").trim();
    values[entry[1] ?? ""] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return values;
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

function repositorySlug(repository: string): string {
  return repository
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : null;
}
