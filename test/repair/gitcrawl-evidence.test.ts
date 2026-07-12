import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

import { GitcrawlEvidenceAdapter } from "../../dist/repair/gitcrawl-evidence-adapter.js";
import {
  __setGitcrawlEvidenceArchiveTestHooks,
  moveGitcrawlEvidenceNoClobber,
} from "../../dist/repair/gitcrawl-evidence-archive.js";
import {
  GITCRAWL_DATASETS,
  GITCRAWL_PACKET_VERSION,
  GITCRAWL_PACKET_VERSION_V1,
  GITCRAWL_QUERY_CONTRACT_VERSION,
  type GitcrawlCoverageRow,
  type GitcrawlQueryEnvelope,
  type GitcrawlQueryRequest,
  type GitcrawlQuerySource,
  canonicalJson,
  createGitcrawlEvidenceClaim,
  gitcrawlQueryDigest,
  sha256Canonical,
} from "../../dist/repair/gitcrawl-evidence-contract.js";
import {
  buildGitcrawlEvidencePacket,
  renderGitcrawlEvidencePacket,
  verifyEmbeddedGitcrawlEvidencePacket,
  verifyGitcrawlEvidenceJobTargets,
  verifyGitcrawlEvidencePacket,
} from "../../dist/repair/gitcrawl-evidence-graph.js";
import { LocalGitcrawlQuerySource } from "../../dist/repair/gitcrawl-evidence-local.js";
import {
  __setGitcrawlEvidenceMigrationTestHooks,
  inventoryGitcrawlEvidenceMigration,
} from "../../dist/repair/gitcrawl-evidence-migration.js";
import {
  __setGitcrawlJobPublicationTestHooks,
  publishGitcrawlGeneratedJob,
} from "../../dist/repair/gitcrawl-job-publication.js";
import {
  assertGitcrawlThreadSafetyProjectionMatches,
  deriveGitcrawlThreadPolicySignals,
  stripGitcrawlHtmlComments,
} from "../../dist/repair/gitcrawl-evidence-policy.js";
import { fsyncGitcrawlDirectory } from "../../dist/repair/gitcrawl-filesystem.js";
import {
  __setGitcrawlCursorLockTestHooks,
  compatibleGitcrawlScanCursor,
  readGitcrawlScanCursor,
  readGitcrawlScanOffset,
  writeGitcrawlScanOffset as writeGitcrawlScanOffsetRaw,
} from "../../dist/repair/gitcrawl-scan-cursor.js";
import { parseJob, parseSimpleYaml, renderPrompt, validateJob } from "../../dist/repair/lib.js";

const now = new Date("2026-07-12T12:00:00.000Z");
const generatedAt = "2026-07-12T11:55:00.000Z";
const snapshotId = "snapshot-a";
const fingerprint = "a".repeat(64);
const revision = "b".repeat(64);
const queryDigest = "c".repeat(64);
const archiveId = "fixture";
const clusterListQueryDigest = gitcrawlQueryDigest("gitcrawl.clusters.list", {
  owner: "openclaw",
  repo: "openclaw",
  status: "active",
  min_size: 1,
});
const oldestPullRequestQueryDigest = gitcrawlQueryDigest("gitcrawl.threads.search", {
  owner: "openclaw",
  repo: "openclaw",
  query: "",
  kind: "pull_request",
  state: "open",
  order: "oldest",
});

function writeGitcrawlScanOffset(
  input: Omit<Parameters<typeof writeGitcrawlScanOffsetRaw>[0], "archive"> & {
    archive?: string;
  },
): void {
  writeGitcrawlScanOffsetRaw({
    ...input,
    archive: input.archive ?? archiveId,
  });
}

test("Gitcrawl evidence rejects stale snapshots", async () => {
  const source = new FixtureSource({
    sourceSyncAt: "2026-07-11T00:00:00.000Z",
  });
  await assert.rejects(
    GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "cloud",
      primarySource: source,
      now: () => now,
      maxSnapshotAgeMs: 60 * 60 * 1000,
    }),
    /source sync is stale/,
  );
});

test("Gitcrawl evidence closes owned sources when adapter options are invalid", async () => {
  const primary = new FixtureSource();
  const parity = new FixtureSource({ provider: "local" });
  await assert.rejects(
    GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "parity",
      primarySource: primary,
      paritySource: parity,
      pageSize: 0,
      now: () => now,
    }),
    /page size must be positive/,
  );
  assert.equal(primary.closeCount, 1);
  assert.equal(parity.closeCount, 1);
});

test("Gitcrawl evidence closes each owned source only once", async () => {
  const primary = new FixtureSource();
  const parity = new FixtureSource({ provider: "local" });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: primary,
    paritySource: parity,
    now: () => now,
  });
  await Promise.all([adapter.close(), adapter.close(), adapter.close()]);
  assert.equal(primary.closeCount, 1);
  assert.equal(parity.closeCount, 1);
});

test("Gitcrawl evidence scopes incomplete coverage to the consuming operation", async () => {
  const coverage = completeCoverage();
  coverage.find((row) => row.dataset === "pull_request_details")!.complete = false;
  coverage.find((row) => row.dataset === "pull_request_details")!.covered_count = 0;
  coverage.find((row) => row.dataset === "pull_request_details")!.eligible_count = 1;
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      coverage,
      rows: { "gitcrawl.clusters.list": [clusterRow(1)] },
    }),
    now: () => now,
  });
  assert.equal((await adapter.listClusters()).rows.length, 1);
  await assert.rejects(adapter.reviewContext(42), /pull_request_details coverage is incomplete/);
  await adapter.close();
});

test("Gitcrawl evidence rejects mixed coverage generations", async () => {
  const coverage = completeCoverage();
  coverage[3]!.dataset_generated_at = "2026-07-12T11:54:00.000Z";
  await assert.rejects(
    GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "cloud",
      primarySource: new FixtureSource({ coverage }),
      now: () => now,
    }),
    /mixes dataset generations/,
  );
});

test("Gitcrawl evidence rejects mixed snapshots after coverage", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.clusters.list": [clusterRow(1)],
    },
    snapshotForQuery: (request) =>
      request.name === "gitcrawl.coverage" ? snapshotId : "snapshot-b",
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    now: () => now,
  });
  await assert.rejects(adapter.listClusters(), /mixed snapshot generation/);
  await adapter.close();
});

test("Gitcrawl evidence pins archive identity after coverage", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.clusters.list": [clusterRow(1)],
    },
    archiveForQuery: (request) =>
      request.name === "gitcrawl.coverage" ? "fixture" : "replacement",
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    now: () => now,
  });
  await assert.rejects(adapter.listClusters(), /mixed snapshot generation/);
  await adapter.close();
});

test("Gitcrawl evidence rejects cursor replay", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.clusters.list": [clusterRow(1), clusterRow(2), clusterRow(3)],
    },
    nextCursor: ({ request, defaultCursor }) =>
      request.name === "gitcrawl.clusters.list" && request.cursor ? request.cursor : defaultCursor,
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    pageSize: 1,
    now: () => now,
  });
  await assert.rejects(adapter.listClusters({ maxRows: 2 }), /cursor drift detected/);
  await adapter.close();
});

test("Gitcrawl evidence bounds cluster discovery before the page ceiling", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.clusters.list": Array.from({ length: 20 }, (_, index) => clusterRow(index + 1)),
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    pageSize: 2,
    maxPages: 5,
    now: () => now,
  });
  assert.deepEqual(
    (await adapter.listClusters({ maxRows: 3 })).rows.map((row) => row.id),
    [1, 2, 3],
  );
  await adapter.close();
});

test("Gitcrawl evidence windows expose provider cursors alongside ordinal progress", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.clusters.list": Array.from({ length: 5 }, (_, index) => clusterRow(index + 1)),
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    pageSize: 1,
    maxPages: 20,
    now: () => now,
  });
  const middle = await adapter.listClustersWindow({ offset: 2, maxRows: 2 });
  assert.deepEqual(
    middle.rows.map((row) => row.id),
    [3, 4],
  );
  assert.equal(middle.nextOffset, 4);
  assert.equal(middle.nextProviderCursor, "cursor-4");
  assert.equal(middle.exhausted, false);

  const tail = await adapter.listClustersWindow({ offset: middle.nextOffset, maxRows: 2 });
  assert.deepEqual(
    tail.rows.map((row) => row.id),
    [5],
  );
  assert.equal(tail.nextOffset, 0);
  assert.equal(tail.exhausted, true);
  await adapter.close();
});

test("Gitcrawl evidence resumes beyond the page ceiling from a snapshot-bound provider cursor", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.clusters.list": Array.from({ length: 105 }, (_, index) => clusterRow(index + 1)),
      },
    }),
    pageSize: 10,
    maxPages: 2,
    now: () => now,
  });
  const resumed = await adapter.listClustersWindow({
    offset: 100,
    maxRows: 2,
    resume: {
      offset: 100,
      archive: archiveId,
      snapshotId,
      providerCursor: "cursor-100",
      querySha256: clusterListQueryDigest,
      clusterOrderKey: { memberCount: 2, updatedAt: generatedAt, id: 100 },
    },
  });
  assert.deepEqual(
    resumed.rows.map((row) => row.id),
    [101, 102],
  );
  assert.equal(resumed.nextProviderCursor, "cursor-102");
  await adapter.close();
});

test("Gitcrawl evidence rejects resume cursors from another query", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.clusters.list": Array.from({ length: 4 }, (_, index) => clusterRow(index + 1)),
      },
    }),
    pageSize: 1,
    now: () => now,
  });
  const first = await adapter.listClustersWindow({ offset: 0, maxRows: 1, minSize: 1 });
  await assert.rejects(
    adapter.listClustersWindow({
      offset: first.nextOffset,
      maxRows: 1,
      minSize: 2,
      resume: {
        offset: first.nextOffset,
        archive: archiveId,
        snapshotId,
        providerCursor: first.nextProviderCursor,
        querySha256: first.querySha256,
        clusterOrderKey: first.lastClusterOrderKey,
      },
    }),
    /resume cursor does not match/,
  );
  await assert.rejects(
    adapter.listClustersWindow({
      offset: first.nextOffset,
      maxRows: 1,
      minSize: 1,
      resume: {
        offset: first.nextOffset,
        archive: "fixture-replacement",
        snapshotId,
        providerCursor: first.nextProviderCursor,
        querySha256: first.querySha256,
        clusterOrderKey: first.lastClusterOrderKey,
      },
    }),
    /resume cursor does not match/,
  );
  await adapter.close();
});

test("Gitcrawl evidence rejects unsafe ordinal scan windows", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource(),
    now: () => now,
  });
  await assert.rejects(
    adapter.listClustersWindow({ offset: Number.MAX_SAFE_INTEGER, maxRows: 1 }),
    /scan window exceeds the safe integer range/,
  );
  await adapter.close();
});

test("Gitcrawl cloud transport preserves snapshot-bound pagination", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as GitcrawlQueryRequest;
    requests.push(request as unknown as Record<string, unknown>);
    if (request.name === "gitcrawl.coverage") {
      return jsonResponse(completeCoverage(), "");
    }
    const values = request.cursor ? [clusterRow(2)] : [clusterRow(1)];
    return jsonResponse(values, request.cursor ? "" : "cluster-page-2");
  };
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "cloud",
    cloudUrl: "https://crawl.example.test",
    cloudArchive: "gitcrawl/openclaw__openclaw",
    cloudToken: "test-token",
    fetch: fetchImpl,
    now: () => now,
  });
  const result = await adapter.listClusters();
  assert.deepEqual(
    result.rows.map((row) => row.id),
    [1, 2],
  );
  const secondClusterRequest = requests.filter(
    (request) => request.name === "gitcrawl.clusters.list",
  )[1]!;
  assert.equal(secondClusterRequest.snapshot_id, snapshotId);
  assert.equal(secondClusterRequest.cursor, "cluster-page-2");
  assert.equal(secondClusterRequest.contract_version, GITCRAWL_QUERY_CONTRACT_VERSION);
  assert.equal(secondClusterRequest.repository, "openclaw/openclaw");
  assert.equal(secondClusterRequest.archive, "gitcrawl/openclaw__openclaw");
  await adapter.close();
});

test("Gitcrawl cloud transport requires HTTPS before attaching credentials", async () => {
  await assert.rejects(
    GitcrawlEvidenceAdapter.open({
      repository: "openclaw/openclaw",
      provider: "cloud",
      cloudUrl: "http://crawl.example.test",
      cloudArchive: "gitcrawl/openclaw__openclaw",
      cloudToken: "test-token",
      now: () => now,
    }),
    /must use HTTPS/,
  );
});

test("Gitcrawl cloud transport disables redirects", async () => {
  let redirect: RequestRedirect | undefined;
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "cloud",
    cloudUrl: "https://crawl.example.test",
    cloudArchive: "gitcrawl/openclaw__openclaw",
    cloudToken: "test-token",
    fetch: async (_input, init) => {
      redirect = init?.redirect;
      return jsonResponse(completeCoverage(), "");
    },
    now: () => now,
  });
  assert.equal(redirect, "error");
  await adapter.close();
});

test("Gitcrawl cloud transport requires the negotiated safety contract", async () => {
  for (const contractVersion of [undefined, "legacy-v1"]) {
    const response = (await jsonResponse(completeCoverage(), "").json()) as {
      stats: Record<string, unknown>;
    };
    if (contractVersion === undefined) delete response.stats.contract_version;
    else response.stats.contract_version = contractVersion;
    await assert.rejects(
      GitcrawlEvidenceAdapter.open({
        repository: "openclaw/openclaw",
        provider: "cloud",
        cloudUrl: "https://crawl.example.test",
        cloudArchive: "gitcrawl/openclaw__openclaw",
        cloudToken: "test-token",
        fetch: async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        now: () => now,
      }),
      /contract_version|requires safety contract/,
    );
  }
});

test("Gitcrawl cloud transport binds responses to the requested repository and archive", async () => {
  for (const stats of [
    { repository: "other/repository" },
    { archive: "gitcrawl/other__repository" },
  ]) {
    await assert.rejects(
      GitcrawlEvidenceAdapter.open({
        repository: "openclaw/openclaw",
        provider: "cloud",
        cloudUrl: "https://crawl.example.test",
        cloudArchive: "gitcrawl/openclaw__openclaw",
        cloudToken: "test-token",
        fetch: async () => jsonResponse(completeCoverage(), "", stats),
        now: () => now,
      }),
      /mismatched source identity/,
    );
  }
});

test("Gitcrawl cloud transport redacts authenticated failure bodies", async () => {
  const secret = "private archive payload must not reach logs";
  await assert.rejects(
    GitcrawlEvidenceAdapter.open({
      repository: "openclaw/openclaw",
      provider: "cloud",
      cloudUrl: "https://crawl.example.test",
      cloudArchive: "gitcrawl/openclaw__openclaw",
      cloudToken: "test-token",
      fetch: async () => new Response(secret, { status: 401 }),
      now: () => now,
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /Gitcrawl cloud query gitcrawl\.coverage failed \(401; code=unauthorized\)/,
      );
      assert.doesNotMatch(error.message, /private archive payload/);
      return true;
    },
  );
});

test("Gitcrawl cloud transport enforces its response cap while streaming", async () => {
  const chunk = new Uint8Array(300 * 1024);
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    GitcrawlEvidenceAdapter.open({
      repository: "openclaw/openclaw",
      provider: "cloud",
      cloudUrl: "https://crawl.example.test",
      cloudArchive: "gitcrawl/openclaw__openclaw",
      cloudToken: "test-token",
      fetch: fetchImpl,
      now: () => now,
    }),
    /exceeded 524288 bytes/,
  );
});

test("Gitcrawl cloud transport rejects malformed row envelopes", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        values: completeCoverage(),
        stats: {
          contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
          repository: "openclaw/openclaw",
          archive: "gitcrawl/openclaw__openclaw",
          snapshot_id: snapshotId,
          source_sync_at: generatedAt,
          dataset_generated_at: generatedAt,
          coverage_complete: true,
          next_cursor: "",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    GitcrawlEvidenceAdapter.open({
      repository: "openclaw/openclaw",
      provider: "cloud",
      cloudUrl: "https://crawl.example.test",
      cloudArchive: "gitcrawl/openclaw__openclaw",
      cloudToken: "test-token",
      fetch: fetchImpl,
      now: () => now,
    }),
    /missing columns or rows/,
  );
});

test("Gitcrawl cloud transport rejects missing pagination stats", async () => {
  const values = completeCoverage();
  const columns = Object.keys(values[0]!);
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        columns,
        rows: values.map((row) =>
          columns.map((column) => (row as unknown as Record<string, unknown>)[column]),
        ),
        values,
        stats: {
          contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
          repository: "openclaw/openclaw",
          archive: "gitcrawl/openclaw__openclaw",
          snapshot_id: snapshotId,
          source_sync_at: generatedAt,
          dataset_generated_at: generatedAt,
          coverage_complete: true,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    GitcrawlEvidenceAdapter.open({
      repository: "openclaw/openclaw",
      provider: "cloud",
      cloudUrl: "https://crawl.example.test",
      cloudArchive: "gitcrawl/openclaw__openclaw",
      cloudToken: "test-token",
      fetch: fetchImpl,
      now: () => now,
    }),
    /stats next_cursor must be a string/,
  );
});

test("Gitcrawl cloud transport rejects unsafe provider cursors at the response boundary", async () => {
  for (const cursor of ["x".repeat(8 * 1024 + 1), "cursor\u0000tamper"]) {
    await assert.rejects(
      GitcrawlEvidenceAdapter.open({
        repository: "openclaw/openclaw",
        provider: "cloud",
        cloudUrl: "https://crawl.example.test",
        cloudArchive: "gitcrawl/openclaw__openclaw",
        cloudToken: "test-token",
        fetch: async () => jsonResponse(completeCoverage(), cursor),
        now: () => now,
      }),
      /stats next_cursor is malformed/,
    );
  }
});

test("Gitcrawl parity mode rejects semantic cloud/local drift", async () => {
  const cloud = new FixtureSource({
    provider: "cloud",
    rows: { "gitcrawl.clusters.list": [clusterRow(1)] },
  });
  const local = new FixtureSource({
    provider: "local",
    rows: {
      "gitcrawl.clusters.list": [{ ...clusterRow(1), title: "different cluster title" }],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: cloud,
    paritySource: local,
    now: () => now,
  });
  await assert.rejects(adapter.listClusters(), /cloud\/local parity mismatch/);
  await adapter.close();
});

test("Gitcrawl parity coverage is scoped to the consuming operation", async () => {
  const localCoverage = completeCoverage();
  const localPr = localCoverage.find((row) => row.dataset === "pull_request_details")!;
  localPr.complete = false;
  localPr.covered_count = 0;
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: new FixtureSource({
      provider: "cloud",
      rows: { "gitcrawl.clusters.list": [clusterRow(1)] },
    }),
    paritySource: new FixtureSource({
      provider: "local",
      coverage: localCoverage,
      rows: { "gitcrawl.clusters.list": [clusterRow(1)] },
      snapshotForQuery: () => "local-snapshot",
    }),
    now: () => now,
  });
  assert.equal((await adapter.listClusters()).rows.length, 1);
  await assert.rejects(adapter.reviewContext(42), /pull_request_details coverage is incomplete/);
  await adapter.close();
});

test("Gitcrawl parity mode normalizes local/cloud review row shapes", async () => {
  const cloud = new FixtureSource({
    provider: "cloud",
    rows: {
      "gitcrawl.pull_requests.review_context": [
        reviewContextRow({ changed_files: 1 }),
        {
          ...reviewFileRow(0, "src/provider.ts"),
          number: 42,
          state: null,
          title: null,
          body: null,
        },
      ],
    },
  });
  const local = new FixtureSource({
    provider: "local",
    rows: {
      "gitcrawl.pull_requests.review_context": [
        reviewContextRow({ changed_files: 1 }),
        reviewFileRow(0, "src/provider.ts"),
      ],
    },
    snapshotForQuery: () => "local-snapshot",
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: cloud,
    paritySource: local,
    now: () => now,
  });
  const review = await adapter.reviewContext(42);
  assert.equal(review.rows.length, 2);
  assert(review.claims.every((claim) => claim.parity_snapshot_id === "local-snapshot"));
  await adapter.close();
});

test("Gitcrawl parity mode compares the shared cluster contract", async () => {
  const cloudCluster = clusterRow(1);
  const cloudMember = memberRow();
  for (const field of ["revision_id", "revision_content_hash", "revision_source_updated_at"]) {
    delete cloudMember[field];
  }
  const cloudRelated = { ...cloudMember };
  for (const field of ["cluster_status", "membership_state", "is_draft", "created_at_gh"]) {
    delete cloudRelated[field];
  }
  const cloud = new FixtureSource({
    provider: "cloud",
    rows: {
      "gitcrawl.clusters.list": [cloudCluster],
      "gitcrawl.clusters.members": [cloudMember],
      "gitcrawl.clusters.related": [cloudRelated],
    },
  });
  const local = new FixtureSource({
    provider: "local",
    rows: {
      "gitcrawl.clusters.list": [clusterRow(1)],
      "gitcrawl.clusters.members": [memberRow()],
      "gitcrawl.clusters.related": [memberRow()],
    },
    snapshotForQuery: () => "local-snapshot",
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: cloud,
    paritySource: local,
    now: () => now,
  });
  assert.equal((await adapter.listClusters()).rows.length, 1);
  assert.equal((await adapter.clusterMembers(7)).rows.length, 1);
  assert.equal((await adapter.related(42)).rows.length, 1);
  await adapter.close();
});

test("Gitcrawl parity mode binds representative state", async () => {
  const cloudCluster = clusterRow(1);
  cloudCluster.representative_state = "closed";
  const mismatched = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: new FixtureSource({
      provider: "cloud",
      rows: { "gitcrawl.clusters.list": [cloudCluster] },
    }),
    paritySource: new FixtureSource({
      provider: "local",
      rows: { "gitcrawl.clusters.list": [clusterRow(1)] },
      snapshotForQuery: () => "local-snapshot",
    }),
    now: () => now,
  });
  await assert.rejects(mismatched.listClusters(), /cloud\/local parity mismatch/);
  await mismatched.close();
});

test("Gitcrawl parity mode compares complete safety projections", async () => {
  const cloudMember = memberRow();
  delete cloudMember.labels_json;
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: new FixtureSource({
      provider: "cloud",
      rows: { "gitcrawl.clusters.members": [cloudMember] },
    }),
    paritySource: new FixtureSource({
      provider: "local",
      rows: { "gitcrawl.clusters.members": [memberRow()] },
      snapshotForQuery: () => "local-snapshot",
    }),
    now: () => now,
  });
  await assert.rejects(adapter.clusterMembers(7), /cloud\/local parity mismatch/);
  await adapter.close();
});

test("Gitcrawl cluster parity includes protected author and assignment metadata", async () => {
  for (const override of [
    { author_association: "MEMBER" },
    { author_type: "Bot" },
    { assignees_json: '["maintainer"]' },
  ]) {
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "parity",
      primarySource: new FixtureSource({
        provider: "cloud",
        rows: { "gitcrawl.clusters.members": [memberRow(override)] },
      }),
      paritySource: new FixtureSource({
        provider: "local",
        rows: { "gitcrawl.clusters.members": [memberRow()] },
        snapshotForQuery: () => "local-snapshot",
      }),
      now: () => now,
    });
    await assert.rejects(adapter.clusterMembers(7), /cloud\/local parity mismatch/);
    await adapter.close();
  }
});

test("Gitcrawl complete security metadata requires full actor identity", async () => {
  for (const override of [{ author_login: "" }, { author_type: "" }]) {
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "cloud",
      primarySource: new FixtureSource({
        rows: { "gitcrawl.clusters.members": [memberRow(override)] },
      }),
      now: () => now,
    });
    await assert.rejects(adapter.clusterMembers(7), /author (login|type) is missing/);
    await adapter.close();
  }
});

test("Gitcrawl local SQLite mode snapshots and normalizes current producer data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-local-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  const clusters = await adapter.listClusters();
  assert.deepEqual(
    clusters.rows.map((row) => row.id),
    [7],
  );
  const members = await adapter.clusterMembers(7);
  assert.equal(members.rows[0]?.threadFingerprint?.sha256, fingerprint);
  const review = await adapter.reviewContext(42);
  assert.equal(review.rows.length, 2);
  const context = review.rows.find((row) => "thread" in row);
  assert(context && "thread" in context);
  assert.equal(context.clusterId, 7);
  assert.equal(context.clusterSlug, "cluster-7");
  assert.equal(context.clusterTitle, "Provider refresh");
  assert.equal(context.clusterStatus, "active");
  assert.equal(context.clusterRole, "representative");
  assert.equal(context.scoreToRepresentative, 1);
  assert.match(adapter.snapshotId, /^local:[a-f0-9]{64}$/);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local enrichment selects revisions by RFC3339 instant", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-revision-order-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("update thread_revisions set source_updated_at = ? where id = 9").run(
    "2026-07-12T12:30:00+02:00",
  );
  db.prepare("insert into thread_revisions values (?, ?, ?, ?, ?)").run(
    12,
    42,
    "2026-07-12T11:00:00Z",
    "d".repeat(64),
    generatedAt,
  );
  db.prepare("insert into thread_fingerprints values (?, ?, ?, ?, ?, ?)").run(
    13,
    12,
    "thread-fingerprint-v2",
    "e".repeat(64),
    "latest",
    generatedAt,
  );
  db.prepare("insert into thread_key_summaries values (?, ?, ?, ?)").run(
    14,
    12,
    "Chronologically latest revision",
    generatedAt,
  );
  db.close();
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  const member = (await adapter.clusterMembers(7)).rows[0]!;
  assert.equal(member.sourceRevision?.id, 12);
  assert.equal(member.sourceRevision?.sha256, "d".repeat(64));
  assert.equal(member.keySummary, "Chronologically latest revision");
  assert.equal(member.threadFingerprint?.sha256, "e".repeat(64));
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local enrichment falls back to revision creation time and exact v2 fingerprints", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-revision-fallback-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("insert into thread_revisions values (?, ?, ?, ?, ?)").run(
    12,
    42,
    "",
    "d".repeat(64),
    "2026-07-12T11:59:00Z",
  );
  db.prepare("insert into thread_fingerprints values (?, ?, ?, ?, ?, ?)").run(
    13,
    12,
    "thread-fingerprint-v2",
    "e".repeat(64),
    "exact-v2",
    "2026-07-12T11:59:10Z",
  );
  db.prepare("insert into thread_fingerprints values (?, ?, ?, ?, ?, ?)").run(
    14,
    12,
    "thread-fingerprint-v3",
    "f".repeat(64),
    "newer-unsupported",
    "2026-07-12T11:59:20Z",
  );
  db.close();

  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  const member = (await adapter.clusterMembers(7)).rows[0]!;
  assert.equal(member.sourceRevision?.id, 12);
  assert.equal(member.sourceRevision?.updated_at, "2026-07-12T11:59:00Z");
  assert.deepEqual(member.threadFingerprint, {
    algorithm: "thread-fingerprint-v2",
    sha256: "e".repeat(64),
  });
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local PR review context matches the cloud cluster projection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-review-parity-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const local = await LocalGitcrawlQuerySource.open({
    repository: "openclaw/openclaw",
    dbPath,
  });
  const cloud = new FixtureSource({
    provider: "cloud",
    rows: {
      "gitcrawl.pull_requests.review_context": [
        reviewContextRow({
          title: "chore: add new plugin",
          body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
          author_association: "CONTRIBUTOR",
          stable_slug: undefined,
          role: undefined,
          membership_state: undefined,
          cluster_role: "representative",
          score_to_representative: 1,
          changed_files: 1,
        }),
        reviewFileRow(0, "apps/linux/plugin.ts"),
      ],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: cloud,
    paritySource: local,
    now: () => now,
  });
  const review = await adapter.reviewContext(42);
  assert.equal(review.rows.length, 2);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl review file paths preserve exact bounded identity", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [
          reviewContextRow({ changed_files: 1 }),
          reviewFileRow(0, "x".repeat(1_025)),
        ],
      },
    }),
    now: () => now,
  });
  await assert.rejects(adapter.reviewContext(42), /file path exceeds the safety bound/);
  await adapter.close();
});

test("Gitcrawl local cursors bind the full canonical query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-local-cursor-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const source = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository: "openclaw/openclaw",
    allowLegacy: false,
  });
  const first = await source.query({
    name: "gitcrawl.coverage",
    args: { owner: "openclaw", repo: "openclaw" },
    limit: 1,
    cursor: "",
    snapshot_id: source.snapshotId,
  });
  assert.notEqual(first.stats.next_cursor, "");
  await assert.rejects(
    source.query({
      name: "gitcrawl.coverage",
      args: { owner: "openclaw", repo: "openclaw", scope: "other" },
      limit: 1,
      cursor: first.stats.next_cursor,
      snapshot_id: source.snapshotId,
    }),
    /local Gitcrawl cursor drift/,
  );
  await source.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local non-window queries apply SQL bounds before materialization", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-sql-bounds-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const source = await LocalGitcrawlQuerySource.open({
    dbPath,
    repository: "openclaw/openclaw",
    allowLegacy: false,
  });
  const database = (source as unknown as { db: DatabaseSync }).db;
  const prepare = database.prepare.bind(database);
  const statements: string[] = [];
  mock.method(database, "prepare", (sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  try {
    await source.query({
      name: "gitcrawl.clusters.members",
      args: { cluster_id: 7 },
      limit: 1,
      cursor: "",
      snapshot_id: source.snapshotId,
    });
    await source.query({
      name: "gitcrawl.pull_requests.review_context",
      args: { number: 42 },
      limit: 1,
      cursor: "",
      snapshot_id: source.snapshotId,
    });
    assert(
      statements.some(
        (sql) => /join cluster_memberships/.test(sql) && /limit \? offset \?/.test(sql),
      ),
    );
    assert(
      statements.some(
        (sql) => /from pull_request_files/.test(sql) && /limit \? offset \?/.test(sql),
      ),
    );
  } finally {
    mock.restoreAll();
    await source.close();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl legacy local mode records only explicitly verified coverage", async () => {
  const coverage = completeCoverage();
  for (const dataset of [
    "thread_revisions",
    "thread_fingerprints",
    "thread_key_summaries",
    "pull_request_details",
    "pull_request_files",
  ] as const) {
    const row = coverage.find((candidate) => candidate.dataset === dataset)!;
    row.complete = false;
    row.covered_count = 0;
  }
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "local",
    primarySource: new FixtureSource({
      provider: "local",
      legacy: true,
      coverage,
      rows: { "gitcrawl.clusters.list": [clusterRow(1)] },
    }),
    now: () => now,
  });
  const clusters = await adapter.listClusters();
  const packet = buildGitcrawlEvidencePacket({
    provider: adapter.provider,
    repository: adapter.repository,
    snapshotId: adapter.snapshotId,
    coverage: adapter.coverage,
    requiredCoverage: adapter.requiredCoverageFor("gitcrawl.clusters.list"),
    claims: clusters.claims,
    generatedAt,
  });
  assert.deepEqual(packet.required_coverage, [
    "cluster_groups",
    "cluster_memberships",
    "repositories",
    "threads",
  ]);
  verifyGitcrawlEvidencePacket(packet);
  await adapter.close();
});

test("Gitcrawl evidence rejects missing PR details and malformed fingerprints", async () => {
  const source = new FixtureSource({
    rows: {
      "gitcrawl.pull_requests.review_context": [
        reviewContextRow({ base_sha: "", head_sha: "", details_fetched_at: "" }),
      ],
      "gitcrawl.clusters.members": [memberRow({ fingerprint_hash: "not-a-digest" })],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    now: () => now,
  });
  await assert.rejects(adapter.reviewContext(42), /missing PR details/);
  await assert.rejects(adapter.clusterMembers(7), /must be a lowercase hexadecimal SHA-256/);
  await adapter.close();

  const unsupported = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.clusters.members": [
          memberRow({
            fingerprint_algorithm: "thread-fingerprint-v3",
            fingerprint_hash: "f".repeat(64),
          }),
        ],
      },
    }),
    now: () => now,
  });
  await assert.rejects(
    unsupported.clusterMembers(7),
    /unsupported Gitcrawl thread fingerprint algorithm: thread-fingerprint-v3/,
  );
  await unsupported.close();
});

test("Gitcrawl evidence rejects missing required numeric fields", async () => {
  const coverage = completeCoverage();
  delete (coverage[0] as Partial<GitcrawlCoverageRow>).row_count;
  await assert.rejects(
    GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "cloud",
      primarySource: new FixtureSource({ coverage }),
      now: () => now,
    }),
    /row_count is missing/,
  );

  const missingPosition = reviewFileRow(0, "src/provider.ts");
  delete missingPosition.file_position;
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [
          reviewContextRow({ changed_files: 1 }),
          missingPosition,
        ],
      },
    }),
    now: () => now,
  });
  await assert.rejects(adapter.reviewContext(42), /file position is missing/);
  await adapter.close();
});

test("Gitcrawl cluster evidence binds members to the requested cluster", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.clusters.members": [memberRow({ cluster_id: 8 })],
      },
    }),
    now: () => now,
  });
  await assert.rejects(
    adapter.clusterMembers(7),
    /cluster 7 returned a member from another cluster/,
  );
  await adapter.close();
});

test("Gitcrawl cluster evidence rejects incomplete declared membership", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.clusters.list": [clusterRow(7)],
        "gitcrawl.clusters.members": [memberRow({ cluster_member_count: 2 })],
      },
    }),
    now: () => now,
  });
  await adapter.listClusters();
  await assert.rejects(adapter.clusterMembers(7), /returned 1\/2 members/);
  await adapter.close();

  const emptyAdapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.clusters.members": [],
      },
    }),
    now: () => now,
  });
  await assert.rejects(emptyAdapter.clusterMembers(7), /missing their declared count/);
  await emptyAdapter.close();
});

test("Gitcrawl review evidence binds context and files to the requested pull request", async () => {
  const wrongContext = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [reviewContextRow({ number: 43 })],
      },
    }),
    now: () => now,
  });
  await assert.rejects(wrongContext.reviewContext(42), /returned a different pull request/);
  await wrongContext.close();

  const wrongFile = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [
          reviewContextRow({ changed_files: 1 }),
          { ...reviewFileRow(0, "src/provider.ts"), thread_id: 99 },
        ],
      },
    }),
    now: () => now,
  });
  await assert.rejects(wrongFile.reviewContext(42), /mixed pull request file rows/);
  await wrongFile.close();

  const duplicatePosition = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [
          reviewContextRow({ changed_files: 2 }),
          reviewFileRow(0, "src/provider.ts"),
          reviewFileRow(0, "src/other.ts"),
        ],
      },
    }),
    now: () => now,
  });
  await assert.rejects(duplicatePosition.reviewContext(42), /incomplete file positions/);
  await duplicatePosition.close();

  const missingKindRow = reviewContextRow();
  delete missingKindRow.kind;
  const missingKind = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [missingKindRow],
      },
    }),
    now: () => now,
  });
  await assert.rejects(missingKind.reviewContext(42), /non-pull-request row/);
  await missingKind.close();
});

test("Gitcrawl search rejects provider rows that are not open pull requests", async () => {
  for (const row of [memberRow({ kind: "issue" }), memberRow({ state: "closed" })]) {
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "cloud",
      primarySource: new FixtureSource({
        rows: { "gitcrawl.threads.search": [row] },
      }),
      now: () => now,
    });
    await assert.rejects(adapter.searchOpenPullRequests(), /open pull request search returned/);
    await adapter.close();
  }
});

test("Gitcrawl search rejects null bodies claimed as complete safety metadata", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.threads.search": [memberRow({ body: null })],
      },
    }),
    now: () => now,
  });
  await assert.rejects(
    adapter.searchOpenPullRequests(),
    /thread body is missing from complete security metadata/,
  );
  await adapter.close();
});

test("Gitcrawl complete safety metadata requires a string title", async () => {
  for (const title of [null, { text: "CVE-2026-12345" }]) {
    const adapter = await GitcrawlEvidenceAdapter.fromSources({
      repository: "openclaw/openclaw",
      provider: "cloud",
      primarySource: new FixtureSource({
        rows: {
          "gitcrawl.threads.search": [memberRow({ title })],
        },
      }),
      now: () => now,
    });
    await assert.rejects(
      adapter.searchOpenPullRequests(),
      /thread title is missing from complete security metadata/,
    );
    await adapter.close();
  }
});

test("Gitcrawl low-signal scoring rejects divergent search and review safety projections", () => {
  const search = {
    title: "chore: update provider",
    body: "Routine provider update.",
    authorType: "User",
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    assignees: [],
    securitySensitive: false,
    securityMetadataComplete: true,
    securityProjectionSha256: "a".repeat(64),
    policySignals: {
      blankTemplate: false,
      issueReference: false,
      concreteFix: false,
      thirdPartyCapability: false,
    },
  };
  assert.doesNotThrow(() => assertGitcrawlThreadSafetyProjectionMatches(search, search));
  for (const review of [
    { ...search, body: `${search.body}\nchanged` },
    { ...search, authorAssociation: "MEMBER" },
    { ...search, securitySensitive: !search.securitySensitive },
    { ...search, labels: [{ name: "security" }] },
    { ...search, policySignals: { ...search.policySignals, concreteFix: true } },
  ]) {
    assert.throws(
      () => assertGitcrawlThreadSafetyProjectionMatches(search, review),
      /search and review safety projections diverge/,
    );
  }
});

test("Gitcrawl blank-template scoring requires empty template answers", () => {
  assert.equal(
    deriveGitcrawlThreadPolicySignals(
      "docs: update guide",
      "Describe the problem and fix in 2-5 bullets:\n- Problem:\n- Fix:",
    ).blankTemplate,
    true,
  );
  assert.equal(
    deriveGitcrawlThreadPolicySignals(
      "fix: preserve retries",
      "Problem: retries are dropped after restart\nWhy it matters: work is lost\nFix: persist the retry cursor",
    ).blankTemplate,
    false,
  );
  assert.equal(
    deriveGitcrawlThreadPolicySignals(
      "fix: preserve retries",
      "Retries disappear after restart and lose queued work.\n\nProblem:\nWhy it matters:\nFix:",
    ).blankTemplate,
    false,
  );
  assert.equal(
    deriveGitcrawlThreadPolicySignals(
      "fix: preserve retries",
      [
        "<!--",
        "Explain the change without deleting these instructions.",
        "-->",
        "## Description",
        "Problem:",
        "Why it matters:",
        "Fix:",
      ].join("\n"),
    ).blankTemplate,
    true,
  );
  assert.equal(
    deriveGitcrawlThreadPolicySignals(
      "fix: preserve retries",
      "## Retry data loss\n\nProblem:\nWhy it matters:\nFix:",
    ).blankTemplate,
    false,
  );
});

test("Gitcrawl policy signals ignore HTML-comment instructions", () => {
  const hidden = deriveGitcrawlThreadPolicySignals(
    "docs: update guide",
    [
      "<!-- Fixes #42 by adding a provider plugin for the root cause. -->",
      "Routine documentation cleanup.",
    ].join("\n"),
  );
  assert.equal(hidden.issueReference, false);
  assert.equal(hidden.concreteFix, false);
  assert.equal(hidden.thirdPartyCapability, false);

  const visible = deriveGitcrawlThreadPolicySignals(
    "fix: add provider plugin",
    "Fixes #42 by addressing the root cause.",
  );
  assert.equal(visible.issueReference, true);
  assert.equal(visible.concreteFix, true);
  assert.equal(visible.thirdPartyCapability, true);
});

test("Gitcrawl HTML comment stripping cannot reconstruct an injection marker", () => {
  const boundaryMarker = stripGitcrawlHtmlComments("<!<!-- hidden instructions -->--");
  assert.equal(boundaryMarker, "<!\n--");
  assert.doesNotMatch(boundaryMarker, /<!--/);

  const adjacentComments = stripGitcrawlHtmlComments("<!-- first --><!-- second -->");
  assert.equal(adjacentComments, "\n\n");
  assert.doesNotMatch(adjacentComments, /<!--/);

  const unterminatedComment = stripGitcrawlHtmlComments("visible<!-- hidden");
  assert.equal(unterminatedComment, "visible\n");
  assert.doesNotMatch(unterminatedComment, /<!--/);
});

test("Gitcrawl review evidence rejects malformed detail and file timestamps", async () => {
  const malformedDetail = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [reviewContextRow({ details_fetched_at: "1" })],
      },
    }),
    now: () => now,
  });
  await assert.rejects(malformedDetail.reviewContext(42), /fetched_at is invalid/);
  await malformedDetail.close();

  const malformedFile = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.pull_requests.review_context": [
          reviewContextRow({ changed_files: 1 }),
          { ...reviewFileRow(0, "src/provider.ts"), file_fetched_at: "2026-02-30T12:00:00Z" },
        ],
      },
    }),
    now: () => now,
  });
  await assert.rejects(malformedFile.reviewContext(42), /file fetched_at is invalid/);
  await malformedFile.close();
});

test("Gitcrawl safety projection detects signals beyond prompt bounds", async () => {
  const labels = Array.from({ length: 40 }, (_, index) => ({
    name: index === 39 ? "security" : `label-${index}`,
  }));
  const source = new FixtureSource({
    rows: {
      "gitcrawl.threads.search": [
        memberRow({
          body: `${"x".repeat(2_100)} CVE-2026-12345 fixes #123`,
          labels_json: JSON.stringify(labels),
        }),
      ],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    now: () => now,
  });
  const thread = (await adapter.searchOpenPullRequests()).rows[0]!;
  assert.equal(thread.body.length, 2_048);
  assert.equal(thread.labels?.length, 32);
  assert.equal(thread.securitySensitive, true);
  assert.equal(thread.securityMetadataComplete, true);
  assert.equal(thread.policySignals.concreteFix, true);
  assert.equal(thread.policySignals.issueReference, true);
  assert.match(thread.securityProjectionSha256, /^[a-f0-9]{64}$/);
  await adapter.close();
});

test("Gitcrawl safety completeness requires explicit full source fields", async () => {
  const missingFlag = memberRow();
  delete missingFlag.security_metadata_complete;
  const missingBody = memberRow();
  delete missingBody.body;
  missingBody.security_metadata_complete = false;
  const missingAssociation = memberRow();
  delete missingAssociation.author_association;
  const missingAssignees = memberRow();
  delete missingAssignees.assignees_json;
  const source = new FixtureSource({
    rows: {
      "gitcrawl.threads.search": [missingFlag, missingBody, missingAssociation, missingAssignees],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    now: () => now,
  });
  const rows = (await adapter.searchOpenPullRequests()).rows;
  assert(rows.every((row) => !row.securityMetadataComplete));
  await adapter.close();
});

test("Gitcrawl pull request discovery orders before applying its row bound", async () => {
  const rows = [
    memberRow({ number: 3, thread_id: 3, updated_at_gh: "2026-07-12T11:59:00.000Z" }),
    memberRow({ number: 2, thread_id: 2, updated_at_gh: "2026-07-12T11:58:00.000Z" }),
    memberRow({ number: 1, thread_id: 1, updated_at_gh: "2026-07-12T11:57:00.000Z" }),
  ];
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: { "gitcrawl.threads.search": rows },
    }),
    now: () => now,
  });
  assert.deepEqual(
    (await adapter.searchOpenPullRequests({ maxRows: 2, order: "oldest" })).rows.map(
      (row) => row.number,
    ),
    [1, 2],
  );
  await adapter.close();

  const drifting = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: { "gitcrawl.threads.search": rows },
      honorThreadOrder: false,
    }),
    now: () => now,
  });
  await assert.rejects(
    drifting.searchOpenPullRequests({ maxRows: 2, order: "oldest" }),
    /did not honor oldest-first ordering/,
  );
  await drifting.close();
});

test("Gitcrawl resumed pull request discovery validates discarded rows and order boundaries", async () => {
  const rows = [
    memberRow({ number: 41, updated_at_gh: "2026-07-12T11:57:00.000Z" }),
    memberRow({ number: 42, updated_at_gh: "2026-07-12T11:56:00.000Z" }),
    memberRow({ number: 43, updated_at_gh: "2026-07-12T11:58:00.000Z" }),
  ];
  const discarded = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: { "gitcrawl.threads.search": rows },
      honorThreadOrder: false,
    }),
    pageSize: 10,
    maxPages: 4,
    now: () => now,
  });
  await assert.rejects(
    discarded.searchOpenPullRequestsWindow({ offset: 2, maxRows: 1, order: "oldest" }),
    /did not honor oldest-first ordering/,
  );
  await discarded.close();

  const boundary = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: { "gitcrawl.threads.search": rows },
      honorThreadOrder: false,
    }),
    pageSize: 10,
    maxPages: 1,
    now: () => now,
  });
  await assert.rejects(
    boundary.searchOpenPullRequestsWindow({
      offset: 2,
      maxRows: 1,
      order: "oldest",
      resume: {
        offset: 2,
        archive: archiveId,
        snapshotId,
        providerCursor: "cursor-2",
        querySha256: oldestPullRequestQueryDigest,
      },
    }),
    /missing its order boundary/,
  );
  await assert.rejects(
    boundary.searchOpenPullRequestsWindow({
      offset: 2,
      maxRows: 1,
      order: "oldest",
      resume: {
        offset: 2,
        archive: archiveId,
        snapshotId,
        providerCursor: "cursor-2",
        querySha256: oldestPullRequestQueryDigest,
        orderKey: { updatedAt: "2026-07-12T11:59:00.000Z", number: 42 },
      },
    }),
    /did not honor oldest-first ordering/,
  );
  await boundary.close();
});

test("Gitcrawl pull request ordering compares RFC3339 timestamps chronologically", async () => {
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: new FixtureSource({
      rows: {
        "gitcrawl.threads.search": [
          memberRow({ number: 42, updated_at_gh: "2026-07-12T13:00:00+02:00" }),
          memberRow({ number: 41, updated_at_gh: "2026-07-12T11:00:00Z" }),
        ],
      },
    }),
    now: () => now,
  });
  assert.deepEqual(
    (await adapter.searchOpenPullRequests({ order: "oldest" })).rows.map((row) => row.number),
    [41, 42],
  );
  await adapter.close();
});

test("Gitcrawl search parity includes author association", async () => {
  const cloud = new FixtureSource({
    provider: "cloud",
    rows: { "gitcrawl.threads.search": [memberRow({ author_association: "CONTRIBUTOR" })] },
  });
  const local = new FixtureSource({
    provider: "local",
    rows: { "gitcrawl.threads.search": [memberRow({ author_association: "MEMBER" })] },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "parity",
    primarySource: cloud,
    paritySource: local,
    now: () => now,
  });
  await assert.rejects(adapter.searchOpenPullRequests(), /cloud\/local parity mismatch/);
  await adapter.close();
});

test("Gitcrawl review evidence is fully checked then bounded for prompt packets", async () => {
  const files = Array.from({ length: 120 }, (_, position) =>
    reviewFileRow(position, `src/${"nested/".repeat(20)}file-${position}.ts`),
  );
  const coverage = completeCoverage({
    pull_request_files: { row_count: 120, eligible_count: 120, covered_count: 120 },
  });
  const source = new FixtureSource({
    coverage,
    rows: {
      "gitcrawl.pull_requests.review_context": [reviewContextRow({ changed_files: 120 }), ...files],
    },
  });
  const adapter = await GitcrawlEvidenceAdapter.fromSources({
    repository: "openclaw/openclaw",
    provider: "cloud",
    primarySource: source,
    pageSize: 17,
    now: () => now,
  });
  const result = await adapter.reviewContext(42);
  const context = result.rows[0];
  assert(context && "files" in context);
  assert.equal(context.files.length, 24);
  assert.equal(context.filesOmitted, 96);
  const packet = buildGitcrawlEvidencePacket({
    provider: adapter.provider,
    repository: adapter.repository,
    snapshotId: adapter.snapshotId,
    coverage: adapter.coverage,
    claims: result.claims,
    generatedAt,
  });
  assert(Buffer.byteLength(JSON.stringify(packet, null, 2), "utf8") <= 64 * 1024);
  verifyGitcrawlEvidencePacket(packet);
  await adapter.close();
});

test("Gitcrawl canonical JSON rejects deeply nested provider data", () => {
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 66; depth += 1) nested = { child: nested };
  assert.throws(() => canonicalJson(nested), /exceeds 64 levels of nesting/);
});

test("Gitcrawl packet verification detects digest tampering", () => {
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.clusters.list",
    subject: "openclaw/openclaw#cluster:1",
    data: { id: 1, title: "original" },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [claim],
    generatedAt,
  });
  (packet.claims[0]!.data as Record<string, unknown>).title = "tampered";
  assert.throws(() => verifyGitcrawlEvidencePacket(packet), /claim digest mismatch/);
});

test("Gitcrawl packet verification rejects malformed persisted coverage after redigest", () => {
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [],
    generatedAt,
  });
  for (const [field, value, expected] of [
    ["row_count", -1, /row_count must be a nonnegative safe integer/],
    ["eligible_count", Number.MAX_SAFE_INTEGER + 1, /eligible_count must be a nonnegative/],
    ["covered_count", 0.5, /covered_count must be a nonnegative safe integer/],
    ["complete", 1, /complete must be boolean/],
  ] as const) {
    const tampered = structuredClone(packet);
    (tampered.coverage[0] as unknown as Record<string, unknown>)[field] = value;
    const { sha256: _sha256, ...unsigned } = tampered;
    tampered.sha256 = sha256Canonical(unsigned);
    assert.throws(() => verifyGitcrawlEvidencePacket(tampered), expected);
  }
});

test("Gitcrawl packet derives required coverage from verified query claims", () => {
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.pull_requests.review_context",
    subject: "openclaw/openclaw#pull:42",
    data: { number: 42 },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [claim],
    generatedAt,
  });
  packet.required_coverage = ["repositories", "threads"];
  const { sha256: _sha256, ...unsigned } = packet;
  packet.sha256 = sha256Canonical(unsigned);
  assert.throws(
    () => verifyGitcrawlEvidencePacket(packet),
    /omits required claim coverage pull_request_details/,
  );
});

test("Gitcrawl packet verification rejects over-limit cardinality before reconstruction", () => {
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.clusters.members",
    subject: "openclaw/openclaw#pull:42",
    relations: [{ predicate: "member_of", target: "openclaw/openclaw#cluster:7" }],
    data: { number: 42 },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [claim],
    generatedAt,
  });
  for (const [mutate, expected] of [
    [
      (value: typeof packet) => {
        value.claims = Array.from({ length: 65 }, () => structuredClone(claim));
      },
      /more than 64 claims/,
    ],
    [
      (value: typeof packet) => {
        value.graph.nodes = Array.from({ length: 65 }, (_, index) => ({
          id: `node-${index}`,
          kind: "unknown" as const,
          label: `node-${index}`,
        }));
      },
      /more than 64 nodes/,
    ],
    [
      (value: typeof packet) => {
        value.graph.edges = Array.from({ length: 129 }, () =>
          structuredClone(packet.graph.edges[0]!),
        );
      },
      /more than 128 edges/,
    ],
  ] as const) {
    const tampered = structuredClone(packet);
    mutate(tampered);
    const { sha256: _sha256, ...unsigned } = tampered;
    tampered.sha256 = sha256Canonical(unsigned);
    assert.throws(() => verifyGitcrawlEvidencePacket(tampered), expected);
  }
});

test("Gitcrawl packet bounds relation detail after preserving primary claims", () => {
  const primary = Array.from({ length: 10 }, (_, index) =>
    createGitcrawlEvidenceClaim({
      provider: "cloud",
      snapshotId,
      queryName: "gitcrawl.threads.search",
      subject: `openclaw/openclaw#pull:${index + 1}`,
      data: { number: index + 1 },
    }),
  );
  const related = Array.from({ length: 100 }, (_, index) =>
    createGitcrawlEvidenceClaim({
      provider: "cloud",
      snapshotId,
      queryName: "gitcrawl.pull_requests.review_context",
      subject: `openclaw/openclaw#pull:${Math.floor(index / 10) + 1}@file:${index}`,
      relations: [
        {
          predicate: "evidence_for",
          target: `openclaw/openclaw#pull:${Math.floor(index / 10) + 1}`,
        },
      ],
      data: { position: index },
    }),
  );
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [...related, ...primary],
    generatedAt,
    maxClaims: 12,
  });
  assert.equal(packet.claims.filter((claim) => claim.relations.length === 0).length, 10);
  assert.deepEqual(packet.included, { claims: 12, nodes: 12, edges: 2 });
  verifyGitcrawlEvidencePacket(packet);
});

test("Gitcrawl packet rejects mixed claims and removes edges to bounded-out nodes", () => {
  const primary = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.clusters.list",
    subject: "openclaw/openclaw#cluster:1",
    data: { id: 1 },
  });
  const mixed = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId: "snapshot-b",
    queryName: "gitcrawl.clusters.members",
    subject: "openclaw/openclaw#issue:2",
    relations: [{ predicate: "member_of", target: "openclaw/openclaw#cluster:1" }],
    data: { number: 2 },
  });
  assert.throws(
    () =>
      buildGitcrawlEvidencePacket({
        provider: "cloud",
        repository: "openclaw/openclaw",
        snapshotId,
        coverage: completeCoverage(),
        claims: [primary, mixed],
        generatedAt,
      }),
    /mixes claim bindings/,
  );

  const related = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.clusters.members",
    subject: "openclaw/openclaw#issue:2",
    relations: [{ predicate: "member_of", target: "openclaw/openclaw#cluster:1" }],
    data: { number: 2 },
  });
  const bounded = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [related],
    generatedAt,
    maxNodes: 1,
  });
  assert.equal(bounded.graph.nodes.length, 1);
  assert.equal(bounded.graph.edges.length, 0);
  assert.deepEqual(bounded.included, { claims: 1, nodes: 1, edges: 0 });
  verifyGitcrawlEvidencePacket(bounded);
});

test("Gitcrawl packet verification reconstructs its bounded graph and included counts", () => {
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.clusters.members",
    subject: "openclaw/openclaw#pull:42",
    relations: [{ predicate: "member_of", target: "openclaw/openclaw#cluster:7" }],
    data: { number: 42 },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [claim],
    generatedAt,
  });
  for (const mutate of [
    (value: typeof packet) => {
      value.graph.nodes[0]!.label = "fabricated";
    },
    (value: typeof packet) => {
      value.graph.edges[0]!.predicate = "related_to";
    },
    (value: typeof packet) => {
      value.included.nodes += 1;
    },
    (value: typeof packet) => {
      value.included.edges += 1;
    },
  ]) {
    const tampered = structuredClone(packet);
    mutate(tampered);
    const { sha256: _sha256, ...unsigned } = tampered;
    tampered.sha256 = sha256Canonical(unsigned);
    assert.throws(
      () => verifyGitcrawlEvidencePacket(tampered),
      /graph does not match|included counts do not match/,
    );
  }
});

test("Gitcrawl packet v2 stops asserting omissions while v1 remains readable", () => {
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.clusters.list",
    subject: "openclaw/openclaw#cluster:7",
    data: { id: 7 },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [claim],
    generatedAt,
  });
  assert.equal(packet.version, GITCRAWL_PACKET_VERSION);
  assert.deepEqual(packet.included, { claims: 1, nodes: 1, edges: 0 });
  assert.equal("totals" in packet, false);
  assert.equal("omitted" in packet, false);

  const { version: _version, included: _included, sha256: _sha256, ...legacyCommon } = packet;
  const legacyUnsigned = {
    ...legacyCommon,
    version: GITCRAWL_PACKET_VERSION_V1,
    totals: { claims: 2, nodes: 1, edges: 0 },
    omitted: { claims: 1, nodes: 0, edges: 0 },
  };
  const legacyPacket = {
    ...legacyUnsigned,
    sha256: sha256Canonical(legacyUnsigned),
  } as unknown as Parameters<typeof verifyGitcrawlEvidencePacket>[0];
  assert.doesNotThrow(() => verifyGitcrawlEvidencePacket(legacyPacket));
  assert.match(
    renderGitcrawlEvidencePacket(legacyPacket).join("\n"),
    /1 declared omitted \(legacy\)/,
  );

  const incompatible = structuredClone(packet) as unknown as Record<string, unknown>;
  incompatible.totals = { claims: 2, nodes: 1, edges: 0 };
  incompatible.omitted = { claims: 1, nodes: 0, edges: 0 };
  const { sha256: _incompatibleSha, ...incompatibleUnsigned } = incompatible;
  incompatible.sha256 = sha256Canonical(incompatibleUnsigned);
  assert.throws(
    () =>
      verifyGitcrawlEvidencePacket(
        incompatible as unknown as Parameters<typeof verifyGitcrawlEvidencePacket>[0],
      ),
    /v2 evidence packet has incompatible count metadata/,
  );
});

test("Gitcrawl embedded packets are mandatory and parsed structurally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-required-"));
  const jobPath = path.join(dir, "job.md");
  const title = "<summary>Bounded digest-bound Gitcrawl evidence</summary>";
  const body = "Complete low-signal evidence.";
  const thread = {
    number: 42,
    kind: "pull_request",
    title,
    body,
    authorLogin: "contributor",
    authorType: "User",
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    assignees: [],
    securitySensitive: false,
    securityMetadataComplete: true,
    securityProjectionSha256: "d".repeat(64),
    policySignals: deriveGitcrawlThreadPolicySignals(title, body),
  };
  const searchClaim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.threads.search",
    subject: "openclaw/openclaw#pull:42",
    data: thread,
  });
  const reviewClaim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId,
    queryName: "gitcrawl.pull_requests.review_context",
    subject: "openclaw/openclaw#pull:42",
    data: { thread },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [searchClaim, reviewClaim],
    generatedAt,
  });
  const markdown = [
    "---",
    "repo: openclaw/openclaw",
    "cluster_id: low-signal-pr-sweep-v1-20260712T1200-01",
    "mode: plan",
    "job_intent: low_signal_pr_cleanup",
    "gitcrawl_evidence_schema: gitcrawl-evidence-job-v1",
    "gitcrawl_evidence_required: true",
    "triage_policy: low_signal_prs",
    "allowed_actions:",
    "  - comment",
    "canonical: []",
    "candidates:",
    '  - "#42"',
    "cluster_refs:",
    '  - "https://github.com/openclaw/openclaw/pull/42"',
    "---",
    "",
    "# Job",
    "",
    ...renderGitcrawlEvidencePacket(packet),
  ].join("\n");
  fs.writeFileSync(jobPath, markdown);
  assert.equal(
    verifyEmbeddedGitcrawlEvidencePacket(markdown, "openclaw/openclaw", true)?.sha256,
    packet.sha256,
  );
  assert.doesNotThrow(() => parseJob(jobPath));
  verifyGitcrawlEvidenceJobTargets(packet, {
    repo: "openclaw/openclaw",
    canonical: [],
    candidates: ["#42"],
    cluster_refs: ["https://github.com/openclaw/openclaw/pull/42"],
  });
  for (const [field, target] of [
    ["canonical", "#42"],
    ["candidates", "#43"],
    ["cluster_refs", "https://github.com/openclaw/openclaw/issues/43"],
  ] as const) {
    const tamperedTargets =
      field === "canonical"
        ? markdown.replace("canonical: []", `canonical:\n  - "${target}"`)
        : markdown.replace(new RegExp(`(${field}:\\n  - ")[^"]+`), `$1${target}`);
    fs.writeFileSync(jobPath, tamperedTargets);
    assert.throws(() => parseJob(jobPath), /does not exactly match|no unambiguous packet role/);
    const frontmatterText = tamperedTargets.match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert(frontmatterText);
    assert.throws(
      () =>
        renderPrompt({
          raw: tamperedTargets,
          frontmatter: parseSimpleYaml(frontmatterText),
        }),
      /does not exactly match|no unambiguous packet role/,
    );
  }
  for (const target of [
    "https://user:secret@github.com/openclaw/openclaw/pull/42",
    "https://github.com/openclaw/openclaw/pull/42?token=secret",
    "https://github.com/openclaw/openclaw/pull/42#secret",
  ]) {
    const tamperedTargets = markdown.replace(
      /cluster_refs:\n  - "[^"]+"/,
      `cluster_refs:\n  - "${target}"`,
    );
    const frontmatterText = tamperedTargets.match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert(frontmatterText);
    assert.throws(
      () =>
        renderPrompt({
          raw: tamperedTargets,
          frontmatter: parseSimpleYaml(frontmatterText),
        }),
      (error: Error) => {
        assert.match(error.message, /target is malformed/);
        assert.doesNotMatch(error.message, /secret|token|user/);
        return true;
      },
    );
  }
  fs.writeFileSync(jobPath, markdown);
  const inflated = markdown.replace(
    JSON.stringify(packet, null, 2),
    `${" ".repeat(64 * 1024)}${JSON.stringify(packet, null, 2)}`,
  );
  assert.throws(
    () => verifyEmbeddedGitcrawlEvidencePacket(inflated, "openclaw/openclaw", true),
    /exceeding 65536 bytes/,
  );

  fs.writeFileSync(jobPath, markdown.replace(/\n## Gitcrawl Evidence Packet[\s\S]*$/, ""));
  assert.throws(() => parseJob(jobPath), /missing its required Gitcrawl evidence packet/);

  fs.writeFileSync(jobPath, markdown.replace("gitcrawl_evidence_required: true\n", ""));
  assert.throws(() => parseJob(jobPath), /missing gitcrawl_evidence_required: true/);

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: low-signal-pr-sweep-20260712T1200-01",
      "mode: plan",
      "allowed_actions:",
      "  - comment",
      "---",
      "",
      "# Legacy queued job",
    ].join("\n"),
  );
  const legacyJob = parseJob(jobPath);
  assert(
    validateJob(legacyJob).some((error) =>
      error.includes("legacy pre-evidence Gitcrawl job is quarantined"),
    ),
  );
  assert.equal(runImporter("dist/repair/validate-job.js", [jobPath]).status, 1);
  assert.throws(() => renderPrompt(legacyJob), /legacy pre-evidence Gitcrawl job is quarantined/);

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: manual-repair",
      "mode: plan",
      "allowed_actions:",
      "  - comment",
      "---",
      "",
      "## Gitcrawl Evidence Packet",
      "",
      "ordinary prose, not a bound evidence section",
    ].join("\n"),
  );
  assert.doesNotThrow(() => parseJob(jobPath));
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl low-signal targets require both search and review claims", () => {
  const claim = (number: number, queryName: GitcrawlQueryRequest["name"]) => {
    const title = `Pull request ${number}`;
    const body = "Complete low-signal evidence.";
    const thread = {
      number,
      kind: "pull_request",
      title,
      body,
      authorLogin: "contributor",
      authorType: "User",
      authorAssociation: "CONTRIBUTOR",
      labels: [],
      assignees: [],
      securitySensitive: false,
      securityMetadataComplete: true,
      securityProjectionSha256: "d".repeat(64),
      policySignals: deriveGitcrawlThreadPolicySignals(title, body),
    };
    return createGitcrawlEvidenceClaim({
      provider: "cloud",
      snapshotId,
      queryName,
      subject: `openclaw/openclaw#pull:${number}`,
      data: queryName === "gitcrawl.pull_requests.review_context" ? { thread } : thread,
    });
  };
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [
      claim(42, "gitcrawl.threads.search"),
      claim(42, "gitcrawl.pull_requests.review_context"),
      claim(43, "gitcrawl.threads.search"),
    ],
    generatedAt,
  });
  assert.throws(
    () =>
      verifyGitcrawlEvidenceJobTargets(packet, {
        repo: "openclaw/openclaw",
        canonical: [],
        candidates: ["#42", "#43"],
        cluster_refs: ["#42", "#43"],
      }),
    /missing search or review evidence/,
  );
});

test("Gitcrawl low-signal targets reject foreign and duplicate claims", () => {
  const claim = (queryName: GitcrawlQueryRequest["name"], subject: string, number = 42) =>
    createGitcrawlEvidenceClaim({
      provider: "cloud",
      snapshotId,
      queryName,
      subject,
      data:
        queryName === "gitcrawl.pull_requests.review_context"
          ? { thread: { number, kind: "pull_request" } }
          : { number, kind: "pull_request" },
    });
  for (const claims of [
    [
      claim("gitcrawl.threads.search", "openclaw/openclaw#pull:42"),
      claim("gitcrawl.threads.search", "other/repository#pull:42"),
      claim("gitcrawl.pull_requests.review_context", "openclaw/openclaw#pull:42"),
    ],
    [
      claim("gitcrawl.threads.search", "openclaw/openclaw#pull:42"),
      claim("gitcrawl.threads.search", "openclaw/openclaw#pull:42"),
      claim("gitcrawl.pull_requests.review_context", "openclaw/openclaw#pull:42"),
    ],
  ]) {
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository: "openclaw/openclaw",
      snapshotId,
      coverage: completeCoverage(),
      claims,
      generatedAt,
    });
    assert.throws(
      () =>
        verifyGitcrawlEvidenceJobTargets(packet, {
          repo: "openclaw/openclaw",
          canonical: [],
          candidates: ["#42"],
          cluster_refs: ["#42"],
        }),
      /outside the packet repository|repeats its gitcrawl\.threads\.search claim/,
    );
  }
});

test("Gitcrawl low-signal target claims require matching safety projections", () => {
  const projection = {
    number: 42,
    kind: "pull_request",
    title: "docs: update guide",
    body: "Routine documentation update.",
    authorLogin: "contributor",
    authorType: "User",
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    assignees: [],
    securitySensitive: false,
    securityMetadataComplete: true,
    securityProjectionSha256: "a".repeat(64),
    policySignals: deriveGitcrawlThreadPolicySignals(
      "docs: update guide",
      "Routine documentation update.",
    ),
  };
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [
      createGitcrawlEvidenceClaim({
        provider: "cloud",
        snapshotId,
        queryName: "gitcrawl.threads.search",
        subject: "openclaw/openclaw#pull:42",
        data: projection,
      }),
      createGitcrawlEvidenceClaim({
        provider: "cloud",
        snapshotId,
        queryName: "gitcrawl.pull_requests.review_context",
        subject: "openclaw/openclaw#pull:42",
        data: { thread: { ...projection, authorAssociation: "MEMBER" } },
      }),
    ],
    generatedAt,
  });
  assert.throws(
    () =>
      verifyGitcrawlEvidenceJobTargets(packet, {
        repo: "openclaw/openclaw",
        canonical: [],
        candidates: ["#42"],
        cluster_refs: ["#42"],
      }),
    /search and review safety projections diverge/,
  );

  const { securityProjectionSha256: _digest, ...missingDigest } = projection;
  for (const [search, review] of [
    [missingDigest, projection],
    [projection, missingDigest],
    [missingDigest, missingDigest],
  ]) {
    const incomplete = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository: "openclaw/openclaw",
      snapshotId,
      coverage: completeCoverage(),
      claims: [
        createGitcrawlEvidenceClaim({
          provider: "cloud",
          snapshotId,
          queryName: "gitcrawl.threads.search",
          subject: "openclaw/openclaw#pull:42",
          data: search,
        }),
        createGitcrawlEvidenceClaim({
          provider: "cloud",
          snapshotId,
          queryName: "gitcrawl.pull_requests.review_context",
          subject: "openclaw/openclaw#pull:42",
          data: { thread: review },
        }),
      ],
      generatedAt,
    });
    assert.throws(
      () =>
        verifyGitcrawlEvidenceJobTargets(incomplete, {
          repo: "openclaw/openclaw",
          canonical: [],
          candidates: ["#42"],
          cluster_refs: ["#42"],
        }),
      /incomplete safety metadata/,
    );
  }
});

test("Gitcrawl cluster evidence rejects unsupported member states", () => {
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [
      createGitcrawlEvidenceClaim({
        provider: "cloud",
        snapshotId,
        queryName: "gitcrawl.clusters.members",
        subject: "openclaw/openclaw#pull:42",
        relations: [{ predicate: "member_of", target: "openclaw/openclaw#cluster:7" }],
        data: {
          number: 42,
          kind: "pull_request",
          state: "OPEN",
          role: "representative",
          clusterMemberCount: 1,
        },
      }),
    ],
    generatedAt,
  });
  assert.throws(
    () =>
      verifyGitcrawlEvidenceJobTargets(packet, {
        repo: "openclaw/openclaw",
        canonical: ["#42"],
        candidates: ["#42"],
        cluster_refs: ["#42"],
      }),
    /cluster member claim has an invalid state/,
  );
});

test("Gitcrawl cluster evidence binds declaration ids to the sole membership subject", () => {
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims: [
      createGitcrawlEvidenceClaim({
        provider: "cloud",
        snapshotId,
        queryName: "gitcrawl.clusters.list",
        subject: "openclaw/openclaw#cluster:7",
        data: {
          id: 8,
          memberCount: 1,
          representative: { number: 42, kind: "pull_request" },
        },
      }),
      createGitcrawlEvidenceClaim({
        provider: "cloud",
        snapshotId,
        queryName: "gitcrawl.clusters.members",
        subject: "openclaw/openclaw#pull:42",
        relations: [{ predicate: "member_of", target: "openclaw/openclaw#cluster:7" }],
        data: {
          number: 42,
          kind: "pull_request",
          state: "open",
          role: "representative",
          clusterMemberCount: 1,
        },
      }),
    ],
    generatedAt,
  });
  assert.throws(
    () =>
      verifyGitcrawlEvidenceJobTargets(packet, {
        repo: "openclaw/openclaw",
        canonical: ["#42"],
        candidates: ["#42"],
        cluster_refs: ["#42"],
      }),
    /declaration id does not match its membership subject/,
  );
});

test("Gitcrawl low-signal target claims bind payload number and kind to the subject", () => {
  const searchClaim = (data: Record<string, unknown>) =>
    createGitcrawlEvidenceClaim({
      provider: "cloud",
      snapshotId,
      queryName: "gitcrawl.threads.search",
      subject: "openclaw/openclaw#pull:42",
      data,
    });
  const reviewClaim = (thread: Record<string, unknown>) =>
    createGitcrawlEvidenceClaim({
      provider: "cloud",
      snapshotId,
      queryName: "gitcrawl.pull_requests.review_context",
      subject: "openclaw/openclaw#pull:42",
      data: { thread },
    });
  for (const claims of [
    [
      searchClaim({ number: 43, kind: "pull_request" }),
      reviewClaim({ number: 42, kind: "pull_request" }),
    ],
    [searchClaim({ number: 42, kind: "pull_request" }), reviewClaim({ number: 42, kind: "issue" })],
  ]) {
    const packet = buildGitcrawlEvidencePacket({
      provider: "cloud",
      repository: "openclaw/openclaw",
      snapshotId,
      coverage: completeCoverage(),
      claims,
      generatedAt,
    });
    assert.throws(
      () =>
        verifyGitcrawlEvidenceJobTargets(packet, {
          repo: "openclaw/openclaw",
          canonical: [],
          candidates: ["#42"],
          cluster_refs: ["#42"],
        }),
      /payload does not match|invalid pull request payload/,
    );
  }
});

test("Gitcrawl evidence migration preflight inventories, replaces, and archives legacy jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-migration-"));
  const jobs = path.join(dir, "jobs");
  const archive = path.join(dir, "archive");
  fs.mkdirSync(path.join(jobs, "nested"), { recursive: true });
  const currentCluster = path.join(jobs, "gitcrawl-evidence-v1-7-current.md");
  const currentLowSignal = path.join(jobs, "low-signal-pr-sweep-v1-20260712-current.md");
  const legacyCluster = path.join(jobs, "nested", "gitcrawl-7-legacy.md");
  const legacyLowSignal = path.join(jobs, "low-signal-pr-sweep-20260701-legacy.md");
  const invalidCurrent = path.join(jobs, "gitcrawl-evidence-v1-9-invalid.md");
  const malformedLegacy = path.join(jobs, "gitcrawl-10-malformed.md");
  fs.writeFileSync(currentCluster, migrationEvidenceJob("gitcrawl-evidence-v1-7-current", [42]));
  fs.writeFileSync(
    currentLowSignal,
    migrationEvidenceJob("low-signal-pr-sweep-v1-20260712-current", [99]),
  );
  fs.writeFileSync(legacyCluster, legacyMigrationJob("gitcrawl-7-legacy", [42]));
  fs.writeFileSync(
    legacyLowSignal,
    legacyMigrationJob("low-signal-pr-sweep-20260701-legacy", [99]),
  );
  fs.writeFileSync(
    invalidCurrent,
    legacyMigrationJob("gitcrawl-evidence-v1-9-invalid", [9]).replace(
      "mode: plan",
      "mode: plan\ngitcrawl_evidence_schema: gitcrawl-evidence-job-v1\ngitcrawl_evidence_required: true",
    ),
  );
  fs.writeFileSync(
    malformedLegacy,
    "---\nrepo: openclaw/openclaw\ncluster_id: gitcrawl-10-malformed\nunsupported yaml\n---\n",
  );
  fs.writeFileSync(path.join(jobs, "manual.md"), legacyMigrationJob("manual-repair", [123]));
  fs.mkdirSync(path.join(jobs, ".legacy-gitcrawl-quarantine"), { recursive: true });
  fs.writeFileSync(
    path.join(jobs, ".legacy-gitcrawl-quarantine", "ignored.md"),
    legacyMigrationJob("gitcrawl-99-ignored", [999]),
  );

  const defaultReport = inventoryGitcrawlEvidenceMigration({
    jobsDirectory: jobs,
    provider: "local",
    dbPath: path.join(dir, "gitcrawl.db"),
  });
  assert.equal(defaultReport.archive_directory, path.join(dir, ".legacy-gitcrawl-quarantine"));
  assert.throws(
    () =>
      inventoryGitcrawlEvidenceMigration({
        jobsDirectory: jobs,
        archiveDirectory: path.join(jobs, "archive"),
      }),
    /archive must be outside the active jobs tree/,
  );
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const archiveSymlink = path.join(outside, "archive-link");
  fs.symlinkSync(path.join(jobs, "nested"), archiveSymlink, "dir");
  assert.throws(
    () =>
      inventoryGitcrawlEvidenceMigration({
        jobsDirectory: jobs,
        archiveDirectory: archiveSymlink,
      }),
    /archive must be outside the active jobs tree/,
  );

  const report = inventoryGitcrawlEvidenceMigration({
    jobsDirectory: jobs,
    archiveDirectory: archive,
    provider: "local",
    dbPath: path.join(dir, "gitcrawl.db"),
    maxSnapshotAgeHours: 48,
  });
  assert.deepEqual(report.summary, {
    markdown_files: 7,
    current_jobs: 2,
    legacy_jobs: 2,
    legacy_ready_to_archive: 2,
    invalid_jobs: 2,
  });
  assert.deepEqual(
    report.legacy_jobs.map((entry) => [entry.kind, entry.ready_to_archive]),
    [
      ["low_signal", true],
      ["cluster", true],
    ],
  );
  const cluster = report.legacy_jobs.find((entry) => entry.kind === "cluster")!;
  assert.equal(cluster.reimport_strategy, "exact_cluster");
  assert(cluster.reimport.args.includes("7"));
  assert(cluster.reimport.args.includes("--skip-existing"));
  assert(cluster.reimport.args.includes(path.resolve(dir, "gitcrawl.db")));
  const lowSignal = report.legacy_jobs.find((entry) => entry.kind === "low_signal")!;
  assert.equal(lowSignal.reimport_strategy, "current_policy_rescan");
  assert.deepEqual(lowSignal.targets, ["#99"]);

  const manifest = path.join(dir, "migration.json");
  const blocked = runImporter("dist/repair/gitcrawl-evidence-preflight.js", [
    "--jobs",
    jobs,
    "--archive",
    archive,
    "--write-manifest",
    manifest,
    "--require-replacements",
  ]);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(fs.existsSync(manifest), true);
  fs.rmSync(invalidCurrent);
  fs.rmSync(malformedLegacy);
  assert.equal(
    runImporter("dist/repair/gitcrawl-evidence-preflight.js", [
      "--jobs",
      jobs,
      "--archive",
      archive,
      "--require-replacements",
    ]).status,
    0,
  );
  assert.equal(
    runImporter("dist/repair/gitcrawl-evidence-preflight.js", [
      "--jobs",
      jobs,
      "--archive",
      archive,
      "--require-clean",
    ]).status,
    2,
  );
  const clusterArchivePath = path.join(archive, "nested", "gitcrawl-7-legacy.md");
  fs.mkdirSync(path.dirname(clusterArchivePath), { recursive: true });
  fs.writeFileSync(clusterArchivePath, "existing quarantine");
  const noClobber = spawnSync(cluster.archive.command, cluster.archive.args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(noClobber.status, 0);
  assert.equal(fs.readFileSync(clusterArchivePath, "utf8"), "existing quarantine");
  assert.equal(fs.existsSync(legacyCluster), true);
  fs.rmSync(clusterArchivePath);
  for (const entry of report.legacy_jobs) {
    const archived = spawnSync(entry.archive.command, entry.archive.args, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(archived.status, 0, archived.stderr);
  }
  assert.equal(
    runImporter("dist/repair/gitcrawl-evidence-preflight.js", [
      "--jobs",
      jobs,
      "--archive",
      archive,
      "--require-clean",
    ]).status,
    0,
  );
  assert.equal(fs.existsSync(clusterArchivePath), true);
  fs.mkdirSync(path.dirname(legacyCluster), { recursive: true });
  fs.writeFileSync(legacyCluster, "replacement queue file");
  const blockedRollback = spawnSync(cluster.rollback.command, cluster.rollback.args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(blockedRollback.status, 0);
  assert.equal(fs.readFileSync(legacyCluster, "utf8"), "replacement queue file");
  assert.equal(fs.existsSync(clusterArchivePath), true);
  fs.rmSync(legacyCluster);
  const rolledBack = spawnSync(cluster.rollback.command, cluster.rollback.args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(fs.existsSync(legacyCluster), true);
  assert.equal(fs.existsSync(clusterArchivePath), false);
  const rearchived = spawnSync(cluster.archive.command, cluster.archive.args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(rearchived.status, 0, rearchived.stderr);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl migration reimports invalid deterministic cluster jobs through free staging paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-migration-staging-"));
  const jobs = path.join(dir, "jobs");
  fs.mkdirSync(jobs);
  fs.writeFileSync(
    path.join(jobs, "gitcrawl-evidence-v1-7-invalid.md"),
    legacyMigrationJob("gitcrawl-evidence-v1-7-invalid", [42]).replace(
      "mode: plan",
      "mode: plan\ngitcrawl_evidence_schema: gitcrawl-evidence-job-v1\ngitcrawl_evidence_required: true",
    ),
  );
  fs.writeFileSync(
    path.join(jobs, "gitcrawl-7-legacy.md"),
    legacyMigrationJob("gitcrawl-7-legacy", [42]),
  );

  const first = inventoryGitcrawlEvidenceMigration({ jobsDirectory: jobs });
  const entry = first.legacy_jobs[0]!;
  assert.deepEqual(entry.replacement_paths, []);
  assert(first.invalid_jobs.some((candidate) => candidate.path.includes("invalid")));
  const suffixIndex = entry.reimport.args.indexOf("--suffix");
  assert.notEqual(suffixIndex, -1);
  const firstSuffix = entry.reimport.args[suffixIndex + 1]!;
  const firstOutput = path.join(jobs, `gitcrawl-evidence-v1-7-${firstSuffix}.md`);
  assert.equal(fs.existsSync(firstOutput), false);

  fs.writeFileSync(firstOutput, "occupied staging path\n");
  const secondEntry = inventoryGitcrawlEvidenceMigration({
    jobsDirectory: jobs,
  }).legacy_jobs[0]!;
  const secondSuffix =
    secondEntry.reimport.args[secondEntry.reimport.args.indexOf("--suffix") + 1]!;
  assert.notEqual(secondSuffix, firstSuffix);
  assert.equal(fs.existsSync(path.join(jobs, `gitcrawl-evidence-v1-7-${secondSuffix}.md`)), false);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl migration preflight binds cross-filesystem writer exclusion into commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-migration-cross-"));
  const jobs = path.join(dir, "jobs");
  const archive = path.join(dir, "archive");
  fs.mkdirSync(jobs);
  fs.writeFileSync(
    path.join(jobs, "gitcrawl-evidence-v1-7-current.md"),
    migrationEvidenceJob("gitcrawl-evidence-v1-7-current", [42]),
  );
  fs.writeFileSync(
    path.join(jobs, "gitcrawl-7-legacy.md"),
    legacyMigrationJob("gitcrawl-7-legacy", [42]),
  );
  const restoreHooks = __setGitcrawlEvidenceMigrationTestHooks({
    forceCrossFilesystem: true,
  });
  try {
    const blocked = inventoryGitcrawlEvidenceMigration({
      jobsDirectory: jobs,
      archiveDirectory: archive,
    }).legacy_jobs[0]!;
    assert.equal(blocked.writer_exclusion_required, true);
    assert.equal(blocked.writer_exclusion_confirmed, false);
    assert.equal(blocked.ready_to_archive, false);
    assert.equal(blocked.archive.args.includes("--writer-excluded"), false);
    assert.equal(blocked.rollback.args.includes("--writer-excluded"), false);

    const confirmed = inventoryGitcrawlEvidenceMigration({
      jobsDirectory: jobs,
      archiveDirectory: archive,
      writerExcluded: true,
    }).legacy_jobs[0]!;
    assert.equal(confirmed.writer_exclusion_required, true);
    assert.equal(confirmed.writer_exclusion_confirmed, true);
    assert.equal(confirmed.ready_to_archive, true);
    assert.equal(confirmed.archive.args.at(-1), "--writer-excluded");
    assert.equal(confirmed.rollback.args.at(-1), "--writer-excluded");
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl evidence archive rejects a source replaced before its anchor is pinned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-archive-anchor-race-"));
  const source = path.join(dir, "jobs", "legacy.md");
  const destination = path.join(dir, "archive", "legacy.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "original legacy job");
  let anchor = "";
  const restoreHooks = __setGitcrawlEvidenceArchiveTestHooks({
    beforeSourceAnchorLink: ({ source: candidate, anchor: candidateAnchor }) => {
      assert.equal(candidate, source);
      anchor = candidateAnchor;
      fs.rmSync(source);
      fs.writeFileSync(source, "successor queue job");
    },
  });
  try {
    assert.throws(
      () => moveGitcrawlEvidenceNoClobber("archive", source, destination),
      /source changed before anchoring/,
    );
    assert.equal(fs.readFileSync(source, "utf8"), "successor queue job");
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(anchor), false);
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl evidence archive publishes only the pinned anchor after source replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-archive-pinned-race-"));
  const source = path.join(dir, "jobs", "legacy.md");
  const destination = path.join(dir, "archive", "legacy.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "pinned legacy job");
  let anchor = "";
  const restoreHooks = __setGitcrawlEvidenceArchiveTestHooks({
    afterSourceAnchor: ({ anchor: candidateAnchor }) => {
      anchor = candidateAnchor;
      fs.rmSync(source);
      fs.writeFileSync(source, "successor queue job");
    },
  });
  try {
    assert.throws(
      () => moveGitcrawlEvidenceNoClobber("archive", source, destination),
      /source ownership changed during transfer/,
    );
    assert.equal(fs.readFileSync(source, "utf8"), "successor queue job");
    assert.equal(fs.readFileSync(destination, "utf8"), "pinned legacy job");
    assert.equal(fs.existsSync(anchor), false);
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl evidence archive preserves a source recreated before removal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-archive-race-"));
  const source = path.join(dir, "jobs", "legacy.md");
  const destination = path.join(dir, "archive", "legacy.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "pinned legacy job");
  const restoreHooks = __setGitcrawlEvidenceArchiveTestHooks({
    beforeSourceQuarantine: ({ source: candidate }) => {
      assert.equal(candidate, source);
      fs.rmSync(source);
      fs.writeFileSync(source, "successor queue job");
    },
  });
  try {
    assert.throws(
      () => moveGitcrawlEvidenceNoClobber("archive", source, destination),
      /source ownership changed during transfer/,
    );
    assert.equal(fs.readFileSync(source, "utf8"), "successor queue job");
    assert.equal(fs.readFileSync(destination, "utf8"), "pinned legacy job");
    assert.equal(
      fs.readdirSync(path.dirname(source)).some((name) => name.includes(".moving-")),
      false,
    );
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl evidence archive preserves the live inode and open-descriptor writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-archive-inode-"));
  const source = path.join(dir, "jobs", "legacy.md");
  const destination = path.join(dir, "archive", "legacy.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "pinned legacy job");
  const sourceIdentity = fs.lstatSync(source);
  const writer = fs.openSync(source, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  const restoreHooks = __setGitcrawlEvidenceArchiveTestHooks({
    beforeSourceQuarantine: () => {
      fs.writeSync(writer, " + live write");
      fs.fsyncSync(writer);
    },
  });
  try {
    moveGitcrawlEvidenceNoClobber("archive", source, destination);
    const destinationIdentity = fs.lstatSync(destination);
    assert.equal(destinationIdentity.dev, sourceIdentity.dev);
    assert.equal(destinationIdentity.ino, sourceIdentity.ino);
    assert.equal(fs.readFileSync(destination, "utf8"), "pinned legacy job + live write");
    assert.equal(fs.existsSync(source), false);
  } finally {
    restoreHooks();
    fs.closeSync(writer);
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl evidence archive verifies destination ownership before source removal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-archive-dest-"));
  const source = path.join(dir, "jobs", "legacy.md");
  const destination = path.join(dir, "archive", "legacy.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "pinned legacy job");
  const restoreHooks = __setGitcrawlEvidenceArchiveTestHooks({
    beforeSourceQuarantine: () => {
      fs.rmSync(destination);
      fs.writeFileSync(destination, "replacement archive");
    },
  });
  try {
    assert.throws(
      () => moveGitcrawlEvidenceNoClobber("archive", source, destination),
      /source ownership changed during transfer/,
    );
    assert.equal(fs.readFileSync(source, "utf8"), "pinned legacy job");
    assert.equal(fs.readFileSync(destination, "utf8"), "replacement archive");
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl cross-filesystem archive requires explicit writer exclusion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-archive-cross-"));
  const source = path.join(dir, "jobs", "legacy.md");
  const destination = path.join(dir, "archive", "legacy.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "pinned legacy job");
  const restoreHooks = __setGitcrawlEvidenceArchiveTestHooks({
    forceCrossFilesystem: true,
  });
  try {
    assert.throws(
      () => moveGitcrawlEvidenceNoClobber("archive", source, destination),
      /requires --writer-excluded/,
    );
    assert.equal(fs.readFileSync(source, "utf8"), "pinned legacy job");
    assert.equal(fs.existsSync(destination), false);
    moveGitcrawlEvidenceNoClobber("archive", source, destination, {
      writerExcluded: true,
    });
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(destination, "utf8"), "pinned legacy job");
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl active validation ignores legacy in-tree quarantine records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-validate-"));
  const jobs = path.join(dir, "jobs");
  fs.mkdirSync(path.join(jobs, ".legacy-gitcrawl-quarantine"), { recursive: true });
  fs.writeFileSync(path.join(jobs, "active.md"), legacyMigrationJob("manual-repair", [42]));
  fs.writeFileSync(
    path.join(jobs, ".legacy-gitcrawl-quarantine", "invalid.md"),
    "---\nmalformed\n---\n",
  );
  fs.cpSync(path.join(process.cwd(), "dist"), path.join(dir, "dist"), { recursive: true });
  fs.cpSync(path.join(process.cwd(), "config"), path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  const validated = spawnSync(process.execPath, [path.join(dir, "dist/repair/validate-all.js")], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /validated 1 job\(s\)/);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl generated jobs publish atomically without clobbering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-publication-"));
  const destination = path.join(dir, "job.md");
  let observedTemporary = "";
  const restoreHooks = __setGitcrawlJobPublicationTestHooks({
    beforePublish: ({ destination: candidate, temporary }) => {
      assert.equal(candidate, destination);
      if (fs.existsSync(destination)) return;
      assert.equal(fs.existsSync(destination), false);
      assert.equal(fs.readFileSync(temporary, "utf8"), "complete job");
      assert.equal(fs.lstatSync(temporary).isSymbolicLink(), false);
      observedTemporary = temporary;
    },
  });
  try {
    publishGitcrawlGeneratedJob(destination, "complete job");
    assert.match(path.basename(observedTemporary), /^\.job\.md\.publish-[0-9a-f-]+$/);
    assert.equal(fs.readFileSync(destination, "utf8"), "complete job");
    assert.equal(fs.existsSync(observedTemporary), false);
    assert.throws(
      () => publishGitcrawlGeneratedJob(destination, "replacement"),
      /EEXIST|file already exists/,
    );
    assert.equal(fs.readFileSync(destination, "utf8"), "complete job");
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl generated job publication rejects temporary path replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-job-temp-"));
  const destination = path.join(dir, "job.md");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "preserve me");
  let temporary = "";
  const restoreHooks = __setGitcrawlJobPublicationTestHooks({
    beforePublish: ({ temporary: candidate }) => {
      temporary = candidate;
      fs.unlinkSync(candidate);
      fs.symlinkSync(victim, candidate);
    },
  });
  try {
    assert.throws(
      () => publishGitcrawlGeneratedJob(destination, "complete job"),
      /temporary changed before publication/,
    );
    assert.match(path.basename(temporary), /^\.job\.md\.publish-[0-9a-f-]+$/);
    assert.equal(fs.readFileSync(victim, "utf8"), "preserve me");
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl generated job publication removes a replacement linked after validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-job-link-race-"));
  const destination = path.join(dir, "job.md");
  const restoreHooks = __setGitcrawlJobPublicationTestHooks({
    beforeLink: ({ temporary }) => {
      fs.unlinkSync(temporary);
      fs.writeFileSync(temporary, "attacker replacement");
    },
  });
  try {
    assert.throws(
      () => publishGitcrawlGeneratedJob(destination, "complete job"),
      /publication changed identity/,
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(
      fs.readdirSync(dir).some((name) => name.includes(".cleanup-")),
      false,
    );
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl generated job publication preserves a successor destination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-job-destination-race-"));
  const destination = path.join(dir, "job.md");
  const restoreHooks = __setGitcrawlJobPublicationTestHooks({
    afterLink: () => {
      fs.unlinkSync(destination);
      fs.writeFileSync(destination, "successor job");
    },
  });
  try {
    assert.throws(
      () => publishGitcrawlGeneratedJob(destination, "complete job"),
      /publication changed identity/,
    );
    assert.equal(fs.readFileSync(destination, "utf8"), "successor job");
    assert.equal(
      fs.readdirSync(dir).some((name) => name.includes(".cleanup-")),
      false,
    );
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl scan cursors round-trip and fail closed on tamper", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-cursor-"));
  writeGitcrawlScanOffset({
    directory: dir,
    key: "clusters:local:openclaw/openclaw:min-size=2",
    offset: 17,
    snapshotId,
    providerCursor: "cursor-17",
    querySha256: queryDigest,
    orderKey: { updatedAt: generatedAt, number: 42 },
    updatedAt: generatedAt,
  });
  assert.equal(readGitcrawlScanOffset(dir, "clusters:local:openclaw/openclaw:min-size=2"), 17);
  assert.deepEqual(readGitcrawlScanCursor(dir, "clusters:local:openclaw/openclaw:min-size=2"), {
    offset: 17,
    archive: archiveId,
    snapshotId,
    providerCursor: "cursor-17",
    querySha256: queryDigest,
    orderKey: { updatedAt: generatedAt, number: 42 },
  });
  assert.equal(
    compatibleGitcrawlScanCursor(
      readGitcrawlScanCursor(dir, "clusters:local:openclaw/openclaw:min-size=2"),
      archiveId,
      "snapshot-b",
    ),
    undefined,
  );
  assert.equal(
    compatibleGitcrawlScanCursor(
      readGitcrawlScanCursor(dir, "clusters:local:openclaw/openclaw:min-size=2"),
      "replacement-archive",
      snapshotId,
    ),
    undefined,
  );
  writeGitcrawlScanOffset({
    directory: dir,
    key: "clusters:local:openclaw/openclaw:policy=v1",
    offset: 4,
    snapshotId,
    providerCursor: "cursor-4",
    querySha256: queryDigest,
    clusterOrderKey: { memberCount: 2, updatedAt: generatedAt, id: 7 },
    updatedAt: generatedAt,
  });
  assert.deepEqual(
    readGitcrawlScanCursor(dir, "clusters:local:openclaw/openclaw:policy=v1")?.clusterOrderKey,
    { memberCount: 2, updatedAt: generatedAt, id: 7 },
  );
  fs.writeFileSync(
    path.join(dir, ".gitcrawl-scan-cursors.json"),
    JSON.stringify({
      schema: "clawsweeper-gitcrawl-scan-cursors-v2",
      cursors: {
        bad: {
          offset: -1,
          snapshot_id: snapshotId,
          provider_cursor: "cursor-1",
          updated_at: generatedAt,
        },
      },
    }),
  );
  assert.throws(() => readGitcrawlScanOffset(dir, "bad"), /malformed Gitcrawl scan cursor entry/);
  fs.writeFileSync(
    path.join(dir, ".gitcrawl-scan-cursors.json"),
    JSON.stringify({
      schema: "clawsweeper-gitcrawl-scan-cursors-v2",
      cursors: {
        bad: {
          offset: 1,
          snapshot_id: "\u0000",
          provider_cursor: "cursor-1",
          updated_at: generatedAt,
        },
      },
    }),
  );
  assert.throws(() => readGitcrawlScanOffset(dir, "bad"), /malformed Gitcrawl scan cursor entry/);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl scan cursors safely reset validated v2 and v3 state before writing v4", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-cursor-v2-"));
  const cursorFile = path.join(dir, ".gitcrawl-scan-cursors.json");
  fs.writeFileSync(
    cursorFile,
    JSON.stringify({
      schema: "clawsweeper-gitcrawl-scan-cursors-v2",
      cursors: {
        legacy: {
          offset: 7,
          snapshot_id: snapshotId,
          provider_cursor: "cursor-7",
          updated_at: generatedAt,
        },
      },
    }),
  );
  assert.equal(readGitcrawlScanCursor(dir, "legacy"), undefined);
  fs.writeFileSync(
    cursorFile,
    JSON.stringify({
      schema: "clawsweeper-gitcrawl-scan-cursors-v3",
      cursors: {
        legacy: {
          offset: 7,
          snapshot_id: snapshotId,
          provider_cursor: "cursor-7",
          query_sha256: queryDigest,
          updated_at: generatedAt,
        },
      },
    }),
  );
  assert.equal(readGitcrawlScanCursor(dir, "legacy"), undefined);
  writeGitcrawlScanOffset({
    directory: dir,
    key: "legacy",
    offset: 1,
    snapshotId,
    providerCursor: "cursor-1",
    querySha256: queryDigest,
    updatedAt: generatedAt,
  });
  const written = JSON.parse(fs.readFileSync(cursorFile, "utf8")) as {
    schema: string;
    cursors: Record<string, { query_sha256?: string }>;
  };
  assert.equal(written.schema, "clawsweeper-gitcrawl-scan-cursors-v4");
  assert.equal(written.cursors.legacy?.query_sha256, queryDigest);
  assert.equal(readGitcrawlScanOffset(dir, "legacy"), 1);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl scan cursor updates are monotonic and compare-and-swap bound", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-cursor-cas-"));
  const base = {
    directory: dir,
    key: "clusters:local:openclaw/openclaw:cas",
    snapshotId,
    querySha256: queryDigest,
  };
  writeGitcrawlScanOffset({ ...base, offset: 5, providerCursor: "cursor-5" });
  const first = readGitcrawlScanCursor(dir, base.key)!;
  assert.throws(
    () => writeGitcrawlScanOffset({ ...base, offset: 4, providerCursor: "cursor-4" }),
    /regressive/,
  );
  writeGitcrawlScanOffset({ ...base, offset: 0, providerCursor: "" });
  assert.equal(readGitcrawlScanOffset(dir, base.key), 5);
  assert.throws(
    () => writeGitcrawlScanOffset({ ...base, offset: 5, providerCursor: "other-5" }),
    /conflicts at offset/,
  );
  writeGitcrawlScanOffset({
    ...base,
    snapshotId: "snapshot-b",
    offset: 1,
    providerCursor: "cursor-1",
    expected: first,
  });
  assert.equal(readGitcrawlScanCursor(dir, base.key)?.snapshotId, "snapshot-b");
  assert.throws(
    () =>
      writeGitcrawlScanOffset({
        ...base,
        snapshotId: "snapshot-c",
        offset: 2,
        providerCursor: "cursor-2",
        expected: first,
      }),
    /changed before update/,
  );
  assert.equal(readGitcrawlScanCursor(dir, base.key)?.snapshotId, "snapshot-b");
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl cursor temporaries reject path replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-cursor-temp-"));
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "preserve me");
  let temporaryName = "";
  const restoreHooks = __setGitcrawlCursorLockTestHooks({
    beforeCursorPublish: ({ temporary }) => {
      temporaryName = path.basename(temporary);
      fs.unlinkSync(temporary);
      fs.symlinkSync(victim, temporary);
    },
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /cursor temporary changed before publication/,
    );
    assert.match(temporaryName, /^\.gitcrawl-scan-cursors\.json\.write-[0-9a-f-]+$/);
    assert.equal(fs.readFileSync(victim, "utf8"), "preserve me");
    assert.equal(fs.existsSync(path.join(dir, ".gitcrawl-scan-cursors.json")), false);
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl SQLite lock initialization rejects path replacement and symlinks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-db-"));
  const victim = path.join(dir, "victim.sqlite");
  fs.writeFileSync(victim, "preserve me");
  let temporaryName = "";
  const restoreHooks = __setGitcrawlCursorLockTestHooks({
    beforeLockDatabasePublish: ({ temporary }) => {
      temporaryName = path.basename(temporary);
      fs.unlinkSync(temporary);
      fs.symlinkSync(victim, temporary);
    },
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /lock database changed before publication/,
    );
    assert.match(temporaryName, /^\.lock\.sqlite\.init-[0-9a-f-]+$/);
    assert.equal(fs.readFileSync(victim, "utf8"), "preserve me");
  } finally {
    restoreHooks();
  }

  const lockDirectory = path.join(dir, ".gitcrawl-scan-cursors.lock-v2");
  fs.mkdirSync(lockDirectory);
  fs.symlinkSync(victim, path.join(lockDirectory, "lock.sqlite"));
  assert.throws(
    () =>
      writeGitcrawlScanOffset({
        directory: dir,
        key: "symlink",
        offset: 1,
        snapshotId,
        providerCursor: "cursor-1",
        querySha256: queryDigest,
      }),
    /lock database must be a regular file/,
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "preserve me");
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl legacy migration database rejects replacement before and after validation", () => {
  for (const phase of ["before-validation", "before-link"] as const) {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), `clawsweeper-gitcrawl-migration-db-${phase}-`),
    );
    const victim = path.join(dir, "victim.sqlite");
    const databasePath = path.join(dir, ".gitcrawl-scan-cursors.lock-migration.sqlite");
    fs.writeFileSync(victim, "preserve me");
    let temporary = "";
    const replaceTemporary = (candidate: string): void => {
      temporary = candidate;
      fs.unlinkSync(candidate);
      if (phase === "before-validation") fs.symlinkSync(victim, candidate);
      else fs.writeFileSync(candidate, "attacker replacement");
    };
    const hooks =
      phase === "before-validation"
        ? {
            beforeLegacyMigrationDatabasePublish: ({
              temporary: candidate,
            }: {
              temporary: string;
            }) => replaceTemporary(candidate),
          }
        : {
            beforeLegacyMigrationDatabaseLink: ({ temporary: candidate }: { temporary: string }) =>
              replaceTemporary(candidate),
          };
    const restoreHooks = __setGitcrawlCursorLockTestHooks(hooks);
    try {
      assert.throws(
        () =>
          writeGitcrawlScanOffset({
            directory: dir,
            key: phase,
            offset: 1,
            snapshotId,
            providerCursor: "cursor-1",
            querySha256: queryDigest,
          }),
        phase === "before-validation"
          ? /migration database changed before publication/
          : /migration database changed during publication/,
      );
      assert.match(
        path.basename(temporary),
        /^\.gitcrawl-scan-cursors\.lock-migration\.sqlite\.init-[0-9a-f-]+$/,
      );
      assert.equal(fs.readFileSync(victim, "utf8"), "preserve me");
      assert.equal(fs.existsSync(databasePath), false);
      assert.equal(fs.existsSync(temporary), false);
    } finally {
      restoreHooks();
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("Gitcrawl SQLite lock initialization reclaims only stale recognizable temporaries", () => {
  const recovered = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-recover-"));
  const recoveredLock = path.join(recovered, ".gitcrawl-scan-cursors.lock-v2");
  const staleTime = new Date(Date.now() - 60_000);
  fs.mkdirSync(recoveredLock);
  const interrupted = path.join(
    recoveredLock,
    ".lock.sqlite.init-00000000-0000-4000-8000-000000000000",
  );
  fs.writeFileSync(interrupted, "partial sqlite initialization");
  fs.utimesSync(interrupted, staleTime, staleTime);
  fs.utimesSync(recoveredLock, staleTime, staleTime);
  writeGitcrawlScanOffset({
    directory: recovered,
    key: "recovered",
    offset: 1,
    snapshotId,
    providerCursor: "cursor-1",
    querySha256: queryDigest,
  });
  assert.equal(readGitcrawlScanOffset(recovered, "recovered"), 1);
  assert.equal(fs.existsSync(path.join(recoveredLock, "lock.sqlite")), true);
  assert.equal(fs.existsSync(interrupted), false);
  fs.rmSync(recovered, { force: true, recursive: true });

  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-blocked-"));
  const blockedLock = path.join(blocked, ".gitcrawl-scan-cursors.lock-v2");
  fs.mkdirSync(blockedLock);
  fs.writeFileSync(path.join(blockedLock, "unrecognized-owner"), "preserve");
  fs.utimesSync(blockedLock, staleTime, staleTime);
  assert.throws(
    () =>
      writeGitcrawlScanOffset({
        directory: blocked,
        key: "blocked",
        offset: 1,
        snapshotId,
        providerCursor: "cursor-1",
        querySha256: queryDigest,
      }),
    /lock database failed identity validation/,
  );
  assert.equal(fs.readFileSync(path.join(blockedLock, "unrecognized-owner"), "utf8"), "preserve");
  fs.rmSync(blocked, { force: true, recursive: true });
});

test("Gitcrawl scan cursors serialize shared updates across processes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-cursor-lock-"));
  const lockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const legacyMigrationPath = path.join(dir, ".gitcrawl-scan-cursors.lock-migration");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
  );
  const blockedWriter = runCursorWriter(dir, "blocked", 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readGitcrawlScanCursor(dir, "blocked"), undefined);
  fs.rmSync(lockPath);
  await blockedWriter;

  fs.rmSync(lockPath, { force: true, recursive: true });
  const durableLockDatabase = path.join(dir, ".gitcrawl-scan-cursors.lock-v2", "lock.sqlite");
  const durableLockIdentity = fs.lstatSync(durableLockDatabase);
  fs.mkdirSync(lockPath);
  const staleTime = new Date(Date.now() - 60_000);
  for (const suffix of ["a", "b"]) {
    const stale = path.join(lockPath, `0000000000000000-2147483647-dead-${suffix}.json`);
    fs.writeFileSync(
      stale,
      JSON.stringify({
        pid: 2_147_483_647,
        token: `dead-${suffix}`,
        acquired_at: staleTime.toISOString(),
      }),
    );
    fs.utimesSync(stale, staleTime, staleTime);
  }
  fs.mkdirSync(legacyMigrationPath);
  fs.utimesSync(legacyMigrationPath, staleTime, staleTime);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) => runCursorWriter(dir, `writer-${index}`, index + 2)),
  );
  for (let index = 0; index < 12; index += 1) {
    assert.equal(readGitcrawlScanOffset(dir, `writer-${index}`), index + 2);
  }
  assert.equal(readGitcrawlScanOffset(dir, "blocked"), 1);
  const durableLockAfterMigration = fs.lstatSync(durableLockDatabase);
  assert.equal(durableLockAfterMigration.dev, durableLockIdentity.dev);
  assert.equal(durableLockAfterMigration.ino, durableLockIdentity.ino);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(legacyMigrationPath), false);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl scan cursors serialize with the mixed-version migration and legacy locks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-mixed-lock-"));
  const migrationPath = path.join(dir, ".gitcrawl-scan-cursors.lock-migration.sqlite");
  const legacyLockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const migration = new DatabaseSync(migrationPath, { timeout: 5_000 });
  migration.exec("pragma journal_mode = delete");
  migration.exec("create table migration_guard (id integer primary key check (id = 1))");
  migration.exec("begin immediate");

  const writer = runCursorWriter(dir, "mixed-version", 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(legacyLockPath), false);
  assert.equal(readGitcrawlScanCursor(dir, "mixed-version"), undefined);

  fs.mkdirSync(legacyLockPath);
  const legacy = new DatabaseSync(path.join(legacyLockPath, "lock.sqlite"), { timeout: 5_000 });
  legacy.exec("pragma journal_mode = delete");
  legacy.exec("create table lock_guard (id integer primary key check (id = 1))");
  legacy.exec("begin immediate");
  migration.exec("commit");
  migration.close();

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readGitcrawlScanCursor(dir, "mixed-version"), undefined);
  legacy.exec("commit");
  legacy.close();
  await writer;

  assert.equal(readGitcrawlScanOffset(dir, "mixed-version"), 1);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl stale lock reclamation preserves a replacement lock by identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-identity-"));
  const lockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const staleTime = new Date(Date.now() - 60_000);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 2_147_483_647, acquired_at: staleTime.toISOString() }),
  );
  fs.utimesSync(lockPath, staleTime, staleTime);
  const realNow = Date.now();
  let replaced = false;
  const restoreTestHooks = __setGitcrawlCursorLockTestHooks({
    beforeQuarantineRename: ({ entryPath }) => {
      if (entryPath !== lockPath || replaced) return;
      replaced = true;
      fs.rmSync(lockPath);
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquired_at: new Date(realNow).toISOString() }),
      );
    },
    now: () => (replaced ? realNow + 10_000 : realNow),
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /timed out waiting for Gitcrawl scan cursor lock/,
    );
    assert.equal(replaced, true);
    assert.equal(Number(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid), process.pid);
  } finally {
    restoreTestHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl legacy guard acquisition preserves a replacement lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-acquire-"));
  const lockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const successor = `${JSON.stringify({
    pid: process.pid,
    token: "successor",
    acquired_at: new Date().toISOString(),
  })}\n`;
  const restoreHooks = __setGitcrawlCursorLockTestHooks({
    beforeLegacyGuardValidate: ({ lockPath: candidate }) => {
      assert.equal(candidate, lockPath);
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, successor);
    },
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /legacy cursor guard changed during acquisition/,
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), successor);
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl directory durability tolerates unsupported native Windows opens", () => {
  const unsupported = Object.assign(new Error("directory open unsupported"), { code: "EPERM" });
  assert.doesNotThrow(() =>
    fsyncGitcrawlDirectory("C:\\queue", {
      platform: "win32",
      openDirectory: () => {
        throw unsupported;
      },
    }),
  );
  assert.throws(
    () =>
      fsyncGitcrawlDirectory("/queue", {
        platform: "linux",
        openDirectory: () => {
          throw unsupported;
        },
      }),
    /directory open unsupported/,
  );
  let closed = false;
  fsyncGitcrawlDirectory("/queue", {
    platform: "linux",
    openDirectory: () => 42,
    fsync: () => {
      throw Object.assign(new Error("directory fsync unsupported"), { code: "EINVAL" });
    },
    close: (descriptor) => {
      assert.equal(descriptor, 42);
      closed = true;
    },
  });
  assert.equal(closed, true);
});

test("Gitcrawl legacy directory lock preserves a successor added before quarantine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-child-"));
  const lockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const staleOwner = path.join(lockPath, "stale-owner.json");
  const successor = path.join(lockPath, "successor-owner.json");
  const realNow = Date.now();
  const staleTime = new Date(realNow - 60_000);
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    staleOwner,
    JSON.stringify({ pid: 2_147_483_647, acquired_at: staleTime.toISOString() }),
  );
  fs.utimesSync(staleOwner, staleTime, staleTime);
  fs.utimesSync(lockPath, staleTime, staleTime);
  let replaced = false;
  const restoreHooks = __setGitcrawlCursorLockTestHooks({
    beforeQuarantineRename: ({ entryPath }) => {
      if (entryPath !== lockPath || replaced) return;
      fs.writeFileSync(
        successor,
        JSON.stringify({ pid: process.pid, acquired_at: new Date(realNow).toISOString() }),
      );
      replaced = true;
    },
    now: () => (replaced ? realNow + 10_000 : realNow),
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /timed out waiting for Gitcrawl scan cursor lock/,
    );
    assert.equal(replaced, true);
    assert.equal(Number(JSON.parse(fs.readFileSync(successor, "utf8")).pid), process.pid);
    assert.equal(fs.existsSync(staleOwner), true);
    assert.equal(fs.existsSync(path.join(lockPath, "lock.sqlite")), false);
  } finally {
    restoreHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl stale lock reclamation rejects same-file ownership replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-owner-"));
  const lockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const staleTime = new Date(Date.now() - 60_000);
  const staleContents = JSON.stringify({
    pid: 2_147_483_647,
    acquired_at: staleTime.toISOString(),
  });
  fs.writeFileSync(lockPath, staleContents);
  fs.utimesSync(lockPath, staleTime, staleTime);
  const realNow = Date.now();
  let replaced = false;
  const restoreTestHooks = __setGitcrawlCursorLockTestHooks({
    beforeQuarantineRename: ({ entryPath }) => {
      if (entryPath !== lockPath || replaced) return;
      const replacement = JSON.stringify({
        pid: process.pid,
        acquired_at: staleTime.toISOString(),
      }).padEnd(staleContents.length);
      assert.equal(replacement.length, staleContents.length);
      fs.writeFileSync(lockPath, replacement);
      fs.utimesSync(lockPath, staleTime, staleTime);
      replaced = true;
    },
    now: () => (replaced ? realNow + 10_000 : realNow),
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /timed out waiting for Gitcrawl scan cursor lock/,
    );
    assert.equal(replaced, true);
    assert.equal(Number(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid), process.pid);
  } finally {
    restoreTestHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl stale lock rollback preserves a lock recreated after quarantine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-lock-rollback-"));
  const lockPath = path.join(dir, ".gitcrawl-scan-cursors.lock");
  const staleTime = new Date(Date.now() - 60_000);
  const staleContents = JSON.stringify({
    pid: 2_147_483_647,
    acquired_at: staleTime.toISOString(),
  });
  fs.writeFileSync(lockPath, staleContents);
  fs.utimesSync(lockPath, staleTime, staleTime);
  let quarantinePath = "";
  const restoreTestHooks = __setGitcrawlCursorLockTestHooks({
    beforeQuarantineRename: ({ entryPath }) => {
      if (entryPath !== lockPath) return;
      const replacement = JSON.stringify({
        pid: 2_147_483_646,
        acquired_at: staleTime.toISOString(),
      }).padEnd(staleContents.length);
      assert.equal(replacement.length, staleContents.length);
      fs.writeFileSync(lockPath, replacement);
      fs.utimesSync(lockPath, staleTime, staleTime);
    },
    beforeQuarantineRestore: ({ entryPath, quarantinePath: candidate }) => {
      if (entryPath !== lockPath) return;
      quarantinePath = candidate;
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
      );
    },
  });
  try {
    assert.throws(
      () =>
        writeGitcrawlScanOffset({
          directory: dir,
          key: "replacement",
          offset: 1,
          snapshotId,
          providerCursor: "cursor-1",
          querySha256: queryDigest,
        }),
      /preserved both lock entries/,
    );
    assert.notEqual(quarantinePath, "");
    assert.equal(Number(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid), process.pid);
    assert.equal(Number(JSON.parse(fs.readFileSync(quarantinePath, "utf8")).pid), 2_147_483_646);
  } finally {
    restoreTestHooks();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test("Gitcrawl importers attach verified evidence packets to generated jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-import-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  const clusterOut = path.join(dir, "clusters");
  const lowSignalOut = path.join(dir, "low-signal");
  seedLocalDatabase(dbPath);
  refreshLocalDatabaseTimestamps(dbPath, new Date(Date.now() - 60_000).toISOString());

  const cluster = runImporter("dist/repair/import-gitcrawl-clusters.js", [
    "7",
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    clusterOut,
    "--mode",
    "plan",
    "--skip-existing",
    "false",
    "--max-snapshot-age-hours",
    "48",
  ]);
  assert.equal(cluster.status, 0, cluster.stderr);
  const clusterJobPath = path.join(clusterOut, fs.readdirSync(clusterOut)[0]!);
  const clusterJob = fs.readFileSync(clusterJobPath, "utf8");
  assert.match(clusterJob, /^gitcrawl_evidence_schema: gitcrawl-evidence-job-v1$/m);
  assert.match(clusterJob, /^gitcrawl_evidence_required: true$/m);
  const clusterPacket = evidencePacket(clusterJob);
  assert.equal(clusterPacket.provider, "local");
  assert.match(clusterPacket.snapshot_id, /^local:[a-f0-9]{64}$/);
  verifyGitcrawlEvidencePacket(clusterPacket);
  assert.equal(runImporter("dist/repair/validate-job.js", [clusterJobPath]).status, 0);
  const duplicateCluster = runImporter("dist/repair/import-gitcrawl-clusters.js", [
    "7",
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    clusterOut,
    "--mode",
    "plan",
    "--skip-existing",
    "false",
    "--max-snapshot-age-hours",
    "48",
  ]);
  assert.equal(duplicateCluster.status, 1);
  assert.equal(fs.readFileSync(clusterJobPath, "utf8"), clusterJob);

  const lowSignal = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", [
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    lowSignalOut,
    "--limit",
    "1",
    "--batch-size",
    "1",
    "--skip-existing",
    "false",
    "--max-snapshot-age-hours",
    "48",
  ]);
  assert.equal(lowSignal.status, 0, lowSignal.stderr);
  const lowSignalJobPath = path.join(lowSignalOut, fs.readdirSync(lowSignalOut)[0]!);
  const lowSignalJob = fs.readFileSync(lowSignalJobPath, "utf8");
  assert.match(lowSignalJob, /^gitcrawl_evidence_schema: gitcrawl-evidence-job-v1$/m);
  assert.match(lowSignalJob, /^gitcrawl_evidence_required: true$/m);
  const lowSignalPacket = evidencePacket(lowSignalJob);
  assert.equal(lowSignalPacket.provider, "local");
  assert(lowSignalPacket.claims.some((claim) => claim.query.name === "gitcrawl.threads.search"));
  assert(
    lowSignalPacket.claims.some(
      (claim) => claim.query.name === "gitcrawl.pull_requests.review_context",
    ),
  );
  verifyGitcrawlEvidencePacket(lowSignalPacket);
  assert.equal(runImporter("dist/repair/validate-job.js", [lowSignalJobPath]).status, 0);
  const prompt = renderPrompt(parseJob(lowSignalJobPath));
  assert.match(prompt, /````md\n+---/);
  assert.match(prompt, /```json\n\{/);
  const duplicateLowSignal = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", [
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    lowSignalOut,
    "--limit",
    "1",
    "--batch-size",
    "1",
    "--skip-existing",
    "false",
    "--max-snapshot-age-hours",
    "48",
  ]);
  assert.equal(duplicateLowSignal.status, 1);
  assert.equal(fs.readFileSync(lowSignalJobPath, "utf8"), lowSignalJob);

  const tamperedJobPath = path.join(dir, "tampered.md");
  fs.writeFileSync(
    tamperedJobPath,
    lowSignalJob.replace('"provider": "local"', '"provider": "cloud"'),
  );
  assert.throws(() => parseJob(tamperedJobPath), /Gitcrawl evidence/);

  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl cluster jobs bind canonical, candidate, and context roles exactly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-target-roles-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  const outDir = path.join(dir, "jobs");
  seedLocalDatabase(dbPath);
  addClusterMembers(dbPath, 1);
  refreshLocalDatabaseTimestamps(dbPath, new Date(Date.now() - 60_000).toISOString());
  const imported = runImporter("dist/repair/import-gitcrawl-clusters.js", [
    "7",
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    outDir,
    "--skip-existing",
    "false",
  ]);
  assert.equal(imported.status, 0, imported.stderr);
  const jobPath = path.join(outDir, markdownFiles(outDir)[0]!);
  const job = fs.readFileSync(jobPath, "utf8");
  for (const tampered of [
    job.replace('canonical:\n  - "#42"', 'canonical:\n  - "#100"'),
    job.replace('candidates:\n  - "#42"\n  - "#100"', 'candidates:\n  - "#100"'),
    job.replace('cluster_refs:\n  - "#42"\n  - "#100"', 'cluster_refs:\n  - "#100"'),
  ]) {
    fs.writeFileSync(jobPath, tampered);
    assert.throws(
      () => parseJob(jobPath),
      /does not exactly match packet targets|no unambiguous packet role/,
    );
  }
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl cluster intake refuses bounded packets that omit actionable members", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-bounded-cluster-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  const outDir = path.join(dir, "jobs");
  seedLocalDatabase(dbPath);
  addClusterMembers(dbPath, 64);
  refreshLocalDatabaseTimestamps(dbPath, new Date(Date.now() - 60_000).toISOString());

  const imported = runImporter("dist/repair/import-gitcrawl-clusters.js", [
    "--from-gitcrawl",
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    outDir,
    "--limit",
    "1",
    "--scan-limit",
    "1",
    "--skip-existing",
    "true",
    "--max-snapshot-age-hours",
    "48",
  ]);
  assert.equal(imported.status, 1);
  assert.match(imported.stderr, /omitted \d+ member claim\(s\); refusing a partial repair job/);
  assert.equal(fs.existsSync(outDir) ? markdownFiles(outDir).length : 0, 0);
  assert.equal(fs.existsSync(path.join(outDir, ".gitcrawl-scan-cursors.json")), false);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl importers resume past processed rows without scanning evidence prose", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-progress-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  const clusterOut = path.join(dir, "clusters");
  const lowSignalOut = path.join(dir, "low-signal");
  seedLocalDatabase(dbPath);
  addLocalCandidate(dbPath, {
    threadId: 43,
    number: 43,
    clusterId: 8,
    title: "docs: cleanup test guide",
    body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
    filePath: "docs/test-guide.md",
  });
  refreshLocalDatabaseTimestamps(dbPath, new Date(Date.now() - 60_000).toISOString());

  fs.mkdirSync(clusterOut, { recursive: true });
  fs.writeFileSync(
    path.join(clusterOut, "existing.md"),
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: gitcrawl-7-existing",
      "cluster_refs:",
      '  - "#42"',
      "---",
      "",
    ].join("\n"),
  );
  const clusterArgs = [
    "--from-gitcrawl",
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    clusterOut,
    "--mode",
    "plan",
    "--limit",
    "1",
    "--scan-limit",
    "1",
    "--min-size",
    "1",
    "--allow-empty",
    "--max-snapshot-age-hours",
    "48",
  ];
  const clusterFirst = runImporter("dist/repair/import-gitcrawl-clusters.js", clusterArgs);
  assert.equal(clusterFirst.status, 0, clusterFirst.stderr);
  assert.equal(markdownFiles(clusterOut).length, 2);
  assert(markdownFiles(clusterOut).some((file) => /gitcrawl-evidence-v1-8-/.test(file)));
  assert(
    cursorKeys(clusterOut).some(
      (key) =>
        key.includes("min-open=1") &&
        key.includes("skip-closed=75") &&
        key.includes("skip-security=true") &&
        key.includes("skip-features=true"),
    ),
  );
  const clusterSecond = runImporter("dist/repair/import-gitcrawl-clusters.js", clusterArgs);
  assert.equal(clusterSecond.status, 0, clusterSecond.stderr);
  assert.equal(markdownFiles(clusterOut).length, 2);

  fs.mkdirSync(lowSignalOut, { recursive: true });
  fs.writeFileSync(
    path.join(lowSignalOut, "existing.md"),
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: low-signal-pr-sweep-existing",
      "triage_policy: low_signal_prs",
      "candidates:",
      '  - "#42"',
      "cluster_refs:",
      '  - "#42"',
      "---",
      "",
      "Evidence prose mentions #43 but must not mark it processed.",
      "",
    ].join("\n"),
  );
  const lowSignalArgs = [
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    lowSignalOut,
    "--limit",
    "1",
    "--batch-size",
    "1",
    "--scan-limit",
    "1",
    "--min-score",
    "1",
    "--max-snapshot-age-hours",
    "48",
  ];
  const lowSignalFirst = runImporter(
    "dist/repair/import-gitcrawl-low-signal-prs.js",
    lowSignalArgs,
  );
  assert.equal(lowSignalFirst.status, 0, lowSignalFirst.stderr);
  assert.equal(markdownFiles(lowSignalOut).length, 1);
  assert(
    cursorKeys(lowSignalOut).some(
      (key) => key.includes("min-score=1") && key.includes("max-files=120"),
    ),
  );
  const lowSignalSecond = runImporter(
    "dist/repair/import-gitcrawl-low-signal-prs.js",
    lowSignalArgs,
  );
  assert.equal(lowSignalSecond.status, 0, lowSignalSecond.stderr);
  const generated = markdownFiles(lowSignalOut)
    .filter((file) => file !== "existing.md")
    .map((file) => fs.readFileSync(path.join(lowSignalOut, file), "utf8"));
  assert.equal(generated.length, 1);
  assert.match(generated[0]!, /  - "#43"/);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl importers restart changed snapshots and dedupe durable jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-generation-"));
  const clusterDbPath = path.join(dir, "cluster.db");
  const clusterOut = path.join(dir, "cluster-jobs");
  seedLocalDatabase(clusterDbPath);
  addLocalCandidate(clusterDbPath, {
    threadId: 43,
    number: 43,
    clusterId: 8,
    title: "docs: cleanup test guide",
    body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
    filePath: "docs/test-guide.md",
  });
  refreshLocalDatabaseTimestamps(clusterDbPath, new Date(Date.now() - 120_000).toISOString());
  fs.mkdirSync(clusterOut, { recursive: true });
  fs.writeFileSync(
    path.join(clusterOut, "existing.md"),
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: gitcrawl-7-existing",
      "cluster_refs:",
      '  - "#42"',
      "---",
      "",
    ].join("\n"),
  );
  const clusterArgs = [
    "--from-gitcrawl",
    "--repo",
    "openclaw/openclaw",
    "--db",
    clusterDbPath,
    "--out",
    clusterOut,
    "--mode",
    "plan",
    "--limit",
    "1",
    "--scan-limit",
    "1",
    "--max-scan-windows",
    "1",
    "--min-size",
    "1",
    "--allow-empty",
    "--max-snapshot-age-hours",
    "48",
  ];
  const clusterFirst = runImporter("dist/repair/import-gitcrawl-clusters.js", clusterArgs);
  assert.equal(clusterFirst.status, 0, clusterFirst.stderr);
  const clusterCursorKey = cursorKeys(clusterOut)[0]!;
  const firstClusterCursor = readGitcrawlScanCursor(clusterOut, clusterCursorKey)!;
  assert.equal(firstClusterCursor.offset, 1);

  addLocalCandidate(clusterDbPath, {
    threadId: 41,
    number: 41,
    clusterId: 6,
    title: "docs: add moved-ahead candidate",
    body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
    filePath: "docs/moved-ahead.md",
  });
  refreshLocalDatabaseTimestamps(clusterDbPath, new Date(Date.now() - 60_000).toISOString());
  const clusterSecond = runImporter("dist/repair/import-gitcrawl-clusters.js", clusterArgs);
  assert.equal(clusterSecond.status, 0, clusterSecond.stderr);
  assert(markdownFiles(clusterOut).some((file) => /gitcrawl-evidence-v1-6-/.test(file)));
  const secondClusterCursor = readGitcrawlScanCursor(clusterOut, clusterCursorKey)!;
  assert.notEqual(secondClusterCursor.snapshotId, firstClusterCursor.snapshotId);
  assert.equal(secondClusterCursor.offset, 1);

  const pullDbPath = path.join(dir, "pull.db");
  const pullOut = path.join(dir, "pull-jobs");
  seedLocalDatabase(pullDbPath);
  addLocalCandidate(pullDbPath, {
    threadId: 43,
    number: 43,
    clusterId: 8,
    title: "docs: cleanup test guide",
    body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
    filePath: "docs/test-guide.md",
  });
  refreshLocalDatabaseTimestamps(pullDbPath, new Date(Date.now() - 120_000).toISOString());
  fs.mkdirSync(pullOut, { recursive: true });
  fs.writeFileSync(
    path.join(pullOut, "existing.md"),
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: low-signal-pr-sweep-existing",
      "triage_policy: low_signal_prs",
      "candidates:",
      '  - "#42"',
      "cluster_refs:",
      '  - "#42"',
      "---",
      "",
    ].join("\n"),
  );
  const pullArgs = [
    "--repo",
    "openclaw/openclaw",
    "--db",
    pullDbPath,
    "--out",
    pullOut,
    "--sort",
    "stale",
    "--limit",
    "1",
    "--batch-size",
    "1",
    "--scan-limit",
    "1",
    "--min-score",
    "1",
    "--max-snapshot-age-hours",
    "48",
  ];
  const pullFirst = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", pullArgs);
  assert.equal(pullFirst.status, 0, pullFirst.stderr);
  const pullCursorKey = cursorKeys(pullOut)[0]!;
  const firstPullCursor = readGitcrawlScanCursor(pullOut, pullCursorKey)!;
  assert.equal(firstPullCursor.offset, 1);

  addLocalCandidate(pullDbPath, {
    threadId: 41,
    number: 41,
    clusterId: 6,
    title: "docs: add moved-ahead candidate",
    body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
    filePath: "docs/moved-ahead.md",
  });
  refreshLocalDatabaseTimestamps(pullDbPath, new Date(Date.now() - 60_000).toISOString());
  const pullSecond = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", pullArgs);
  assert.equal(pullSecond.status, 0, pullSecond.stderr);
  const generated = markdownFiles(pullOut)
    .filter((file) => file !== "existing.md")
    .map((file) => fs.readFileSync(path.join(pullOut, file), "utf8"));
  assert.equal(generated.length, 1);
  assert.match(generated[0]!, /  - "#41"/);
  const secondPullCursor = readGitcrawlScanCursor(pullOut, pullCursorKey)!;
  assert.notEqual(secondPullCursor.snapshotId, firstPullCursor.snapshotId);
  assert.equal(secondPullCursor.offset, 1);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl low-signal intake replays a window until every qualifying candidate is emitted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-window-replay-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  const outDir = path.join(dir, "jobs");
  seedLocalDatabase(dbPath);
  addLocalCandidate(dbPath, {
    threadId: 43,
    number: 43,
    clusterId: 8,
    title: "docs: cleanup test guide",
    body: "Problem:\nWhy it matters:\nDescribe the problem and fix",
    filePath: "docs/test-guide.md",
  });
  refreshLocalDatabaseTimestamps(dbPath, new Date(Date.now() - 60_000).toISOString());
  const importerArgs = [
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    outDir,
    "--limit",
    "1",
    "--batch-size",
    "1",
    "--scan-limit",
    "2",
    "--min-score",
    "1",
    "--max-snapshot-age-hours",
    "48",
  ];
  const first = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", importerArgs);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(markdownFiles(outDir).length, 1);
  assert.equal(fs.existsSync(path.join(outDir, ".gitcrawl-scan-cursors.json")), false);

  const second = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", importerArgs);
  assert.equal(second.status, 0, second.stderr);
  const jobs = markdownFiles(outDir).map((file) =>
    fs.readFileSync(path.join(outDir, file), "utf8"),
  );
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs
      .flatMap((job) => [...job.matchAll(/^  - "#(\d+)"$/gm)].map((match) => Number(match[1])))
      .sort((left, right) => left - right),
    [42, 42, 43, 43],
  );
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local mode rejects excerpt-only safety metadata and unknown assignees", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-excerpt-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("alter table threads rename column body to body_excerpt");
  db.exec("alter table threads drop column assignees_json");
  db.close();

  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  const thread = (await adapter.searchOpenPullRequests()).rows[0]!;
  assert.equal(thread.securityMetadataComplete, false);
  assert.equal(thread.assignees, undefined);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl low-signal intake fails closed when author association is unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-association-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  const outDir = path.join(dir, "jobs");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("alter table threads drop column author_association");
  db.close();

  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  const thread = (await adapter.searchOpenPullRequests()).rows[0]!;
  assert.equal(thread.authorAssociation, undefined);
  assert.equal(thread.securityMetadataComplete, false);
  await adapter.close();
  refreshLocalDatabaseTimestamps(dbPath, new Date(Date.now() - 60_000).toISOString());

  const imported = runImporter("dist/repair/import-gitcrawl-low-signal-prs.js", [
    "--repo",
    "openclaw/openclaw",
    "--db",
    dbPath,
    "--out",
    outDir,
    "--limit",
    "1",
    "--skip-existing",
    "false",
    "--max-snapshot-age-hours",
    "48",
  ]);
  assert.equal(imported.status, 1);
  assert.match(imported.stderr, /requires author association evidence for #42/);
  assert.equal(fs.existsSync(outDir) ? markdownFiles(outDir).length : 0, 0);
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local freshness ignores a fresh export without a fresh repository sync", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-freshness-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("update sync_runs set finished_at = ?").run("2026-07-10T00:00:00.000Z");
  db.prepare("insert into sync_runs values (?, ?, ?, ?, ?, ?)").run(
    2,
    1,
    "numbers:42",
    "success",
    generatedAt,
    generatedAt,
  );
  db.prepare("update portable_metadata set value = ? where key = 'exported_at'").run(generatedAt);
  db.close();

  await assert.rejects(
    GitcrawlEvidenceAdapter.open({
      repository: "openclaw/openclaw",
      provider: "local",
      dbPath,
      now: () => now,
      maxSnapshotAgeMs: 60 * 60 * 1000,
    }),
    /source sync is stale/,
  );
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local coverage rejects cross-repository cluster membership", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-repo-binding-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("insert into repositories values (?, ?, ?, ?)").run(
    2,
    "other/repository",
    "other",
    "repository",
  );
  db.prepare(
    `insert into threads
     select 43, 2, 43, kind, state, title, body, author_login, author_type,
            author_association, html_url, labels_json, assignees_json, is_draft,
            created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, last_pulled_at, updated_at
     from threads where id = 42`,
  ).run();
  db.prepare("insert into cluster_memberships values (?, ?, ?, ?, ?, ?, ?)").run(
    7,
    43,
    "member",
    "active",
    0.5,
    generatedAt,
    generatedAt,
  );
  db.close();

  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  await assert.rejects(adapter.clusterMembers(7), /cluster_groups coverage is incomplete/);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl portable cluster counts derive from active memberships without member_count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-membership-proof-"));
  const dbPath = path.join(dir, "portable.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("alter table cluster_groups drop column member_count");
  db.close();
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  const clusters = await adapter.listClusters();
  assert.equal(clusters.rows[0]?.memberCount, 1);
  const members = await adapter.clusterMembers(7);
  assert.equal(members.rows[0]?.clusterMemberCount, 1);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local cluster intake tolerates PR details without updated_at", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-pr-capability-"));
  const dbPath = path.join(dir, "portable.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("alter table pull_request_details drop column updated_at");
  db.close();
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  assert.deepEqual(
    (await adapter.listClusters()).rows.map((row) => row.id),
    [7],
  );
  const context = (await adapter.reviewContext(42)).rows.find((row) => "thread" in row) as
    | { detailsUpdatedAt: string }
    | undefined;
  assert.equal(context?.detailsUpdatedAt, "");
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local coverage timestamps are scoped to the selected repository", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-repo-time-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  addForeignRepositoryFixture(dbPath, "2026-07-12T11:59:00.000Z");
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  assert(
    adapter.coverage.every(
      (row) =>
        row.dataset_generated_at === generatedAt &&
        (!row.max_source_at || row.max_source_at === generatedAt),
    ),
  );
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local coverage rejects malformed PR file freshness timestamps", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-file-time-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLocalDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("update pull_request_files set fetched_at = ?").run("not-a-timestamp");
  db.close();
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    now: () => now,
  });
  await assert.rejects(adapter.reviewContext(42), /pull_request_files coverage is incomplete/);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

test("Gitcrawl local mode selects populated legacy clusters and tolerates created_at-only rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-legacy-"));
  const dbPath = path.join(dir, "gitcrawl.db");
  seedLegacyDatabase(dbPath);
  const adapter = await GitcrawlEvidenceAdapter.open({
    repository: "openclaw/openclaw",
    provider: "local",
    dbPath,
    allowLegacyLocal: true,
    now: () => now,
  });
  const clusters = await adapter.listClusters();
  assert.deepEqual(
    clusters.rows.map((row) => row.id),
    [7],
  );
  assert.equal(clusters.rows[0]?.updatedAt, generatedAt);
  assert.deepEqual(
    (await adapter.clusterMembers(7)).rows.map((row) => row.number),
    [42],
  );
  const pulls = await adapter.searchOpenPullRequests();
  assert.deepEqual(
    pulls.rows.map((row) => row.number),
    [43],
  );
  assert.equal(pulls.rows[0]?.securityMetadataComplete, false);
  await adapter.close();
  fs.rmSync(dir, { force: true, recursive: true });
});

class FixtureSource implements GitcrawlQuerySource {
  readonly provider: "local" | "cloud";
  readonly legacy: boolean;
  closeCount = 0;

  private readonly coverage: GitcrawlCoverageRow[];
  private readonly rows: Partial<Record<GitcrawlQueryRequest["name"], Record<string, unknown>[]>>;
  private readonly sourceSyncAt: string;
  private readonly snapshotForQuery: (request: GitcrawlQueryRequest) => string;
  private readonly archiveForQuery: (request: GitcrawlQueryRequest) => string;
  private readonly honorThreadOrder: boolean;
  private readonly nextCursor?: (input: {
    request: GitcrawlQueryRequest;
    defaultCursor: string;
  }) => string;

  constructor(
    options: {
      provider?: "local" | "cloud";
      legacy?: boolean;
      coverage?: GitcrawlCoverageRow[];
      rows?: Partial<Record<GitcrawlQueryRequest["name"], Record<string, unknown>[]>>;
      sourceSyncAt?: string;
      snapshotForQuery?: (request: GitcrawlQueryRequest) => string;
      archiveForQuery?: (request: GitcrawlQueryRequest) => string;
      nextCursor?: (input: { request: GitcrawlQueryRequest; defaultCursor: string }) => string;
      honorThreadOrder?: boolean;
    } = {},
  ) {
    this.provider = options.provider ?? "cloud";
    this.legacy = options.legacy ?? false;
    this.coverage = options.coverage ?? completeCoverage();
    this.rows = options.rows ?? {};
    this.sourceSyncAt = options.sourceSyncAt ?? generatedAt;
    this.snapshotForQuery = options.snapshotForQuery ?? (() => snapshotId);
    this.archiveForQuery = options.archiveForQuery ?? (() => "fixture");
    this.nextCursor = options.nextCursor;
    this.honorThreadOrder = options.honorThreadOrder ?? true;
  }

  async query(request: GitcrawlQueryRequest): Promise<GitcrawlQueryEnvelope> {
    let allRows =
      request.name === "gitcrawl.coverage" ? this.coverage : (this.rows[request.name] ?? []);
    if (request.name === "gitcrawl.threads.search" && this.honorThreadOrder) {
      const direction = request.args.order === "oldest" ? 1 : -1;
      allRows = [...allRows].sort((left, right) => {
        const updated =
          Date.parse(String(left.updated_at_gh ?? left.updated_at ?? "")) -
            Date.parse(String(right.updated_at_gh ?? right.updated_at ?? "")) ||
          Number(left.number ?? 0) - Number(right.number ?? 0);
        return updated * direction;
      });
    }
    if (request.name === "gitcrawl.clusters.list") {
      allRows = [...allRows].sort((left, right) => {
        return (
          Number(right.member_count ?? 0) - Number(left.member_count ?? 0) ||
          Date.parse(String(right.updated_at ?? "")) - Date.parse(String(left.updated_at ?? "")) ||
          Number(left.cluster_id ?? 0) - Number(right.cluster_id ?? 0)
        );
      });
    }
    const offset = request.cursor ? Number(request.cursor.replace("cursor-", "")) : 0;
    const values = allRows.slice(offset, offset + request.limit);
    const nextOffset = offset + values.length < allRows.length ? offset + values.length : null;
    const defaultCursor = nextOffset === null ? "" : `cursor-${nextOffset}`;
    return {
      values,
      stats: {
        contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        repository: "openclaw/openclaw",
        archive: this.archiveForQuery(request),
        snapshot_id: this.snapshotForQuery(request),
        source_sync_at: this.sourceSyncAt,
        dataset_generated_at: generatedAt,
        coverage_complete: true,
        next_cursor: this.nextCursor?.({ request, defaultCursor }) ?? defaultCursor,
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function completeCoverage(
  overrides: Partial<
    Record<
      GitcrawlCoverageRow["dataset"],
      Partial<Pick<GitcrawlCoverageRow, "row_count" | "eligible_count" | "covered_count">>
    >
  > = {},
): GitcrawlCoverageRow[] {
  return GITCRAWL_DATASETS.map((dataset) => {
    const override = overrides[dataset];
    return {
      dataset,
      row_count: override?.row_count ?? 1,
      eligible_count: override?.eligible_count ?? 1,
      covered_count: override?.covered_count ?? 1,
      max_source_at: generatedAt,
      dataset_generated_at: generatedAt,
      complete: true,
    };
  });
}

function clusterRow(id: number): Record<string, unknown> {
  return {
    cluster_id: id,
    stable_slug: `cluster-${id}`,
    status: "active",
    cluster_type: "duplicate_candidate",
    title: `Cluster ${id}`,
    representative_thread_id: id * 10,
    representative_number: id * 100,
    representative_kind: "issue",
    representative_state: "open",
    representative_title: `Issue ${id}`,
    member_count: 2,
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
    role: "member",
    membership_state: "active",
    score_to_representative: 0.95,
    thread_id: 42,
    number: 42,
    kind: "pull_request",
    state: "open",
    title: "Fix provider refresh",
    body: "A bounded body",
    author_login: "contributor",
    author_type: "User",
    author_association: "CONTRIBUTOR",
    html_url: "https://github.com/openclaw/openclaw/pull/42",
    is_draft: 0,
    created_at_gh: generatedAt,
    updated_at_gh: generatedAt,
    key_summary: "Fixes token refresh",
    labels_json: "[]",
    assignees_json: "[]",
    security_metadata_complete: 1,
    revision_id: 9,
    revision_content_hash: revision,
    revision_source_updated_at: generatedAt,
    fingerprint_algorithm: "thread-fingerprint-v2",
    fingerprint_hash: fingerprint,
    fingerprint_slug: "fp",
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
    cluster_role: "member",
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

function jsonResponse(
  values: Record<string, unknown>[],
  nextCursor: string,
  stats: Record<string, unknown> = {},
): Response {
  const columns = values.length > 0 ? Object.keys(values[0]!) : [];
  return new Response(
    JSON.stringify({
      columns,
      rows: values.map((row) => columns.map((column) => row[column])),
      values,
      stats: {
        contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        repository: "openclaw/openclaw",
        archive: "gitcrawl/openclaw__openclaw",
        snapshot_id: snapshotId,
        source_sync_at: generatedAt,
        dataset_generated_at: generatedAt,
        coverage_complete: true,
        next_cursor: nextCursor,
        ...stats,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function runImporter(script: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runCursorWriter(directory: string, key: string, offset: number): Promise<void> {
  const source = [
    'import { writeGitcrawlScanOffset } from "./dist/repair/gitcrawl-scan-cursor.js";',
    "writeGitcrawlScanOffset({",
    "  directory: process.env.CURSOR_DIRECTORY,",
    "  key: process.env.CURSOR_KEY,",
    "  offset: Number(process.env.CURSOR_OFFSET),",
    `  archive: ${JSON.stringify(archiveId)},`,
    '  snapshotId: "snapshot-a",',
    "  providerCursor: `cursor-${process.env.CURSOR_OFFSET}`,",
    `  querySha256: ${JSON.stringify(queryDigest)},`,
    `  updatedAt: ${JSON.stringify(generatedAt)},`,
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CURSOR_DIRECTORY: directory,
      CURSOR_KEY: key,
      CURSOR_OFFSET: String(offset),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cursor writer exited ${code}: ${stderr}`));
    });
  });
}

function markdownFiles(directory: string): string[] {
  return fs.readdirSync(directory).filter((file) => file.endsWith(".md"));
}

function cursorKeys(directory: string): string[] {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(directory, ".gitcrawl-scan-cursors.json"), "utf8"),
  ) as { cursors: Record<string, unknown> };
  return Object.keys(parsed.cursors);
}

function evidencePacket(markdown: string): ReturnType<typeof buildGitcrawlEvidencePacket> {
  const match = markdown.match(
    /<summary>Bounded digest-bound Gitcrawl evidence<\/summary>\n\n```json\n([\s\S]*?)\n```/,
  );
  assert(match?.[1], "generated job is missing its Gitcrawl evidence packet");
  return JSON.parse(match[1]);
}

function migrationEvidenceJob(clusterId: string, numbers: number[]): string {
  const claims = numbers.flatMap((number) => {
    const title = `Migration pull request ${number}`;
    const body = "Complete migration evidence.";
    const thread = {
      number,
      kind: "pull_request",
      title,
      body,
      authorLogin: "contributor",
      authorType: "User",
      authorAssociation: "CONTRIBUTOR",
      labels: [],
      assignees: [],
      securitySensitive: false,
      securityMetadataComplete: true,
      securityProjectionSha256: "d".repeat(64),
      policySignals: deriveGitcrawlThreadPolicySignals(title, body),
    };
    return [
      createGitcrawlEvidenceClaim({
        provider: "local",
        snapshotId,
        queryName: "gitcrawl.threads.search",
        subject: `openclaw/openclaw#pull:${number}`,
        data: thread,
      }),
      createGitcrawlEvidenceClaim({
        provider: "local",
        snapshotId,
        queryName: "gitcrawl.pull_requests.review_context",
        subject: `openclaw/openclaw#pull:${number}`,
        data: { thread },
      }),
    ];
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "local",
    repository: "openclaw/openclaw",
    snapshotId,
    coverage: completeCoverage(),
    claims,
    generatedAt,
  });
  return [
    "---",
    "repo: openclaw/openclaw",
    `cluster_id: ${clusterId}`,
    "mode: plan",
    "gitcrawl_evidence_schema: gitcrawl-evidence-job-v1",
    "gitcrawl_evidence_required: true",
    "allowed_actions:",
    "  - comment",
    "canonical: []",
    "candidates:",
    ...numbers.map((number) => `  - "#${number}"`),
    "cluster_refs:",
    ...numbers.map((number) => `  - "#${number}"`),
    "---",
    "",
    "# Migration replacement",
    "",
    ...renderGitcrawlEvidencePacket(packet),
  ].join("\n");
}

function legacyMigrationJob(clusterId: string, numbers: number[]): string {
  return [
    "---",
    "repo: openclaw/openclaw",
    `cluster_id: ${clusterId}`,
    "mode: plan",
    "allowed_actions:",
    "  - comment",
    "candidates:",
    ...numbers.map((number) => `  - "#${number}"`),
    "cluster_refs:",
    ...numbers.map((number) => `  - "#${number}"`),
    "---",
    "",
    "# Legacy migration job",
  ].join("\n");
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
      body text not null,
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
      finished_at text not null
    );
    create table portable_metadata (key text primary key, value text not null);
  `);
  db.prepare("insert into repositories values (?, ?, ?, ?)").run(
    1,
    "openclaw/openclaw",
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
    "chore: add new plugin",
    "Problem:\nWhy it matters:\nDescribe the problem and fix",
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
    "apps/linux/plugin.ts",
    "modified",
    1,
    1,
    2,
    "",
    generatedAt,
  );
  db.prepare("insert into portable_metadata values ('exported_at', ?)").run(generatedAt);
  db.prepare("insert into sync_runs values (?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    "open",
    "success",
    generatedAt,
    generatedAt,
  );
  db.close();
}

function addLocalCandidate(
  dbPath: string,
  input: {
    threadId: number;
    number: number;
    clusterId: number;
    title: string;
    body: string;
    filePath: string;
  },
): void {
  const db = new DatabaseSync(dbPath);
  const revisionId = input.threadId + 100;
  const fingerprintId = input.threadId + 200;
  const summaryId = input.threadId + 300;
  db.prepare(
    `insert into threads(
       id, repo_id, number, kind, state, title, body, author_login, author_type,
       author_association, html_url, labels_json, assignees_json, is_draft,
       created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, last_pulled_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.threadId,
    1,
    input.number,
    "pull_request",
    "open",
    input.title,
    input.body,
    "contributor-two",
    "User",
    "CONTRIBUTOR",
    `https://github.com/openclaw/openclaw/pull/${input.number}`,
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
    revisionId,
    input.threadId,
    generatedAt,
    revision,
    generatedAt,
  );
  db.prepare("insert into thread_fingerprints values (?, ?, ?, ?, ?, ?)").run(
    fingerprintId,
    revisionId,
    "thread-fingerprint-v2",
    fingerprint,
    `fp-${input.number}`,
    generatedAt,
  );
  db.prepare("insert into thread_key_summaries values (?, ?, ?, ?)").run(
    summaryId,
    revisionId,
    input.title,
    generatedAt,
  );
  db.prepare("insert into cluster_groups values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    input.clusterId,
    1,
    `cluster-key-${input.clusterId}`,
    `cluster-${input.clusterId}`,
    "active",
    "duplicate_candidate",
    input.threadId,
    input.title,
    generatedAt,
    generatedAt,
    "",
    1,
  );
  db.prepare("insert into cluster_memberships values (?, ?, ?, ?, ?, ?, ?)").run(
    input.clusterId,
    input.threadId,
    "representative",
    "active",
    1,
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into pull_request_details values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    input.threadId,
    "3".repeat(40),
    "4".repeat(40),
    `fix/${input.number}`,
    "contributor/openclaw",
    "clean",
    3,
    1,
    1,
    generatedAt,
    generatedAt,
  );
  db.prepare("insert into pull_request_files values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    input.threadId,
    0,
    input.filePath,
    "modified",
    2,
    1,
    3,
    "",
    generatedAt,
  );
  db.close();
}

function addClusterMembers(dbPath: string, count: number): void {
  const db = new DatabaseSync(dbPath);
  const insertThread = db.prepare(
    `insert into threads(
       id, repo_id, number, kind, state, title, body, author_login, author_type,
       author_association, html_url, labels_json, assignees_json, is_draft,
       created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, last_pulled_at, updated_at
     )
     select ?, repo_id, ?, 'issue', 'open', ?, body, author_login, author_type,
            author_association, ?, labels_json, assignees_json, 0,
            created_at_gh, updated_at_gh, '', '', last_pulled_at, updated_at
     from threads where id = 42`,
  );
  const insertMembership = db.prepare(
    "insert into cluster_memberships values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (let index = 0; index < count; index += 1) {
    const id = 1_000 + index;
    const number = 100 + index;
    insertThread.run(
      id,
      number,
      `Oversized cluster member ${number}`,
      `https://github.com/openclaw/openclaw/issues/${number}`,
    );
    insertMembership.run(7, id, "member", "active", 0.5, generatedAt, generatedAt);
  }
  db.prepare("update cluster_groups set member_count = ? where id = 7").run(count + 1);
  db.close();
}

function seedLegacyDatabase(dbPath: string): void {
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
      title text not null
    );
    create table cluster_groups (id integer primary key, repo_id integer not null);
    create table clusters (
      id integer primary key,
      repo_id integer not null,
      representative_thread_id integer,
      member_count integer not null,
      closed_at_local text,
      created_at text not null
    );
    create table cluster_members (
      cluster_id integer not null,
      thread_id integer not null,
      score_to_representative real,
      created_at text not null
    );
    create table sync_runs (
      id integer primary key,
      repo_id integer not null,
      scope text not null,
      status text not null,
      started_at text not null,
      finished_at text not null
    );
  `);
  db.prepare("insert into repositories values (?, ?, ?, ?)").run(
    1,
    "openclaw/openclaw",
    "openclaw",
    "openclaw",
  );
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?)").run(
    42,
    1,
    42,
    "issue",
    "open",
    "Legacy cluster member",
  );
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?)").run(
    43,
    1,
    43,
    "pull_request",
    "open",
    "Legacy pull request",
  );
  db.prepare("insert into clusters values (?, ?, ?, ?, ?, ?)").run(7, 1, 42, 1, null, generatedAt);
  db.prepare("insert into cluster_members values (?, ?, ?, ?)").run(7, 42, 1, generatedAt);
  db.prepare("insert into sync_runs values (?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    "open",
    "success",
    generatedAt,
    generatedAt,
  );
  db.close();
}

function addForeignRepositoryFixture(dbPath: string, timestamp: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("insert into repositories values (?, ?, ?, ?)").run(
    2,
    "other/repository",
    "other",
    "repository",
  );
  db.prepare(
    `insert into threads
     select 142, 2, 142, kind, state, title, body, author_login, author_type,
            author_association, html_url, labels_json, assignees_json, is_draft,
            ?, ?, closed_at_gh, merged_at_gh, ?, ?
     from threads where id = 42`,
  ).run(timestamp, timestamp, timestamp, timestamp);
  db.prepare("insert into thread_revisions values (?, ?, ?, ?, ?)").run(
    109,
    142,
    timestamp,
    "c".repeat(64),
    timestamp,
  );
  db.prepare("insert into thread_fingerprints values (?, ?, ?, ?, ?, ?)").run(
    110,
    109,
    "thread-fingerprint-v2",
    "d".repeat(64),
    "foreign",
    timestamp,
  );
  db.prepare("insert into thread_key_summaries values (?, ?, ?, ?)").run(
    111,
    109,
    "Foreign summary",
    timestamp,
  );
  db.prepare("insert into cluster_groups values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    107,
    2,
    "foreign-key",
    "foreign-cluster",
    "active",
    "duplicate_candidate",
    142,
    "Foreign cluster",
    timestamp,
    timestamp,
    "",
    1,
  );
  db.prepare("insert into cluster_memberships values (?, ?, ?, ?, ?, ?, ?)").run(
    107,
    142,
    "representative",
    "active",
    1,
    timestamp,
    timestamp,
  );
  db.prepare("insert into pull_request_details values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    142,
    "5".repeat(40),
    "6".repeat(40),
    "foreign",
    "other/repository",
    "clean",
    1,
    1,
    1,
    timestamp,
    timestamp,
  );
  db.prepare("insert into pull_request_files values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    142,
    0,
    "foreign.ts",
    "modified",
    1,
    1,
    2,
    "",
    timestamp,
  );
  db.prepare("insert into sync_runs values (?, ?, ?, ?, ?, ?)").run(
    2,
    2,
    "open",
    "success",
    timestamp,
    timestamp,
  );
  db.close();
}

function refreshLocalDatabaseTimestamps(dbPath: string, timestamp: string): void {
  const db = new DatabaseSync(dbPath);
  for (const [table, columns] of [
    ["threads", ["created_at_gh", "updated_at_gh", "last_pulled_at", "updated_at"]],
    ["thread_revisions", ["source_updated_at", "created_at"]],
    ["thread_fingerprints", ["created_at"]],
    ["thread_key_summaries", ["created_at"]],
    ["cluster_groups", ["created_at", "updated_at"]],
    ["cluster_memberships", ["created_at", "updated_at"]],
    ["pull_request_details", ["fetched_at", "updated_at"]],
    ["pull_request_files", ["fetched_at"]],
    ["sync_runs", ["started_at", "finished_at"]],
  ] as const) {
    db.prepare(`update ${table} set ${columns.map((column) => `${column} = ?`).join(", ")}`).run(
      ...columns.map(() => timestamp),
    );
  }
  db.prepare("update portable_metadata set value = ? where key = 'exported_at'").run(timestamp);
  db.close();
}
