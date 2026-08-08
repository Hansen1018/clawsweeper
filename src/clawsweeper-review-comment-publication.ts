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
    durableReviewVersionFromBody,
    durableReviewVersion,
    identitylessPublicationFallback,
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

  function markerAttribute(attributes: string, name: string): string | undefined {
    return attributes.match(new RegExp(`\\b${name}=([^\\s>]+)`, "i"))?.[1];
  }

  function boundedReviewVersionMarker(
    number: number,
    identity: {
      reviewedAt: string;
      headSha: string | null;
      sourceRevision: string | null;
      leaseOwner: string | null;
      leaseCommentId: string | null;
    } | null,
  ): string {
    if (
      !identity ||
      timestampMs(identity.reviewedAt) === null ||
      (identity.headSha !== null && !/^[0-9a-f]{40}$/i.test(identity.headSha))
    ) {
      return "";
    }
    const attrs = [
      `item=${number}`,
      `reviewed_at=${identity.reviewedAt}`,
      `sha=${identity.headSha?.toLowerCase() ?? "na"}`,
      ...(identity.sourceRevision &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(identity.sourceRevision)
        ? [`source_revision=${identity.sourceRevision.toLowerCase()}`]
        : []),
      ...(identity.leaseOwner && /^[A-Za-z0-9._:-]{1,200}$/.test(identity.leaseOwner)
        ? [`lease_owner=${identity.leaseOwner}`]
        : []),
      ...(identity.leaseCommentId &&
      /^[1-9]\d*$/.test(identity.leaseCommentId) &&
      Number.isSafeInteger(Number(identity.leaseCommentId))
        ? [`lease_comment_id=${identity.leaseCommentId}`]
        : []),
      "v=1",
    ].join(" ");
    return `<!-- clawsweeper-review-version ${attrs} -->`;
  }

  function oversizedReviewCommentFallback(
    number: number,
    body: string,
    bodyBytes: number,
    existing: Record<string, unknown> | undefined,
  ): string {
    const markers = trailingHtmlComments(body);
    const versionMarker = markerForItem(
      markers,
      /^<!--\s+clawsweeper-review-version\b([^>]*)-->$/,
      number,
    );
    const versionAttributes =
      versionMarker?.match(/^<!--\s+clawsweeper-review-version\b([^>]*)-->$/)?.[1] ?? "";
    const verdictMarker = markerForItem(
      markers,
      /^<!--\s+clawsweeper-verdict:[^\s>]+\b([^>]*)-->$/,
      number,
    );
    const verdictAttributes =
      verdictMarker?.match(/^<!--\s+clawsweeper-verdict:[^\s>]+\b([^>]*)-->$/)?.[1] ?? "";
    const stateMarker = markerForItem(
      markers,
      /^<!--\s+clawsweeper-review-state:[^\s>]+\b([^>]*)-->$/,
      number,
    );
    const stateAttributes =
      stateMarker?.match(/^<!--\s+clawsweeper-review-state:[^\s>]+\b([^>]*)-->$/)?.[1] ?? "";
    const exactHead =
      stateAttributes.match(/\bsha=([0-9a-f]{40})\b/i)?.[1]?.toLowerCase() ??
      verdictAttributes.match(/\bsha=([0-9a-f]{40})\b/i)?.[1]?.toLowerCase() ??
      versionAttributes.match(/\bsha=([0-9a-f]{40})\b/i)?.[1]?.toLowerCase();
    const sourceReviewedAt = markerAttribute(versionAttributes, "reviewed_at");
    const sourceHead = markerAttribute(versionAttributes, "sha");
    const sourceIdentity =
      sourceReviewedAt &&
      timestampMs(sourceReviewedAt) !== null &&
      markerAttribute(versionAttributes, "v") === "1" &&
      (exactHead ? sourceHead?.toLowerCase() === exactHead : sourceHead === "na")
        ? {
            reviewedAt: sourceReviewedAt,
            headSha: exactHead ?? null,
            sourceRevision: markerAttribute(versionAttributes, "source_revision") ?? null,
            leaseOwner: markerAttribute(versionAttributes, "lease_owner") ?? null,
            leaseCommentId: markerAttribute(versionAttributes, "lease_comment_id") ?? null,
          }
        : null;
    const existingVersion = sourceIdentity ? null : durableReviewVersion(existing, number);
    // Reuse only the same-head identity of the authoritative comment being
    // replaced. Never invent a review timestamp for malformed report metadata.
    const selectedReviewVersion =
      sourceIdentity ??
      (exactHead
        ? existingVersion?.headSha?.toLowerCase() === exactHead
          ? existingVersion
          : null
        : existingVersion?.headSha === null
          ? existingVersion
          : null);
    const selectedReviewedAtMs = selectedReviewVersion
      ? timestampMs(selectedReviewVersion.reviewedAt)
      : null;
    const reviewVersion =
      selectedReviewVersion && selectedReviewedAtMs !== null
        ? {
            ...selectedReviewVersion,
            reviewedAt: new Date(selectedReviewedAtMs).toISOString(),
          }
        : null;
    const blockedVerdict = [
      `item=${number}`,
      ...(exactHead ? [`sha=${exactHead}`] : []),
      ...(reviewVersion ? [`reviewed_at=${reviewVersion.reviewedAt}`] : []),
    ].join(" ");
    const blockedState =
      exactHead && reviewVersion
        ? `<!-- clawsweeper-review-state:blocked item=${number} sha=${exactHead} v=1 -->`
        : "";
    const boundedVersion = boundedReviewVersionMarker(number, reviewVersion);
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
      reviewVersion
        ? "The previous same-head verdict is not authoritative. ClawSweeper replaced it with this bounded blocked state and stopped the apply path."
        : "ClawSweeper stopped the apply path because it could not publish an authoritative same-head blocked state.",
      "",
      "## Before merge",
      "",
      "- [ ] **Retry bounded review publication (P2)** - Reduce or compact the generated review, then run a fresh exact-head review before merge.",
      "",
      "## Findings",
      "",
      `- [P2] Durable review body was ${bodyBytes} bytes; the publication limit is ${DURABLE_REVIEW_COMMENT_MAX_BYTES} bytes.`,
      "",
      `<!-- clawsweeper-verdict:needs-human ${blockedVerdict} -->`,
      blockedState,
      boundedVersion,
    ]
      .filter(Boolean)
      .join("\n");
    const markedFallback = markedReviewCommentBody(number, fallback);
    if (Buffer.byteLength(markedFallback, "utf8") <= DURABLE_REVIEW_COMMENT_MAX_BYTES) {
      return markedFallback;
    }
    const minimalFallback = markedReviewCommentBody(
      number,
      [
        "Codex review: publication failed closed.",
        "",
        "**Blocked by review publication failure.**",
        "",
        `<!-- clawsweeper-verdict:needs-human item=${number}${exactHead ? ` sha=${exactHead}` : ""} -->`,
        blockedState,
        boundedVersion,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (Buffer.byteLength(minimalFallback, "utf8") <= DURABLE_REVIEW_COMMENT_MAX_BYTES) {
      return minimalFallback;
    }
    throw new Error(`bounded durable review fallback for #${number} exceeds the publication limit`);
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
      ? oversizedReviewCommentFallback(number, markedBody, bodyBytes, existing)
      : markedBody;
    const id = commentId(existing);
    if (id !== null && identitylessPublicationFallback(number, existing)) {
      const leaseCommentId = Number(
        durableReviewVersionFromBody(markedBody, number)?.leaseCommentId,
      );
      if (!Number.isSafeInteger(leaseCommentId) || leaseCommentId <= id) {
        throw new Error(
          `durable review comment ${id} is a fail-closed publication fallback; a fresh review lease is required before replacement`,
        );
      }
    }
    const identitylessFallback =
      oversized && durableReviewVersionFromBody(publicationBody, number) === null;
    // Identity-less fallbacks need a new server id so later review leases can
    // prove causal supersession without comparing client and server clocks.
    const patchTargetId =
      !identitylessFallback && id !== null && canPatchReviewComment(existing) ? id : null;
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
