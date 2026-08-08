import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { PR_CLOSE_COVERAGE_PROOF_SECTION } from "./clawsweeper-policy.js";
import type { CloseReason, ReviewArtifactDestination } from "./clawsweeper-types.js";
import { parseGhJson } from "./github-json.js";
import {
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import type { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";
import type { createReviewCommentState } from "./clawsweeper-review-comment-state.js";
import { trailingHtmlComments } from "./review-comment-markers.js";

const DURABLE_REVIEW_COMMENT_MAX_BYTES = 60 * 1024;

export class DurableReviewPublicationBlockedError extends Error {
  constructor(
    message: string,
    readonly syncedComment: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DurableReviewPublicationBlockedError";
  }
}

export function createReviewCommentPublication(
  dependencies: ReviewCommentWorkflowDependencies &
    ReturnType<typeof createReviewCommentIdentity> &
    ReturnType<typeof createReviewCommentState>,
) {
  const {
    root: ROOT,
    targetRepo,
    ghObservedMutationCommand,
    sha256,
    ghPaged,
    reviewCommentBodyDigest,
    asRecord,
    ensureDir,
    frontMatterValue,
    replaceFrontMatterValue,
    sectionValue,
    timestampMs,
    sentence,
    normalizedLabelSet,
    sectionLineValue,
    markdownLink,
    closeAppliedCommentMarker,
    markedReviewCommentBody,
    issueReviewComment,
    issueReviewCommentWithBody,
    commentUpdatedAt,
    commentId,
    commentUrl,
    commentBodyMatches,
    canPatchReviewComment,
  } = dependencies;

  function reviewArtifactDestination(
    action: string | undefined,
    itemIsOpen: boolean,
  ): ReviewArtifactDestination {
    if (!itemIsOpen) return "skip_closed";
    return action === "closed" || action === "skipped_already_closed" ? "closed" : "items";
  }

  function runtimeBudgetExceeded(
    startedAtMs: number,
    maxRuntimeMs: number,
    nowMs: number,
  ): boolean {
    return maxRuntimeMs > 0 && nowMs - startedAtMs >= maxRuntimeMs;
  }

  function removeCurrentCursorTraceItem(
    examinedItemNumbers: number[],
    currentNumber: number,
  ): void {
    if (examinedItemNumbers.at(-1) === currentNumber) examinedItemNumbers.pop();
  }

  function timeoutWithinRuntimeBudget(
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ): number | null {
    if (maxRuntimeMs <= 0) return requestedTimeoutMs;
    const remainingMs = maxRuntimeMs - (nowMs - startedAtMs);
    return remainingMs > 0 ? Math.min(requestedTimeoutMs, remainingMs) : null;
  }

  function coverageProofRetryExhaustedRuntimeBudget(
    startedAtMs: number,
    maxRuntimeMs: number,
    actionTaken: string,
    nowMs: number,
  ): boolean {
    return (
      actionTaken === "retry_pr_close_coverage_proof" &&
      runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, nowMs)
    );
  }

  function recordedLabelSyncCoversUpdate(options: {
    itemUpdatedAt: string;
    labelsSyncedAt: string | undefined;
    liveLabels: readonly string[];
    recordedLabels: readonly string[];
    hasNonAutomationActivity: boolean;
  }): boolean {
    const itemUpdatedAtMs = timestampMs(options.itemUpdatedAt);
    const labelsSyncedAtMs = timestampMs(options.labelsSyncedAt);
    if (
      itemUpdatedAtMs === null ||
      labelsSyncedAtMs === null ||
      itemUpdatedAtMs > labelsSyncedAtMs ||
      options.hasNonAutomationActivity
    ) {
      return false;
    }
    const liveLabelSet = normalizedLabelSet(options.liveLabels);
    const recordedLabelSet = normalizedLabelSet(options.recordedLabels);
    return (
      liveLabelSet.size === recordedLabelSet.size &&
      [...liveLabelSet].every((label) => recordedLabelSet.has(label))
    );
  }

  function updateReviewCommentMetadata(
    markdown: string,
    comment: Record<string, unknown> | undefined,
    body: string,
  ): string {
    let next = replaceFrontMatterValue(
      markdown,
      "review_comment_sha256",
      reviewCommentBodyDigest(body),
    );
    const id = commentId(comment);
    const url = commentUrl(comment);
    if (id !== null) next = replaceFrontMatterValue(next, "review_comment_id", String(id));
    if (url) next = replaceFrontMatterValue(next, "review_comment_url", url);
    const checkedAt = new Date().toISOString();
    next = replaceFrontMatterValue(
      next,
      "review_comment_synced_at",
      commentUpdatedAt(comment) ?? checkedAt,
    );
    next = replaceFrontMatterValue(next, "review_comment_checked_at", checkedAt);
    return next;
  }

  function writeCommentPayload(number: number, body: string): string {
    const commentPath = join(ROOT, ".artifacts", `comment-${number}-${randomUUID()}`);
    const commentFile = `${commentPath}.md`;
    ensureDir(dirname(commentFile));
    writeFileSync(commentFile, body, "utf8");
    const commentPayloadFile = `${commentPath}.json`;
    writeFileSync(commentPayloadFile, JSON.stringify({ body }), "utf8");
    return commentPayloadFile;
  }

  function markerForItem(
    markers: readonly string[],
    pattern: RegExp,
    number: number,
  ): string | undefined {
    return [...markers].reverse().find((marker) => {
      const match = marker.match(pattern);
      return match && new RegExp(`\\bitem=${number}\\b`).test(match[1] ?? "");
    });
  }

  function oversizedReviewCommentFallback(number: number, body: string, bodyBytes: number): string {
    const markers = trailingHtmlComments(body);
    const versionMarker = markerForItem(
      markers,
      /^<!--\s+clawsweeper-review-version\b([^>]*)-->$/,
      number,
    );
    const versionAttributes =
      versionMarker?.match(/^<!--\s+clawsweeper-review-version\b([^>]*)-->$/)?.[1] ?? "";
    const stateMarker = markerForItem(
      markers,
      /^<!--\s+clawsweeper-review-state:[^\s>]+\b([^>]*)-->$/,
      number,
    );
    const stateAttributes =
      stateMarker?.match(/^<!--\s+clawsweeper-review-state:[^\s>]+\b([^>]*)-->$/)?.[1] ?? "";
    const exactHead =
      stateAttributes.match(/\bsha=([0-9a-f]{40})\b/i)?.[1]?.toLowerCase() ??
      versionAttributes.match(/\bsha=([0-9a-f]{40})\b/i)?.[1]?.toLowerCase();
    const verdictMarker = markerForItem(
      markers,
      /^<!--\s+clawsweeper-verdict:[^\s>]+\b([^>]*)-->$/,
      number,
    );
    const blockedVerdict = verdictMarker?.replace(
      /^<!--\s+clawsweeper-verdict:[^\s>]+/,
      "<!-- clawsweeper-verdict:needs-human",
    );
    const blockedState = exactHead
      ? `<!-- clawsweeper-review-state:blocked item=${number} sha=${exactHead} v=1 -->`
      : "";
    const fallback = [
      "Codex review: publication failed closed.",
      "",
      "# ClawSweeper review",
      "",
      "## What this changes",
      "",
      "The generated durable review exceeded the bounded GitHub publication size.",
      "",
      "## Merge readiness",
      "",
      "**Blocked by review publication failure - 1 item remains**",
      "",
      "The previous same-head verdict is not authoritative. ClawSweeper replaced it with this bounded blocked state and stopped the apply path.",
      "",
      "## Before merge",
      "",
      "- [ ] **Retry bounded review publication (P2)** - Reduce or compact the generated review, then run a fresh exact-head review before merge.",
      "",
      "## Findings",
      "",
      `- [P2] Durable review body was ${bodyBytes} bytes; the publication limit is ${DURABLE_REVIEW_COMMENT_MAX_BYTES} bytes.`,
      "",
      blockedVerdict ?? "",
      blockedState,
      versionMarker ?? "",
    ]
      .filter(Boolean)
      .join("\n");
    return markedReviewCommentBody(number, fallback);
  }

  function upsertReviewComment(
    number: number,
    body: string,
    existing = issueReviewComment(number, [body]),
    mutationIdentity?: string,
  ): Record<string, unknown> {
    const markedBody = markedReviewCommentBody(number, body);
    const bodyBytes = Buffer.byteLength(markedBody, "utf8");
    const oversized = bodyBytes > DURABLE_REVIEW_COMMENT_MAX_BYTES;
    const publicationBody = oversized
      ? oversizedReviewCommentFallback(number, markedBody, bodyBytes)
      : markedBody;
    const id = commentId(existing);
    const patchTargetId = id !== null && canPatchReviewComment(existing) ? id : null;
    const payload = writeCommentPayload(number, publicationBody);
    let args: string[];
    if (patchTargetId !== null) {
      args = [
        "api",
        `repos/${targetRepo()}/issues/comments/${patchTargetId}`,
        "--method",
        "PATCH",
        "--input",
        payload,
      ];
    } else {
      args = [
        "api",
        `repos/${targetRepo()}/issues/${number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ];
    }
    const response = ghObservedMutationCommand({
      identity:
        mutationIdentity ??
        `review_comment_upsert:${number}:${reviewCommentBodyDigest(publicationBody)}`,
      args,
      knownNoMutation: (error) =>
        isGitHubRequiresAuthenticationError(error) || isLockedConversationCommentError(error),
    });
    const written = reviewCommentFromMutationResponse(response, args);
    const writtenId = commentId(written);
    // Comment identity alone cannot authorize duplicate cleanup. The mutation
    // response must expose the exact body requested by this write.
    const verifiedWritten =
      writtenId !== null &&
      (patchTargetId === null || writtenId === patchTargetId) &&
      commentBodyMatches(written, publicationBody)
        ? written
        : undefined;
    const synced =
      verifiedWritten ??
      issueReviewCommentWithBody(number, publicationBody, patchTargetId ?? undefined);
    if (synced && oversized) {
      throw new DurableReviewPublicationBlockedError(
        `durable review comment for #${number} exceeded ${DURABLE_REVIEW_COMMENT_MAX_BYTES} bytes; published a blocked fallback and stopped apply`,
        synced,
      );
    }
    if (synced) return synced;
    if (patchTargetId !== null) {
      throw new Error(
        `GitHub comment PATCH for #${number} did not verify target comment ${patchTargetId}`,
      );
    }
    throw new Error(
      `GitHub comment mutation for #${number} did not return or expose the synced review comment`,
    );
  }

  function reviewCommentFromMutationResponse(
    response: string,
    args: readonly string[],
  ): Record<string, unknown> | undefined {
    if (!response.trim()) return undefined;
    try {
      const comment = asRecord(parseGhJson<unknown>(response, args));
      if (commentId(comment) !== null || commentUrl(comment)) {
        return comment;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function issueCommentWithMarker(
    number: number,
    marker: string,
  ): Record<string, unknown> | undefined {
    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
      asRecord,
    );
    return comments.find((candidate) => {
      const body = candidate.body;
      return typeof body === "string" && body.includes(marker);
    });
  }

  function closeAppliedEvidenceLink(markdown: string, itemUrl: string): string {
    const reviewCommentUrl = frontMatterValue(markdown, "review_comment_url");
    if (reviewCommentUrl && reviewCommentUrl !== "unknown") {
      return markdownLink("durable ClawSweeper review", reviewCommentUrl);
    }
    const fixedPrUrl = frontMatterValue(markdown, "fixed_pr_url");
    const fixedPrNumber = frontMatterValue(markdown, "fixed_pr_number");
    if (fixedPrUrl && fixedPrUrl !== "unknown") {
      const label =
        fixedPrNumber && fixedPrNumber !== "unknown" ? `fix PR #${fixedPrNumber}` : "fix PR";
      return markdownLink(label, fixedPrUrl);
    }
    return markdownLink("closed PR", itemUrl);
  }

  function renderCloseAppliedComment(options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
  }): string {
    const coverageProofLine = closeAppliedCoverageProofLine(options.markdown);
    return [
      "ClawSweeper applied the proposed close for this PR.",
      "",
      "- Action: closed this PR.",
      `- Close reason: ${closeReasonText(options.closeReason)}.`,
      `- Evidence: ${closeAppliedEvidenceLink(options.markdown, options.itemUrl)}.`,
      coverageProofLine,
      "",
      closeAppliedCommentMarker(options.number),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  function closeAppliedCoverageProofLine(markdown: string): string | null {
    const proof = sectionValue(markdown, PR_CLOSE_COVERAGE_PROOF_SECTION);
    if (!proof) return null;
    const reason = sectionLineValue(proof, "Reason");
    if (!reason) return null;
    const covering = sectionLineValue(proof, "Covering PR");
    return [`- Coverage proof: ${sentence(reason)}`, covering ? ` Covering PR: ${covering}.` : ""]
      .join("")
      .trim();
  }

  function ensureCloseAppliedComment(options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
    dryRun: boolean;
  }): string {
    const marker = closeAppliedCommentMarker(options.number);
    if (issueCommentWithMarker(options.number, marker)) {
      return "matching ClawSweeper close-applied comment already exists";
    }
    const body = renderCloseAppliedComment(options);
    if (options.dryRun) return "dry-run: would post close-applied comment";
    const payload = writeCommentPayload(options.number, body);
    ghObservedMutationCommand({
      identity: `close_applied_comment:${options.number}:${sha256(body)}`,
      args: [
        "api",
        `repos/${targetRepo()}/issues/${options.number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ],
    });
    return "posted close-applied comment";
  }

  return {
    reviewArtifactDestination,
    runtimeBudgetExceeded,
    removeCurrentCursorTraceItem,
    timeoutWithinRuntimeBudget,
    coverageProofRetryExhaustedRuntimeBudget,
    recordedLabelSyncCoversUpdate,
    updateReviewCommentMetadata,
    writeCommentPayload,
    upsertReviewComment,
    reviewCommentFromMutationResponse,
    issueCommentWithMarker,
    closeAppliedEvidenceLink,
    renderCloseAppliedComment,
    closeAppliedCoverageProofLine,
    ensureCloseAppliedComment,
  };
}
