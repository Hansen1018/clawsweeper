import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GITCRAWL_DATASETS,
  GITCRAWL_QUERY_COVERAGE,
  GITCRAWL_QUERY_CONTRACT_VERSION,
  type GitcrawlClusterOrderKey,
  type GitcrawlCoverageRow,
  type GitcrawlDataset,
  type GitcrawlEvidenceRelation,
  type GitcrawlEvidenceResumeCursor,
  type GitcrawlEvidenceResult,
  type GitcrawlProvider,
  type GitcrawlQueryEnvelope,
  type GitcrawlQueryName,
  type GitcrawlQuerySource,
  type GitcrawlSourceRevision,
  type GitcrawlThreadFingerprint,
  type GitcrawlThreadOrderKey,
  assertSha256,
  assertSnapshotId,
  canonicalJson,
  compareCanonicalText,
  createGitcrawlEvidenceClaim,
  gitcrawlQueryDigest,
  parseRfc3339Timestamp,
  sha256Canonical,
} from "./gitcrawl-evidence-contract.js";
import { CloudGitcrawlQuerySource } from "./gitcrawl-evidence-cloud.js";
import { LocalGitcrawlQuerySource } from "./gitcrawl-evidence-local.js";
import {
  deriveGitcrawlThreadPolicySignals,
  sanitizeGitcrawlPromptValue,
  stripGitcrawlHtmlComments,
  type GitcrawlThreadPolicySignals,
} from "./gitcrawl-evidence-policy.js";
import { hasSecuritySignalText } from "./security-signals.js";

const DEFAULT_MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 128;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_REVIEW_FILES_IN_PACKET = 24;
const MAX_SAFETY_FIELD_BYTES = 512 * 1024;

export type GitcrawlEvidenceAdapterOptions = {
  repository: string;
  provider: GitcrawlProvider;
  dbPath?: string;
  allowLegacyLocal?: boolean;
  cloudUrl?: string;
  cloudArchive?: string;
  cloudToken?: string;
  fetch?: typeof fetch;
  maxSnapshotAgeMs?: number;
  pageSize?: number;
  maxPages?: number;
  now?: () => Date;
};

export type GitcrawlEvidenceSourceOptions = {
  repository: string;
  provider: GitcrawlProvider;
  primarySource: GitcrawlQuerySource;
  paritySource?: GitcrawlQuerySource;
  maxSnapshotAgeMs?: number;
  pageSize?: number;
  maxPages?: number;
  now?: () => Date;
};

export type GitcrawlClusterEvidence = {
  id: number;
  stableSlug: string;
  status: string;
  clusterType: string;
  title: string;
  representative: {
    threadId: number | null;
    number: number | null;
    kind: string;
    state: string;
    title: string;
  };
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
};

export type GitcrawlThreadEvidence = {
  clusterId?: number;
  clusterSlug?: string;
  clusterStatus?: string;
  clusterMemberCount?: number;
  role?: string;
  membershipState?: string;
  scoreToRepresentative?: number | null;
  threadId: number;
  number: number;
  kind: string;
  state: string;
  title: string;
  body: string;
  authorLogin: string;
  authorType: string;
  authorAssociation?: string;
  htmlUrl: string;
  labels?: unknown[];
  assignees?: unknown[];
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  keySummary: string;
  securitySensitive: boolean;
  securityMetadataComplete: boolean;
  securityProjectionSha256: string;
  policySignals: GitcrawlThreadPolicySignals;
  sourceRevision?: GitcrawlSourceRevision;
  threadFingerprint?: GitcrawlThreadFingerprint;
};

export type GitcrawlReviewContext = {
  thread: GitcrawlThreadEvidence;
  baseSha: string;
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  mergeableState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  detailsFetchedAt: string;
  detailsUpdatedAt: string;
  clusterId: number | null;
  clusterSlug: string;
  clusterTitle: string;
  clusterStatus: string;
  clusterRole: string;
  scoreToRepresentative: number | null;
  files: GitcrawlReviewFile[];
  filesOmitted: number;
};

export type GitcrawlReviewFile = {
  position: number;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previousPath: string;
  fetchedAt: string;
};

export type {
  GitcrawlClusterOrderKey,
  GitcrawlEvidenceResumeCursor,
  GitcrawlThreadOrderKey,
} from "./gitcrawl-evidence-contract.js";

export type GitcrawlEvidenceWindow<T> = GitcrawlEvidenceResult<T> & {
  offset: number;
  nextOffset: number;
  nextProviderCursor: string;
  querySha256: string;
  parityNextProviderCursor?: string;
  lastOrderKey?: GitcrawlThreadOrderKey;
  lastClusterOrderKey?: GitcrawlClusterOrderKey;
  exhausted: boolean;
};

type SessionState = {
  source: GitcrawlQuerySource;
  repository: string;
  archive: string;
  snapshotId: string;
  sourceSha256: string;
  snapshotSchemaName: string;
  snapshotSchemaVersion: number;
  snapshotSchemaHash: string;
  snapshotCapabilities: string[];
  snapshotPublishedAt: string;
  snapshotCutoverAt: string;
  snapshotCoverageComplete: boolean;
  sourceSyncAt: string;
  datasetGeneratedAt: string;
  coverage: GitcrawlCoverageRow[];
};

type ClaimInput<T> = {
  data: T;
  subject: string;
  sourceRevision?: GitcrawlSourceRevision;
  threadFingerprint?: GitcrawlThreadFingerprint;
  relations?: GitcrawlEvidenceRelation[];
};

export class GitcrawlEvidenceAdapter {
  readonly repository: string;
  readonly provider: GitcrawlProvider;

  private readonly primary: SessionState;
  private readonly parity: SessionState | undefined;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly clusterMemberCounts = new Map<number, number>();
  private closePromise: Promise<void> | undefined;

  private constructor(input: {
    repository: string;
    provider: GitcrawlProvider;
    primary: SessionState;
    parity?: SessionState;
    pageSize: number;
    maxPages: number;
  }) {
    this.repository = input.repository;
    this.provider = input.provider;
    this.primary = input.primary;
    this.parity = input.parity;
    this.pageSize = input.pageSize;
    this.maxPages = input.maxPages;
  }

  static async open(options: GitcrawlEvidenceAdapterOptions): Promise<GitcrawlEvidenceAdapter> {
    let primarySource: GitcrawlQuerySource | undefined;
    let paritySource: GitcrawlQuerySource | undefined;
    try {
      if (options.provider === "local") {
        primarySource = await openLocalSource(options);
      } else {
        primarySource = openCloudSource(options);
        if (options.provider === "parity") paritySource = await openLocalSource(options);
      }
    } catch (error) {
      await Promise.allSettled([primarySource?.close(), paritySource?.close()].filter(Boolean));
      throw error;
    }
    return GitcrawlEvidenceAdapter.fromSources({
      repository: options.repository,
      provider: options.provider,
      primarySource,
      ...(paritySource === undefined ? {} : { paritySource }),
      ...(options.maxSnapshotAgeMs === undefined
        ? {}
        : { maxSnapshotAgeMs: options.maxSnapshotAgeMs }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  static async fromSources(
    options: GitcrawlEvidenceSourceOptions,
  ): Promise<GitcrawlEvidenceAdapter> {
    try {
      assertSourceTopology(options);
      const pageSize = positiveInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, "page size");
      const maxPages = positiveInteger(options.maxPages ?? DEFAULT_MAX_PAGES, "max pages");
      const maxAge = nonNegativeInteger(
        options.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS,
        "max snapshot age",
      );
      const now = options.now ?? (() => new Date());
      const primary = await initializeSession(options.primarySource, {
        repository: options.repository,
        pageSize,
        maxPages,
        maxAge,
        now,
      });
      const parity =
        options.paritySource === undefined
          ? undefined
          : await initializeSession(options.paritySource, {
              repository: options.repository,
              pageSize,
              maxPages,
              maxAge,
              now,
            });
      if (parity !== undefined) {
        assertCoverageParity(
          primary.coverage,
          parity.coverage,
          GITCRAWL_QUERY_COVERAGE["gitcrawl.coverage"],
        );
      }
      return new GitcrawlEvidenceAdapter({
        repository: options.repository,
        provider: options.provider,
        primary,
        ...(parity === undefined ? {} : { parity }),
        pageSize,
        maxPages,
      });
    } catch (error) {
      await Promise.allSettled([options.primarySource.close(), options.paritySource?.close()]);
      throw error;
    }
  }

  get snapshotId(): string {
    return this.primary.snapshotId;
  }

  get archive(): string {
    return this.primary.archive;
  }

  get paritySnapshotId(): string | undefined {
    return this.parity?.snapshotId;
  }

  get parityArchive(): string | undefined {
    return this.parity?.archive;
  }

  get coverage(): GitcrawlCoverageRow[] {
    return this.primary.coverage.map((row) => ({ ...row }));
  }

  get requiredCoverage(): GitcrawlDataset[] {
    return this.requiredCoverageFor("gitcrawl.coverage");
  }

  requiredCoverageFor(...queries: GitcrawlQueryName[]): GitcrawlDataset[] {
    const required = new Set<GitcrawlDataset>();
    for (const query of queries) {
      for (const dataset of GITCRAWL_QUERY_COVERAGE[query]) required.add(dataset);
    }
    const datasets = [...required].sort(compareCanonicalText);
    requireDatasets(this.primary.coverage, datasets);
    if (this.parity !== undefined) {
      requireDatasets(this.parity.coverage, datasets);
      assertCoverageParity(this.primary.coverage, this.parity.coverage, datasets);
    }
    return datasets;
  }

  async listClusters(
    options: {
      status?: string;
      minSize?: number;
      maxRows?: number;
    } = {},
  ): Promise<GitcrawlEvidenceResult<GitcrawlClusterEvidence>> {
    const maxRows =
      options.maxRows === undefined ? undefined : positiveInteger(options.maxRows, "max rows");
    const rows = await this.queryNormalized(
      "gitcrawl.clusters.list",
      {
        owner: ownerRepo(this.repository).owner,
        repo: ownerRepo(this.repository).repo,
        status: options.status ?? "active",
        min_size: options.minSize ?? 1,
      },
      normalizeCluster,
      clusterParityView,
      maxRows,
    );
    this.rememberClusterCounts(rows);
    return this.claimResult(
      "gitcrawl.clusters.list",
      rows.map((data) => ({
        data,
        subject: clusterSubject(this.repository, data.id),
      })),
    );
  }

  async listClustersWindow(options: {
    status?: string;
    minSize?: number;
    offset: number;
    maxRows: number;
    resume?: GitcrawlEvidenceResumeCursor;
  }): Promise<GitcrawlEvidenceWindow<GitcrawlClusterEvidence>> {
    if (options.resume !== undefined && options.resume.clusterOrderKey === undefined) {
      throw new Error("Gitcrawl cluster scan resume cursor is missing its order boundary");
    }
    const window = await this.queryNormalizedWindow(
      "gitcrawl.clusters.list",
      {
        owner: ownerRepo(this.repository).owner,
        repo: ownerRepo(this.repository).repo,
        status: options.status ?? "active",
        min_size: options.minSize ?? 1,
      },
      normalizeCluster,
      clusterParityView,
      nonNegativeInteger(options.offset, "scan offset"),
      positiveInteger(options.maxRows, "max rows"),
      options.resume,
    );
    assertClusterOrder(window.consumedRows, options.resume?.clusterOrderKey);
    if (window.parityConsumedRows !== undefined) {
      assertClusterOrder(window.parityConsumedRows, options.resume?.clusterOrderKey);
    }
    this.rememberClusterCounts(window.consumedRows);
    const lastClusterOrderKey =
      window.consumedRows.length === 0
        ? options.resume?.clusterOrderKey
        : clusterOrderKey(window.consumedRows.at(-1)!);
    return {
      ...this.claimResult(
        "gitcrawl.clusters.list",
        window.rows.map((data) => ({
          data,
          subject: clusterSubject(this.repository, data.id),
        })),
      ),
      offset: window.offset,
      nextOffset: window.nextOffset,
      nextProviderCursor: window.nextProviderCursor,
      querySha256: window.querySha256,
      ...(window.parityNextProviderCursor === undefined
        ? {}
        : { parityNextProviderCursor: window.parityNextProviderCursor }),
      ...(lastClusterOrderKey === undefined ? {} : { lastClusterOrderKey }),
      exhausted: window.exhausted,
    };
  }

  async clusterMembers(clusterId: number): Promise<GitcrawlEvidenceResult<GitcrawlThreadEvidence>> {
    const rows = await this.queryNormalized(
      "gitcrawl.clusters.members",
      {
        ...ownerRepo(this.repository),
        cluster_id: positiveInteger(clusterId, "cluster id"),
      },
      normalizeThread,
      clusterMemberParityView,
    );
    for (const row of rows) {
      if (row.clusterId !== clusterId) {
        throw new Error(`Gitcrawl cluster ${clusterId} returned a member from another cluster`);
      }
    }
    const declaredCounts = new Set(
      rows.map((row) => row.clusterMemberCount).filter((count) => count !== undefined),
    );
    const cachedCount = this.clusterMemberCounts.get(clusterId);
    if (cachedCount !== undefined) declaredCounts.add(cachedCount);
    if (rows.some((row) => row.clusterMemberCount === undefined)) {
      throw new Error(`Gitcrawl cluster ${clusterId} members are missing their declared count`);
    }
    if (declaredCounts.size > 1) {
      throw new Error(`Gitcrawl cluster ${clusterId} returned conflicting member counts`);
    }
    const declaredCount = [...declaredCounts][0];
    if (declaredCount === undefined) {
      throw new Error(`Gitcrawl cluster ${clusterId} members are missing their declared count`);
    }
    if (rows.length !== declaredCount) {
      throw new Error(
        `Gitcrawl cluster ${clusterId} returned ${rows.length}/${declaredCount} members`,
      );
    }
    this.clusterMemberCounts.set(clusterId, declaredCount);
    return this.claimResult(
      "gitcrawl.clusters.members",
      rows.map((data) => ({
        data,
        subject: threadSubject(this.repository, data.kind, data.number),
        ...(data.sourceRevision === undefined ? {} : { sourceRevision: data.sourceRevision }),
        ...(data.threadFingerprint === undefined
          ? {}
          : { threadFingerprint: data.threadFingerprint }),
        relations: [
          {
            predicate: "member_of",
            target: clusterSubject(this.repository, clusterId),
          },
        ],
      })),
    );
  }

  async related(number: number): Promise<GitcrawlEvidenceResult<GitcrawlThreadEvidence>> {
    const rows = await this.queryNormalized(
      "gitcrawl.clusters.related",
      {
        ...ownerRepo(this.repository),
        number: positiveInteger(number, "thread number"),
      },
      normalizeThread,
      relatedThreadParityView,
    );
    return this.claimResult(
      "gitcrawl.clusters.related",
      rows.map((data) => ({
        data,
        subject: threadSubject(this.repository, data.kind, data.number),
        ...(data.sourceRevision === undefined ? {} : { sourceRevision: data.sourceRevision }),
        ...(data.threadFingerprint === undefined
          ? {}
          : { threadFingerprint: data.threadFingerprint }),
        relations: [
          {
            predicate: "related_to",
            target: `${this.repository}#thread:${number}`,
          },
        ],
      })),
    );
  }

  async reviewContext(
    number: number,
  ): Promise<GitcrawlEvidenceResult<GitcrawlReviewContext | GitcrawlReviewFile>> {
    const raw = await this.queryNormalized(
      "gitcrawl.pull_requests.review_context",
      {
        ...ownerRepo(this.repository),
        number: positiveInteger(number, "pull request number"),
      },
      (row) => ({ ...row }),
      reviewRawParityView,
    );
    const contextRows = raw.filter((row) => row.row_kind === "context");
    if (contextRows.length !== 1) {
      throw new Error(`Gitcrawl review context for #${number} requires exactly one context row`);
    }
    const contextThreadId = safePositive(contextRows[0]!.thread_id, "review context thread id");
    if (safePositive(contextRows[0]!.number, "review context number") !== number) {
      throw new Error(`Gitcrawl review context for #${number} returned a different pull request`);
    }
    const contextKind = boundedString(contextRows[0]!.kind, 32);
    if (contextKind !== "pull_request") {
      throw new Error(`Gitcrawl review context for #${number} returned a non-pull-request row`);
    }
    for (const row of raw.filter((candidate) => candidate.row_kind === "file")) {
      if (safePositive(row.thread_id, "review file thread id") !== contextThreadId) {
        throw new Error(`Gitcrawl review context for #${number} mixed pull request file rows`);
      }
      if (row.number !== undefined && safePositive(row.number, "review file number") !== number) {
        throw new Error(`Gitcrawl review context for #${number} mixed pull request file rows`);
      }
    }
    const context = normalizeReviewContext(contextRows[0]!);
    context.thread.kind = "pull_request";
    const files = raw
      .filter((row) => row.row_kind === "file")
      .map(normalizeReviewFile)
      .sort((left, right) => left.position - right.position);
    if (!context.baseSha || !context.headSha || !context.detailsFetchedAt) {
      throw new Error(`Gitcrawl review context for #${number} is missing PR details`);
    }
    assertTimestamp(context.detailsFetchedAt, `Gitcrawl review context for #${number} fetched_at`);
    if (context.detailsUpdatedAt) {
      assertTimestamp(
        context.detailsUpdatedAt,
        `Gitcrawl review context for #${number} updated_at`,
      );
    }
    for (const file of files) {
      assertTimestamp(file.fetchedAt, `Gitcrawl review context for #${number} file fetched_at`);
    }
    assertCompleteReviewFiles(number, files, context.changedFiles);
    const boundedFiles = files.slice(0, MAX_REVIEW_FILES_IN_PACKET);
    const combined: GitcrawlReviewContext = {
      ...context,
      files: boundedFiles,
      filesOmitted: files.length - boundedFiles.length,
    };
    const pullSubject = threadSubject(this.repository, "pull_request", number);
    const claims: ClaimInput<GitcrawlReviewContext | GitcrawlReviewFile>[] = [
      {
        data: combined,
        subject: pullSubject,
        ...(combined.thread.sourceRevision === undefined
          ? {}
          : { sourceRevision: combined.thread.sourceRevision }),
        ...(combined.thread.threadFingerprint === undefined
          ? {}
          : { threadFingerprint: combined.thread.threadFingerprint }),
      },
      ...boundedFiles.map((file) => ({
        data: file,
        subject: `${pullSubject}@file:${file.position}:${file.path}`,
        relations: [{ predicate: "evidence_for" as const, target: pullSubject }],
      })),
    ];
    return this.claimResult("gitcrawl.pull_requests.review_context", claims);
  }

  async searchOpenPullRequests(
    options: { maxRows?: number; order?: "newest" | "oldest" } = {},
  ): Promise<GitcrawlEvidenceResult<GitcrawlThreadEvidence>> {
    const maxRows =
      options.maxRows === undefined ? undefined : positiveInteger(options.maxRows, "max rows");
    const order = options.order ?? "newest";
    const rows = await this.queryNormalized(
      "gitcrawl.threads.search",
      {
        ...ownerRepo(this.repository),
        query: "",
        kind: "pull_request",
        state: "open",
        order,
      },
      normalizeThread,
      searchThreadParityView,
      maxRows,
    );
    assertOpenPullRequestRows(rows);
    assertThreadOrder(rows, order);
    return this.claimResult(
      "gitcrawl.threads.search",
      rows.map((data) => ({
        data,
        subject: threadSubject(this.repository, "pull_request", data.number),
        ...(data.sourceRevision === undefined ? {} : { sourceRevision: data.sourceRevision }),
        ...(data.threadFingerprint === undefined
          ? {}
          : { threadFingerprint: data.threadFingerprint }),
      })),
    );
  }

  async searchOpenPullRequestsWindow(options: {
    offset: number;
    maxRows: number;
    order?: "newest" | "oldest";
    resume?: GitcrawlEvidenceResumeCursor;
  }): Promise<GitcrawlEvidenceWindow<GitcrawlThreadEvidence>> {
    const order = options.order ?? "newest";
    if (options.resume !== undefined && options.resume.orderKey === undefined) {
      throw new Error("Gitcrawl pull request scan resume cursor is missing its order boundary");
    }
    const window = await this.queryNormalizedWindow(
      "gitcrawl.threads.search",
      {
        ...ownerRepo(this.repository),
        query: "",
        kind: "pull_request",
        state: "open",
        order,
      },
      normalizeThread,
      searchThreadParityView,
      nonNegativeInteger(options.offset, "scan offset"),
      positiveInteger(options.maxRows, "max rows"),
      options.resume,
    );
    assertOpenPullRequestRows(window.consumedRows);
    assertThreadOrder(window.consumedRows, order, options.resume?.orderKey);
    if (window.parityConsumedRows !== undefined) {
      assertOpenPullRequestRows(window.parityConsumedRows);
      assertThreadOrder(window.parityConsumedRows, order, options.resume?.orderKey);
    }
    const lastOrderKey =
      window.consumedRows.length === 0
        ? options.resume?.orderKey
        : threadOrderKey(window.consumedRows.at(-1)!);
    return {
      ...this.claimResult(
        "gitcrawl.threads.search",
        window.rows.map((data) => ({
          data,
          subject: threadSubject(this.repository, "pull_request", data.number),
          ...(data.sourceRevision === undefined ? {} : { sourceRevision: data.sourceRevision }),
          ...(data.threadFingerprint === undefined
            ? {}
            : { threadFingerprint: data.threadFingerprint }),
        })),
      ),
      offset: window.offset,
      nextOffset: window.nextOffset,
      nextProviderCursor: window.nextProviderCursor,
      querySha256: window.querySha256,
      ...(window.parityNextProviderCursor === undefined
        ? {}
        : { parityNextProviderCursor: window.parityNextProviderCursor }),
      ...(lastOrderKey === undefined ? {} : { lastOrderKey }),
      exhausted: window.exhausted,
    };
  }

  async close(): Promise<void> {
    this.closePromise ??= Promise.all(
      [this.primary.source, this.parity?.source]
        .filter((source): source is GitcrawlQuerySource => source !== undefined)
        .map((source) => source.close()),
    ).then(() => undefined);
    await this.closePromise;
  }

  private async queryNormalized<T>(
    name: GitcrawlQueryName,
    args: Record<string, unknown>,
    normalize: (row: Record<string, unknown>) => T,
    parityView: (row: T) => unknown = (row) => row,
    maxRows?: number,
  ): Promise<T[]> {
    this.requiredCoverageFor(name);
    const primaryRows = (
      await queryAll(this.primary, name, args, this.pageSize, this.maxPages, maxRows)
    ).map(normalize);
    if (this.parity !== undefined) {
      const parityRows = (
        await queryAll(this.parity, name, args, this.pageSize, this.maxPages, maxRows)
      ).map(normalize);
      assertRowsParity(name, primaryRows, parityRows, parityView);
    }
    return primaryRows;
  }

  private async queryNormalizedWindow<T>(
    name: GitcrawlQueryName,
    args: Record<string, unknown>,
    normalize: (row: Record<string, unknown>) => T,
    parityView: (row: T) => unknown,
    offset: number,
    maxRows: number,
    resume?: GitcrawlEvidenceResumeCursor,
  ): Promise<{
    rows: T[];
    consumedRows: T[];
    parityConsumedRows?: T[];
    offset: number;
    nextOffset: number;
    nextProviderCursor: string;
    parityNextProviderCursor?: string;
    exhausted: boolean;
    querySha256: string;
  }> {
    this.requiredCoverageFor(name);
    const querySha256 = gitcrawlQueryDigest(name, args);
    assertResumeCursor(this.primary, this.parity, offset, querySha256, resume);
    const primary = await queryWindow(
      this.primary,
      name,
      args,
      this.pageSize,
      this.maxPages,
      offset,
      maxRows,
      resume?.providerCursor ?? "",
    );
    const primaryRows = primary.rows.map(normalize);
    const primaryConsumedRows = primary.consumedRows.map(normalize);
    let parityNextProviderCursor: string | undefined;
    let parityConsumedRows: T[] | undefined;
    if (this.parity !== undefined) {
      const parity = await queryWindow(
        this.parity,
        name,
        args,
        this.pageSize,
        this.maxPages,
        offset,
        maxRows,
        resume?.parityProviderCursor ?? "",
      );
      const parityRows = parity.rows.map(normalize);
      parityConsumedRows = parity.consumedRows.map(normalize);
      assertRowsParity(name, primaryRows, parityRows, parityView);
      assertRowsParity(name, primaryConsumedRows, parityConsumedRows, parityView);
      if (primary.exhausted !== parity.exhausted || primary.nextOffset !== parity.nextOffset) {
        throw new Error(`Gitcrawl cloud/local pagination parity mismatch for ${name}`);
      }
      parityNextProviderCursor = parity.nextProviderCursor;
    }
    return {
      ...primary,
      rows: primaryRows,
      consumedRows: primaryConsumedRows,
      ...(parityConsumedRows === undefined ? {} : { parityConsumedRows }),
      ...(parityNextProviderCursor === undefined ? {} : { parityNextProviderCursor }),
      querySha256,
    };
  }

  private claimResult<T>(
    queryName: GitcrawlQueryName,
    inputs: ClaimInput<T>[],
  ): GitcrawlEvidenceResult<T> {
    const claims = inputs.map((input) =>
      createGitcrawlEvidenceClaim({
        provider: this.provider,
        snapshotId: this.primary.snapshotId,
        ...(this.parity === undefined ? {} : { paritySnapshotId: this.parity.snapshotId }),
        queryName,
        subject: input.subject,
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
        ...(input.threadFingerprint === undefined
          ? {}
          : { threadFingerprint: input.threadFingerprint }),
        ...(input.relations === undefined ? {} : { relations: input.relations }),
        data: input.data,
      }),
    );
    return { rows: inputs.map((input) => input.data), claims };
  }

  private rememberClusterCounts(rows: GitcrawlClusterEvidence[]): void {
    for (const row of rows) {
      const previous = this.clusterMemberCounts.get(row.id);
      if (previous !== undefined && previous !== row.memberCount) {
        throw new Error(`Gitcrawl cluster ${row.id} changed member count within one snapshot`);
      }
      this.clusterMemberCounts.set(row.id, row.memberCount);
    }
  }
}

export function resolveGitcrawlDbPath(
  repository: string,
  repoRoot: string,
  explicitDb?: string,
): string {
  const configured = explicitDb?.trim() || process.env.CLAWSWEEPER_GITCRAWL_DB?.trim();
  if (configured) return path.resolve(configured);
  const fileName = `${repository
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "__")}.sync.db`;
  const candidates = [
    path.join(repoRoot, "..", "gitcrawl-store", "data", fileName),
    path.join(os.homedir(), ".config", "gitcrawl", "stores", "gitcrawl-store", "data", fileName),
    path.join(os.homedir(), ".config", "gitcrawl", "gitcrawl.db"),
  ];
  return candidates.find((candidate) => pathExists(candidate)) ?? candidates.at(-1)!;
}

export function gitcrawlEvidenceOptionsFromArgs(input: {
  repository: string;
  repoRoot: string;
  args: Record<string, unknown>;
}): GitcrawlEvidenceAdapterOptions {
  const provider = String(
    input.args["gitcrawl-provider"] ?? process.env.CLAWSWEEPER_GITCRAWL_PROVIDER ?? "local",
  ) as GitcrawlProvider;
  if (!["local", "cloud", "parity"].includes(provider)) {
    throw new Error("--gitcrawl-provider must be local, cloud, or parity");
  }
  const explicitDb =
    typeof input.args.db === "string"
      ? input.args.db
      : typeof input.args["parity-db"] === "string"
        ? input.args["parity-db"]
        : undefined;
  const maxAgeHours = Number(
    input.args["max-snapshot-age-hours"] ??
      process.env.CLAWSWEEPER_GITCRAWL_MAX_SNAPSHOT_AGE_HOURS ??
      6,
  );
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    throw new Error("--max-snapshot-age-hours must be non-negative");
  }
  const options: GitcrawlEvidenceAdapterOptions = {
    repository: input.repository,
    provider,
    dbPath: resolveGitcrawlDbPath(input.repository, input.repoRoot, explicitDb),
    allowLegacyLocal:
      input.args["allow-legacy-local"] === true ||
      process.env.CLAWSWEEPER_GITCRAWL_ALLOW_LEGACY_LOCAL === "1",
    maxSnapshotAgeMs: maxAgeHours * 60 * 60 * 1000,
  };
  if (provider !== "local") {
    options.cloudUrl = String(
      input.args["cloud-url"] ?? process.env.CLAWSWEEPER_GITCRAWL_CLOUD_URL ?? "",
    );
    options.cloudArchive = String(
      input.args["cloud-archive"] ??
        process.env.CLAWSWEEPER_GITCRAWL_CLOUD_ARCHIVE ??
        `gitcrawl/${input.repository.replace("/", "__")}`,
    );
    options.cloudToken = process.env.CLAWSWEEPER_GITCRAWL_CLOUD_TOKEN ?? "";
  }
  return options;
}

function openCloudSource(options: GitcrawlEvidenceAdapterOptions): GitcrawlQuerySource {
  return new CloudGitcrawlQuerySource({
    baseUrl: options.cloudUrl ?? "",
    archive: options.cloudArchive ?? "",
    repository: options.repository,
    token: options.cloudToken ?? "",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

async function openLocalSource(
  options: GitcrawlEvidenceAdapterOptions,
): Promise<GitcrawlQuerySource> {
  return LocalGitcrawlQuerySource.open({
    dbPath: options.dbPath ?? "",
    repository: options.repository,
    allowLegacy: options.allowLegacyLocal ?? false,
  });
}

async function initializeSession(
  source: GitcrawlQuerySource,
  options: {
    repository: string;
    pageSize: number;
    maxPages: number;
    maxAge: number;
    now: () => Date;
  },
): Promise<SessionState> {
  const state: SessionState = {
    source,
    repository: options.repository,
    archive: "",
    snapshotId: "",
    sourceSha256: "",
    snapshotSchemaName: "",
    snapshotSchemaVersion: 0,
    snapshotSchemaHash: "",
    snapshotCapabilities: [],
    snapshotPublishedAt: "",
    snapshotCutoverAt: "",
    snapshotCoverageComplete: false,
    sourceSyncAt: "",
    datasetGeneratedAt: "",
    coverage: [],
  };
  const rows = await queryAll(state, "gitcrawl.coverage", {}, options.pageSize, options.maxPages);
  const coverage = rows.map(normalizeCoverageRow);
  assertCoverage(coverage);
  if (coverage.some((row) => row.dataset_generated_at !== state.datasetGeneratedAt)) {
    throw new Error("Gitcrawl coverage mixes dataset generations");
  }
  assertFreshTimestamp(state.sourceSyncAt, "source sync", options.maxAge, options.now());
  assertFreshTimestamp(
    state.datasetGeneratedAt,
    "dataset generation",
    options.maxAge,
    options.now(),
  );
  state.coverage = coverage;
  return state;
}

async function queryAll(
  state: SessionState,
  name: GitcrawlQueryName,
  args: Record<string, unknown>,
  pageSize: number,
  maxPages: number,
  maxRows?: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const remaining = maxRows === undefined ? pageSize : Math.min(pageSize, maxRows - rows.length);
    if (remaining <= 0) return rows;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error(`Gitcrawl cursor replay detected for ${name}`);
      }
      seenCursors.add(cursor);
    }
    const envelope = await state.source.query({
      name,
      args,
      limit: remaining,
      cursor,
      snapshot_id: state.snapshotId,
    });
    bindEnvelope(state, envelope, name);
    if (envelope.values.length > remaining) {
      throw new Error(`Gitcrawl ${name} returned more rows than requested`);
    }
    rows.push(...envelope.values);
    const next = envelope.stats.next_cursor;
    if (next && (next === cursor || seenCursors.has(next))) {
      throw new Error(`Gitcrawl cursor drift detected for ${name}`);
    }
    if (maxRows !== undefined && rows.length >= maxRows) return rows.slice(0, maxRows);
    if (!next) return rows;
    cursor = next;
  }
  throw new Error(`Gitcrawl ${name} pagination exceeded ${maxPages} pages`);
}

async function queryWindow(
  state: SessionState,
  name: GitcrawlQueryName,
  args: Record<string, unknown>,
  pageSize: number,
  maxPages: number,
  offset: number,
  maxRows: number,
  startCursor: string,
): Promise<{
  rows: Record<string, unknown>[];
  consumedRows: Record<string, unknown>[];
  offset: number;
  nextOffset: number;
  nextProviderCursor: string;
  exhausted: boolean;
}> {
  const rows: Record<string, unknown>[] = [];
  const consumedRows: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  const target = offset + maxRows;
  if (!Number.isSafeInteger(target)) {
    throw new Error(`Gitcrawl ${name} scan window exceeds the safe integer range`);
  }
  let cursor = startCursor;
  let seenRows = startCursor ? offset : 0;
  for (let page = 0; page < maxPages; page += 1) {
    const requestLimit = Math.min(pageSize, target - seenRows);
    if (requestLimit <= 0) {
      return {
        rows,
        consumedRows,
        offset,
        nextOffset: offset + rows.length,
        nextProviderCursor: cursor,
        exhausted: false,
      };
    }
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error(`Gitcrawl cursor replay detected for ${name}`);
      }
      seenCursors.add(cursor);
    }
    const envelope = await state.source.query({
      name,
      args,
      limit: requestLimit,
      cursor,
      snapshot_id: state.snapshotId,
    });
    bindEnvelope(state, envelope, name);
    if (envelope.values.length > requestLimit) {
      throw new Error(`Gitcrawl ${name} returned more rows than requested`);
    }
    const pageStart = seenRows;
    seenRows += envelope.values.length;
    consumedRows.push(...envelope.values);
    for (const [index, row] of envelope.values.entries()) {
      const rowOffset = pageStart + index;
      if (rowOffset >= offset && rows.length < maxRows) rows.push(row);
    }
    const next = envelope.stats.next_cursor;
    if (next && (next === cursor || seenCursors.has(next))) {
      throw new Error(`Gitcrawl cursor drift detected for ${name}`);
    }
    if (!next) {
      return {
        rows,
        consumedRows,
        offset,
        nextOffset: 0,
        nextProviderCursor: "",
        exhausted: true,
      };
    }
    if (rows.length >= maxRows) {
      return {
        rows,
        consumedRows,
        offset,
        nextOffset: offset + rows.length,
        nextProviderCursor: next,
        exhausted: false,
      };
    }
    cursor = next;
  }
  throw new Error(`Gitcrawl ${name} pagination exceeded ${maxPages} pages`);
}

function assertResumeCursor(
  primary: SessionState,
  parity: SessionState | undefined,
  offset: number,
  querySha256: string,
  resume: GitcrawlEvidenceResumeCursor | undefined,
): void {
  if (resume === undefined) return;
  if (
    resume.offset !== offset ||
    offset <= 0 ||
    !resume.providerCursor ||
    resume.archive !== primary.archive ||
    resume.snapshotId !== primary.snapshotId ||
    resume.querySha256 !== querySha256
  ) {
    throw new Error("Gitcrawl scan resume cursor does not match the active snapshot and offset");
  }
  if (parity === undefined) {
    if (
      resume.parityArchive !== undefined ||
      resume.paritySnapshotId !== undefined ||
      resume.parityProviderCursor !== undefined
    ) {
      throw new Error("Gitcrawl scan resume cursor has unexpected parity state");
    }
    return;
  }
  if (
    resume.parityArchive !== parity.archive ||
    resume.paritySnapshotId !== parity.snapshotId ||
    !resume.parityProviderCursor
  ) {
    throw new Error("Gitcrawl parity scan resume cursor does not match the active snapshot");
  }
}

function bindEnvelope(
  state: SessionState,
  envelope: GitcrawlQueryEnvelope,
  name: GitcrawlQueryName,
): void {
  const stats = envelope.stats;
  if (stats.contract_version !== GITCRAWL_QUERY_CONTRACT_VERSION) {
    throw new Error(
      `Gitcrawl ${name} returned incompatible safety contract ${String(stats.contract_version)}`,
    );
  }
  if (
    stats.repository !== state.repository ||
    !stats.archive.trim() ||
    stats.archive !== stats.archive.trim()
  ) {
    throw new Error(`Gitcrawl ${name} returned mismatched source identity`);
  }
  assertSnapshotId(stats.snapshot_id);
  const snapshotValue: unknown = envelope.snapshot;
  if (typeof snapshotValue !== "object" || snapshotValue === null || Array.isArray(snapshotValue)) {
    throw new Error(`Gitcrawl ${name} returned no snapshot provenance`);
  }
  const snapshot = snapshotValue as GitcrawlQueryEnvelope["snapshot"];
  if (
    !Array.isArray(snapshot.capabilities) ||
    snapshot.capabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error(`Gitcrawl ${name} returned malformed snapshot capabilities`);
  }
  assertSha256(snapshot.source_sha256, "Gitcrawl snapshot source sha256");
  if (
    snapshot.id !== stats.snapshot_id ||
    snapshot.source_sync_at !== stats.source_sync_at ||
    snapshot.dataset_generated_at !== stats.dataset_generated_at ||
    snapshot.coverage_complete !== stats.coverage_complete
  ) {
    throw new Error(`Gitcrawl ${name} returned mismatched snapshot provenance`);
  }
  if (state.source.provider === "cloud") {
    assertSha256(snapshot.id, "Gitcrawl cloud snapshot id");
    if (
      snapshot.id !== snapshot.source_sha256 ||
      !snapshot.schema_name.trim() ||
      !Number.isSafeInteger(snapshot.schema_version) ||
      snapshot.schema_version <= 0 ||
      !snapshot.schema_hash.trim() ||
      !snapshot.capabilities.includes(name) ||
      !snapshot.published_at ||
      !snapshot.cutover_at
    ) {
      throw new Error(`Gitcrawl ${name} returned incomplete cloud snapshot provenance`);
    }
    parseRfc3339Timestamp(snapshot.published_at, "Gitcrawl cloud snapshot published_at");
    parseRfc3339Timestamp(snapshot.cutover_at, "Gitcrawl cloud snapshot cutover_at");
  }
  if (!stats.coverage_complete && name !== "gitcrawl.coverage") {
    throw new Error(`Gitcrawl ${name} returned incomplete coverage`);
  }
  if (!state.snapshotId) {
    state.archive = stats.archive;
    state.snapshotId = stats.snapshot_id;
    state.sourceSha256 = snapshot.source_sha256;
    state.snapshotSchemaName = snapshot.schema_name;
    state.snapshotSchemaVersion = snapshot.schema_version;
    state.snapshotSchemaHash = snapshot.schema_hash;
    state.snapshotCapabilities = [...snapshot.capabilities];
    state.snapshotPublishedAt = snapshot.published_at;
    state.snapshotCutoverAt = snapshot.cutover_at;
    state.snapshotCoverageComplete = snapshot.coverage_complete;
    state.sourceSyncAt = stats.source_sync_at;
    state.datasetGeneratedAt = stats.dataset_generated_at;
  } else if (
    stats.snapshot_id !== state.snapshotId ||
    snapshot.source_sha256 !== state.sourceSha256 ||
    snapshot.schema_name !== state.snapshotSchemaName ||
    snapshot.schema_version !== state.snapshotSchemaVersion ||
    snapshot.schema_hash !== state.snapshotSchemaHash ||
    canonicalJson(snapshot.capabilities) !== canonicalJson(state.snapshotCapabilities) ||
    snapshot.published_at !== state.snapshotPublishedAt ||
    snapshot.cutover_at !== state.snapshotCutoverAt ||
    snapshot.coverage_complete !== state.snapshotCoverageComplete ||
    stats.archive !== state.archive ||
    stats.source_sync_at !== state.sourceSyncAt ||
    stats.dataset_generated_at !== state.datasetGeneratedAt
  ) {
    throw new Error(`Gitcrawl ${name} mixed snapshot generation`);
  }
}

function normalizeCoverageRow(row: Record<string, unknown>): GitcrawlCoverageRow {
  const dataset = String(row.dataset ?? "");
  if (!GITCRAWL_DATASETS.includes(dataset as GitcrawlCoverageRow["dataset"])) {
    throw new Error(`Gitcrawl coverage returned unknown dataset ${dataset}`);
  }
  const normalized = {
    dataset: dataset as GitcrawlCoverageRow["dataset"],
    row_count: safeNonNegative(row.row_count, `${dataset} row_count`),
    eligible_count: safeNonNegative(row.eligible_count, `${dataset} eligible_count`),
    covered_count: safeNonNegative(row.covered_count, `${dataset} covered_count`),
    max_source_at: boundedString(row.max_source_at, 64),
    dataset_generated_at: boundedString(row.dataset_generated_at, 64),
    complete: booleanValue(row.complete),
  };
  if (normalized.covered_count > normalized.eligible_count) {
    throw new Error(`Gitcrawl coverage ${dataset} exceeds eligible rows`);
  }
  if (normalized.complete && normalized.covered_count !== normalized.eligible_count) {
    throw new Error(`Gitcrawl coverage ${dataset} is marked complete with missing rows`);
  }
  return normalized;
}

function assertCoverage(coverage: GitcrawlCoverageRow[]): void {
  const byDataset = new Map(coverage.map((row) => [row.dataset, row]));
  if (coverage.length !== new Set(coverage.map((row) => row.dataset)).size) {
    throw new Error("Gitcrawl coverage contains duplicate datasets");
  }
  for (const dataset of GITCRAWL_DATASETS) {
    if (!byDataset.has(dataset)) throw new Error(`Gitcrawl coverage is missing ${dataset}`);
  }
  requireDatasets(coverage, GITCRAWL_QUERY_COVERAGE["gitcrawl.coverage"]);
}

function assertCoverageParity(
  primary: GitcrawlCoverageRow[],
  parity: GitcrawlCoverageRow[],
  datasets: readonly GitcrawlDataset[],
): void {
  const included = new Set(datasets);
  const projection = (rows: GitcrawlCoverageRow[]) =>
    rows
      .filter((row) => included.has(row.dataset))
      .map((row) => ({
        dataset: row.dataset,
        row_count: row.row_count,
        eligible_count: row.eligible_count,
        covered_count: row.covered_count,
        complete: row.complete,
      }))
      .sort((left, right) => compareCanonicalText(left.dataset, right.dataset));
  if (canonicalJson(projection(primary)) !== canonicalJson(projection(parity))) {
    throw new Error("Gitcrawl cloud/local coverage parity mismatch");
  }
}

function requireDatasets(
  coverage: GitcrawlCoverageRow[],
  datasets: readonly GitcrawlCoverageRow["dataset"][],
): void {
  for (const dataset of datasets) {
    if (!coverage.find((row) => row.dataset === dataset)?.complete) {
      throw new Error(`Gitcrawl ${dataset} coverage is incomplete`);
    }
  }
}

function normalizeCluster(row: Record<string, unknown>): GitcrawlClusterEvidence {
  return {
    id: safePositive(row.cluster_id, "cluster id"),
    stableSlug: boundedString(row.stable_slug, 512),
    status: boundedString(row.status, 64),
    clusterType: boundedString(row.cluster_type, 64),
    title: boundedString(stripGitcrawlHtmlComments(safetyString(row.title, "cluster title")), 512),
    representative: {
      threadId: optionalPositive(row.representative_thread_id),
      number: optionalPositive(row.representative_number),
      kind: boundedString(row.representative_kind, 32),
      state: boundedString(row.representative_state, 32),
      title: boundedString(
        stripGitcrawlHtmlComments(
          safetyString(row.representative_title, "cluster representative title"),
        ),
        512,
      ),
    },
    memberCount: safeNonNegative(row.member_count, "member count"),
    createdAt: boundedString(row.created_at, 64),
    updatedAt: boundedString(row.updated_at, 64),
    closedAt: boundedString(row.closed_at, 64),
  };
}

function normalizeThread(row: Record<string, unknown>): GitcrawlThreadEvidence {
  const completeSecurityMetadata = booleanValue(row.security_metadata_complete);
  if (completeSecurityMetadata && typeof row.title !== "string") {
    throw new Error("Gitcrawl thread title is missing from complete security metadata");
  }
  if (completeSecurityMetadata && typeof row.body !== "string") {
    throw new Error("Gitcrawl thread body is missing from complete security metadata");
  }
  if (
    completeSecurityMetadata &&
    (typeof row.author_login !== "string" || !row.author_login.trim())
  ) {
    throw new Error("Gitcrawl thread author login is missing from complete security metadata");
  }
  if (
    completeSecurityMetadata &&
    (typeof row.author_type !== "string" || !row.author_type.trim())
  ) {
    throw new Error("Gitcrawl thread author type is missing from complete security metadata");
  }
  const safetyTitle = safetyString(row.title, "thread title");
  const safetyBody = safetyString(row.body, "thread body");
  const promptTitle = stripGitcrawlHtmlComments(safetyTitle);
  const promptBody = stripGitcrawlHtmlComments(safetyBody);
  const hasBodyField = typeof row.body === "string";
  const hasLabelsField = row.labels_json !== undefined && row.labels_json !== null;
  const hasAssigneesField = row.assignees_json !== undefined && row.assignees_json !== null;
  const authorAssociation = boundedString(row.author_association, 64);
  const hasAuthorAssociation = authorAssociation.length > 0;
  const authorLogin = boundedString(row.author_login, 256);
  const authorType = boundedString(row.author_type, 64);
  const safetyLabels = hasLabelsField ? unboundedJsonArray(row.labels_json, "thread labels") : [];
  const safetyAssignees = hasAssigneesField
    ? unboundedJsonArray(row.assignees_json, "thread assignees")
    : [];
  const promptLabels = sanitizeGitcrawlPromptValue(safetyLabels);
  const promptAssignees = sanitizeGitcrawlPromptValue(safetyAssignees);
  const securityMetadataComplete =
    completeSecurityMetadata &&
    hasBodyField &&
    hasLabelsField &&
    hasAssigneesField &&
    hasAuthorAssociation &&
    authorLogin.length > 0 &&
    authorType.length > 0;
  const securityProjection = {
    title: safetyTitle,
    body: safetyBody,
    author_login: authorLogin,
    author_type: authorType,
    labels: safetyLabels,
    assignees: safetyAssignees,
    author_association: authorAssociation || null,
    complete: securityMetadataComplete,
  };
  const fingerprintHash = boundedString(row.fingerprint_hash, 256);
  const fingerprintAlgorithm = boundedString(row.fingerprint_algorithm, 64);
  const revisionHash = boundedString(row.revision_content_hash, 256);
  if (fingerprintHash) {
    if (fingerprintAlgorithm !== "thread-fingerprint-v2") {
      throw new Error(
        `unsupported Gitcrawl thread fingerprint algorithm: ${fingerprintAlgorithm || "missing"}`,
      );
    }
    assertSha256(fingerprintHash, "Gitcrawl thread fingerprint");
  }
  if (revisionHash) assertSha256(revisionHash, "Gitcrawl source revision");
  const revisionId = optionalPositive(row.revision_id);
  const revisionUpdatedAt = boundedString(
    row.revision_source_updated_at || row.updated_at_gh || row.updated_at,
    64,
  );
  const sourceRevision =
    revisionId === null && !revisionHash && !revisionUpdatedAt
      ? undefined
      : {
          ...(revisionId === null ? {} : { id: revisionId }),
          ...(revisionHash ? { sha256: revisionHash } : {}),
          ...(revisionUpdatedAt ? { updated_at: revisionUpdatedAt } : {}),
        };
  const threadFingerprint = fingerprintHash
    ? {
        algorithm: fingerprintAlgorithm,
        sha256: fingerprintHash,
      }
    : undefined;
  return {
    ...(optionalPositive(row.cluster_id) === null
      ? {}
      : { clusterId: optionalPositive(row.cluster_id)! }),
    ...(boundedString(row.stable_slug ?? row.cluster_slug, 512)
      ? { clusterSlug: boundedString(row.stable_slug ?? row.cluster_slug, 512) }
      : {}),
    ...(boundedString(row.cluster_status, 64)
      ? { clusterStatus: boundedString(row.cluster_status, 64) }
      : {}),
    ...(row.cluster_member_count === undefined
      ? {}
      : {
          clusterMemberCount: safeNonNegative(row.cluster_member_count, "cluster member count"),
        }),
    ...(boundedString(row.role ?? row.cluster_role, 64)
      ? { role: boundedString(row.role ?? row.cluster_role, 64) }
      : {}),
    ...(boundedString(row.membership_state, 64)
      ? { membershipState: boundedString(row.membership_state, 64) }
      : {}),
    ...(row.score_to_representative === undefined
      ? {}
      : { scoreToRepresentative: optionalNumber(row.score_to_representative) }),
    threadId: safePositive(row.thread_id, "thread id"),
    number: safePositive(row.number, "thread number"),
    kind: boundedString(row.kind, 32),
    state: boundedString(row.state, 32),
    title: boundedString(promptTitle, 512),
    body: boundedString(promptBody, 2_048),
    authorLogin,
    authorType,
    ...(authorAssociation ? { authorAssociation } : {}),
    htmlUrl: boundedString(row.html_url, 2_048),
    ...(hasLabelsField ? { labels: boundedJsonArray(promptLabels, 32, 256) } : {}),
    ...(hasAssigneesField ? { assignees: boundedJsonArray(promptAssignees, 16, 256) } : {}),
    isDraft: booleanValue(row.is_draft),
    createdAt: boundedString(row.created_at_gh, 64),
    updatedAt: boundedString(row.updated_at_gh || row.updated_at, 64),
    keySummary: boundedString(
      stripGitcrawlHtmlComments(safetyString(row.key_summary, "thread key summary")),
      2_048,
    ),
    securitySensitive: hasSecuritySignalText(safetyTitle, safetyBody, safetyLabels),
    securityMetadataComplete,
    securityProjectionSha256: sha256Canonical(securityProjection),
    policySignals: deriveGitcrawlThreadPolicySignals(safetyTitle, safetyBody),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(threadFingerprint === undefined ? {} : { threadFingerprint }),
  };
}

function normalizeReviewContext(
  row: Record<string, unknown>,
): Omit<GitcrawlReviewContext, "files" | "filesOmitted"> {
  return {
    thread: normalizeThread(row),
    baseSha: boundedString(row.base_sha, 128),
    headSha: boundedString(row.head_sha, 128),
    headRef: boundedString(row.head_ref, 512),
    headRepoFullName: boundedString(row.head_repo_full_name, 512),
    mergeableState: boundedString(row.mergeable_state, 64),
    additions: safeNonNegative(row.additions, "PR additions"),
    deletions: safeNonNegative(row.deletions, "PR deletions"),
    changedFiles: safeNonNegative(row.changed_files, "PR changed files"),
    detailsFetchedAt: boundedString(row.details_fetched_at, 64),
    detailsUpdatedAt: boundedString(row.details_updated_at, 64),
    clusterId: optionalPositive(row.cluster_id),
    clusterSlug: boundedString(row.cluster_slug, 512),
    clusterTitle: boundedString(
      stripGitcrawlHtmlComments(safetyString(row.cluster_title, "review cluster title")),
      512,
    ),
    clusterStatus: boundedString(row.cluster_status, 64),
    clusterRole: boundedString(row.cluster_role, 64),
    scoreToRepresentative: optionalNumber(row.score_to_representative),
  };
}

function normalizeReviewFile(row: Record<string, unknown>): GitcrawlReviewFile {
  return {
    position: safeNonNegative(row.file_position, "file position"),
    path: exactFilePath(row.file_path, "file path"),
    status: boundedString(row.file_status, 64),
    additions: safeNonNegative(row.file_additions, "file additions"),
    deletions: safeNonNegative(row.file_deletions, "file deletions"),
    changes: safeNonNegative(row.file_changes, "file changes"),
    previousPath: exactFilePath(row.file_previous_path, "previous file path", true),
    fetchedAt: boundedString(row.file_fetched_at, 64),
  };
}

function assertCompleteReviewFiles(
  number: number,
  files: GitcrawlReviewFile[],
  changedFiles: number,
): void {
  if (files.length !== changedFiles) {
    throw new Error(
      `Gitcrawl review context for #${number} has ${files.length}/${changedFiles} files`,
    );
  }
  // Gitcrawl positions are the snapshot-local identity; paths can legitimately repeat.
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (file.position !== index) {
      throw new Error(`Gitcrawl review context for #${number} has incomplete file positions`);
    }
    if (!file.path || !file.fetchedAt) {
      throw new Error(`Gitcrawl review context for #${number} has incomplete file identity`);
    }
  }
}

function assertThreadOrder(
  rows: GitcrawlThreadEvidence[],
  order: "newest" | "oldest",
  previousKey?: GitcrawlThreadOrderKey,
): void {
  const keys = [
    ...(previousKey === undefined ? [] : [validatedThreadOrderKey(previousKey)]),
    ...rows.map((row) => validatedThreadOrderKey(threadOrderKey(row))),
  ];
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1]!;
    const current = keys[index]!;
    const direction = previous.timestamp - current.timestamp || previous.number - current.number;
    if ((order === "newest" && direction < 0) || (order === "oldest" && direction > 0)) {
      throw new Error(`Gitcrawl pull request search did not honor ${order}-first ordering`);
    }
  }
}

function assertClusterOrder(
  rows: GitcrawlClusterEvidence[],
  previousKey?: GitcrawlClusterOrderKey,
): void {
  const keys = [
    ...(previousKey === undefined ? [] : [validatedClusterOrderKey(previousKey)]),
    ...rows.map((row) => validatedClusterOrderKey(clusterOrderKey(row))),
  ];
  for (let index = 1; index < keys.length; index += 1) {
    if (compareClusterOrderKeys(keys[index - 1]!, keys[index]!) > 0) {
      throw new Error("Gitcrawl cluster list did not honor its stable ordering");
    }
  }
}

function clusterOrderKey(row: GitcrawlClusterEvidence): GitcrawlClusterOrderKey {
  return { memberCount: row.memberCount, updatedAt: row.updatedAt, id: row.id };
}

function validatedClusterOrderKey(
  key: GitcrawlClusterOrderKey,
): GitcrawlClusterOrderKey & { timestamp: number } {
  if (!Number.isSafeInteger(key.memberCount) || key.memberCount < 0) {
    throw new Error("Gitcrawl cluster member count is invalid");
  }
  if (!Number.isSafeInteger(key.id) || key.id <= 0) {
    throw new Error("Gitcrawl cluster id is invalid");
  }
  return {
    ...key,
    timestamp: parseRfc3339Timestamp(key.updatedAt, "Gitcrawl cluster updated_at"),
  };
}

function compareClusterOrderKeys(
  left: GitcrawlClusterOrderKey & { timestamp: number },
  right: GitcrawlClusterOrderKey & { timestamp: number },
): number {
  return (
    right.memberCount - left.memberCount || right.timestamp - left.timestamp || left.id - right.id
  );
}

function threadOrderKey(row: GitcrawlThreadEvidence): GitcrawlThreadOrderKey {
  return { updatedAt: row.updatedAt, number: row.number };
}

function validatedThreadOrderKey(
  key: GitcrawlThreadOrderKey,
): GitcrawlThreadOrderKey & { timestamp: number } {
  return {
    ...key,
    timestamp: parseRfc3339Timestamp(key.updatedAt, "Gitcrawl thread updated_at"),
  };
}

function assertOpenPullRequestRows(rows: GitcrawlThreadEvidence[]): void {
  for (const row of rows) {
    if (row.kind !== "pull_request" || row.state !== "open") {
      throw new Error(
        `Gitcrawl open pull request search returned ${row.kind || "unknown"} #${row.number} in ${row.state || "unknown"} state`,
      );
    }
  }
}

function clusterParityView(row: GitcrawlClusterEvidence): unknown {
  return row;
}

function searchThreadParityView(row: GitcrawlThreadEvidence): unknown {
  const { sourceRevision: _sourceRevision, ...common } = row;
  return common;
}

function clusterMemberParityView(row: GitcrawlThreadEvidence): unknown {
  const { sourceRevision: _sourceRevision, ...common } = row;
  return common;
}

function relatedThreadParityView(row: GitcrawlThreadEvidence): unknown {
  const {
    sourceRevision: _sourceRevision,
    clusterStatus: _clusterStatus,
    membershipState: _membershipState,
    createdAt: _createdAt,
    isDraft: _isDraft,
    ...common
  } = row;
  return common;
}

function reviewRawParityView(row: Record<string, unknown>): unknown {
  if (row.row_kind === "file") {
    return {
      rowKind: "file",
      ...normalizeReviewFile(row),
    };
  }
  const context = normalizeReviewContext(row);
  return {
    rowKind: "context",
    ...context,
    thread: clusterMemberParityView(context.thread),
  };
}

function assertRowsParity<T>(
  name: GitcrawlQueryName,
  primary: T[],
  parity: T[],
  project: (row: T) => unknown,
): void {
  const normalize = (rows: T[]) => rows.map(project).map(canonicalJson).sort(compareCanonicalText);
  if (canonicalJson(normalize(primary)) !== canonicalJson(normalize(parity))) {
    throw new Error(`Gitcrawl cloud/local parity mismatch for ${name}`);
  }
}

function assertFreshTimestamp(value: string, label: string, maxAge: number, now: Date): void {
  const timestamp = parseRfc3339Timestamp(value, `Gitcrawl ${label} timestamp`);
  const age = now.getTime() - timestamp;
  if (age < -MAX_CLOCK_SKEW_MS) throw new Error(`Gitcrawl ${label} timestamp is in the future`);
  if (age > maxAge) {
    throw new Error(`Gitcrawl ${label} is stale by ${Math.floor(age / 60_000)} minutes`);
  }
}

function assertTimestamp(value: string, label: string): void {
  parseRfc3339Timestamp(value, label);
}

function assertSourceTopology(options: GitcrawlEvidenceSourceOptions): void {
  if (options.provider === "local") {
    if (options.primarySource.provider !== "local" || options.paritySource !== undefined) {
      throw new Error("Gitcrawl local mode requires one local source");
    }
    return;
  }
  if (options.primarySource.provider !== "cloud") {
    throw new Error(`Gitcrawl ${options.provider} mode requires a cloud primary source`);
  }
  if (options.provider === "cloud" && options.paritySource !== undefined) {
    throw new Error("Gitcrawl cloud mode does not accept a parity source");
  }
  if (options.provider === "parity" && options.paritySource?.provider !== "local") {
    throw new Error("Gitcrawl parity mode requires a local parity source");
  }
}

function ownerRepo(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`invalid Gitcrawl repository: ${repository}`);
  }
  return { owner, repo };
}

function clusterSubject(repository: string, clusterId: number): string {
  return `${repository}#cluster:${clusterId}`;
}

function threadSubject(repository: string, kind: string, number: number): string {
  return `${repository}#${kind === "pull_request" ? "pull" : "issue"}:${number}`;
}

function boundedString(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function exactFilePath(value: unknown, label: string, allowEmpty = false): string {
  if (value === undefined || value === null) {
    if (allowEmpty) return "";
    throw new Error(`Gitcrawl ${label} is missing`);
  }
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Gitcrawl ${label} is invalid`);
  }
  if (Buffer.byteLength(value, "utf8") > 1_024) {
    throw new Error(`Gitcrawl ${label} exceeds the safety bound`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`Gitcrawl ${label} is missing`);
  return value;
}

function boundedJsonArray(value: unknown, maxItems: number, maxItemBytes: number): unknown[] {
  return unboundedJsonArray(value, "JSON array field")
    .slice(0, maxItems)
    .map((entry) => {
      const text = canonicalJson(entry);
      if (Buffer.byteLength(text, "utf8") <= maxItemBytes) return entry;
      return text.slice(0, maxItemBytes);
    });
}

function unboundedJsonArray(value: unknown, label: string): unknown[] {
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_SAFETY_FIELD_BYTES) {
      throw new Error(`Gitcrawl ${label} exceeds the safety bound`);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Gitcrawl ${label} is malformed`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`Gitcrawl ${label} is malformed`);
  return parsed;
}

function safetyString(value: unknown, label: string): string {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_SAFETY_FIELD_BYTES) {
    throw new Error(`Gitcrawl ${label} exceeds the safety bound`);
  }
  return text.trim();
}

function safePositive(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid`);
  return number;
}

function optionalPositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeNonNegative(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${label} is missing`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Gitcrawl numeric field is invalid");
  return number;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function pathExists(value: string): boolean {
  return Boolean(value) && path.isAbsolute(value) && fs.existsSync(value);
}
