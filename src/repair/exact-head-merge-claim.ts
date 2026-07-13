import type { LooseRecord } from "./json-types.js";

const CLAIM_PREFIX = "clawsweeper-exact-head-merge-claim:v1";
const RELEASE_PREFIX = "clawsweeper-exact-head-merge-release:v1";
const CLAIM_PATTERN =
  /<!-- clawsweeper-exact-head-merge-claim:v1 repo=([^ ]+) pr=([1-9][0-9]*) head=([a-fA-F0-9]{40}) method=([a-z]+) owner=([a-z0-9_-]+) claimant=([^ ]+) -->/g;
const RELEASE_PATTERN =
  /<!-- clawsweeper-exact-head-merge-release:v1 claim=([1-9][0-9]*) repo=([^ ]+) pr=([1-9][0-9]*) head=([a-fA-F0-9]{40}) method=([a-z]+) owner=([a-z0-9_-]+) claimant=([^ ]+) -->/g;

export type ExactHeadMergeClaimIdentity = {
  repository: string;
  number: number;
  headSha: string;
  method: "squash";
};

export type ExactHeadMergeClaimRequest = ExactHeadMergeClaimIdentity & {
  owner: string;
  claimant: string;
  appId: number;
  appSlug: string;
};

export type ExactHeadMergeClaimResult =
  | { status: "acquired"; reason: ""; claimId: number }
  | { status: "existing"; reason: string; claimId: number }
  | { status: "blocked" | "unknown"; reason: string; claimId: null };

export type ExactHeadMergeClaimInspection =
  | { status: "absent"; reason: ""; claimId: null }
  | {
      status: "released";
      reason: "prior exact-head merge claim was explicitly released";
      claimId: null;
    }
  | Exclude<ExactHeadMergeClaimResult, { status: "acquired" }>;

export type ExactHeadMergeClaimReleaseResult =
  | { status: "released"; reason: ""; claimId: number }
  | { status: "blocked" | "unknown"; reason: string; claimId: number };

type ParsedClaim = ExactHeadMergeClaimIdentity & {
  owner: string;
  claimant: string;
};

type ParsedRelease = ParsedClaim & {
  claimId: number;
};

type TrustedClaim = {
  comment: LooseRecord;
  id: number;
  claim: ParsedClaim;
};

type TrustedRelease = {
  comment: LooseRecord;
  id: number;
  release: ParsedRelease;
};

type InspectedClaims = {
  claims: TrustedClaim[];
  exact: TrustedClaim[];
  exactHistory: boolean;
  releases: TrustedRelease[];
};

export function exactHeadMergeClaimant(
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalizedOwner = normalizeOwner(owner);
  const runId = String(env.GITHUB_RUN_ID ?? "").trim();
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error("workflow identity is invalid for the exact-head merge claim");
  }
  return `${normalizedOwner}:${runId}:${runAttempt}`;
}

export function exactHeadMergeClaimIdentity(
  request: ExactHeadMergeClaimIdentity,
): ExactHeadMergeClaimIdentity {
  return normalizeIdentity(request);
}

export function exactHeadMergeClaimBody(request: ExactHeadMergeClaimRequest): string {
  const normalized = normalizeRequest(request);
  return [
    exactHeadMergeClaimMarker(normalized),
    `ClawSweeper reserved the exact-head squash merge request for \`${normalized.headSha.slice(0, 12)}\`. Later workflow attempts will only reconcile GitHub state unless this reservation is explicitly released before dispatch.`,
  ].join("\n");
}

export function exactHeadMergeClaimReleaseBody(
  request: ExactHeadMergeClaimRequest,
  claimId: number,
): string {
  const normalized = normalizeRequest(request);
  const normalizedClaimId = normalizeCommentId(claimId, "claim");
  return [
    exactHeadMergeReleaseMarker(normalized, normalizedClaimId),
    `ClawSweeper released the unused exact-head squash merge reservation for \`${normalized.headSha.slice(0, 12)}\`. No merge request was dispatched under claim ${normalizedClaimId}.`,
  ].join("\n");
}

export function isTrustedExactHeadMergeClaimComment(
  comment: LooseRecord,
  request: ExactHeadMergeClaimRequest,
): boolean {
  const normalized = normalizeRequest(request);
  if (!trustedClaimAuthor(comment, normalized)) return false;
  const body = String(comment.body ?? "");
  const claims = parseClaimMarkers(body);
  return (
    markerCount(body, CLAIM_PREFIX) === 1 &&
    markerCount(body, RELEASE_PREFIX) === 0 &&
    claims.length === 1 &&
    sameClaim(claims[0]!, normalized) &&
    claims[0]!.owner === normalized.owner &&
    claims[0]!.claimant === normalized.claimant
  );
}

export function isTrustedExactHeadMergeClaimReleaseComment(
  comment: LooseRecord,
  request: ExactHeadMergeClaimRequest,
  claimId: number,
): boolean {
  const normalized = normalizeRequest(request);
  const normalizedClaimId = normalizeCommentId(claimId, "claim");
  if (!trustedClaimAuthor(comment, normalized)) return false;
  const body = String(comment.body ?? "");
  const releases = parseReleaseMarkers(body);
  return (
    markerCount(body, CLAIM_PREFIX) === 0 &&
    markerCount(body, RELEASE_PREFIX) === 1 &&
    releases.length === 1 &&
    releases[0]!.claimId === normalizedClaimId &&
    sameClaim(releases[0]!, normalized) &&
    releases[0]!.owner === normalized.owner &&
    releases[0]!.claimant === normalized.claimant
  );
}

export function ensureExactHeadMergeClaim(
  request: ExactHeadMergeClaimRequest,
  io: {
    listComments: () => LooseRecord[];
    createComment: (body: string) => LooseRecord;
  },
): ExactHeadMergeClaimResult {
  const normalized = normalizeRequest(request);
  const marker = exactHeadMergeClaimMarker(normalized);
  const initial = inspectExactHeadMergeClaim(normalized, io.listComments);
  if (
    initial.status === "existing" ||
    initial.status === "blocked" ||
    initial.status === "unknown"
  ) {
    return initial;
  }

  let createError = "";
  try {
    io.createComment(exactHeadMergeClaimBody(normalized));
  } catch (error) {
    createError = errorText(error);
  }

  const confirmed = inspectClaims(normalized, io.listComments);
  if ("failure" in confirmed) return confirmed.failure;
  if (confirmed.value.exact.length === 0) {
    return {
      status: "unknown",
      reason: `exact-head merge claim outcome could not be confirmed${createError ? `: ${createError}` : ""}`,
      claimId: null,
    };
  }

  const ownClaims = confirmed.value.exact.filter((claim) =>
    String(claim.comment.body ?? "").includes(marker),
  );
  const winningClaim = confirmed.value.exact[0]!;
  if (ownClaims.some((claim) => claim.id === winningClaim.id)) {
    return { status: "acquired", reason: "", claimId: winningClaim.id };
  }
  return {
    status: "existing",
    reason: "another verified workflow owns the exact-head merge claim; reconciliation only",
    claimId: winningClaim.id,
  };
}

export function releaseExactHeadMergeClaim(
  request: ExactHeadMergeClaimRequest,
  claimId: number,
  io: {
    listComments: () => LooseRecord[];
    createComment: (body: string) => LooseRecord;
  },
): ExactHeadMergeClaimReleaseResult {
  const normalized = normalizeRequest(request);
  const normalizedClaimId = normalizeCommentId(claimId, "claim");
  const initial = inspectClaims(normalized, io.listComments);
  if ("failure" in initial) {
    return {
      status: initial.failure.status,
      reason: initial.failure.reason,
      claimId: normalizedClaimId,
    };
  }
  const active = initial.value.exact[0];
  if (!active) {
    const referenced = initial.value.claims.find(
      (claim) =>
        claim.id === normalizedClaimId &&
        sameClaim(claim.claim, normalized) &&
        claim.claim.owner === normalized.owner &&
        claim.claim.claimant === normalized.claimant,
    );
    const released = initial.value.releases.some(
      (release) =>
        release.release.claimId === normalizedClaimId &&
        sameClaim(release.release, normalized) &&
        release.release.owner === normalized.owner &&
        release.release.claimant === normalized.claimant,
    );
    if (referenced && released) {
      return { status: "released", reason: "", claimId: normalizedClaimId };
    }
    return {
      status: "blocked",
      reason: "exact-head merge claim is not active and has no matching release",
      claimId: normalizedClaimId,
    };
  }
  if (active.id !== normalizedClaimId) {
    return {
      status: "blocked",
      reason: "exact-head merge claim ownership changed before release",
      claimId: normalizedClaimId,
    };
  }

  let createError = "";
  try {
    io.createComment(exactHeadMergeClaimReleaseBody(normalized, normalizedClaimId));
  } catch (error) {
    createError = errorText(error);
  }

  const confirmed = inspectClaims(normalized, io.listComments);
  if ("failure" in confirmed) {
    return {
      status: confirmed.failure.status,
      reason: confirmed.failure.reason,
      claimId: normalizedClaimId,
    };
  }
  if (
    confirmed.value.releases.some(
      (release) =>
        release.release.claimId === normalizedClaimId &&
        sameClaim(release.release, normalized) &&
        release.release.owner === normalized.owner &&
        release.release.claimant === normalized.claimant,
    )
  ) {
    return { status: "released", reason: "", claimId: normalizedClaimId };
  }
  return {
    status: "unknown",
    reason: `exact-head merge claim release could not be confirmed${createError ? `: ${createError}` : ""}`,
    claimId: normalizedClaimId,
  };
}

export function inspectExactHeadMergeClaim(
  request: ExactHeadMergeClaimRequest,
  listComments: () => LooseRecord[],
): ExactHeadMergeClaimInspection {
  const normalized = normalizeRequest(request);
  const inspected = inspectClaims(normalized, listComments);
  if ("failure" in inspected) return inspected.failure;
  if (inspected.value.exact.length > 0) {
    return {
      status: "existing",
      reason: "exact-head merge request is durably claimed; reconciliation only",
      claimId: inspected.value.exact[0]!.id,
    };
  }
  if (inspected.value.exactHistory) {
    return {
      status: "released",
      reason: "prior exact-head merge claim was explicitly released",
      claimId: null,
    };
  }
  return { status: "absent", reason: "", claimId: null };
}

function inspectClaims(
  request: ExactHeadMergeClaimRequest,
  listComments: () => LooseRecord[],
):
  | { value: InspectedClaims }
  | { failure: Extract<ExactHeadMergeClaimResult, { status: "blocked" | "unknown" }> } {
  let comments: LooseRecord[];
  try {
    comments = listComments();
  } catch (error) {
    return {
      failure: {
        status: "unknown",
        reason: `exact-head merge claim state could not be read: ${errorText(error)}`,
        claimId: null,
      },
    };
  }
  if (!Array.isArray(comments)) {
    return {
      failure: {
        status: "unknown",
        reason: "exact-head merge claim comments response is invalid",
        claimId: null,
      },
    };
  }

  const claims: TrustedClaim[] = [];
  const releases: TrustedRelease[] = [];
  for (const comment of comments) {
    if (!trustedClaimAuthor(comment, request)) continue;
    const body = String(comment.body ?? "");
    const claimCount = markerCount(body, CLAIM_PREFIX);
    const releaseCount = markerCount(body, RELEASE_PREFIX);
    if (claimCount === 0 && releaseCount === 0) continue;
    if (claimCount > 1 || releaseCount > 1 || (claimCount === 1 && releaseCount === 1)) {
      return malformedMarkerFailure();
    }
    const id = commentId(comment);
    if (!id) {
      return {
        failure: {
          status: "blocked",
          reason: "trusted exact-head merge claim state is missing an immutable comment id",
          claimId: null,
        },
      };
    }
    if (claimCount === 1) {
      const markers = parseClaimMarkers(body);
      if (markers.length !== 1) return malformedMarkerFailure();
      const claim = markers[0]!;
      if (!sameClaimScope(claim, request)) return conflictingScopeFailure(claim);
      claims.push({ comment, id, claim });
      continue;
    }
    const markers = parseReleaseMarkers(body);
    if (markers.length !== 1) return malformedMarkerFailure();
    const release = markers[0]!;
    if (!sameClaimScope(release, request)) return conflictingScopeFailure(release);
    releases.push({ comment, id, release });
  }

  claims.sort((left, right) => left.id - right.id);
  releases.sort((left, right) => left.id - right.id);
  for (const release of releases) {
    const referenced = claims.find(
      (claim) =>
        claim.id === release.release.claimId &&
        sameClaim(claim.claim, release.release) &&
        claim.claim.owner === release.release.owner &&
        claim.claim.claimant === release.release.claimant,
    );
    if (!referenced || release.id <= referenced.id) {
      return {
        failure: {
          status: "blocked",
          reason: "trusted exact-head merge claim release does not match a prior claim",
          claimId: null,
        },
      };
    }
  }

  const exactClaims = claims.filter((claim) => sameClaim(claim.claim, request));
  const exact = exactClaims.filter(
    (claim) =>
      !releases.some((release) => sameClaim(release.release, claim.claim) && release.id > claim.id),
  );
  return {
    value: {
      claims,
      exact,
      exactHistory: exactClaims.length > 0,
      releases,
    },
  };
}

function malformedMarkerFailure(): {
  failure: { status: "blocked"; reason: string; claimId: null };
} {
  return {
    failure: {
      status: "blocked",
      reason: "trusted exact-head merge claim marker is malformed, mixed, or duplicated",
      claimId: null,
    },
  };
}

function conflictingScopeFailure(claim: ExactHeadMergeClaimIdentity): {
  failure: { status: "blocked"; reason: string; claimId: null };
} {
  return {
    failure: {
      status: "blocked",
      reason: `conflicting durable merge claim exists for ${claim.repository}#${claim.number}`,
      claimId: null,
    },
  };
}

function exactHeadMergeClaimMarker(request: ExactHeadMergeClaimRequest): string {
  return `<!-- ${CLAIM_PREFIX} repo=${encodeURIComponent(request.repository)} pr=${request.number} head=${request.headSha} method=${request.method} owner=${request.owner} claimant=${encodeURIComponent(request.claimant)} -->`;
}

function exactHeadMergeReleaseMarker(request: ExactHeadMergeClaimRequest, claimId: number): string {
  return `<!-- ${RELEASE_PREFIX} claim=${claimId} repo=${encodeURIComponent(request.repository)} pr=${request.number} head=${request.headSha} method=${request.method} owner=${request.owner} claimant=${encodeURIComponent(request.claimant)} -->`;
}

function parseClaimMarkers(body: string): ParsedClaim[] {
  const claims: ParsedClaim[] = [];
  for (const match of body.matchAll(CLAIM_PATTERN)) {
    try {
      claims.push({
        repository: normalizeRepository(decodeURIComponent(match[1]!)),
        number: normalizeNumber(Number(match[2])),
        headSha: normalizeHeadSha(match[3]!),
        method: normalizeMethod(match[4]!),
        owner: normalizeOwner(match[5]!),
        claimant: normalizeClaimant(decodeURIComponent(match[6]!)),
      });
    } catch {
      return [];
    }
  }
  return claims;
}

function parseReleaseMarkers(body: string): ParsedRelease[] {
  const releases: ParsedRelease[] = [];
  for (const match of body.matchAll(RELEASE_PATTERN)) {
    try {
      releases.push({
        claimId: normalizeCommentId(Number(match[1]), "claim"),
        repository: normalizeRepository(decodeURIComponent(match[2]!)),
        number: normalizeNumber(Number(match[3])),
        headSha: normalizeHeadSha(match[4]!),
        method: normalizeMethod(match[5]!),
        owner: normalizeOwner(match[6]!),
        claimant: normalizeClaimant(decodeURIComponent(match[7]!)),
      });
    } catch {
      return [];
    }
  }
  return releases;
}

function markerCount(body: string, marker: string): number {
  return body.split(marker).length - 1;
}

function normalizeRequest(request: ExactHeadMergeClaimRequest): ExactHeadMergeClaimRequest {
  const identity = normalizeIdentity(request);
  const appId = Number(request.appId);
  const appSlug = String(request.appSlug ?? "")
    .trim()
    .toLowerCase();
  if (!Number.isSafeInteger(appId) || appId < 1) {
    throw new Error("authenticated GitHub App id is invalid for the exact-head merge claim");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug)) {
    throw new Error("authenticated GitHub App slug is invalid for the exact-head merge claim");
  }
  return {
    ...identity,
    owner: normalizeOwner(request.owner),
    claimant: normalizeClaimant(request.claimant),
    appId,
    appSlug,
  };
}

function normalizeIdentity(request: ExactHeadMergeClaimIdentity): ExactHeadMergeClaimIdentity {
  return {
    repository: normalizeRepository(request.repository),
    number: normalizeNumber(request.number),
    headSha: normalizeHeadSha(request.headSha),
    method: normalizeMethod(request.method),
  };
}

function normalizeRepository(value: string): string {
  const repository = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository is invalid for the exact-head merge claim");
  }
  return repository;
}

function normalizeNumber(value: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("pull request number is invalid for the exact-head merge claim");
  }
  return number;
}

function normalizeHeadSha(value: string): string {
  const headSha = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    throw new Error("head SHA is invalid for the exact-head merge claim");
  }
  return headSha;
}

function normalizeMethod(value: string): "squash" {
  if (
    String(value ?? "")
      .trim()
      .toLowerCase() !== "squash"
  ) {
    throw new Error("merge method is invalid for the exact-head merge claim");
  }
  return "squash";
}

function normalizeOwner(value: string): string {
  const owner = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(owner)) {
    throw new Error("owner is invalid for the exact-head merge claim");
  }
  return owner;
}

function normalizeClaimant(value: string): string {
  const claimant = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(claimant)) {
    throw new Error("claimant is invalid for the exact-head merge claim");
  }
  return claimant;
}

function trustedClaimAuthor(comment: LooseRecord, request: ExactHeadMergeClaimRequest): boolean {
  const app = comment.performed_via_github_app;
  if (
    !app ||
    Number(app.id) !== request.appId ||
    String(app.slug ?? "")
      .trim()
      .toLowerCase() !== request.appSlug
  ) {
    return false;
  }
  const login = String(comment.user?.login ?? "")
    .trim()
    .toLowerCase();
  return login === `${request.appSlug}[bot]`;
}

function sameClaim(left: ExactHeadMergeClaimIdentity, right: ExactHeadMergeClaimIdentity): boolean {
  return sameClaimScope(left, right) && left.headSha === right.headSha;
}

function sameClaimScope(
  left: ExactHeadMergeClaimIdentity,
  right: ExactHeadMergeClaimIdentity,
): boolean {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.method === right.method
  );
}

function normalizeCommentId(value: number, kind: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`${kind} comment id is invalid for the exact-head merge claim`);
  }
  return id;
}

function commentId(comment: LooseRecord): number | null {
  const id = Number(comment.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
