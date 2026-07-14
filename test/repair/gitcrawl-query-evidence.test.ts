import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { GitcrawlEvidenceAdapter } from "../../dist/repair/gitcrawl-evidence-adapter.js";
import { CloudGitcrawlQuerySource } from "../../dist/repair/gitcrawl-evidence-cloud.js";
import {
  GITCRAWL_DATASETS,
  GITCRAWL_QUERY_CONTRACT_VERSION,
  GITCRAWL_QUERY_NAMES,
  canonicalJson,
  createGitcrawlEvidenceClaim,
  sha256Canonical,
  type GitcrawlCoverageRow,
  type GitcrawlQueryEnvelope,
  type GitcrawlQueryRequest,
  type GitcrawlQuerySource,
  verifyGitcrawlEvidenceClaim,
} from "../../dist/repair/gitcrawl-evidence-contract.js";
import {
  buildGitcrawlEvidencePacket,
  verifyGitcrawlEvidencePacket,
} from "../../dist/repair/gitcrawl-evidence-graph.js";
import { LocalGitcrawlQuerySource } from "../../dist/repair/gitcrawl-evidence-local.js";
import {
  deriveGitcrawlThreadPolicySignals,
  sanitizeGitcrawlPromptValue,
  stripGitcrawlHtmlComments,
} from "../../dist/repair/gitcrawl-evidence-policy.js";

const now = new Date("2026-07-14T10:00:00.000Z");
const generatedAt = "2026-07-14T09:55:00.000Z";
const snapshotId = "a".repeat(64);
const revision = "b".repeat(64);
const fingerprint = "c".repeat(64);
const repository = "openclaw/openclaw";
const archive = "gitcrawl/openclaw__openclaw";

test("six-query adapter binds read-only evidence into verified claims and graph packets", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.clusters.list": [clusterRow()],
      "gitcrawl.clusters.members": [memberRow()],
      "gitcrawl.clusters.related": [
        { source_number: 42, ...memberRow({ thread_id: 43, number: 43, kind: "issue" }) },
      ],
      "gitcrawl.threads.search": [memberRow()],
      "gitcrawl.pull_requests.review_context": [
        reviewContextRow({ changed_files: 1 }),
        reviewFileRow(0, "src/provider.ts"),
      ],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository,
    provider: "cloud",
    primarySource: source,
    now: () => now,
  });

  const clusters = await adapter.listClusters();
  const members = await adapter.clusterMembers(7);
  const related = await adapter.related(42);
  const search = await adapter.searchOpenPullRequests();
  const review = await adapter.reviewContext(42);

  assert.deepEqual(
    [...new Set(source.requests.map((request) => request.name))].sort(),
    [...GITCRAWL_QUERY_NAMES].sort(),
  );
  assert.equal(clusters.rows[0]?.id, 7);
  assert.equal(members.rows[0]?.threadFingerprint?.sha256, fingerprint);
  assert.equal(related.rows[0]?.number, 43);
  assert.equal(search.rows[0]?.sourceRevision?.sha256, revision);
  assert.equal(review.rows.length, 2);
  assert.deepEqual(adapter.requiredCoverageFor(...GITCRAWL_QUERY_NAMES), [
    "cluster_groups",
    "cluster_memberships",
    "pull_request_details",
    "pull_request_files",
    "repositories",
    "threads",
  ]);

  const claims = [
    ...clusters.claims,
    ...members.claims,
    ...related.claims,
    ...search.claims,
    ...review.claims,
  ];
  for (const claim of claims) {
    assert.equal(claim.repository, repository);
    const request = source.requests.find((candidate) => candidate.name === claim.query.name);
    assert(request);
    assert.equal(claim.query.args_sha256, sha256Canonical(request.args));
  }
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository,
    snapshotId: adapter.snapshotId,
    coverage: adapter.coverage,
    claims,
    generatedAt,
  });
  assert.doesNotThrow(() => verifyGitcrawlEvidencePacket(packet));
  assert(packet.graph.nodes.some((node) => node.id === `${repository}#cluster:7`));
  assert(packet.graph.edges.some((edge) => edge.predicate === "member_of"));
  await adapter.close();
  assert.equal(source.closeCount, 1);
});

test("query evidence fails closed on source, relation, review, and packet drift", async (t) => {
  await t.test("snapshot generation changes", async () => {
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository,
      provider: "cloud",
      primarySource: new FixtureSource({
        snapshotForQuery: (request) =>
          request.name === "gitcrawl.coverage" ? snapshotId : "d".repeat(64),
        rows: { "gitcrawl.clusters.list": [clusterRow()] },
      }),
      now: () => now,
    });
    await assert.rejects(adapter.listClusters(), /mixed snapshot generation/);
    await adapter.close();
  });

  await t.test("cluster members escape the requested cluster", async () => {
    const adapter = await adapterFor({
      "gitcrawl.clusters.members": [memberRow({ cluster_id: 8 })],
    });
    await assert.rejects(
      adapter.clusterMembers(7),
      /cluster 7 returned a member from another cluster/,
    );
    await adapter.close();
  });

  await t.test("related results point back to themselves", async () => {
    const adapter = await adapterFor({
      "gitcrawl.clusters.related": [{ source_number: 42, ...memberRow() }],
    });
    await assert.rejects(adapter.related(42), /cannot relate thread 42 to itself/);
    await adapter.close();
  });

  await t.test("review files are incomplete", async () => {
    const adapter = await adapterFor({
      "gitcrawl.pull_requests.review_context": [
        reviewContextRow({ changed_files: 2 }),
        reviewFileRow(0, "src/provider.ts"),
      ],
    });
    await assert.rejects(adapter.reviewContext(42), /has 1\/2 files/);
    await adapter.close();
  });

  await t.test("search returns a non-pull-request row", async () => {
    const adapter = await adapterFor({
      "gitcrawl.threads.search": [memberRow({ kind: "issue" })],
    });
    await assert.rejects(adapter.searchOpenPullRequests(), /open pull request search returned/);
    await adapter.close();
  });

  await t.test("packet claims are mutated after binding", () => {
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage: completeCoverage(),
      claims: [],
      generatedAt,
    });
    packet.coverage[0]!.covered_count = 0;
    assert.throws(
      () => verifyGitcrawlEvidencePacket(packet),
      /digest mismatch|incomplete coverage/,
    );
  });

  await t.test("claims contain unsupported fields", async () => {
    const adapter = await adapterFor({ "gitcrawl.clusters.list": [clusterRow()] });
    const claim = (await adapter.listClusters()).claims[0]!;
    (claim.query as unknown as Record<string, unknown>).ignored = true;
    assert.throws(
      () => verifyGitcrawlEvidenceClaim(claim),
      /query contains unsupported field ignored/,
    );
    await adapter.close();
  });

  await t.test("standalone claims have inconsistent parity bindings", () => {
    const base = {
      repository,
      snapshotId,
      queryName: "gitcrawl.coverage" as const,
      queryArgs: {},
      subject: `${repository}#dataset:threads`,
      data: { dataset: "threads" },
    };
    assert.throws(
      () => createGitcrawlEvidenceClaim({ ...base, provider: "parity" }),
      /missing its local snapshot/,
    );
    assert.throws(
      () =>
        createGitcrawlEvidenceClaim({
          ...base,
          provider: "cloud",
          paritySnapshotId: "d".repeat(64),
        }),
      /non-parity claim has a parity snapshot/,
    );
  });

  await t.test("claim relations have unsupported semantics", () => {
    const base = {
      provider: "cloud" as const,
      repository,
      snapshotId,
      queryName: "gitcrawl.coverage" as const,
      queryArgs: {},
      subject: `${repository}#dataset:threads`,
      data: { dataset: "threads" },
    };
    assert.throws(
      () =>
        createGitcrawlEvidenceClaim({
          ...base,
          relations: [
            {
              predicate: "owns" as "member_of",
              target: `${repository}#dataset:repositories`,
            },
          ],
        }),
      /unsupported Gitcrawl evidence relation/,
    );
    assert.throws(
      () =>
        createGitcrawlEvidenceClaim({
          ...base,
          relations: [{ predicate: "describes", target: " " }],
        }),
      /relation target is missing or malformed/,
    );
  });

  await t.test("packet repository is relabeled", async () => {
    const adapter = await adapterFor({ "gitcrawl.clusters.list": [clusterRow()] });
    const claim = (await adapter.listClusters()).claims[0]!;
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository: "openclaw/other",
          snapshotId,
          coverage: completeCoverage(),
          claims: [claim],
          generatedAt,
        }),
      /mixes claim bindings/,
    );
    await adapter.close();
  });

  await t.test("v2 packet graph is recomputed as empty", async () => {
    const adapter = await adapterFor({ "gitcrawl.clusters.list": [clusterRow()] });
    const claim = (await adapter.listClusters()).claims[0]!;
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage: completeCoverage(),
      claims: [claim],
      generatedAt,
    });
    packet.graph = { nodes: [], edges: [] };
    packet.included = { claims: 1, nodes: 0, edges: 0 };
    const { sha256: _sha256, ...unsigned } = packet;
    packet.sha256 = sha256Canonical(unsigned);
    assert.throws(
      () => verifyGitcrawlEvidencePacket(packet),
      /graph does not match its verified claims/,
    );
    await adapter.close();
  });

  await t.test("packet bounds would discard claims or graph nodes", async () => {
    const adapter = await adapterFor({
      "gitcrawl.clusters.members": [memberRow()],
    });
    const claims = (await adapter.clusterMembers(7)).claims;
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository,
          snapshotId,
          coverage: completeCoverage(),
          claims,
          generatedAt,
          maxNodes: 1,
        }),
      /graph exceeds its complete bounds/,
    );
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository,
          snapshotId,
          coverage: completeCoverage(),
          claims,
          generatedAt,
          maxBytes: 1_024,
        }),
      /packet exceeds 1024 bytes/,
    );
    await adapter.close();
  });

  await t.test("parity hides policy-relevant relationship status", async () => {
    const primary = new FixtureSource({
      provider: "cloud",
      rows: {
        "gitcrawl.clusters.related": [
          { source_number: 42, ...memberRow({ thread_id: 43, number: 43, kind: "issue" }) },
        ],
      },
    });
    const parity = new FixtureSource({
      provider: "local",
      rows: {
        "gitcrawl.clusters.related": [
          {
            source_number: 42,
            ...memberRow({
              thread_id: 43,
              number: 43,
              kind: "issue",
              cluster_status: "closed",
              membership_state: "inactive",
            }),
          },
        ],
      },
    });
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository,
      provider: "parity",
      primarySource: primary,
      paritySource: parity,
      now: () => now,
    });
    await assert.rejects(adapter.related(42), /cloud\/local parity mismatch/);
    await adapter.close();
  });

  await t.test("thread kind is unknown", async () => {
    const adapter = await adapterFor({
      "gitcrawl.clusters.related": [
        { source_number: 42, ...memberRow({ thread_id: 43, number: 43, kind: "discussion" }) },
      ],
    });
    await assert.rejects(adapter.related(42), /unsupported Gitcrawl thread kind/);
    await adapter.close();
  });
});

test("cloud source authenticates, binds identity, and refuses unsafe transport", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const headers: Headers[] = [];
  const source = new CloudGitcrawlQuerySource({
    baseUrl: "https://crawl.example.test",
    archive,
    repository,
    token: "reader-token",
    accessClientId: "access-id",
    accessClientSecret: "access-secret",
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers));
      return jsonResponse(completeCoverage());
    },
  });
  const result = await source.query({
    name: "gitcrawl.coverage",
    args: {},
    limit: 50,
    cursor: "",
    snapshot_id: "",
  });
  assert.equal(result.snapshot.id, snapshotId);
  assert.equal(requests[0]?.contract_version, GITCRAWL_QUERY_CONTRACT_VERSION);
  assert.equal(requests[0]?.repository, repository);
  assert.equal(requests[0]?.archive, archive);
  assert.equal(headers[0]?.get("authorization"), "Bearer reader-token");
  assert.equal(headers[0]?.get("CF-Access-Client-Id"), "access-id");
  assert.equal(headers[0]?.get("CF-Access-Client-Secret"), "access-secret");

  assert.throws(
    () =>
      new CloudGitcrawlQuerySource({
        baseUrl: "http://crawl.example.test",
        archive,
        repository,
        token: "reader-token",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      new CloudGitcrawlQuerySource({
        baseUrl: "https://crawl.example.test",
        archive,
        repository,
      }),
    /requires a bearer token or Cloudflare Access service token/,
  );

  const mismatched = new CloudGitcrawlQuerySource({
    baseUrl: "https://crawl.example.test",
    archive,
    repository,
    token: "reader-token",
    fetch: async () => jsonResponse(completeCoverage(), { archive: "gitcrawl/other__repo" }),
  });
  await assert.rejects(
    mismatched.query({
      name: "gitcrawl.coverage",
      args: {},
      limit: 50,
      cursor: "",
      snapshot_id: "",
    }),
    /mismatched source identity/,
  );
});

test("cloud source does not retry before a long Retry-After window", async () => {
  let requests = 0;
  const sleeps: number[] = [];
  const source = new CloudGitcrawlQuerySource({
    baseUrl: "https://crawl.example.test",
    archive,
    repository,
    token: "reader-token",
    maxAttempts: 2,
    retryMaxDelayMs: 2_000,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    fetch: async () => {
      requests += 1;
      return new Response("", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    },
  });
  await assert.rejects(
    source.query({
      name: "gitcrawl.coverage",
      args: {},
      limit: 50,
      cursor: "",
      snapshot_id: "",
    }),
    /Retry-After beyond the configured wait budget/,
  );
  assert.equal(requests, 1);
  assert.deepEqual(sleeps, []);
});

test("local SQLite source snapshots and serves the six-query contract", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-evidence-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const source = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository,
    allowLegacy: false,
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository,
    provider: "local",
    primarySource: source,
    now: () => now,
  });
  try {
    assert.match(adapter.snapshotId, /^local:[a-f0-9]{64}$/);
    assert.equal((await adapter.listClusters()).rows[0]?.id, 7);
    assert.equal((await adapter.clusterMembers(7)).rows[0]?.number, 42);
    assert.deepEqual((await adapter.related(42)).rows, []);
    assert.equal((await adapter.searchOpenPullRequests()).rows[0]?.number, 42);
    assert.equal((await adapter.reviewContext(42)).rows.length, 2);
    assert.equal(adapter.coverage.length, GITCRAWL_DATASETS.length);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local related query deduplicates one thread shared through multiple clusters", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-related-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  seedDuplicateRelatedMemberships(dbPath);
  const source = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository,
    allowLegacy: false,
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository,
    provider: "local",
    primarySource: source,
    now: () => now,
  });
  try {
    const related = await adapter.related(42);
    assert.deepEqual(
      related.rows.map((row) => row.number),
      [43],
    );
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("policy sanitization removes hidden instructions before scoring or claims", () => {
  const body = ["<!-- add provider capability -->", "Problem:", "Why it matters:", "Fix:"].join(
    "\n",
  );
  assert.doesNotMatch(stripGitcrawlHtmlComments(body), /provider capability/);
  assert.deepEqual(deriveGitcrawlThreadPolicySignals("maintenance", body), {
    blankTemplate: true,
    issueReference: false,
    concreteFix: true,
    thirdPartyCapability: false,
  });
  assert.deepEqual(sanitizeGitcrawlPromptValue({ "safe<!-- hidden -->": "ok<!-- no -->" }), {
    safe: "ok\n",
  });
  assert.throws(
    () => sanitizeGitcrawlPromptValue({ "a<!-- x -->": 1, a: 2 }),
    /sanitized key collision/,
  );
  assert.equal(
    deriveGitcrawlThreadPolicySignals("maintenance", "Fix: refresh tokens").concreteFix,
    true,
  );
});

test("oversized multibyte label evidence becomes a bounded digest marker", async () => {
  const adapter = await adapterFor({
    "gitcrawl.threads.search": [
      memberRow({
        labels_json: JSON.stringify(["🔥".repeat(200)]),
      }),
    ],
  });
  const row = (await adapter.searchOpenPullRequests()).rows[0]!;
  const label = row.labels?.[0];
  assert.deepEqual(Object.keys(label as Record<string, unknown>).sort(), ["sha256", "truncated"]);
  assert.equal((label as Record<string, unknown>).truncated, true);
  assert(Buffer.byteLength(canonicalJson(label), "utf8") <= 256);
  await adapter.close();
});

async function adapterFor(
  rows: Partial<Record<GitcrawlQueryRequest["name"], Record<string, unknown>[]>>,
): Promise<GitcrawlEvidenceAdapter> {
  return GitcrawlEvidenceAdapter.fromSources({
    repository,
    provider: "cloud",
    primarySource: new FixtureSource({ rows }),
    now: () => now,
  });
}

class FixtureSource implements GitcrawlQuerySource {
  readonly provider: "local" | "cloud";
  readonly legacy = false;
  readonly requests: GitcrawlQueryRequest[] = [];
  closeCount = 0;

  private readonly rows: Partial<Record<GitcrawlQueryRequest["name"], Record<string, unknown>[]>>;
  private readonly snapshotForQuery: (request: GitcrawlQueryRequest) => string;

  constructor(
    options: {
      provider?: "local" | "cloud";
      rows?: Partial<Record<GitcrawlQueryRequest["name"], Record<string, unknown>[]>>;
      snapshotForQuery?: (request: GitcrawlQueryRequest) => string;
    } = {},
  ) {
    this.provider = options.provider ?? "cloud";
    this.rows = options.rows ?? {};
    this.snapshotForQuery = options.snapshotForQuery ?? (() => snapshotId);
  }

  async query(request: GitcrawlQueryRequest): Promise<GitcrawlQueryEnvelope> {
    this.requests.push(request);
    const rows =
      request.name === "gitcrawl.coverage" ? completeCoverage() : (this.rows[request.name] ?? []);
    const values = orderRows(request, rows).slice(0, request.limit);
    const querySnapshotId = this.snapshotForQuery(request);
    return {
      values,
      snapshot: snapshotProvenance(querySnapshotId),
      stats: {
        contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        repository,
        archive,
        snapshot_id: querySnapshotId,
        source_sync_at: generatedAt,
        dataset_generated_at: generatedAt,
        coverage_complete: true,
        next_cursor: "",
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function orderRows(
  request: GitcrawlQueryRequest,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (request.name === "gitcrawl.threads.search") {
    const direction = request.args.order === "oldest" ? 1 : -1;
    return [...rows].sort(
      (left, right) =>
        direction *
        (Date.parse(String(left.updated_at_gh ?? "")) -
          Date.parse(String(right.updated_at_gh ?? ""))),
    );
  }
  if (request.name === "gitcrawl.clusters.list") {
    return [...rows].sort(
      (left, right) =>
        Number(right.member_count ?? 0) - Number(left.member_count ?? 0) ||
        Number(left.cluster_id ?? 0) - Number(right.cluster_id ?? 0),
    );
  }
  return rows;
}

function completeCoverage(): GitcrawlCoverageRow[] {
  return GITCRAWL_DATASETS.map((dataset) => ({
    dataset,
    row_count: 1,
    eligible_count: 1,
    covered_count: 1,
    max_source_at: generatedAt,
    dataset_generated_at: generatedAt,
    complete: true,
  }));
}

function clusterRow(): Record<string, unknown> {
  return {
    cluster_id: 7,
    stable_slug: "cluster-7",
    status: "active",
    cluster_type: "duplicate_candidate",
    title: "Provider refresh",
    representative_thread_id: 42,
    representative_number: 42,
    representative_kind: "pull_request",
    representative_state: "open",
    representative_title: "Fix provider refresh",
    member_count: 1,
    created_at: generatedAt,
    updated_at: generatedAt,
    closed_at: "",
  };
}

function memberRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cluster_id: 7,
    cluster_member_count: 1,
    stable_slug: "cluster-7",
    cluster_status: "active",
    role: "representative",
    membership_state: "active",
    score_to_representative: 1,
    thread_id: 42,
    number: 42,
    kind: "pull_request",
    state: "open",
    title: "Fix provider refresh",
    body: "Fixes token refresh after expiry.",
    author_login: "contributor",
    author_type: "User",
    author_association: "CONTRIBUTOR",
    html_url: "https://github.com/openclaw/openclaw/pull/42",
    labels_json: "[]",
    assignees_json: "[]",
    security_metadata_complete: 1,
    is_draft: 0,
    created_at_gh: generatedAt,
    updated_at_gh: generatedAt,
    key_summary: "Fixes token refresh",
    revision_id: 9,
    revision_content_hash: revision,
    revision_source_updated_at: generatedAt,
    fingerprint_algorithm: "thread-fingerprint-v2",
    fingerprint_hash: fingerprint,
    ...overrides,
  };
}

function reviewContextRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    row_kind: "context",
    ...memberRow(),
    cluster_member_count: undefined,
    base_sha: "1".repeat(40),
    head_sha: "2".repeat(40),
    head_ref: "fix/provider-refresh",
    head_repo_full_name: "contributor/openclaw",
    mergeable_state: "clean",
    additions: 5,
    deletions: 2,
    changed_files: 0,
    details_fetched_at: generatedAt,
    details_updated_at: generatedAt,
    cluster_slug: "cluster-7",
    cluster_title: "Provider refresh",
    cluster_role: "representative",
    ...overrides,
  };
}

function reviewFileRow(position: number, filePath: string): Record<string, unknown> {
  return {
    row_kind: "file",
    thread_id: 42,
    file_position: position,
    file_path: filePath,
    file_status: "modified",
    file_additions: 1,
    file_deletions: 1,
    file_changes: 2,
    file_previous_path: "",
    file_fetched_at: generatedAt,
  };
}

function snapshotProvenance(id: string): GitcrawlQueryEnvelope["snapshot"] {
  return {
    id,
    source_sha256: id,
    schema_name: "gitcrawl-cloud-v2",
    schema_version: 2,
    schema_hash: "gitcrawl-cloud-v2",
    capabilities: [...GITCRAWL_QUERY_NAMES],
    source_sync_at: generatedAt,
    dataset_generated_at: generatedAt,
    coverage_complete: true,
    published_at: generatedAt,
    cutover_at: generatedAt,
  };
}

function jsonResponse(
  values: Record<string, unknown>[],
  stats: Record<string, unknown> = {},
): Response {
  const columns = values.length > 0 ? Object.keys(values[0]!) : [];
  return new Response(
    JSON.stringify({
      columns,
      rows: values.map((row) => columns.map((column) => row[column])),
      values,
      snapshot: snapshotProvenance(snapshotId),
      stats: {
        contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        repository,
        archive,
        snapshot_id: snapshotId,
        source_sync_at: generatedAt,
        dataset_generated_at: generatedAt,
        coverage_complete: true,
        next_cursor: "",
        ...stats,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function seedLocalDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table repositories (
      id integer primary key,
      full_name text not null,
      owner text not null,
      name text not null
    );
    create table threads (
      id integer primary key,
      repo_id integer not null,
      number integer not null,
      kind text not null,
      state text not null,
      title text not null,
      body text,
      author_login text not null,
      author_type text not null,
      author_association text not null,
      html_url text not null,
      labels_json text not null,
      assignees_json text not null,
      is_draft integer not null,
      created_at_gh text not null,
      updated_at_gh text not null,
      closed_at_gh text not null,
      merged_at_gh text not null,
      last_pulled_at text not null,
      updated_at text not null
    );
    create table thread_revisions (
      id integer primary key,
      thread_id integer not null,
      source_updated_at text not null,
      content_hash text not null,
      created_at text not null
    );
    create table thread_fingerprints (
      id integer primary key,
      thread_revision_id integer not null,
      algorithm_version text not null,
      fingerprint_hash text not null,
      fingerprint_slug text not null,
      created_at text not null
    );
    create table thread_key_summaries (
      id integer primary key,
      thread_revision_id integer not null,
      key_text text not null,
      created_at text not null
    );
    create table cluster_groups (
      id integer primary key,
      repo_id integer not null,
      stable_key text not null,
      stable_slug text not null,
      status text not null,
      cluster_type text not null,
      representative_thread_id integer not null,
      title text not null,
      created_at text not null,
      updated_at text not null,
      closed_at text not null,
      member_count integer not null
    );
    create table cluster_memberships (
      cluster_id integer not null,
      thread_id integer not null,
      role text not null,
      state text not null,
      score_to_representative real,
      created_at text not null,
      updated_at text not null
    );
    create table pull_request_details (
      thread_id integer primary key,
      base_sha text not null,
      head_sha text not null,
      head_ref text not null,
      head_repo_full_name text not null,
      mergeable_state text not null,
      additions integer not null,
      deletions integer not null,
      changed_files integer not null,
      fetched_at text not null,
      updated_at text not null
    );
    create table pull_request_files (
      thread_id integer not null,
      position integer not null,
      path text not null,
      status text not null,
      additions integer not null,
      deletions integer not null,
      changes integer not null,
      previous_path text not null,
      fetched_at text not null
    );
    create table sync_runs (
      id integer primary key,
      repo_id integer not null,
      scope text not null,
      status text not null,
      started_at text not null,
      finished_at text not null,
      stats_json text not null
    );
    create table portable_metadata (key text primary key, value text not null);
  `);
  db.prepare("insert into repositories values (?, ?, ?, ?)").run(
    1,
    repository,
    "openclaw",
    "openclaw",
  );
  db.prepare(
    `insert into threads(
       id, repo_id, number, kind, state, title, body, author_login, author_type,
       author_association, html_url, labels_json, assignees_json, is_draft,
       created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, last_pulled_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    42,
    1,
    42,
    "pull_request",
    "open",
    "Fix provider refresh",
    "Fixes token refresh after expiry.",
    "contributor",
    "User",
    "CONTRIBUTOR",
    "https://github.com/openclaw/openclaw/pull/42",
    "[]",
    "[]",
    0,
    generatedAt,
    generatedAt,
    "",
    "",
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into thread_revisions values (?, ?, ?, ?, ?)").run(
    9,
    42,
    generatedAt,
    revision,
    generatedAt,
  );
  db.prepare("insert into thread_fingerprints values (?, ?, ?, ?, ?, ?)").run(
    10,
    9,
    "thread-fingerprint-v2",
    fingerprint,
    "fp",
    generatedAt,
  );
  db.prepare("insert into thread_key_summaries values (?, ?, ?, ?)").run(
    11,
    9,
    "Fixes token refresh",
    generatedAt,
  );
  db.prepare("insert into cluster_groups values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    7,
    1,
    "cluster-key",
    "cluster-7",
    "active",
    "duplicate_candidate",
    42,
    "Provider refresh",
    generatedAt,
    generatedAt,
    "",
    1,
  );
  db.prepare("insert into cluster_memberships values (?, ?, ?, ?, ?, ?, ?)").run(
    7,
    42,
    "representative",
    "active",
    1,
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into pull_request_details values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    42,
    "1".repeat(40),
    "2".repeat(40),
    "fix/provider-refresh",
    "contributor/openclaw",
    "clean",
    5,
    2,
    1,
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into pull_request_files values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    42,
    0,
    "src/provider.ts",
    "modified",
    1,
    1,
    2,
    "",
    generatedAt,
  );
  db.prepare("insert into portable_metadata values ('exported_at', ?)").run(generatedAt);
  db.prepare("insert into sync_runs values (?, ?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    "open",
    "success",
    generatedAt,
    generatedAt,
    JSON.stringify({
      repository,
      threads_synced: 1,
      metadata_only: false,
      started_at: generatedAt,
      finished_at: generatedAt,
    }),
  );
  db.close();
}

function seedDuplicateRelatedMemberships(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    insert into threads
    select 43, repo_id, 43, 'issue', state, 'Related provider issue', body,
           author_login, author_type, author_association,
           'https://github.com/openclaw/openclaw/issues/43',
           labels_json, assignees_json, is_draft, created_at_gh, updated_at_gh,
           closed_at_gh, merged_at_gh, last_pulled_at, updated_at
    from threads where id = 42;

    update cluster_groups set member_count = 2 where id = 7;
    insert into cluster_memberships
    values (7, 43, 'member', 'active', 0.8, '${generatedAt}', '${generatedAt}');

    insert into cluster_groups
    values (
      8, 1, 'cluster-key-8', 'cluster-8', 'active', 'duplicate_candidate', 42,
      'Second provider cluster', '${generatedAt}', '${generatedAt}', '', 2
    );
    insert into cluster_memberships
    values (8, 42, 'representative', 'active', 1, '${generatedAt}', '${generatedAt}');
    insert into cluster_memberships
    values (8, 43, 'member', 'active', 0.7, '${generatedAt}', '${generatedAt}');
  `);
  db.close();
}
