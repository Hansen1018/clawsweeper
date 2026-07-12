import {
  GITCRAWL_QUERY_CONTRACT_VERSION,
  type GitcrawlQueryEnvelope,
  type GitcrawlQueryRequest,
  type GitcrawlQuerySource,
  assertGitcrawlProviderCursor,
  assertSha256,
  canonicalJson,
  parseRfc3339Timestamp,
} from "./gitcrawl-evidence-contract.js";

const MAX_CLOUD_RESPONSE_BYTES = 512 * 1024;

export type CloudGitcrawlQuerySourceOptions = {
  baseUrl: string;
  archive: string;
  repository: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class CloudGitcrawlQuerySource implements GitcrawlQuerySource {
  readonly provider = "cloud";
  readonly legacy = false;

  private readonly baseUrl: string;
  private readonly archive: string;
  private readonly repository: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CloudGitcrawlQuerySourceOptions) {
    const baseUrl = parseCloudUrl(options.baseUrl);
    this.baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.archive = options.archive.trim();
    this.repository = options.repository.trim();
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!this.archive) throw new Error("Gitcrawl cloud archive is required");
    if (!/^[^/]+\/[^/]+$/.test(this.repository)) {
      throw new Error("Gitcrawl cloud repository is required");
    }
    if (!this.token) throw new Error("Gitcrawl cloud bearer token is required");
  }

  async query(request: GitcrawlQueryRequest): Promise<GitcrawlQueryEnvelope> {
    const queryUrl = `${this.baseUrl}/v1/apps/gitcrawl/archives/${encodeURIComponent(this.archive)}/query`;
    const response = await this.fetchImpl(queryUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        repository: this.repository,
        archive: this.archive,
        name: request.name,
        args: request.args,
        limit: request.limit,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.snapshot_id ? { snapshot_id: request.snapshot_id } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    assertResponseOrigin(response, queryUrl, request.name);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Gitcrawl cloud query ${request.name} failed (${response.status}; code=${cloudHttpErrorCode(response.status)})`,
      );
    }
    const text = await readBoundedResponse(response, request.name);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Gitcrawl cloud query ${request.name} returned malformed JSON`);
    }
    return parseCloudEnvelope(body, request.name, this.repository, this.archive);
  }

  async close(): Promise<void> {}
}

function assertResponseOrigin(response: Response, queryUrl: string, queryName: string): void {
  if (response.redirected) {
    throw new Error(`Gitcrawl cloud query ${queryName} refused a redirected response`);
  }
  if (!response.url) return;
  const expected = new URL(queryUrl);
  const actual = new URL(response.url);
  if (actual.protocol !== "https:" || actual.origin !== expected.origin) {
    throw new Error(`Gitcrawl cloud query ${queryName} returned from an unexpected origin`);
  }
}

function parseCloudEnvelope(
  value: unknown,
  queryName: string,
  expectedRepository: string,
  expectedArchive: string,
): GitcrawlQueryEnvelope {
  const body = record(value, `Gitcrawl cloud ${queryName} response`);
  if (!Array.isArray(body.values)) {
    throw new Error(`Gitcrawl cloud ${queryName} response is missing values`);
  }
  const values = body.values.map((row, index) =>
    record(row, `Gitcrawl cloud ${queryName} value ${index}`),
  );
  const columns = optionalStringArray(body.columns, "columns");
  const rows = optionalRows(body.rows);
  if (columns === undefined || rows === undefined) {
    throw new Error(`Gitcrawl cloud ${queryName} response is missing columns or rows`);
  }
  if (columns.length !== new Set(columns).size) {
    throw new Error(`Gitcrawl cloud ${queryName} response has duplicate columns`);
  }
  if (rows.length !== values.length) {
    throw new Error(`Gitcrawl cloud ${queryName} rows/values length mismatch`);
  }
  for (const [index, row] of rows.entries()) {
    if (row.length !== columns.length) {
      throw new Error(`Gitcrawl cloud ${queryName} row ${index} column count mismatch`);
    }
    const projected = Object.fromEntries(
      columns.map((column, columnIndex) => [column, row[columnIndex]]),
    );
    if (canonicalJson(projected) !== canonicalJson(values[index])) {
      throw new Error(`Gitcrawl cloud ${queryName} rows/values parity mismatch at row ${index}`);
    }
  }
  const rawStats = record(body.stats, `Gitcrawl cloud ${queryName} stats`);
  const contractVersion = requiredString(rawStats.contract_version, "contract_version");
  if (contractVersion !== GITCRAWL_QUERY_CONTRACT_VERSION) {
    throw new Error(
      `Gitcrawl cloud query ${queryName} requires safety contract ${GITCRAWL_QUERY_CONTRACT_VERSION}`,
    );
  }
  const repository = requiredString(rawStats.repository, "repository");
  const archive = requiredString(rawStats.archive, "archive");
  if (repository !== expectedRepository || archive !== expectedArchive) {
    throw new Error(`Gitcrawl cloud query ${queryName} returned mismatched source identity`);
  }
  const nextCursor = requiredString(rawStats.next_cursor, "next_cursor", true);
  assertGitcrawlProviderCursor(nextCursor, `Gitcrawl cloud ${queryName} stats next_cursor`);
  const snapshot = parseSnapshotProvenance(body.snapshot, queryName, rawStats);
  const stats: GitcrawlQueryEnvelope["stats"] = {
    contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
    repository,
    archive,
    snapshot_id: requiredString(rawStats.snapshot_id, "snapshot_id"),
    source_sync_at: requiredString(rawStats.source_sync_at, "source_sync_at"),
    dataset_generated_at: requiredString(rawStats.dataset_generated_at, "dataset_generated_at"),
    coverage_complete: requiredBoolean(rawStats.coverage_complete, "coverage_complete"),
    next_cursor: nextCursor,
  };
  return { columns, rows, values, snapshot, stats };
}

function parseSnapshotProvenance(
  value: unknown,
  queryName: string,
  stats: Record<string, unknown>,
): GitcrawlQueryEnvelope["snapshot"] {
  const snapshot = record(value, `Gitcrawl cloud ${queryName} snapshot`);
  const id = requiredSnapshotString(snapshot.id, "id");
  const sourceSha256 = requiredSnapshotString(snapshot.source_sha256, "source_sha256");
  assertSha256(id, "Gitcrawl cloud snapshot id");
  assertSha256(sourceSha256, "Gitcrawl cloud snapshot source sha256");
  if (id !== sourceSha256 || id !== stats.snapshot_id) {
    throw new Error(`Gitcrawl cloud query ${queryName} returned mismatched snapshot provenance`);
  }
  const schemaName = requiredSnapshotString(snapshot.schema_name, "schema_name");
  const schemaVersion = snapshot.schema_version;
  if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) <= 0) {
    throw new Error("Gitcrawl cloud snapshot schema_version must be a positive integer");
  }
  const schemaHash = requiredSnapshotString(snapshot.schema_hash, "schema_hash");
  const capabilities = requiredSnapshotStringArray(snapshot.capabilities, "capabilities");
  if (!capabilities.includes(queryName)) {
    throw new Error(`Gitcrawl cloud snapshot does not declare ${queryName} capability`);
  }
  const sourceSyncAt = requiredSnapshotString(snapshot.source_sync_at, "source_sync_at");
  const datasetGeneratedAt = requiredSnapshotString(
    snapshot.dataset_generated_at,
    "dataset_generated_at",
  );
  const publishedAt = requiredSnapshotString(snapshot.published_at, "published_at");
  const cutoverAt = requiredSnapshotString(snapshot.cutover_at, "cutover_at");
  for (const [timestamp, label] of [
    [sourceSyncAt, "source_sync_at"],
    [datasetGeneratedAt, "dataset_generated_at"],
    [publishedAt, "published_at"],
    [cutoverAt, "cutover_at"],
  ] as const) {
    parseRfc3339Timestamp(timestamp, `Gitcrawl cloud snapshot ${label}`);
  }
  const coverageComplete = requiredBoolean(
    snapshot.coverage_complete,
    "snapshot coverage_complete",
  );
  if (
    sourceSyncAt !== stats.source_sync_at ||
    datasetGeneratedAt !== stats.dataset_generated_at ||
    coverageComplete !== stats.coverage_complete
  ) {
    throw new Error(`Gitcrawl cloud query ${queryName} returned mismatched snapshot metadata`);
  }
  return {
    id,
    source_sha256: sourceSha256,
    schema_name: schemaName,
    schema_version: Number(schemaVersion),
    schema_hash: schemaHash,
    capabilities,
    source_sync_at: sourceSyncAt,
    dataset_generated_at: datasetGeneratedAt,
    coverage_complete: coverageComplete,
    published_at: publishedAt,
    cutover_at: cutoverAt,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Gitcrawl cloud ${label} must be a string array`);
  }
  return value;
}

function optionalRows(value: unknown): unknown[][] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry))) {
    throw new Error("Gitcrawl cloud rows must be arrays");
  }
  return value as unknown[][];
}

function parseCloudUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Gitcrawl cloud URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Gitcrawl cloud URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Gitcrawl cloud URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Gitcrawl cloud URL must not contain a query or fragment");
  }
  return url;
}

async function readBoundedResponse(response: Response, queryName: string): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUD_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLarge(queryName);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CLOUD_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(queryName);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function responseTooLarge(queryName: string): Error {
  return new Error(`Gitcrawl cloud query ${queryName} exceeded ${MAX_CLOUD_RESPONSE_BYTES} bytes`);
}

function cloudHttpErrorCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 408) return "request_timeout";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unexpected_status";
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(
      `Gitcrawl cloud stats ${field} must be a${allowEmpty ? "" : " non-empty"} string`,
    );
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Gitcrawl cloud stats ${field} must be a boolean`);
  }
  return value;
}

function requiredSnapshotString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`Gitcrawl cloud snapshot ${field} must be a non-empty trimmed string`);
  }
  return value;
}

function requiredSnapshotStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim() || entry !== entry.trim())
  ) {
    throw new Error(`Gitcrawl cloud snapshot ${field} must be non-empty trimmed strings`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new Error(`Gitcrawl cloud snapshot ${field} must not contain duplicates`);
  }
  return strings;
}
