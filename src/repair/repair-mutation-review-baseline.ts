import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isReviewedPrActivityCursor } from "../review-activity-cursor.js";
import type { RepairMutationTargetKind } from "./repair-mutation-activity.js";

export const EMPTY_REPAIR_REVIEW_ACTIVITY_CURSOR = `v2:0:${createHash("sha256")
  .update("[]")
  .digest("hex")}`;

type RepairMutationReviewBaselineOptions = {
  repository: string;
  number: number;
  targetKind: RepairMutationTargetKind;
  explicitCursor?: unknown;
  expectedUpdatedAt?: unknown;
  reviewedBefore?: unknown;
  stateRoot?: string | null;
};

export function resolveRepairMutationReviewActivityCursor(
  options: RepairMutationReviewBaselineOptions,
): string | null {
  if (options.targetKind !== "pull_request") return null;

  const explicitCursor = stringValue(options.explicitCursor);
  if (explicitCursor) return explicitCursor;

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
    reviewedAt === null ||
    reviewedAt > options.reviewedBefore ||
    !isReviewedPrActivityCursor(cursor)
  ) {
    return null;
  }
  return cursor;
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
