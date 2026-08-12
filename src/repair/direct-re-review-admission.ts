export type DirectReReviewOrigin = "hosted_webhook" | "comment_router";

export type DirectReReviewDecision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  sourceAction: "re_review";
  supersedesInProgress: false;
  sourceDeliveryId: string;
  sourceCommentId: number;
  sourceCommentUpdatedAt: string;
  commandBodyDigest: string;
  commandOrigin: DirectReReviewOrigin;
  sourceCommentVerified?: boolean;
  commandStatusMarker: string;
  additionalPrompt: string;
  statusCommentId?: number;
  sourceHeadSha?: string;
  sourceUpdatedAt?: string;
  sourceHeadVerified?: boolean;
  sourceAuthoritySeq?: number;
};

export type DirectReReviewIntake = {
  protocolVersion: 1;
  commandVersionId: string;
  installationId: number;
  sourceCommentId: number;
  sourceCommentUpdatedAt: string;
  commandBodyDigest: string;
  commandOrigin: DirectReReviewOrigin;
  decision: Omit<
    DirectReReviewDecision,
    "sourceHeadVerified" | "sourceAuthoritySeq" | "sourceUpdatedAt" | "sourceCommentVerified"
  >;
};

type CoordinatedDirectReReviewIntake = Omit<DirectReReviewIntake, "decision"> & {
  decision: DirectReReviewDecision;
};

export type AuthorityReservationResult =
  | { kind: "reserved"; sourceAuthoritySeq: number }
  | { kind: "already_completed" }
  | { kind: "rejected"; reason: string };

export type AuthorityCompletionResult =
  | { kind: "completed" }
  | { kind: "missing" }
  | { kind: "conflict"; reason: string };

export type ExactReviewEnqueueResult =
  | { kind: "queued"; itemKey: string; deduped: boolean }
  | { kind: "rejected"; reason: string };

export type DirectReReviewCoordinatorResult =
  | {
      kind: "completed";
      decision: DirectReReviewDecision;
      statusCommentId: number | null;
    }
  | { kind: "retry"; reason: "head_changed" | "dependency_unavailable" }
  | { kind: "rejected"; reason: string };

export type DirectReReviewCoordinatorAdapter = {
  readPullRequest: () => Promise<{ headSha: string; updatedAt?: string }>;
  reserveAuthority: (decision: DirectReReviewDecision) => Promise<AuthorityReservationResult>;
  completeAuthority: (
    sourceAuthoritySeq: number,
    disposition: "enqueued" | "mismatch",
  ) => Promise<AuthorityCompletionResult>;
  enqueue: (decision: DirectReReviewDecision) => Promise<ExactReviewEnqueueResult>;
  convergeAcknowledgement: (decision: DirectReReviewDecision) => Promise<number | null>;
  addReaction: () => Promise<void>;
};

export function reReviewCommandVersionIdentity(options: {
  commentId: number;
  updatedAt: string;
  bodySha256: string;
}) {
  const timestamp = Date.parse(options.updatedAt);
  const digest = options.bodySha256.trim().toLowerCase();
  if (
    !Number.isSafeInteger(options.commentId) ||
    options.commentId < 1 ||
    !Number.isFinite(timestamp) ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    throw new Error("exact re-review command version is invalid");
  }
  return `command-${options.commentId}-${timestamp.toString(36)}-${digest}`;
}

export function directReReviewIntake(options: {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  installationId: number;
  sourceCommentId: number;
  sourceCommentUpdatedAt: string;
  commandBodyDigest: string;
  commandOrigin: DirectReReviewOrigin;
  additionalPrompt: string;
  statusCommentId?: number;
  candidateHeadSha?: string;
}): DirectReReviewIntake {
  const commandVersionId = reReviewCommandVersionIdentity({
    commentId: options.sourceCommentId,
    updatedAt: options.sourceCommentUpdatedAt,
    bodySha256: options.commandBodyDigest,
  });
  if (!Number.isSafeInteger(options.installationId) || options.installationId < 1) {
    throw new Error("exact re-review installation is invalid");
  }
  const decision: DirectReReviewDecision = {
    targetRepo: options.targetRepo,
    targetBranch: options.targetBranch,
    itemNumber: options.itemNumber,
    itemKind: options.itemKind,
    sourceEvent: options.itemKind === "pull_request" ? "pull_request" : "issues",
    sourceAction: "re_review",
    supersedesInProgress: false,
    sourceDeliveryId: commandVersionId,
    sourceCommentId: options.sourceCommentId,
    sourceCommentUpdatedAt: options.sourceCommentUpdatedAt,
    commandBodyDigest: options.commandBodyDigest,
    commandOrigin: options.commandOrigin,
    commandStatusMarker: directReReviewStatusMarker(options.itemNumber, commandVersionId),
    additionalPrompt: options.additionalPrompt.slice(0, 5_000),
    ...(options.statusCommentId ? { statusCommentId: options.statusCommentId } : {}),
    ...(options.candidateHeadSha ? { sourceHeadSha: options.candidateHeadSha } : {}),
  };
  return {
    protocolVersion: 1,
    commandVersionId,
    installationId: options.installationId,
    sourceCommentId: options.sourceCommentId,
    sourceCommentUpdatedAt: options.sourceCommentUpdatedAt,
    commandBodyDigest: options.commandBodyDigest,
    commandOrigin: options.commandOrigin,
    decision,
  };
}

export function validateDirectReReviewIntake(value: unknown): DirectReReviewIntake | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intake = value as Partial<DirectReReviewIntake>;
  const decision = intake.decision as Partial<DirectReReviewDecision> | undefined;
  if (
    intake.protocolVersion !== 1 ||
    !decision ||
    !Number.isSafeInteger(intake.installationId) ||
    Number(intake.installationId) < 1 ||
    !Number.isSafeInteger(intake.sourceCommentId) ||
    Number(intake.sourceCommentId) < 1 ||
    !Number.isFinite(Date.parse(String(intake.sourceCommentUpdatedAt || ""))) ||
    !/^[0-9a-f]{64}$/.test(String(intake.commandBodyDigest || "")) ||
    (intake.commandOrigin !== "hosted_webhook" && intake.commandOrigin !== "comment_router") ||
    typeof intake.commandVersionId !== "string" ||
    intake.commandVersionId !==
      reReviewCommandVersionIdentity({
        commentId: Number(intake.sourceCommentId),
        updatedAt: String(intake.sourceCommentUpdatedAt),
        bodySha256: String(intake.commandBodyDigest),
      }) ||
    decision.sourceDeliveryId !== intake.commandVersionId ||
    decision.sourceCommentId !== intake.sourceCommentId ||
    decision.sourceCommentUpdatedAt !== intake.sourceCommentUpdatedAt ||
    decision.commandBodyDigest !== intake.commandBodyDigest ||
    decision.commandOrigin !== intake.commandOrigin ||
    typeof decision.targetRepo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(decision.targetRepo) ||
    typeof decision.targetBranch !== "string" ||
    !/^[A-Za-z0-9_./-]+$/.test(decision.targetBranch) ||
    !Number.isSafeInteger(decision.itemNumber) ||
    Number(decision.itemNumber) < 1 ||
    (decision.itemKind !== "issue" && decision.itemKind !== "pull_request") ||
    decision.sourceEvent !== (decision.itemKind === "pull_request" ? "pull_request" : "issues") ||
    decision.sourceAction !== "re_review" ||
    decision.supersedesInProgress !== false ||
    decision.commandStatusMarker !==
      directReReviewStatusMarker(Number(decision.itemNumber), intake.commandVersionId) ||
    typeof decision.additionalPrompt !== "string" ||
    decision.additionalPrompt.length > 5_000 ||
    Object.hasOwn(decision, "sourceHeadVerified") ||
    Object.hasOwn(decision, "sourceAuthoritySeq") ||
    Object.hasOwn(decision, "sourceUpdatedAt") ||
    Object.hasOwn(decision, "sourceCommentVerified")
  ) {
    return null;
  }
  return intake as DirectReReviewIntake;
}

export async function coordinateDirectReReview(
  intake: CoordinatedDirectReReviewIntake,
  adapter: DirectReReviewCoordinatorAdapter,
): Promise<DirectReReviewCoordinatorResult> {
  let decision: DirectReReviewDecision = intake.decision;
  let sourceAuthoritySeq: number | null = null;
  if (decision.itemKind === "pull_request") {
    let pull: { headSha: string; updatedAt?: string };
    try {
      pull = await adapter.readPullRequest();
    } catch {
      return { kind: "retry", reason: "dependency_unavailable" };
    }
    const headSha = pull.headSha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      return { kind: "rejected", reason: "live pull request head is invalid" };
    }
    decision = {
      ...decision,
      sourceHeadSha: headSha,
      sourceHeadVerified: true,
      ...(pull.updatedAt ? { sourceUpdatedAt: pull.updatedAt } : {}),
    };
    const reservation = await adapter.reserveAuthority(decision);
    if (reservation.kind === "rejected") return reservation;
    if (reservation.kind === "reserved") {
      sourceAuthoritySeq = reservation.sourceAuthoritySeq;
      decision = { ...decision, sourceAuthoritySeq };
    }
  }

  const queued = await adapter.enqueue(decision);
  if (queued.kind === "rejected") {
    if (sourceAuthoritySeq !== null) {
      const latest = await adapter.readPullRequest().catch(() => null);
      const latestHead = latest?.headSha.trim().toLowerCase();
      if (!latest || !/^[0-9a-f]{40}$/.test(latestHead || "")) {
        return { kind: "retry", reason: "dependency_unavailable" };
      }
      const changed = latestHead !== decision.sourceHeadSha;
      await adapter.completeAuthority(sourceAuthoritySeq, "mismatch");
      if (changed) return { kind: "retry", reason: "head_changed" };
    }
    return queued;
  }
  if (sourceAuthoritySeq !== null) {
    const completion = await adapter.completeAuthority(sourceAuthoritySeq, "enqueued");
    if (completion.kind === "conflict") return { kind: "rejected", reason: completion.reason };
  }

  const [statusCommentId] = await Promise.all([
    adapter.convergeAcknowledgement(decision),
    adapter.addReaction(),
  ]);
  return { kind: "completed", decision, statusCommentId };
}

export function planClawSweeperAcknowledgementConvergence(
  comments: Array<{ id?: unknown; body?: unknown; created_at?: unknown }>,
  statusMarker: string,
) {
  const sourceMarker = String(
    comments.find((comment) => String(comment.body || "").includes(statusMarker))?.body || "",
  ).match(/<!--\s*clawsweeper-command-ack:\d+\s*-->/i)?.[0];
  const byId = new Map<number, (typeof comments)[number]>();
  for (const comment of comments) {
    const id = Number(comment.id);
    if (Number.isSafeInteger(id) && id > 0) byId.set(id, comment);
  }
  const requested = [...byId.values()]
    .filter((comment) => String(comment.body ?? "").includes(statusMarker))
    .sort(compareAcknowledgements);
  const keepId = Number(requested[0]?.id) || null;
  const prunableIds = [...byId.values()]
    .filter((comment) => {
      const body = String(comment.body ?? "");
      if (body.includes(statusMarker)) return Number(comment.id) !== keepId;
      return Boolean(
        sourceMarker &&
        body.includes(sourceMarker) &&
        !body.includes("clawsweeper-command-status:"),
      );
    })
    .map((comment) => Number(comment.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return { keepId, prunableIds };
}

function compareAcknowledgements(
  left: { id?: unknown; created_at?: unknown },
  right: { id?: unknown; created_at?: unknown },
) {
  return (
    String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")) ||
    Number(left.id) - Number(right.id)
  );
}

function directReReviewStatusMarker(itemNumber: number, commandVersionId: string) {
  if (
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1 ||
    !/^command-[a-z0-9-]{1,100}$/.test(commandVersionId)
  ) {
    throw new Error("exact re-review command status marker is invalid");
  }
  return `<!-- clawsweeper-command-status:${itemNumber}:re_review:${commandVersionId} -->`;
}
