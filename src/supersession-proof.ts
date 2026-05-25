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
  filePaths?: readonly string[];
  filesHydrated?: unknown;
  filesTruncated?: unknown;
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

export function proofBodyExcerpt(value: unknown, limit = 200): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function compactSupersessionFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((entry) => stringValue(recordValue(entry, "path"))).filter(Boolean)),
  ].sort();
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
    changedFiles: input.filePaths?.length ?? 0,
    filePaths: [...(input.filePaths ?? [])],
    filesHydrated: finiteNumber(input.filesHydrated),
    filesTruncated: booleanOrUndefined(input.filesTruncated),
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
  if (proof.securityBlocked) {
    return {
      ...proof,
      decision: "keep_open",
      reason: proof.reason || "model found source PR security-sensitive context",
    };
  }
  if (proof.decision !== "superseded") return proof;
  if (supersessionProofHasConcreteCloseEvidence(proof)) return proof;
  return {
    ...proof,
    decision: "keep_open",
    reason: `model supersession proof was incomplete: ${
      proof.reason || "missing concrete coverage proof"
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
    proof.reason.trim().length > 0 &&
    !proof.securityBlocked
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
