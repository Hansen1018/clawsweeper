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
  DEFAULT_EVIDENCE_PACKET_MAX_BYTES,
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
const cloudQueryUrl = `https://crawl.example.test/v1/apps/gitcrawl/archives/${encodeURIComponent(archive)}/query`;

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

  await t.test("coverage rows use another snapshot", async () => {
    const coverage = completeCoverage();
    coverage[0]!.snapshot_id = "d".repeat(64);
    const source = new FixtureSource({ coverage });
    await assert.rejects(
      GitcrawlEvidenceAdapter.fromSources({
        repository,
        provider: "cloud",
        primarySource: source,
        now: () => now,
      }),
      /coverage returned mismatched snapshot/,
    );
    assert.equal(source.closeCount, 1);
  });

  await t.test("source initialization surfaces cleanup failures", async () => {
    const source = new FixtureSource({
      closeError: new Error("fixture close failed"),
    });
    await assert.rejects(
      GitcrawlEvidenceAdapter.fromSources({
        repository,
        provider: "cloud",
        primarySource: source,
        expectedSnapshotId: "d".repeat(64),
        now: () => now,
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => String(entry).includes("fixture close failed")),
    );
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

  await t.test("cluster members belong to a non-active cluster", async () => {
    const adapter = await adapterFor({
      "gitcrawl.clusters.members": [memberRow({ cluster_status: "closed" })],
    });
    await assert.rejects(adapter.clusterMembers(7), /returned a non-active cluster/);
    await adapter.close();
  });

  await t.test("bounded queries reject nonterminal truncation and bind max_rows", async () => {
    const source = new FixtureSource({
      rows: {
        "gitcrawl.clusters.list": [clusterRow(), clusterRow({ cluster_id: 8 })],
      },
    });
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository,
      provider: "cloud",
      primarySource: source,
      pageSize: 1,
      now: () => now,
    });
    await assert.rejects(
      adapter.listClusters({ maxRows: 1 }),
      /truncated a nonterminal result at max_rows=1/,
    );
    const request = source.requests.find(
      (candidate) => candidate.name === "gitcrawl.clusters.list",
    );
    assert.equal(request?.args.max_rows, 1);
    await adapter.close();
  });

  await t.test("overlapping pages cannot satisfy declared membership", async () => {
    const source = new FixtureSource({
      overlapSecondPageFor: "gitcrawl.clusters.members",
      rows: {
        "gitcrawl.clusters.members": [
          memberRow({ cluster_member_count: 2 }),
          memberRow({ cluster_member_count: 2, thread_id: 43, number: 43 }),
        ],
      },
    });
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository,
      provider: "cloud",
      primarySource: source,
      pageSize: 1,
      now: () => now,
    });
    await assert.rejects(adapter.clusterMembers(7), /duplicate row identity/);
    await adapter.close();
  });

  await t.test("replayed canonical threads cannot hide behind provider row ids", async () => {
    const adapter = await adapterFor({
      "gitcrawl.threads.search": [memberRow(), memberRow({ thread_id: 43 })],
    });
    await assert.rejects(adapter.searchOpenPullRequests(), /duplicate row identity/);
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

  await t.test("thread rows require complete safety metadata", async () => {
    for (const incomplete of [
      { security_metadata_complete: 0 },
      { body: undefined },
      { labels_json: undefined },
      { assignees_json: undefined },
      { author_association: undefined },
      { author_login: "" },
      { author_type: "" },
    ]) {
      const adapter = await adapterFor({
        "gitcrawl.threads.search": [memberRow(incomplete)],
      });
      await assert.rejects(adapter.searchOpenPullRequests(), /security metadata/);
      await adapter.close();
    }
  });

  await t.test("thread rows bind repository, kind, and number to their URL", async () => {
    for (const mismatched of [
      { html_url: "https://github.com/openclaw/other/pull/42" },
      { kind: "issue", html_url: "https://github.com/openclaw/openclaw/pull/42" },
      { number: 43, html_url: "https://github.com/openclaw/openclaw/pull/42" },
    ]) {
      const adapter = await adapterFor({
        "gitcrawl.threads.search": [memberRow(mismatched)],
      });
      await assert.rejects(adapter.searchOpenPullRequests(), /thread identity does not match/);
      await adapter.close();
    }
  });

  await t.test("packet claims are mutated after binding", () => {
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage: completeCoverage(),
      requiredCoverage: ["repositories", "threads"],
      claims: [],
      generatedAt,
    });
    packet.coverage[0]!.covered_count = 0;
    assert.throws(
      () => verifyGitcrawlEvidencePacket(packet),
      /digest mismatch|incomplete coverage|invalid complete coverage/,
    );
  });

  await t.test("packets and coverage rows reject unsupported fields", () => {
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage: completeCoverage(),
      requiredCoverage: ["repositories", "threads"],
      claims: [],
      generatedAt,
    });
    (packet as unknown as Record<string, unknown>).ignored = true;
    let { sha256: _sha256, ...unsigned } = packet as unknown as Record<string, unknown>;
    packet.sha256 = sha256Canonical(unsigned);
    assert.throws(
      () => verifyGitcrawlEvidencePacket(packet),
      /packet contains unsupported field ignored/,
    );

    delete (packet as unknown as Record<string, unknown>).ignored;
    (packet.coverage[0] as unknown as Record<string, unknown>).ignored = true;
    ({ sha256: _sha256, ...unsigned } = packet as unknown as Record<string, unknown>);
    packet.sha256 = sha256Canonical(unsigned);
    assert.throws(
      () => verifyGitcrawlEvidencePacket(packet),
      /coverage row contains unsupported field ignored/,
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
    assert.throws(
      () =>
        createGitcrawlEvidenceClaim({
          ...base,
          subject: "openclaw/other#dataset:threads",
        }),
      /claim subject is missing or malformed/,
    );
    assert.throws(
      () =>
        createGitcrawlEvidenceClaim({
          ...base,
          relations: [
            {
              predicate: "describes",
              target: "openclaw/other#dataset:repositories",
            },
          ],
        }),
      /relation target is missing or malformed/,
    );
  });

  await t.test("source revision metadata is canonical", () => {
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
          sourceRevision: { id: -1, updated_at: generatedAt },
        }),
      /id must be a positive safe integer/,
    );
    assert.throws(
      () =>
        createGitcrawlEvidenceClaim({
          ...base,
          sourceRevision: { id: 1, updated_at: "not-a-timestamp" },
        }),
      /source revision updated_at is invalid/,
    );
  });

  await t.test("claims reject non-JSON object values", () => {
    const base = {
      provider: "cloud" as const,
      repository,
      snapshotId,
      queryName: "gitcrawl.coverage" as const,
      queryArgs: {},
      subject: `${repository}#dataset:threads`,
    };
    assert.throws(
      () => createGitcrawlEvidenceClaim({ ...base, data: { observed_at: new Date(generatedAt) } }),
      /canonical JSON rejects non-plain objects/,
    );
  });

  await t.test("packet coverage is bound to its snapshot", () => {
    const coverage = completeCoverage();
    coverage[0]!.snapshot_id = "d".repeat(64);
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository,
          snapshotId,
          coverage,
          requiredCoverage: ["repositories", "threads"],
          claims: [],
          generatedAt,
        }),
      /mixes coverage snapshots/,
    );
  });

  await t.test("incomplete packet coverage cannot exceed total rows", () => {
    const coverage = completeCoverage();
    const clusterCoverage = coverage.find((row) => row.dataset === "cluster_groups");
    assert(clusterCoverage);
    clusterCoverage.row_count = 1;
    clusterCoverage.eligible_count = 2;
    clusterCoverage.covered_count = 0;
    clusterCoverage.complete = false;
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository,
          snapshotId,
          coverage,
          requiredCoverage: ["repositories", "threads"],
          claims: [],
          generatedAt,
        }),
      /more eligible rows than total rows/,
    );
  });

  await t.test("packet generation is an RFC 3339 timestamp", () => {
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository,
          snapshotId,
          coverage: completeCoverage(),
          requiredCoverage: ["repositories", "threads"],
          claims: [],
          generatedAt: "not-a-timestamp",
        }),
      /packet generated_at is invalid/,
    );
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage: completeCoverage(),
      requiredCoverage: ["repositories", "threads"],
      claims: [],
      generatedAt,
    });
    packet.generated_at = "not-a-timestamp";
    const { sha256: _sha256, ...unsigned } = packet;
    packet.sha256 = sha256Canonical(unsigned);
    assert.throws(() => verifyGitcrawlEvidencePacket(packet), /packet generated_at is invalid/);
  });

  await t.test("packet coverage defaults to the included claim queries", () => {
    const coverage = completeCoverage();
    const unrelated = coverage.find((row) => row.dataset === "cluster_groups");
    assert(unrelated);
    unrelated.covered_count = 0;
    unrelated.complete = false;
    const claim = createGitcrawlEvidenceClaim({
      provider: "cloud",
      repository,
      snapshotId,
      queryName: "gitcrawl.threads.search",
      queryArgs: { owner: "openclaw", repo: "openclaw" },
      subject: `${repository}#pull:42`,
      data: memberRow(),
    });
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage,
      claims: [claim],
      generatedAt,
    });
    assert.deepEqual(packet.required_coverage, ["repositories", "threads"]);
    assert.doesNotThrow(() => verifyGitcrawlEvidencePacket(packet));
    assert.throws(
      () =>
        buildGitcrawlEvidencePacket({
          provider: "cloud",
          repository,
          snapshotId,
          coverage,
          claims: [],
          generatedAt,
        }),
      /without claims require explicit coverage/,
    );
  });

  await t.test("packets reject duplicate canonical claims", () => {
    const base = {
      provider: "cloud" as const,
      repository,
      snapshotId,
      queryName: "gitcrawl.threads.search" as const,
      queryArgs: { owner: "openclaw", repo: "openclaw" },
      subject: `${repository}#pull:42`,
    };
    const claim = createGitcrawlEvidenceClaim({
      ...base,
      data: memberRow(),
    });
    const conflicting = createGitcrawlEvidenceClaim({
      ...base,
      data: memberRow({ title: "Conflicting title" }),
    });
    const packetInput = {
      provider: "cloud" as const,
      repository,
      snapshotId,
      coverage: completeCoverage(),
      generatedAt,
    };
    assert.throws(
      () => buildGitcrawlEvidencePacket({ ...packetInput, claims: [claim, claim] }),
      /repeats claim/,
    );
    assert.throws(
      () => buildGitcrawlEvidencePacket({ ...packetInput, claims: [claim, conflicting] }),
      /conflicting claims/,
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

  await t.test("packet verification bounds input before canonicalization", () => {
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository,
      snapshotId,
      coverage: completeCoverage(),
      requiredCoverage: ["repositories", "threads"],
      claims: [],
      generatedAt,
    });
    packet.coverage[0]!.max_source_at = "x".repeat(DEFAULT_EVIDENCE_PACKET_MAX_BYTES);
    assert.throws(() => verifyGitcrawlEvidencePacket(packet), /packet exceeds 65536 bytes/);
    assert.throws(
      () => verifyGitcrawlEvidencePacket(packet, DEFAULT_EVIDENCE_PACKET_MAX_BYTES + 1),
      /packet limit must be an integer from 1 to 65536/,
    );
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

  await t.test("parity reverses an ordered result", async () => {
    const first = memberRow({ cluster_member_count: 2 });
    const second = memberRow({
      cluster_member_count: 2,
      thread_id: 43,
      number: 43,
      updated_at_gh: "2026-07-14T09:54:00.000Z",
    });
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository,
      provider: "parity",
      primarySource: new FixtureSource({
        provider: "cloud",
        rows: { "gitcrawl.clusters.members": [first, second] },
      }),
      paritySource: new FixtureSource({
        provider: "local",
        rows: { "gitcrawl.clusters.members": [second, first] },
      }),
      now: () => now,
    });
    await assert.rejects(adapter.clusterMembers(7), /cloud\/local parity mismatch/);
    await adapter.close();
  });

  await t.test("cluster and thread timestamps are canonical", async () => {
    const clusters = await adapterFor({
      "gitcrawl.clusters.list": [clusterRow({ created_at: "not-a-timestamp" })],
    });
    await assert.rejects(clusters.listClusters(), /cluster created_at is invalid/);
    await clusters.close();

    const threads = await adapterFor({
      "gitcrawl.threads.search": [memberRow({ created_at_gh: "not-a-timestamp" })],
    });
    await assert.rejects(threads.searchOpenPullRequests(), /thread created_at is invalid/);
    await threads.close();
  });

  await t.test("non-active cluster scopes are not certified", async () => {
    const adapter = await adapterFor({ "gitcrawl.clusters.list": [clusterRow()] });
    await assert.rejects(
      adapter.listClusters({ status: "all" }),
      /certifies only active cluster queries/,
    );
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
      return cloudResponse(
        new Response("", {
          status: 429,
          headers: { "retry-after": "60" },
        }),
      );
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

test("cloud source rejects redirects without retrying authenticated requests", async () => {
  let requests = 0;
  const sleeps: number[] = [];
  const source = new CloudGitcrawlQuerySource({
    baseUrl: "https://crawl.example.test",
    archive,
    repository,
    token: "reader-token",
    maxAttempts: 3,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    fetch: async () => {
      requests += 1;
      return cloudResponse(
        new Response("", {
          status: 302,
          headers: { location: "https://other.example.test/query" },
        }),
      );
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
    /refused a redirected response/,
  );
  assert.equal(requests, 1);
  assert.deepEqual(sleeps, []);
});

test("cloud source requires exact successful status, origin metadata, and strict UTF-8", async () => {
  const request = {
    name: "gitcrawl.coverage" as const,
    args: {},
    limit: 50,
    cursor: "",
    snapshot_id: "",
  };
  for (const [response, pattern] of [
    [cloudResponse(new Response("{}", { status: 202 })), /failed \(202;/],
    [new Response("{}", { status: 200 }), /missing origin metadata/],
    [
      cloudResponse(
        new Response(Uint8Array.from([0xc3, 0x28]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
      /malformed UTF-8/,
    ],
  ] as const) {
    const source = new CloudGitcrawlQuerySource({
      baseUrl: "https://crawl.example.test",
      archive,
      repository,
      token: "reader-token",
      fetch: async () => response,
    });
    await assert.rejects(source.query(request), pattern);
  }
});

test("cloud source validates request JSON before retrying and ignores malformed Retry-After", async () => {
  let serializationRequests = 0;
  const serializationSource = new CloudGitcrawlQuerySource({
    baseUrl: "https://crawl.example.test",
    archive,
    repository,
    token: "reader-token",
    fetch: async () => {
      serializationRequests += 1;
      return jsonResponse(completeCoverage());
    },
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    serializationSource.query({
      name: "gitcrawl.coverage",
      args: circular,
      limit: 50,
      cursor: "",
      snapshot_id: "",
    }),
    /request is not JSON serializable/,
  );
  assert.equal(serializationRequests, 0);

  let retryRequests = 0;
  const sleeps: number[] = [];
  const retrySource = new CloudGitcrawlQuerySource({
    baseUrl: "https://crawl.example.test",
    archive,
    repository,
    token: "reader-token",
    maxAttempts: 2,
    retryBaseDelayMs: 25,
    retryMaxDelayMs: 100,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    fetch: async () => {
      retryRequests += 1;
      return retryRequests === 1
        ? cloudResponse(new Response("", { status: 429, headers: { "retry-after": "tomorrow" } }))
        : jsonResponse(completeCoverage());
    },
  });
  await retrySource.query({
    name: "gitcrawl.coverage",
    args: {},
    limit: 50,
    cursor: "",
    snapshot_id: "",
  });
  assert.equal(retryRequests, 2);
  assert.deepEqual(sleeps, [25]);
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

test("local PR file aggregation is scoped to the selected repository", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-multi-repo-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  seedUnrelatedRepositoryFiles(dbPath);
  const localSource = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository,
    allowLegacy: false,
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository,
    provider: "local",
    primarySource: localSource,
    now: () => now,
  });
  try {
    const fileCoverage = adapter.coverage.find((row) => row.dataset === "pull_request_files");
    assert.deepEqual(fileCoverage, {
      snapshot_id: adapter.snapshotId,
      dataset: "pull_request_files",
      row_count: 1,
      eligible_count: 1,
      covered_count: 1,
      max_source_at: generatedAt,
      dataset_generated_at: generatedAt,
      complete: true,
    });
    assert.equal((await adapter.reviewContext(42)).rows.length, 2);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local close removes its snapshot when database close fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-close-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const source = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository,
    allowLegacy: false,
  });
  const internals = source as unknown as {
    db: { close: () => void };
    tempDir: string;
  };
  const originalClose = internals.db.close.bind(internals.db);
  const closeError = new Error("fixture database close failed");
  internals.db.close = () => {
    originalClose();
    throw closeError;
  };
  try {
    await assert.rejects(source.close(), (error: unknown) => error === closeError);
    assert.equal(fs.existsSync(internals.tempDir), false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local coverage rejects active clusters without valid memberships", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-coverage-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("delete from cluster_memberships");
  db.close();
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
    await assert.rejects(adapter.listClusters(), /cluster_groups coverage is incomplete/);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local portable export timestamps are not source freshness proof", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-export-age-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("drop table sync_runs");
  db.prepare("update portable_metadata set value = ? where key = 'exported_at'").run(
    now.toISOString(),
  );
  db.close();
  const source = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository,
    allowLegacy: false,
  });
  try {
    await assert.rejects(
      GitcrawlEvidenceAdapter.fromSources({
        repository,
        provider: "local",
        primarySource: source,
        now: () => now,
      }),
      /source sync timestamp is invalid/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local portable cluster coverage requires explicit run provenance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-portable-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    drop table cluster_runs;
    drop table sync_runs;
    create table repo_sync_state (
      repo_id integer primary key,
      last_full_open_scan_started_at text not null,
      last_overlapping_open_scan_completed_at text not null,
      last_non_overlapping_scan_completed_at text not null,
      last_open_close_reconciled_at text not null
    );
  `);
  db.prepare("insert into repo_sync_state values (?, ?, ?, ?, ?)").run(
    1,
    generatedAt,
    generatedAt,
    generatedAt,
    generatedAt,
  );
  db.close();
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
    assert.equal(adapter.provenance.source_sync_at, generatedAt);
    assert.equal(adapter.provenance.dataset_generated_at, generatedAt);
    await assert.rejects(adapter.listClusters(), /cluster_groups coverage is incomplete/);
    await assert.rejects(adapter.clusterMembers(7), /cluster_groups coverage is incomplete/);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local cluster coverage requires the latest successful run", async (t) => {
  for (const scenario of ["missing", "stale", "predates-source"] as const) {
    await t.test(scenario, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-run-"));
      const dbPath = path.join(directory, "gitcrawl.db");
      seedLocalDatabase(dbPath);
      const db = new DatabaseSync(dbPath);
      if (scenario === "missing") {
        db.exec("delete from cluster_runs");
      } else if (scenario === "stale") {
        db.prepare("insert into cluster_runs values (?, ?, ?, ?, ?, ?, ?)").run(
          2,
          1,
          "open",
          "success",
          generatedAt,
          generatedAt,
          "{}",
        );
      } else {
        const sourceAt = "2026-07-14T09:56:00.000Z";
        const clusterFinishedAt = "2026-07-14T09:57:00.000Z";
        db.prepare(
          `update sync_runs
           set started_at = ?, finished_at = ?, stats_json = ?
           where repo_id = ?`,
        ).run(
          sourceAt,
          sourceAt,
          JSON.stringify({
            repository,
            threads_synced: 1,
            metadata_only: false,
            started_at: sourceAt,
            finished_at: sourceAt,
          }),
          1,
        );
        db.prepare("update portable_metadata set value = ? where key = 'exported_at'").run(
          sourceAt,
        );
        db.prepare("update cluster_runs set finished_at = ? where repo_id = ?").run(
          clusterFinishedAt,
          1,
        );
      }
      db.close();
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
        await assert.rejects(adapter.listClusters(), /cluster_groups coverage is incomplete/);
      } finally {
        await adapter.close();
        fs.rmSync(directory, { force: true, recursive: true });
      }
    });
  }
});

test("local evidence follows accepted observation order at equal timestamps", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-observation-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    update threads
    set observation_sequence = 2,
        evidence_observation_sequence = 2
    where id = 42
  `);
  db.close();
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
    const thread = (await adapter.searchOpenPullRequests()).rows[0]!;
    assert.deepEqual(thread.sourceRevision, { updated_at: generatedAt });
    assert.equal(thread.threadFingerprint, undefined);
    assert.equal(thread.keySummary, "");
    await assert.rejects(adapter.reviewContext(42), /pull_request_details coverage is incomplete/);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local PR file coverage requires its own current child reservation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-files-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    update threads
    set observation_sequence = 2,
        evidence_observation_sequence = 2
    where id = 42;
    update thread_child_observation_reservations
    set observation_sequence = 2
    where thread_id = 42 and family = 'pull_request_details';
  `);
  db.close();
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
    await assert.rejects(adapter.reviewContext(42), /pull_request_files coverage is incomplete/);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local PR details require canonical repository and number identity", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-pr-identity-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("update pull_request_details set number = 43 where thread_id = 42");
  db.close();
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
    await assert.rejects(adapter.reviewContext(42), /pull_request_details coverage is incomplete/);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("local related query ignores memberships in closed clusters", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-query-closed-related-"));
  const dbPath = path.join(directory, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  seedClosedRelatedMembership(dbPath);
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
    assert.deepEqual((await adapter.related(42)).rows, []);
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
  assert.equal(
    deriveGitcrawlThreadPolicySignals("Add<!-- hidden -->provider", "").thirdPartyCapability,
    true,
  );
  assert.equal(
    deriveGitcrawlThreadPolicySignals("Refactor", "<!-- references #42 -->").issueReference,
    false,
  );
  assert.equal(
    stripGitcrawlHtmlComments("safe<!-- outer <!-- nested --> hidden -->tail"),
    "safe\ntail",
  );
});

test("search and review evidence must agree on one thread safety projection", async () => {
  const adapter = await adapterFor({
    "gitcrawl.threads.search": [memberRow()],
    "gitcrawl.pull_requests.review_context": [
      reviewContextRow({ body: "Different review body", thread_id: 43 }),
    ],
  });
  await adapter.searchOpenPullRequests();
  await assert.rejects(adapter.reviewContext(42), /search and review safety projections diverge/);
  await adapter.close();
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
  private readonly coverage: GitcrawlCoverageRow[];
  private readonly snapshotForQuery: (request: GitcrawlQueryRequest) => string;
  private readonly overlapSecondPageFor: GitcrawlQueryRequest["name"] | undefined;
  private readonly closeError: Error | undefined;

  constructor(
    options: {
      provider?: "local" | "cloud";
      rows?: Partial<Record<GitcrawlQueryRequest["name"], Record<string, unknown>[]>>;
      coverage?: GitcrawlCoverageRow[];
      snapshotForQuery?: (request: GitcrawlQueryRequest) => string;
      overlapSecondPageFor?: GitcrawlQueryRequest["name"];
      closeError?: Error;
    } = {},
  ) {
    this.provider = options.provider ?? "cloud";
    this.rows = options.rows ?? {};
    this.coverage = options.coverage ?? completeCoverage();
    this.snapshotForQuery = options.snapshotForQuery ?? (() => snapshotId);
    this.overlapSecondPageFor = options.overlapSecondPageFor;
    this.closeError = options.closeError;
  }

  async query(request: GitcrawlQueryRequest): Promise<GitcrawlQueryEnvelope> {
    this.requests.push(request);
    const rows =
      request.name === "gitcrawl.coverage" ? this.coverage : (this.rows[request.name] ?? []);
    const requestedOffset = request.cursor ? Number(request.cursor) : 0;
    const offset =
      request.name === this.overlapSecondPageFor && requestedOffset > 0
        ? requestedOffset - 1
        : requestedOffset;
    const ordered = orderRows(request, rows);
    const values = ordered.slice(offset, offset + request.limit);
    const nextOffset = requestedOffset + values.length;
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
        next_cursor: nextOffset < ordered.length ? String(nextOffset) : "",
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError !== undefined) throw this.closeError;
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
    snapshot_id: snapshotId,
    dataset,
    row_count: 1,
    eligible_count: 1,
    covered_count: 1,
    max_source_at: generatedAt,
    dataset_generated_at: generatedAt,
    complete: true,
  }));
}

function clusterRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

function memberRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const number = Number(overrides.number ?? 42);
  const kind = String(overrides.kind ?? "pull_request");
  return {
    cluster_id: 7,
    cluster_member_count: 1,
    stable_slug: "cluster-7",
    cluster_status: "active",
    role: "representative",
    membership_state: "active",
    score_to_representative: 1,
    thread_id: 42,
    number,
    kind,
    state: "open",
    title: "Fix provider refresh",
    body: "Fixes token refresh after expiry.",
    author_login: "contributor",
    author_type: "User",
    author_association: "CONTRIBUTOR",
    html_url: `https://github.com/openclaw/openclaw/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
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
  return cloudResponse(
    new Response(
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
    ),
  );
}

function cloudResponse(response: Response, url = cloudQueryUrl): Response {
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
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
      observation_sequence integer not null,
      evidence_observation_sequence integer not null,
      evidence_source_updated_at text not null,
      updated_at text not null
    );
    create table thread_revisions (
      id integer primary key,
      thread_id integer not null,
      source_updated_at text not null,
      content_hash text not null,
      observation_sequence integer not null,
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
      first_seen_run_id integer,
      last_seen_run_id integer,
      created_at text not null,
      updated_at text not null
    );
    create table pull_request_details (
      thread_id integer primary key,
      repo_id integer not null,
      number integer not null,
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
    create table cluster_runs (
      id integer primary key,
      repo_id integer not null,
      scope text not null,
      status text not null,
      started_at text not null,
      finished_at text not null,
      stats_json text not null
    );
    create table thread_child_observation_reservations (
      thread_id integer not null,
      family text not null,
      source_updated_at text not null,
      observation_sequence integer not null,
      primary key (thread_id, family)
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
       created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, last_pulled_at,
       observation_sequence, evidence_observation_sequence, evidence_source_updated_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    1,
    1,
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into thread_revisions values (?, ?, ?, ?, ?, ?)").run(
    9,
    42,
    generatedAt,
    revision,
    1,
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
  db.prepare("insert into cluster_memberships values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    7,
    42,
    "representative",
    "active",
    1,
    1,
    1,
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into pull_request_details values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    42,
    1,
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
  db.prepare("insert into cluster_runs values (?, ?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    "open",
    "success",
    generatedAt,
    generatedAt,
    "{}",
  );
  db.prepare("insert into thread_child_observation_reservations values (?, ?, ?, ?)").run(
    42,
    "pull_request_details",
    generatedAt,
    1,
  );
  db.prepare("insert into thread_child_observation_reservations values (?, ?, ?, ?)").run(
    42,
    "pull_request_files",
    generatedAt,
    1,
  );
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
           closed_at_gh, merged_at_gh, last_pulled_at, observation_sequence,
           evidence_observation_sequence, evidence_source_updated_at, updated_at
    from threads where id = 42;

    update cluster_groups set member_count = 2 where id = 7;
    insert into cluster_memberships
    values (7, 43, 'member', 'active', 0.8, 1, 1, '${generatedAt}', '${generatedAt}');

    insert into cluster_groups
    values (
      8, 1, 'cluster-key-8', 'cluster-8', 'active', 'duplicate_candidate', 42,
      'Second provider cluster', '${generatedAt}', '${generatedAt}', '', 2
    );
    insert into cluster_memberships
    values (8, 42, 'representative', 'active', 1, 1, 1, '${generatedAt}', '${generatedAt}');
    insert into cluster_memberships
    values (8, 43, 'member', 'active', 0.7, 1, 1, '${generatedAt}', '${generatedAt}');
  `);
  db.close();
}

function seedUnrelatedRepositoryFiles(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("insert into repositories values (?, ?, ?, ?)").run(
    2,
    "openclaw/other",
    "openclaw",
    "other",
  );
  db.exec(`
    insert into threads
    select 84, 2, 84, 'pull_request', state, 'Unrelated provider change', body,
           author_login, author_type, author_association,
           'https://github.com/openclaw/other/pull/84',
           labels_json, assignees_json, is_draft, created_at_gh, updated_at_gh,
           closed_at_gh, merged_at_gh, last_pulled_at, observation_sequence,
           evidence_observation_sequence, evidence_source_updated_at, updated_at
    from threads where id = 42;

    insert into pull_request_details
    select 84, 2, 84, base_sha, head_sha, head_ref, 'contributor/other', mergeable_state,
           additions, deletions, 2, fetched_at, updated_at
    from pull_request_details where thread_id = 42;

    insert into pull_request_files
    select 84, 0, 'src/unrelated-a.ts', status, additions, deletions, changes,
           previous_path, fetched_at
    from pull_request_files where thread_id = 42;

    insert into pull_request_files
    select 84, 1, 'src/unrelated-b.ts', status, additions, deletions, changes,
           previous_path, fetched_at
    from pull_request_files where thread_id = 42;
  `);
  db.close();
}

function seedClosedRelatedMembership(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    insert into threads
    select 43, repo_id, 43, 'issue', 'closed', 'Related provider issue', body,
           author_login, author_type, author_association,
           'https://github.com/openclaw/openclaw/issues/43',
           labels_json, assignees_json, is_draft, created_at_gh, updated_at_gh,
           closed_at_gh, merged_at_gh, last_pulled_at, observation_sequence,
           evidence_observation_sequence, evidence_source_updated_at, updated_at
    from threads where id = 42;

    insert into cluster_groups
    values (
      8, 1, 'cluster-key-8', 'cluster-8', 'closed', 'duplicate_candidate', 42,
      'Closed provider cluster', '${generatedAt}', '${generatedAt}', '${generatedAt}', 2
    );
    insert into cluster_memberships
    values (8, 42, 'representative', 'active', 1, 1, 1, '${generatedAt}', '${generatedAt}');
    insert into cluster_memberships
    values (8, 43, 'member', 'active', 0.7, 1, 1, '${generatedAt}', '${generatedAt}');
  `);
  db.close();
}
