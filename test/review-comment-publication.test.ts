import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReviewCommentLeases } from "../dist/clawsweeper-review-comment-leases.js";
import {
  createReviewCommentPublication,
  DurableReviewPublicationBlockedError,
} from "../dist/clawsweeper-review-comment-publication.js";
import { createReviewCommentAutomation } from "../dist/clawsweeper-review-comment-automation.js";
import { createReviewCommentState } from "../dist/clawsweeper-review-comment-state.js";

const itemNumber = 120232;
const headSha = "522ac4a03828a827c5c266194459d995b9982ff9";
const reviewMarker = `<!-- clawsweeper-review item=${itemNumber} -->`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function markedReviewBody(body: string): string {
  return body.includes(reviewMarker) ? body : `${body.trimEnd()}\n\n${reviewMarker}`;
}

function durableReviewComment(options: {
  id: number;
  reviewedAt: string;
  updatedAt: string;
  leaseCommentId?: number;
  state?: "ready" | "blocked" | "needs-changes";
  author?: string;
}): Record<string, unknown> {
  const state = options.state ?? "ready";
  return {
    id: options.id,
    created_at: options.updatedAt,
    updated_at: options.updatedAt,
    user: { login: options.author ?? "clawsweeper[bot]" },
    body: [
      "Codex review: durable state fixture.",
      "",
      `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} confidence=high updated_at=${options.updatedAt} reviewed_at=${options.reviewedAt} -->`,
      `<!-- clawsweeper-review-state:${state} item=${itemNumber} sha=${headSha} v=1 -->`,
      `<!-- clawsweeper-review-version item=${itemNumber} reviewed_at=${options.reviewedAt} sha=${headSha} source_revision=${"a".repeat(64)} lease_owner=fixture lease_comment_id=${options.leaseCommentId ?? options.id} v=1 -->`,
      reviewMarker,
    ].join("\n\n"),
  };
}

function reviewCommentState(comments: () => Record<string, unknown>[]) {
  return createReviewCommentState({
    targetRepo: () => "openclaw/openclaw",
    ghPaged: comments,
    reviewCommentBodyDigest: sha256,
    asRecord: (value: unknown) => value as Record<string, unknown>,
    parseGitHubItemRef: () => ({ repo: "openclaw/openclaw", kind: "pull_request", number: 1 }),
    frontMatterValue: () => undefined,
    timestampMs: (value: string | undefined) => {
      const parsed = Date.parse(value ?? "");
      return Number.isFinite(parsed) ? parsed : null;
    },
    linkedPullRequestRefsFromText: () => [],
    linkedPullRequestSignalContextsFromText: () => [],
    reviewCommentMarker: () => reviewMarker,
    pullHeadShaFromContext: () => headSha,
    pullHeadShaFromReport: () => headSha,
    reviewLeaseRevisionFromReport: () => headSha,
    markerAttributeValue: (value: string) => value,
  } as never);
}

function reviewCommentPublication(options: {
  root: string;
  comments: () => Record<string, unknown>[];
  state: ReturnType<typeof reviewCommentState>;
  mutate: (options: { args: string[] }) => string;
}) {
  return createReviewCommentPublication({
    root: options.root,
    targetRepo: () => "openclaw/openclaw",
    ghObservedMutationCommand: options.mutate,
    sha256,
    ghPaged: options.comments,
    reviewCommentBodyDigest: sha256,
    asRecord: (value: unknown) => value as Record<string, unknown>,
    ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
    frontMatterValue: () => undefined,
    replaceFrontMatterValue: (markdown: string) => markdown,
    sectionValue: () => "",
    timestampMs: (value: string | undefined) => {
      const parsed = Date.parse(value ?? "");
      return Number.isFinite(parsed) ? parsed : null;
    },
    sentence: (value: string) => value,
    normalizedLabelSet: () => new Set<string>(),
    sectionLineValue: () => undefined,
    markdownLink: (label: string) => label,
    closeAppliedCommentMarker: () => "",
    ...options.state,
  } as never);
}

test("review version timestamps round-trip through the durable parser", () => {
  const fields: Record<string, string> = {
    type: "pull_request",
    number: String(itemNumber),
    reviewed_at: "2026-08-08T20:00:00+02:00",
    item_source_revision: "a".repeat(64),
    review_lease_owner: "fixture",
    review_lease_comment_id: "20",
  };
  const automation = createReviewCommentAutomation({
    frontMatterValue: (_markdown: string, key: string) => fields[key],
    pullHeadShaFromReport: () => headSha,
    markerAttributeValue: (value: string) => value.trim().replace(/[^\w./:@-]/g, "_") || "unknown",
    timestampMs: (value: string | undefined) => {
      const parsed = Date.parse(value ?? "");
      return Number.isFinite(parsed) ? parsed : null;
    },
  } as never);
  const versionMarker = automation.reviewVersionMarkerFromReport("report");
  const comment = {
    id: 20,
    user: { login: "clawsweeper[bot]" },
    body: [versionMarker, reviewMarker].join("\n\n"),
  };
  const parsed = reviewCommentState(() => []).durableReviewVersion(comment, itemNumber);

  assert.match(versionMarker, /\breviewed_at=2026-08-08T18:00:00\.000Z\b/);
  assert.ok(parsed);
  assert.equal(parsed.reviewedAt, "2026-08-08T18:00:00.000Z");
  assert.equal(Date.parse(parsed.reviewedAt), Date.parse(fields.reviewed_at));
});

test("oversized durable review publication replaces same-head ready state and aborts", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-publication-"));
  try {
    const existing = durableReviewComment({
      id: 20,
      reviewedAt: "2026-08-07T16:00:00Z",
      updatedAt: "2026-08-07T16:01:00Z",
    });
    const state = reviewCommentState(() => []);
    let publishedBody = "";
    const publication = createReviewCommentPublication({
      root,
      targetRepo: () => "openclaw/openclaw",
      ghObservedMutationCommand: ({ args }: { args: string[] }) => {
        const input = args[args.indexOf("--input") + 1];
        assert.ok(input);
        publishedBody = JSON.parse(readFileSync(input, "utf8")).body;
        return JSON.stringify({
          ...existing,
          updated_at: "2026-08-07T16:02:00Z",
          body: publishedBody,
        });
      },
      sha256,
      ghPaged: () => [],
      reviewCommentBodyDigest: sha256,
      asRecord: (value: unknown) => value as Record<string, unknown>,
      ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
      frontMatterValue: () => undefined,
      replaceFrontMatterValue: (markdown: string) => markdown,
      sectionValue: () => "",
      timestampMs: (value: string | undefined) => {
        const parsed = Date.parse(value ?? "");
        return Number.isFinite(parsed) ? parsed : null;
      },
      sentence: (value: string) => value,
      normalizedLabelSet: () => new Set<string>(),
      sectionLineValue: () => undefined,
      markdownLink: (label: string) => label,
      closeAppliedCommentMarker: () => "",
      ...state,
      markedReviewCommentBody: (_number: number, body: string) => markedReviewBody(body),
      issueReviewComment: () => existing,
      issueReviewCommentWithBody: () => undefined,
      commentUpdatedAt: () => "2026-08-07T16:02:00Z",
      commentId: (comment: Record<string, unknown> | undefined) =>
        typeof comment?.id === "number" ? comment.id : null,
      commentUrl: () => `https://github.com/openclaw/openclaw/pull/${itemNumber}#issuecomment-20`,
      commentBodyMatches: (comment: Record<string, unknown> | undefined, body: string) =>
        comment?.body === body,
      canPatchReviewComment: () => true,
    } as never);

    const oversized = [
      "Codex review: ready for maintainer look.",
      "",
      "x".repeat(70_000),
      "",
      `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} confidence=high updated_at=2026-08-07T16:01:00Z reviewed_at=2026-08-07T16:00:00Z diagnostic=${"y".repeat(70_000)} -->`,
      `<!-- clawsweeper-review-state:ready item=${itemNumber} sha=${headSha} v=1 -->`,
      `<!-- clawsweeper-review-version item=${itemNumber} reviewed_at=2026-08-07T16:00:00Z sha=${headSha} source_revision=${"a".repeat(64)} lease_owner=${"z".repeat(70_000)} lease_comment_id=20 v=1 -->`,
      reviewMarker,
    ].join("\n\n");

    let publicationError: unknown;
    try {
      publication.upsertReviewComment(itemNumber, oversized, existing);
    } catch (error) {
      publicationError = error;
    }
    assert.ok(publicationError instanceof DurableReviewPublicationBlockedError);
    assert.match(publicationError.message, /published a blocked fallback and stopped apply/);
    assert.equal(publicationError.syncedComment.id, 20);
    assert.ok(Buffer.byteLength(publishedBody, "utf8") <= 60 * 1024);
    assert.match(publishedBody, /Codex review: publication failed closed\./);
    assert.match(publishedBody, /## Before merge[\s\S]*- \[ \]/);
    assert.match(
      publishedBody,
      new RegExp(`<!-- clawsweeper-review-state:blocked item=${itemNumber} sha=${headSha} v=1 -->`),
    );
    assert.doesNotMatch(publishedBody, /clawsweeper-review-state:ready/);
    assert.doesNotMatch(publishedBody, /y{100}|z{100}/);
    assert.equal((publishedBody.match(/<!-- clawsweeper-review-state:/g) ?? []).length, 1);
    assert.equal((publishedBody.match(/<!-- clawsweeper-review-version\b/g) ?? []).length, 1);
    assert.ok(publishedBody.trimEnd().endsWith(reviewMarker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed oversized fallback reuses only same-head identity and outranks older ready state", () => {
  const invalidVersionMarkers = [
    "",
    `<!-- clawsweeper-review-version item=${itemNumber} reviewed_at=2026-08-07T14:00:00Z sha=${"b".repeat(40)} v=1 -->`,
  ];
  for (const invalidVersionMarker of invalidVersionMarkers) {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-publication-ordering-"));
    try {
      const older = durableReviewComment({
        id: 10,
        reviewedAt: "2026-08-07T15:00:00Z",
        updatedAt: "2026-08-07T15:01:00Z",
      });
      const current = durableReviewComment({
        id: 20,
        reviewedAt: "2026-08-07T16:00:00Z",
        updatedAt: "2026-08-07T16:01:00Z",
      });
      let published = current;
      let comments = [older, current];
      const state = reviewCommentState(() => comments);
      const publication = reviewCommentPublication({
        root,
        comments: () => comments,
        state,
        mutate: ({ args }) => {
          const input = args[args.indexOf("--input") + 1];
          assert.ok(input);
          const body = JSON.parse(readFileSync(input, "utf8")).body;
          published = {
            ...current,
            updated_at: "2026-08-08T00:01:00Z",
            body,
          };
          comments = [older, published];
          return JSON.stringify(published);
        },
      });
      const oversized = [
        "Codex review: ready for maintainer look.",
        "",
        "x".repeat(70_000),
        "",
        `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} confidence=high reviewed_at=unknown -->`,
        invalidVersionMarker,
        reviewMarker,
      ]
        .filter(Boolean)
        .join("\n\n");

      assert.throws(
        () => publication.upsertReviewComment(itemNumber, oversized, current),
        DurableReviewPublicationBlockedError,
      );
      const version = state.durableReviewVersion(published, itemNumber);
      assert.ok(version);
      assert.equal(version.headSha, headSha);
      assert.equal(version.reviewedAt, "2026-08-07T16:00:00Z");
      assert.match(String(published.body), /clawsweeper-review-state:blocked/);
      assert.doesNotMatch(String(published.body), /clawsweeper-review-state:ready/);
      assert.equal(state.selectIssueReviewComment(itemNumber, comments)?.id, 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("identity-less blocked fallback vetoes older ready duplicates until a fresh review", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-publication-veto-"));
  try {
    const selected = {
      id: 20,
      created_at: "2026-08-07T16:00:00Z",
      updated_at: "2026-08-07T16:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: ["Codex review: incomplete durable state.", reviewMarker].join("\n\n"),
    };
    const olderReady = durableReviewComment({
      id: 10,
      reviewedAt: "2026-08-07T15:00:00Z",
      updatedAt: "2026-08-07T15:01:00Z",
    });
    let published = selected;
    let comments = [selected];
    const mutationArgs: string[][] = [];
    const state = reviewCommentState(() => comments);
    const publication = reviewCommentPublication({
      root,
      comments: () => comments,
      state,
      mutate: ({ args }) => {
        mutationArgs.push(args);
        const input = args[args.indexOf("--input") + 1];
        assert.ok(input);
        published = {
          ...selected,
          id: 100,
          updated_at: "2026-08-07T16:02:00Z",
          body: JSON.parse(readFileSync(input, "utf8")).body,
        };
        comments = [olderReady, published];
        return JSON.stringify(published);
      },
    });
    const oversized = [
      "Codex review: ready for maintainer look.",
      "",
      "x".repeat(70_000),
      "",
      `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} reviewed_at=unknown -->`,
      reviewMarker,
    ].join("\n\n");

    assert.throws(
      () => publication.upsertReviewComment(itemNumber, oversized, selected),
      DurableReviewPublicationBlockedError,
    );
    assert.equal(state.durableReviewVersion(published, itemNumber), null);
    assert.doesNotMatch(String(published.body), /clawsweeper-review-state:/);
    assert.match(String(published.body), /Codex review: publication failed closed\./);
    assert.match(mutationArgs[0]?.[1] ?? "", /issues\/120232\/comments$/);
    assert.equal(state.selectIssueReviewComment(itemNumber, comments)?.id, 100);

    const staleButEdited = durableReviewComment({
      id: 110,
      reviewedAt: "2026-08-07T15:30:00Z",
      updatedAt: "2026-08-07T16:03:00Z",
      leaseCommentId: 90,
    });
    comments = [olderReady, published, staleButEdited];
    assert.equal(state.selectIssueReviewComment(itemNumber, comments)?.id, 100);
    assert.throws(
      () => publication.upsertReviewComment(itemNumber, String(staleButEdited.body), published),
      /fresh review lease is required/,
    );
    assert.equal(mutationArgs.length, 1);

    const freshReady = durableReviewComment({
      id: 120,
      reviewedAt: "2026-08-07T16:04:00Z",
      updatedAt: "2026-08-07T16:05:00Z",
      leaseCommentId: 120,
    });
    comments.push(freshReady);
    assert.equal(state.selectIssueReviewComment(itemNumber, comments)?.id, 120);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("newest exact durable comment wins over older trusted duplicates", () => {
  const older = durableReviewComment({
    id: 10,
    reviewedAt: "2026-08-07T15:00:00Z",
    updatedAt: "2026-08-07T16:10:00Z",
  });
  const newer = durableReviewComment({
    id: 20,
    reviewedAt: "2026-08-07T16:00:00Z",
    updatedAt: "2026-08-07T16:05:00Z",
    state: "blocked",
  });
  const untrusted = durableReviewComment({
    id: 30,
    reviewedAt: "2026-08-07T17:00:00Z",
    updatedAt: "2026-08-07T17:00:00Z",
    author: "reviewer",
  });
  const comments = [older, untrusted, newer];
  const state = createReviewCommentState({
    targetRepo: () => "openclaw/openclaw",
    ghPaged: () => [],
    reviewCommentBodyDigest: sha256,
    asRecord: (value: unknown) => value as Record<string, unknown>,
    parseGitHubItemRef: () => ({ repo: "openclaw/openclaw", kind: "pull_request", number: 1 }),
    frontMatterValue: () => undefined,
    timestampMs: (value: string | undefined) => {
      const parsed = Date.parse(value ?? "");
      return Number.isFinite(parsed) ? parsed : null;
    },
    linkedPullRequestRefsFromText: () => [],
    linkedPullRequestSignalContextsFromText: () => [],
    reviewCommentMarker: () => reviewMarker,
    pullHeadShaFromContext: () => headSha,
    pullHeadShaFromReport: () => headSha,
    reviewLeaseRevisionFromReport: () => headSha,
    markerAttributeValue: (value: string) => value,
  } as never);

  assert.equal(state.selectIssueReviewComment(itemNumber, comments)?.id, 20);
});

test("lease election includes active legacy leases on non-canonical durable duplicates", () => {
  const nowMs = Date.parse("2026-08-08T00:05:00Z");
  const canonical = durableReviewComment({
    id: 20,
    reviewedAt: "2026-08-08T00:02:00Z",
    updatedAt: "2026-08-08T00:02:00Z",
  });
  const activeLegacy = durableReviewComment({
    id: 10,
    reviewedAt: "2026-08-08T00:01:00Z",
    updatedAt: "2026-08-08T00:01:00Z",
  });
  activeLegacy.body = String(activeLegacy.body).replace(
    reviewMarker,
    [
      `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=2026-08-08T00:00:00Z lease_expires_at=2026-08-08T00:10:00Z owner=legacy-worker v=1 -->`,
      reviewMarker,
    ].join("\n\n"),
  );
  const untrustedLegacy = {
    ...activeLegacy,
    id: 5,
    user: { login: "reviewer" },
  };
  const state = reviewCommentState(() => [untrustedLegacy, activeLegacy, canonical]);
  const snapshot = state.issueReviewCommentState(itemNumber);

  assert.equal(snapshot.reviewComment?.id, 20);
  assert.deepEqual(
    snapshot.leaseComments.map((comment) => comment.id),
    [10],
  );

  const leases = createReviewCommentLeases({
    ...state,
    targetRepo: () => "openclaw/openclaw",
    gitHubRuntimeBudgetError: class extends Error {},
  } as never);
  assert.equal(
    leases.reviewStartLeaseWinnerCommentIdForTest({
      comments: snapshot.leaseComments,
      itemNumber,
      headSha,
      nowMs,
    }),
    10,
  );
});

test("mutation fallback verifies trusted comment identity", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-publication-recovery-"));
  try {
    const publishedBody = String(
      durableReviewComment({
        id: 99,
        reviewedAt: "2026-08-07T17:00:00Z",
        updatedAt: "2026-08-07T17:01:00Z",
        state: "needs-changes",
      }).body,
    );
    const older = durableReviewComment({
      id: 10,
      reviewedAt: "2026-08-07T15:00:00Z",
      updatedAt: "2026-08-07T16:10:00Z",
    });
    const selected = durableReviewComment({
      id: 20,
      reviewedAt: "2026-08-07T16:00:00Z",
      updatedAt: "2026-08-07T16:20:00Z",
      state: "blocked",
    });
    const contributor = durableReviewComment({
      id: 30,
      reviewedAt: "2026-08-07T17:00:00Z",
      updatedAt: "2026-08-07T16:30:00Z",
      author: "reviewer",
    });
    const initialComments = [older, contributor, selected];

    const patchFallbackComments = [
      { ...older, body: publishedBody },
      selected,
      { ...contributor, body: publishedBody },
    ];
    const patchState = reviewCommentState(() => patchFallbackComments);
    const selectedComment = patchState.selectIssueReviewComment(itemNumber, initialComments);
    assert.equal(selectedComment?.id, 20);
    const patchCalls: string[][] = [];
    const patchPublication = reviewCommentPublication({
      root,
      comments: () => patchFallbackComments,
      state: patchState,
      mutate: ({ args }) => {
        patchCalls.push(args);
        return "";
      },
    });
    assert.throws(
      () => patchPublication.upsertReviewComment(itemNumber, publishedBody, selectedComment),
      /did not verify target comment 20/,
    );
    assert.match(patchCalls[0]?.[1] ?? "", /issues\/comments\/20$/);

    const staleResponseCalls: string[][] = [];
    const staleResponsePublication = reviewCommentPublication({
      root,
      comments: () => initialComments,
      state: patchState,
      mutate: ({ args }) => {
        staleResponseCalls.push(args);
        return JSON.stringify(selected);
      },
    });
    assert.throws(
      () =>
        staleResponsePublication.upsertReviewComment(itemNumber, publishedBody, selectedComment),
      /did not verify target comment 20/,
    );
    assert.match(staleResponseCalls[0]?.[1] ?? "", /issues\/comments\/20$/);

    const postRecoveryComments = [
      { ...older, body: publishedBody },
      { ...selected, body: publishedBody },
      { ...contributor, body: publishedBody },
    ];
    const postState = reviewCommentState(() => postRecoveryComments);
    const postCalls: string[][] = [];
    const postPublication = reviewCommentPublication({
      root,
      comments: () => postRecoveryComments,
      state: postState,
      mutate: ({ args }) => {
        postCalls.push(args);
        return "";
      },
    });
    const recovered = postPublication.upsertReviewComment(itemNumber, publishedBody, contributor);
    assert.equal(recovered.id, 20);
    assert.match(postCalls[0]?.[1] ?? "", /issues\/120232\/comments$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
