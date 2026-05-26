export type SupersessionProofModelDecision = "superseded" | "keep_open";

export interface SupersessionProofModelResult {
  sourceSummary: string;
  replacementSummary: string;
  coveredWork: string[];
  uniqueSourceWork: string[];
  securityBlocked: boolean;
  decision: SupersessionProofModelDecision;
  reason: string;
}

export interface SupersessionProofCloseDecision {
  close: boolean;
  reason: string;
  proof: SupersessionProofModelResult;
}

export interface SupersessionProofViewInput {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  body?: unknown;
  labels?: unknown;
  headSha?: unknown;
  headRefOid?: unknown;
  updatedAt?: unknown;
  changedFiles?: unknown;
  filePaths?: readonly string[];
  files?: readonly unknown[];
  filesHydrated?: unknown;
  filesTruncated?: unknown;
  comments?: readonly unknown[];
  commentsTruncated?: unknown;
  reviews?: readonly unknown[];
  reviewsTruncated?: unknown;
  reviewComments?: readonly unknown[];
  reviewCommentsTruncated?: unknown;
}

const SUPERSESSION_PROOF_DECISIONS = new Set<SupersessionProofModelDecision>([
  "superseded",
  "keep_open",
]);

const SUPERSESSION_PROOF_SCHEMA_KEYS = new Set([
  "sourceSummary",
  "replacementSummary",
  "coveredWork",
  "uniqueSourceWork",
  "securityBlocked",
  "decision",
  "reason",
]);

const PROOF_PATCH_EXCERPT_LIMIT = 1600;
const PROOF_COMMENT_EXCERPT_LIMIT = 800;
const PROOF_FILE_CONTEXT_LIMIT = 80;
const PROOF_COMMENT_CONTEXT_LIMIT = 40;

export function proofBodyExcerpt(value: unknown, limit = 200): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function compactSupersessionFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .flatMap((entry) => [
          stringValue(recordValue(entry, "path")),
          stringValue(recordValue(entry, "filename")),
          stringValue(recordValue(entry, "previous_filename")),
        ])
        .filter(Boolean),
    ),
  ].sort();
}

export function compactSupersessionFiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      dropUndefinedValues({
        path:
          stringValue(recordValue(entry, "path")) || stringValue(recordValue(entry, "filename")),
        previousPath:
          stringValue(recordValue(entry, "previousPath")) ||
          stringValue(recordValue(entry, "previous_filename")),
        status:
          stringValue(recordValue(entry, "status")) ||
          stringValue(recordValue(entry, "changeType")),
        additions: finiteNumber(recordValue(entry, "additions")),
        deletions: finiteNumber(recordValue(entry, "deletions")),
        changes: finiteNumber(recordValue(entry, "changes")),
        patchExcerpt: proofBodyExcerpt(recordValue(entry, "patch"), PROOF_PATCH_EXCERPT_LIMIT),
      }),
    )
    .filter((entry) => Object.keys(entry).length > 0)
    .slice(0, PROOF_FILE_CONTEXT_LIMIT);
}

export function compactSupersessionComments(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      dropUndefinedValues({
        author:
          stringValue(recordValue(entry, "author")) ||
          stringValue(recordValue(recordValue(entry, "user"), "login")),
        authorAssociation: stringValue(recordValue(entry, "authorAssociation")),
        url: stringValue(recordValue(entry, "url")) || stringValue(recordValue(entry, "html_url")),
        createdAt:
          stringValue(recordValue(entry, "createdAt")) ||
          stringValue(recordValue(entry, "created_at")),
        updatedAt:
          stringValue(recordValue(entry, "updatedAt")) ||
          stringValue(recordValue(entry, "updated_at")),
        bodyExcerpt: proofBodyExcerpt(recordValue(entry, "body"), PROOF_COMMENT_EXCERPT_LIMIT),
      }),
    )
    .filter((entry) => Object.keys(entry).length > 0)
    .slice(0, PROOF_COMMENT_CONTEXT_LIMIT);
}

export function compactSupersessionReviews(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      dropUndefinedValues({
        author:
          stringValue(recordValue(entry, "author")) ||
          stringValue(recordValue(recordValue(entry, "user"), "login")),
        authorAssociation:
          stringValue(recordValue(entry, "authorAssociation")) ||
          stringValue(recordValue(entry, "author_association")),
        state: stringValue(recordValue(entry, "state")),
        url: stringValue(recordValue(entry, "url")) || stringValue(recordValue(entry, "html_url")),
        submittedAt:
          stringValue(recordValue(entry, "submittedAt")) ||
          stringValue(recordValue(entry, "submitted_at")),
        createdAt:
          stringValue(recordValue(entry, "createdAt")) ||
          stringValue(recordValue(entry, "created_at")),
        updatedAt:
          stringValue(recordValue(entry, "updatedAt")) ||
          stringValue(recordValue(entry, "updated_at")),
        bodyExcerpt: proofBodyExcerpt(recordValue(entry, "body"), PROOF_COMMENT_EXCERPT_LIMIT),
      }),
    )
    .filter((entry) => Object.keys(entry).length > 0)
    .slice(0, PROOF_COMMENT_CONTEXT_LIMIT);
}

export function supersessionProofViewContextTruncated(input: SupersessionProofViewInput): boolean {
  return (
    proofEntriesTruncated(input.files, PROOF_FILE_CONTEXT_LIMIT, [
      { key: "patch", limit: PROOF_PATCH_EXCERPT_LIMIT },
    ]) ||
    proofEntriesTruncated(input.comments, PROOF_COMMENT_CONTEXT_LIMIT, [
      { key: "body", limit: PROOF_COMMENT_EXCERPT_LIMIT },
    ]) ||
    input.commentsTruncated === true ||
    proofEntriesTruncated(input.reviews, PROOF_COMMENT_CONTEXT_LIMIT, [
      { key: "body", limit: PROOF_COMMENT_EXCERPT_LIMIT },
    ]) ||
    input.reviewsTruncated === true ||
    proofEntriesTruncated(input.reviewComments, PROOF_COMMENT_CONTEXT_LIMIT, [
      { key: "body", limit: PROOF_COMMENT_EXCERPT_LIMIT },
    ]) ||
    input.reviewCommentsTruncated === true
  );
}

export function compactSupersessionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .flatMap((entry) => [
          stringValue(entry),
          stringValue(recordValue(entry, "name")),
          stringValue(recordValue(entry, "label")),
          stringValue(recordValue(entry, "value")),
        ])
        .filter(Boolean),
    ),
  ].sort();
}

export function compactSupersessionProofView(
  input: SupersessionProofViewInput,
): Record<string, unknown> {
  const fileContext = compactSupersessionFiles(input.files);
  return dropUndefinedValues({
    number: finiteNumber(input.number),
    title: stringValue(input.title),
    url: stringValue(input.url),
    state: stringValue(input.state),
    mergedAt: stringValue(input.mergedAt) || null,
    bodyExcerpt: proofBodyExcerpt(input.body),
    labels: compactSupersessionLabels(input.labels),
    headSha: nullableString(input.headSha),
    headRefOid: nullableString(input.headRefOid),
    updatedAt: nullableString(input.updatedAt),
    changedFiles: finiteNumber(input.changedFiles) ?? input.filePaths?.length ?? fileContext.length,
    filePaths: [...(input.filePaths ?? [])],
    fileContext,
    filesHydrated: finiteNumber(input.filesHydrated),
    filesTruncated: booleanOrUndefined(input.filesTruncated),
    comments: compactSupersessionComments(input.comments),
    commentsTruncated: booleanOrUndefined(input.commentsTruncated),
    reviews: compactSupersessionReviews(input.reviews),
    reviewsTruncated: booleanOrUndefined(input.reviewsTruncated),
    reviewComments: compactSupersessionComments(input.reviewComments),
    reviewCommentsTruncated: booleanOrUndefined(input.reviewCommentsTruncated),
  });
}

export function parseSupersessionProofModelResult(value: unknown): SupersessionProofModelResult {
  const parsed = requireRecord(value, "supersessionProof");
  rejectUnexpectedKeys(parsed, SUPERSESSION_PROOF_SCHEMA_KEYS, "supersessionProof");
  return {
    sourceSummary: requireString(parsed.sourceSummary, "supersessionProof.sourceSummary"),
    replacementSummary: requireString(
      parsed.replacementSummary,
      "supersessionProof.replacementSummary",
    ),
    coveredWork: requireStringArray(parsed.coveredWork, "supersessionProof.coveredWork"),
    uniqueSourceWork: requireStringArray(
      parsed.uniqueSourceWork,
      "supersessionProof.uniqueSourceWork",
    ),
    securityBlocked: requireBoolean(parsed.securityBlocked, "supersessionProof.securityBlocked"),
    decision: requireEnum(
      parsed.decision,
      SUPERSESSION_PROOF_DECISIONS,
      "supersessionProof.decision",
    ),
    reason: requireString(parsed.reason, "supersessionProof.reason"),
  };
}

export function normalizedSupersessionProofModelResult(
  proof: SupersessionProofModelResult,
): SupersessionProofModelResult {
  const normalizedProof = {
    ...proof,
    sourceSummary: proof.sourceSummary.trim(),
    replacementSummary: proof.replacementSummary.trim(),
    coveredWork: proof.coveredWork.map((entry) => entry.trim()).filter(Boolean),
    uniqueSourceWork: proof.uniqueSourceWork.map((entry) => entry.trim()).filter(Boolean),
    reason: proof.reason.trim(),
  };
  if (normalizedProof.decision !== "superseded") return normalizedProof;
  if (supersessionProofHasConcreteCloseEvidence(normalizedProof)) return normalizedProof;
  return {
    ...normalizedProof,
    decision: "keep_open",
    reason: `model supersession proof was incomplete: ${
      normalizedProof.reason || "missing concrete coverage proof"
    }`,
  };
}

export function supersessionProofCloseDecision(
  proof: SupersessionProofModelResult,
): SupersessionProofCloseDecision {
  const normalized = normalizedSupersessionProofModelResult(proof);
  return {
    close: normalized.decision === "superseded",
    reason: normalized.reason || "replacement closeout proof was incomplete",
    proof: normalized,
  };
}

function supersessionProofHasConcreteCloseEvidence(proof: SupersessionProofModelResult): boolean {
  return (
    proof.sourceSummary.trim().length > 0 &&
    proof.replacementSummary.trim().length > 0 &&
    proof.coveredWork.length > 0 &&
    proof.uniqueSourceWork.length === 0 &&
    proof.reason.trim().length > 0
  );
}

function dropUndefinedValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Exclude<unknown, undefined>] => {
      const [, entryValue] = entry;
      return entryValue !== undefined;
    }),
  );
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return stringValue(value) || null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function proofEntriesTruncated(
  entries: readonly unknown[] | undefined,
  entryLimit: number,
  textLimits: ReadonlyArray<{ key: string; limit: number }>,
): boolean {
  if (!entries) return false;
  if (entries.length > entryLimit) return true;
  return entries.some((entry) =>
    textLimits.some(({ key, limit }) => proofTextWasTruncated(recordValue(entry, key), limit)),
  );
}

function proofTextWasTruncated(value: unknown, limit: number): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > limit;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new Error(`${path} had unexpected keys: ${unexpected.join(", ")}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...value];
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${path} must be one of: ${[...allowed].join(", ")}`);
  }
  return value as T;
}
