import { createHash } from "node:crypto";

const COMMENT_MAX_BYTES = 65_536;
const PREVIOUS_START = "<!-- clawsweeper-review-previous:start v=1 -->";
const PREVIOUS_END = "<!-- clawsweeper-review-previous:end v=1 -->";
const IDENTITY_PATTERN = /<!--\s*clawsweeper-review\s+item=(\d+)\s*-->\s*$/i;
const STATUS_PATTERN = /<!--\s*clawsweeper-review-status:(refreshing|interrupted)\b([^>]*)-->\s*$/i;

export interface DurableReviewStatusProjection {
  state: "refreshing" | "interrupted";
  itemNumber: number;
  targetRevision: string;
  startedAt: string;
  leaseOwner: string;
  leaseCommentId: number;
  previousDigest: string;
  previousVisibleDigest: string;
  previousReviewedAt: string | null;
  previousSha: string | null;
  previousBody: string;
}

export interface DurableReviewRefreshOptions {
  itemNumber: number;
  targetRevision: string;
  startedAt: string;
  leaseOwner: string;
  leaseCommentId: number;
  previousReviewedAt?: string | null | undefined;
  previousSha?: string | null | undefined;
  workflowUrl?: string | null;
}

function digest(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex");
}

function markerValue(value: string): string {
  return value.trim().replace(/[^\w./:@-]/g, "_") || "unknown";
}

function markerAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const token of source.trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator > 0) attributes.set(token.slice(0, separator), token.slice(separator + 1));
  }
  return attributes;
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function sanitizePreviousBody(body: string): string {
  return body
    .replace(/<!--\s*clawsweeper-(?!review-history\b)[\s\S]*?-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return `${bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "")
    .trimEnd()}\n\n_[Previous review truncated while a fresh review runs.]_`;
}

function safeWorkflowUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length <= 512 && /^https:\/\/[^\s()[\]]+$/.test(trimmed) ? trimmed : null;
}

export function parseDurableReviewStatusProjection(
  body: string,
  expectedItemNumber?: number,
): DurableReviewStatusProjection | null {
  const normalized = body.replace(/\r\n?/g, "\n").trim();
  const identity = normalized.match(IDENTITY_PATTERN);
  const itemNumber = Number(identity?.[1]);
  if (!identity || !Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  if (expectedItemNumber !== undefined && itemNumber !== expectedItemNumber) return null;

  const beforeIdentity = normalized.slice(0, identity.index).trimEnd();
  const status = beforeIdentity.match(STATUS_PATTERN);
  if (!status?.[1]) return null;
  const attributes = markerAttributes(status[2] ?? "");
  const leaseCommentId = Number(attributes.get("lease_comment_id"));
  const targetRevision = attributes.get("target_revision") ?? "";
  const startedAt = attributes.get("started_at") ?? "";
  const leaseOwner = attributes.get("lease_owner") ?? "";
  const previousDigest = attributes.get("previous_digest") ?? "";
  const previousVisibleDigest = attributes.get("previous_visible_digest") ?? "";
  if (
    attributes.get("v") !== "1" ||
    Number(attributes.get("item")) !== itemNumber ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(targetRevision) ||
    !validTimestamp(startedAt) ||
    !/^[\w./:@-]+$/.test(leaseOwner) ||
    !Number.isSafeInteger(leaseCommentId) ||
    leaseCommentId <= 0 ||
    !/^[0-9a-f]{64}$/.test(previousDigest) ||
    !/^[0-9a-f]{64}$/.test(previousVisibleDigest)
  ) {
    return null;
  }

  const visible = beforeIdentity.slice(0, status.index).trimEnd();
  const previousStart = visible.indexOf(PREVIOUS_START);
  const previousEnd = visible.indexOf(PREVIOUS_END);
  if (
    previousStart < 0 ||
    previousEnd <= previousStart ||
    visible.indexOf(PREVIOUS_START, previousStart + PREVIOUS_START.length) >= 0 ||
    visible.indexOf(PREVIOUS_END, previousEnd + PREVIOUS_END.length) >= 0
  ) {
    return null;
  }
  const previousBody = visible.slice(previousStart + PREVIOUS_START.length, previousEnd).trim();
  if (!previousBody || digest(previousBody) !== previousVisibleDigest) return null;

  const nullableAttribute = (name: string): string | null => {
    const value = attributes.get(name);
    return !value || value === "na" || value === "unknown" ? null : value;
  };
  const previousReviewedAt = nullableAttribute("previous_reviewed_at");
  const previousSha = nullableAttribute("previous_sha");
  if (previousReviewedAt && !validTimestamp(previousReviewedAt)) return null;
  if (previousSha && !/^[\w./:@-]+$/.test(previousSha)) return null;
  return {
    state: status[1].toLowerCase() as DurableReviewStatusProjection["state"],
    itemNumber,
    targetRevision,
    startedAt,
    leaseOwner,
    leaseCommentId,
    previousDigest,
    previousVisibleDigest,
    previousReviewedAt,
    previousSha,
    previousBody,
  };
}

function renderProjection(
  projection: Omit<DurableReviewStatusProjection, "state" | "previousVisibleDigest"> & {
    state: DurableReviewStatusProjection["state"];
  },
  workflowUrl?: string | null,
): string | null {
  const previousVisibleDigest = digest(projection.previousBody);
  const interrupted = projection.state === "interrupted";
  const title = interrupted
    ? `Review refresh for \`${projection.targetRevision.slice(0, 12)}\` was interrupted.`
    : `Fresh ClawSweeper review in progress for \`${projection.targetRevision.slice(0, 12)}\`.`;
  const explanation = interrupted
    ? "The previous review below is stale. A new review must complete before it can be used for merge decisions."
    : "The previous review below is stale and must not be used for merge decisions.";
  const workflow = !interrupted && workflowUrl ? ` [View workflow](${workflowUrl})` : "";
  const attributes = [
    `item=${projection.itemNumber}`,
    `target_revision=${projection.targetRevision}`,
    `started_at=${markerValue(projection.startedAt)}`,
    `lease_owner=${markerValue(projection.leaseOwner)}`,
    `lease_comment_id=${projection.leaseCommentId}`,
    `previous_digest=${projection.previousDigest}`,
    `previous_visible_digest=${previousVisibleDigest}`,
    `previous_reviewed_at=${markerValue(projection.previousReviewedAt ?? "na")}`,
    `previous_sha=${markerValue(projection.previousSha ?? "na")}`,
    "v=1",
  ].join(" ");
  const body = [
    interrupted ? "> [!CAUTION]" : "> [!WARNING]",
    `> **${title}**`,
    `> ${explanation}`,
    `> Started ${projection.startedAt}.${workflow}`,
    "",
    "<details>",
    `<summary>Previous review (stale${interrupted ? " after interrupted refresh" : " while refresh runs"})</summary>`,
    "",
    PREVIOUS_START,
    projection.previousBody,
    PREVIOUS_END,
    "",
    "</details>",
    "",
    `<!-- clawsweeper-review-status:${projection.state} ${attributes} -->`,
    "",
    `<!-- clawsweeper-review item=${projection.itemNumber} -->`,
  ].join("\n");
  return Buffer.byteLength(body, "utf8") <= COMMENT_MAX_BYTES ? body : null;
}

export function renderDurableReviewRefreshProjection(
  previousBody: string,
  options: DurableReviewRefreshOptions,
): string | null {
  const existing = parseDurableReviewStatusProjection(previousBody, options.itemNumber);
  const originalPreviousBody = existing?.previousBody ?? previousBody;
  const visiblePreviousBody = sanitizePreviousBody(originalPreviousBody);
  if (!visiblePreviousBody) return null;
  const projection = {
    state: "refreshing" as const,
    itemNumber: options.itemNumber,
    targetRevision: options.targetRevision.trim().toLowerCase(),
    startedAt: options.startedAt,
    leaseOwner: options.leaseOwner,
    leaseCommentId: options.leaseCommentId,
    previousDigest: existing?.previousDigest ?? digest(originalPreviousBody),
    previousReviewedAt: existing?.previousReviewedAt ?? options.previousReviewedAt ?? null,
    previousSha: existing?.previousSha ?? options.previousSha ?? null,
    previousBody: existing?.previousBody ?? visiblePreviousBody,
  };
  const workflowUrl = safeWorkflowUrl(options.workflowUrl);
  return (
    renderProjection(projection, workflowUrl) ??
    renderProjection({ ...projection, previousBody: truncateUtf8(projection.previousBody, 48_000) })
  );
}

export function renderInterruptedDurableReviewProjection(
  body: string,
  expected: {
    itemNumber: number;
    leaseOwner: string;
    leaseCommentId: number;
    targetRevision: string;
  },
): string | null {
  const projection = parseDurableReviewStatusProjection(body, expected.itemNumber);
  if (
    !projection ||
    projection.state !== "refreshing" ||
    projection.leaseOwner !== expected.leaseOwner ||
    projection.leaseCommentId !== expected.leaseCommentId ||
    projection.targetRevision !== expected.targetRevision.trim().toLowerCase()
  ) {
    return null;
  }
  return renderProjection({ ...projection, state: "interrupted" });
}

export function isDurableReviewStatusProjection(body: string): boolean {
  return parseDurableReviewStatusProjection(body) !== null;
}
