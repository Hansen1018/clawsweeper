import crypto from "node:crypto";

export const GITCRAWL_QUERY_VERSION = "gitcrawl-evidence-v1";
export const GITCRAWL_QUERY_CONTRACT_VERSION = "gitcrawl-query-safety-v3";
export const GITCRAWL_CLAIM_VERSION = "gitcrawl-evidence-claim-v1";
export const GITCRAWL_PACKET_VERSION_V1 = "gitcrawl-evidence-packet-v1";
export const GITCRAWL_PACKET_VERSION = "gitcrawl-evidence-packet-v2";
export const GITCRAWL_PROVIDER_CURSOR_MAX_LENGTH = 8 * 1024;
export const GITCRAWL_CANONICAL_JSON_MAX_DEPTH = 64;

export const GITCRAWL_QUERY_NAMES = [
  "gitcrawl.clusters.list",
  "gitcrawl.clusters.members",
  "gitcrawl.clusters.related",
  "gitcrawl.pull_requests.review_context",
  "gitcrawl.coverage",
  "gitcrawl.threads.search",
] as const;

const GITCRAWL_EVIDENCE_RELATION_PREDICATES = [
  "member_of",
  "related_to",
  "evidence_for",
  "describes",
] as const;

export const GITCRAWL_DATASETS = [
  "repositories",
  "threads",
  "thread_revisions",
  "thread_fingerprints",
  "thread_key_summaries",
  "cluster_groups",
  "cluster_memberships",
  "pull_request_details",
  "pull_request_files",
] as const;

export type GitcrawlDataset = (typeof GITCRAWL_DATASETS)[number];

export type GitcrawlQueryName = (typeof GITCRAWL_QUERY_NAMES)[number];

export type GitcrawlProvider = "local" | "cloud" | "parity";

export const GITCRAWL_QUERY_COVERAGE: Record<GitcrawlQueryName, readonly GitcrawlDataset[]> = {
  "gitcrawl.coverage": ["repositories", "threads"],
  "gitcrawl.clusters.list": ["repositories", "threads", "cluster_groups", "cluster_memberships"],
  "gitcrawl.clusters.members": ["repositories", "threads", "cluster_groups", "cluster_memberships"],
  "gitcrawl.clusters.related": ["repositories", "threads", "cluster_groups", "cluster_memberships"],
  "gitcrawl.pull_requests.review_context": [
    "repositories",
    "threads",
    "pull_request_details",
    "pull_request_files",
  ],
  "gitcrawl.threads.search": ["repositories", "threads"],
};

export type GitcrawlQueryStats = {
  contract_version: typeof GITCRAWL_QUERY_CONTRACT_VERSION;
  repository: string;
  archive: string;
  snapshot_id: string;
  source_sync_at: string;
  dataset_generated_at: string;
  coverage_complete: boolean;
  next_cursor: string;
};

export type GitcrawlSnapshotProvenance = {
  id: string;
  source_sha256: string;
  schema_name: string;
  schema_version: number;
  schema_hash: string;
  capabilities: string[];
  source_sync_at: string;
  dataset_generated_at: string;
  coverage_complete: boolean;
  published_at: string;
  cutover_at: string;
};

export type GitcrawlQueryEnvelope = {
  columns?: string[];
  rows?: unknown[][];
  values: Record<string, unknown>[];
  snapshot: GitcrawlSnapshotProvenance;
  stats: GitcrawlQueryStats;
};

export type GitcrawlQueryRequest = {
  name: GitcrawlQueryName;
  args: Record<string, unknown>;
  limit: number;
  cursor: string;
  snapshot_id: string;
};

export interface GitcrawlQuerySource {
  readonly provider: "local" | "cloud";
  readonly legacy: boolean;
  query(request: GitcrawlQueryRequest): Promise<GitcrawlQueryEnvelope>;
  close(): Promise<void>;
}

export type GitcrawlCoverageRow = {
  dataset: GitcrawlDataset;
  row_count: number;
  eligible_count: number;
  covered_count: number;
  max_source_at: string;
  dataset_generated_at: string;
  complete: boolean;
};

export type GitcrawlSourceRevision = {
  id?: number;
  sha256?: string;
  updated_at?: string;
};

export type GitcrawlThreadFingerprint = {
  algorithm: string;
  sha256: string;
};

export type GitcrawlEvidenceRelation = {
  predicate: "member_of" | "related_to" | "evidence_for" | "describes";
  target: string;
};

export type GitcrawlEvidenceClaim<T = Record<string, unknown>> = {
  version: typeof GITCRAWL_CLAIM_VERSION;
  provider: GitcrawlProvider;
  repository: string;
  snapshot_id: string;
  parity_snapshot_id?: string;
  query: {
    name: GitcrawlQueryName;
    version: typeof GITCRAWL_QUERY_VERSION;
    args_sha256: string;
  };
  subject: string;
  source_revision?: GitcrawlSourceRevision;
  thread_fingerprint?: GitcrawlThreadFingerprint;
  relations: GitcrawlEvidenceRelation[];
  data: T;
  semantic_sha256: string;
  sha256: string;
};

export type GitcrawlEvidenceResult<T> = {
  rows: T[];
  claims: GitcrawlEvidenceClaim<T>[];
};

export function createGitcrawlEvidenceClaim<T>(input: {
  provider: GitcrawlProvider;
  repository: string;
  snapshotId: string;
  paritySnapshotId?: string;
  queryName: GitcrawlQueryName;
  queryArgs?: Record<string, unknown>;
  queryArgsSha256?: string;
  subject: string;
  sourceRevision?: GitcrawlSourceRevision;
  threadFingerprint?: GitcrawlThreadFingerprint;
  relations?: GitcrawlEvidenceRelation[];
  data: T;
}): GitcrawlEvidenceClaim<T> {
  if (!["local", "cloud", "parity"].includes(input.provider)) {
    throw new Error(`unsupported Gitcrawl provider: ${input.provider}`);
  }
  assertGitcrawlRepository(input.repository);
  assertSnapshotId(input.snapshotId);
  if (input.provider === "parity") {
    if (input.paritySnapshotId === undefined) {
      throw new Error("Gitcrawl parity claim is missing its local snapshot");
    }
    assertSnapshotId(input.paritySnapshotId);
  } else if (input.paritySnapshotId !== undefined) {
    throw new Error("Gitcrawl non-parity claim has a parity snapshot");
  }
  assertNoGitcrawlHtmlCommentMarkers(input.subject, "Gitcrawl claim subject");
  assertNoGitcrawlHtmlCommentMarkers(input.relations ?? [], "Gitcrawl claim relations");
  assertNoGitcrawlHtmlCommentMarkers(input.data, "Gitcrawl claim data");
  if (!GITCRAWL_QUERY_NAMES.includes(input.queryName)) {
    throw new Error(`unsupported Gitcrawl query: ${input.queryName}`);
  }
  if ((input.queryArgs === undefined) === (input.queryArgsSha256 === undefined)) {
    throw new Error("Gitcrawl claim query arguments must have exactly one digest source");
  }
  assertNoGitcrawlHtmlCommentMarkers(input.queryArgs ?? {}, "Gitcrawl claim query arguments");
  const queryArgsSha256 =
    input.queryArgs === undefined ? input.queryArgsSha256 : sha256Canonical(input.queryArgs);
  assertSha256(queryArgsSha256!, "claim query arguments sha256");
  const query: GitcrawlEvidenceClaim["query"] = {
    name: input.queryName,
    version: GITCRAWL_QUERY_VERSION,
    args_sha256: queryArgsSha256!,
  };
  if (input.sourceRevision?.sha256 !== undefined) {
    assertSha256(input.sourceRevision.sha256, "source revision sha256");
  }
  if (input.threadFingerprint !== undefined) {
    if (!input.threadFingerprint.algorithm.trim()) {
      throw new Error("thread fingerprint algorithm is required");
    }
    assertSha256(input.threadFingerprint.sha256, "thread fingerprint sha256");
  }
  for (const relation of input.relations ?? []) {
    if (!GITCRAWL_EVIDENCE_RELATION_PREDICATES.includes(relation.predicate)) {
      throw new Error(`unsupported Gitcrawl evidence relation: ${relation.predicate}`);
    }
    if (
      typeof relation.target !== "string" ||
      !relation.target ||
      relation.target !== relation.target.trim() ||
      Buffer.byteLength(relation.target, "utf8") > 2_048 ||
      [...relation.target].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      throw new Error("Gitcrawl evidence relation target is missing or malformed");
    }
  }
  const relations = [...(input.relations ?? [])]
    .map((relation) => ({ ...relation }))
    .sort((left, right) =>
      compareCanonicalText(
        `${left.predicate}:${left.target}`,
        `${right.predicate}:${right.target}`,
      ),
    );
  const semanticPayload = {
    repository: input.repository,
    query,
    subject: input.subject,
    data: input.data,
  };
  const unsigned = {
    version: GITCRAWL_CLAIM_VERSION,
    provider: input.provider,
    repository: input.repository,
    snapshot_id: input.snapshotId,
    ...(input.paritySnapshotId === undefined ? {} : { parity_snapshot_id: input.paritySnapshotId }),
    query,
    subject: input.subject,
    ...(input.sourceRevision === undefined ? {} : { source_revision: input.sourceRevision }),
    ...(input.threadFingerprint === undefined
      ? {}
      : { thread_fingerprint: input.threadFingerprint }),
    relations,
    data: input.data,
    semantic_sha256: sha256Canonical(semanticPayload),
  } satisfies Omit<GitcrawlEvidenceClaim<T>, "sha256">;
  return {
    ...unsigned,
    sha256: sha256Canonical(unsigned),
  };
}

export function verifyGitcrawlEvidenceClaim(claim: GitcrawlEvidenceClaim): void {
  assertExactObjectKeys(
    claim,
    [
      "version",
      "provider",
      "repository",
      "snapshot_id",
      "parity_snapshot_id",
      "query",
      "subject",
      "source_revision",
      "thread_fingerprint",
      "relations",
      "data",
      "semantic_sha256",
      "sha256",
    ],
    "Gitcrawl evidence claim",
  );
  assertExactObjectKeys(
    claim.query,
    ["name", "version", "args_sha256"],
    "Gitcrawl evidence claim query",
  );
  if (claim.source_revision !== undefined) {
    assertExactObjectKeys(
      claim.source_revision,
      ["id", "sha256", "updated_at"],
      "Gitcrawl evidence claim source revision",
    );
  }
  if (claim.thread_fingerprint !== undefined) {
    assertExactObjectKeys(
      claim.thread_fingerprint,
      ["algorithm", "sha256"],
      "Gitcrawl evidence claim thread fingerprint",
    );
  }
  if (!Array.isArray(claim.relations)) {
    throw new Error("Gitcrawl evidence claim relations must be an array");
  }
  for (const relation of claim.relations) {
    assertExactObjectKeys(relation, ["predicate", "target"], "Gitcrawl evidence claim relation");
  }
  assertSha256(claim.semantic_sha256, "claim semantic sha256");
  assertSha256(claim.sha256, "claim sha256");
  const expected = createGitcrawlEvidenceClaim({
    provider: claim.provider,
    repository: claim.repository,
    snapshotId: claim.snapshot_id,
    ...(claim.parity_snapshot_id === undefined
      ? {}
      : { paritySnapshotId: claim.parity_snapshot_id }),
    queryName: claim.query.name,
    queryArgsSha256: claim.query.args_sha256,
    subject: claim.subject,
    ...(claim.source_revision === undefined ? {} : { sourceRevision: claim.source_revision }),
    ...(claim.thread_fingerprint === undefined
      ? {}
      : { threadFingerprint: claim.thread_fingerprint }),
    relations: claim.relations,
    data: claim.data,
  });
  if (claim.query.version !== GITCRAWL_QUERY_VERSION) {
    throw new Error(`unsupported Gitcrawl query version: ${claim.query.version}`);
  }
  if (claim.version !== GITCRAWL_CLAIM_VERSION) {
    throw new Error(`unsupported Gitcrawl claim version: ${claim.version}`);
  }
  if (claim.semantic_sha256 !== expected.semantic_sha256 || claim.sha256 !== expected.sha256) {
    throw new Error(`Gitcrawl evidence claim digest mismatch for ${claim.subject}`);
  }
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function gitcrawlQueryDigest(
  name: GitcrawlQueryName,
  args: Record<string, unknown>,
): string {
  return sha256Canonical({ name, args });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase hexadecimal SHA-256 digest`);
  }
}

export function assertSnapshotId(value: string): void {
  if (
    !value.trim() ||
    value.length > 256 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("Gitcrawl snapshot id is missing or malformed");
  }
}

export function assertGitcrawlRepository(value: string): void {
  if (typeof value !== "string" || value !== value.trim() || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new Error("Gitcrawl repository is missing or malformed");
  }
}

export function assertNoGitcrawlHtmlCommentMarkers(value: unknown, label: string): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes("<!--") || current.includes("-->")) {
        throw new Error(`${label} contains quarantined HTML comment content`);
      }
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) pending.push(...current);
    else {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        pending.push(key, child);
      }
    }
  }
}

export function assertGitcrawlProviderCursor(
  value: string,
  label: string,
  allowEmpty = true,
): void {
  if (
    (!allowEmpty && value === "") ||
    value.length > GITCRAWL_PROVIDER_CURSOR_MAX_LENGTH ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`${label} is malformed`);
  }
}

export function parseRfc3339Timestamp(value: string, label: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) throw new Error(`${label} is invalid`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zoneHour, zoneMinute] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zoneHour === undefined ? 0 : Number(zoneHour);
  const offsetMinute = zoneMinute === undefined ? 0 : Number(zoneMinute);
  const daysInMonth =
    month < 1 || month > 12
      ? 0
      : month === 2
        ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
          ? 29
          : 28
        : [4, 6, 9, 11].includes(month)
          ? 30
          : 31;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error(`${label} is invalid`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`);
  return timestamp;
}

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactObjectKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field ${unknown.sort(compareCanonicalText)[0]}`);
  }
}

function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > GITCRAWL_CANONICAL_JSON_MAX_DEPTH) {
    throw new Error(
      `canonical JSON exceeds ${GITCRAWL_CANONICAL_JSON_MAX_DEPTH} levels of nesting`,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => canonicalValue(child, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, child]) => [key, canonicalValue(child, depth + 1)]),
    );
  }
  throw new Error(`canonical JSON rejects ${typeof value} values`);
}
