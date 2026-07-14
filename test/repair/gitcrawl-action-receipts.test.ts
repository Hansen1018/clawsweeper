import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readActionEventShard, readAllSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  GITCRAWL_ACTION_RECEIPT_LIMITS,
  classifyGitcrawlActionFailure,
  flushGitcrawlActionReceipts,
  prepareGitcrawlActionReceipt,
  recordGitcrawlActionReceipt,
} from "../../dist/repair/gitcrawl-action-receipts.js";
import {
  GITCRAWL_QUERY_NAMES,
  sha256Canonical,
} from "../../dist/repair/gitcrawl-evidence-contract.js";

const now = new Date("2026-07-14T10:00:00.000Z");
const repository = "openclaw/openclaw";
const snapshotId = "a".repeat(64);
const paritySnapshotId = "b".repeat(64);
const coverageSha256 = sha256Canonical({ coverage: "complete" });
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  GITHUB_SHA: "c".repeat(40),
  GITHUB_WORKFLOW: "Gitcrawl evidence",
  GITHUB_JOB: "evidence",
  GITHUB_RUN_ID: "550",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTION: "gitcrawl-action-receipts",
  GITHUB_RUN_STARTED_AT: now.toISOString(),
  CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
  CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-14",
} satisfies NodeJS.ProcessEnv;

test("Gitcrawl emits bounded snapshot, six-query, coverage, and parity receipts", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  recordGitcrawlActionReceipt(
    root,
    {
      receipt: "snapshot",
      repository,
      provider: "parity",
      snapshotId,
      paritySnapshotId,
      capabilities: [...GITCRAWL_QUERY_NAMES, "gitcrawl.snapshot.provenance.v1"],
      coverageSha256,
      coverageDatasetCount: 9,
      coverageComplete: true,
    },
    { env, now: () => now },
  );
  for (const [index, queryName] of GITCRAWL_QUERY_NAMES.entries()) {
    recordGitcrawlActionReceipt(
      root,
      {
        receipt: "query",
        repository,
        provider: "parity",
        snapshotId,
        paritySnapshotId,
        queryName,
        queryArgsSha256: sha256Canonical({ queryName, args: index }),
        resultSha256: sha256Canonical({ queryName, result: "primary" }),
        parityResultSha256: sha256Canonical({ queryName, result: "parity" }),
        rowCount: index,
        claimCount: index,
        coverageComplete: true,
      },
      { env, now: () => now },
    );
  }
  recordGitcrawlActionReceipt(
    root,
    {
      receipt: "binding",
      binding: "coverage",
      repository,
      provider: "parity",
      snapshotId,
      paritySnapshotId,
      coverageSha256,
      datasetCount: 9,
      rowCount: 90,
      eligibleCount: 80,
      coveredCount: 80,
      complete: true,
    },
    { env, now: () => now },
  );
  recordGitcrawlActionReceipt(
    root,
    {
      receipt: "binding",
      binding: "parity",
      repository,
      provider: "parity",
      snapshotId,
      paritySnapshotId,
      paritySha256: sha256Canonical({ parity: "matched" }),
      queryCount: GITCRAWL_QUERY_NAMES.length,
      primaryCount: 20,
      parityCount: 20,
      matched: true,
    },
    { env, now: () => now },
  );

  const [shardPath] = await flushGitcrawlActionReceipts(root, { env, outputRoot });
  assert.ok(shardPath);
  const events = readActionEventShard(path.join(outputRoot, shardPath));
  assert.equal(events.length, 9);
  assert.equal(events.filter((event) => event.event_type === "gitcrawl.snapshot").length, 1);
  assert.equal(events.filter((event) => event.event_type === "gitcrawl.query").length, 6);
  assert.equal(events.filter((event) => event.event_type === "gitcrawl.binding").length, 2);
  assert.deepEqual(
    events
      .filter((event) => event.event_type === "gitcrawl.query")
      .map((event) => event.attributes?.query_name)
      .sort(),
    [...GITCRAWL_QUERY_NAMES].sort(),
  );
  for (const event of events) {
    assert.equal(event.attributes?.provider, "parity");
    assert.equal(
      event.evidence?.some(
        (entry) => entry.run_url === "https://github.com/openclaw/clawsweeper/actions/runs/550",
      ),
      true,
    );
    assert.deepEqual(event.privacy.fields_dropped, [
      "bodies",
      "local_paths",
      "logs",
      "prompts",
      "query_args",
      "query_rows",
      "sql",
      "tokens",
    ]);
  }
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(
    serialized,
    /SELECT |query_rows":\[|prompt text|Bearer |\/Users\/|private body/,
  );
});

test("prepared Gitcrawl receipts do not persist until committed", () => {
  const root = tempRoot();
  const capabilities = [...GITCRAWL_QUERY_NAMES];
  const prepared = prepareGitcrawlActionReceipt(
    root,
    {
      receipt: "snapshot",
      repository,
      provider: "cloud",
      snapshotId,
      capabilities,
      coverageSha256,
      coverageDatasetCount: 9,
      coverageComplete: true,
    },
    { env, now: () => now },
  );
  assert.ok(prepared.event);
  assert.deepEqual(readAllSpooledActionEvents(root), []);

  capabilities[0] = "gitcrawl.changed";
  const committed = prepared.commit();
  assert.deepEqual(committed, prepared.event);
  assert.deepEqual(readAllSpooledActionEvents(root), [prepared.event]);
  assert.equal(JSON.stringify(committed).includes("gitcrawl.changed"), false);
});

test("Gitcrawl receipt identities are canonical before hashing and persistence", () => {
  const root = tempRoot();
  const prepared = prepareGitcrawlActionReceipt(
    root,
    {
      receipt: "snapshot",
      repository,
      provider: "cloud",
      snapshotId,
      capabilities: [
        ...GITCRAWL_QUERY_NAMES,
        ` ${GITCRAWL_QUERY_NAMES[0]} `,
        " gitcrawl.snapshot.provenance.v1 ",
      ],
      coverageSha256,
      coverageDatasetCount: 9,
      coverageComplete: true,
    },
    { env, now: () => now },
  );
  assert.deepEqual(
    prepared.event?.attributes?.capability,
    [...GITCRAWL_QUERY_NAMES, "gitcrawl.snapshot.provenance.v1"].sort(),
  );
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "snapshot",
          repository,
          provider: "cloud",
          snapshotId: ` ${snapshotId}`,
          capabilities: GITCRAWL_QUERY_NAMES,
          coverageSha256,
          coverageDatasetCount: 9,
          coverageComplete: true,
        },
        { env, now: () => now },
      ),
    /surrounding whitespace/,
  );
});

test("Gitcrawl binding receipts prove complete coverage and matched parity", () => {
  const root = tempRoot();
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "binding",
          binding: "coverage",
          repository,
          provider: "cloud",
          snapshotId,
          coverageSha256,
          datasetCount: 9,
          rowCount: 90,
          eligibleCount: 80,
          coveredCount: 79,
          complete: true,
        },
        { env, now: () => now },
      ),
    /complete coverage must cover every eligible item/,
  );
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "binding",
          binding: "parity",
          repository,
          provider: "parity",
          snapshotId,
          paritySnapshotId,
          paritySha256: sha256Canonical({ parity: "matched" }),
          queryCount: GITCRAWL_QUERY_NAMES.length - 1,
          primaryCount: 20,
          parityCount: 20,
          matched: true,
        },
        { env, now: () => now },
      ),
    /matched parity requires all queries and equal result counts/,
  );
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "binding",
          binding: "parity",
          repository,
          provider: "parity",
          snapshotId,
          paritySnapshotId,
          paritySha256: sha256Canonical({ parity: "matched" }),
          queryCount: GITCRAWL_QUERY_NAMES.length,
          primaryCount: 20,
          parityCount: 19,
          matched: true,
        },
        { env, now: () => now },
      ),
    /matched parity requires all queries and equal result counts/,
  );
});

test("Gitcrawl failure receipts retain only a class and digest", async () => {
  const root = tempRoot();
  const outputRoot = trustedChildRoot(root, "state");
  const rawFailure =
    "Gitcrawl cloud/local parity mismatch at /Users/private/archive.db with BODY_SENTINEL";
  const input = {
    receipt: "failure",
    phase: "query",
    repository,
    provider: "parity",
    snapshotId,
    paritySnapshotId,
    queryName: "gitcrawl.clusters.related",
    error: new Error(rawFailure),
    queryRows: [{ title: "ROW_SENTINEL" }],
    sql: "SELECT SQL_SENTINEL",
    prompt: "PROMPT_SENTINEL",
    logs: "LOG_SENTINEL",
    token: "TOKEN_SENTINEL",
    localPath: "/Users/private/archive.db",
    body: "BODY_SENTINEL",
  } as unknown as Parameters<typeof recordGitcrawlActionReceipt>[1];
  recordGitcrawlActionReceipt(root, input, { env, now: () => now });

  const [shardPath] = await flushGitcrawlActionReceipts(root, { env, outputRoot });
  assert.ok(shardPath);
  const [event] = readActionEventShard(path.join(outputRoot, shardPath));
  assert.equal(event?.event_type, "gitcrawl.query");
  assert.equal(event?.action.status, "failed");
  assert.equal(event?.action.reason_code, "validation_failed");
  assert.equal(event?.attributes?.failure_class, "parity");
  assert.equal(event?.attributes?.query_name, "gitcrawl.clusters.related");
  assert.match(
    event?.evidence?.find((entry) => entry.kind === "gitcrawl_failure")?.sha256 ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(
    JSON.stringify(event),
    /Users|archive\.db|ROW_SENTINEL|SQL_SENTINEL|PROMPT_SENTINEL|LOG_SENTINEL|TOKEN_SENTINEL|BODY_SENTINEL/,
  );
});

test("Gitcrawl failure classification and receipt bounds fail closed", () => {
  assert.equal(
    classifyGitcrawlActionFailure(new Error("HTTP 403 authorization failed")),
    "authentication",
  );
  assert.equal(classifyGitcrawlActionFailure(new Error("request timed out")), "availability");
  assert.equal(classifyGitcrawlActionFailure(new Error("cursor replay detected")), "pagination");
  assert.equal(classifyGitcrawlActionFailure(new Error("malformed response")), "validation");
  assert.equal(classifyGitcrawlActionFailure(new Error("unexpected failure")), "unknown");

  const root = tempRoot();
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "snapshot",
          repository,
          provider: "cloud",
          snapshotId,
          capabilities: Array.from(
            { length: GITCRAWL_ACTION_RECEIPT_LIMITS.maxCapabilities + 1 },
            (_, index) => `gitcrawl.capability.${index}`,
          ),
          coverageSha256,
          coverageDatasetCount: 9,
          coverageComplete: true,
        },
        { env, now: () => now },
      ),
    /capabilities exceed 64 entries/,
  );
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "query",
          repository,
          provider: "cloud",
          snapshotId,
          queryName: "gitcrawl.coverage",
          queryArgsSha256: "not-a-digest",
          resultSha256: sha256Canonical({ result: "safe" }),
          rowCount: 1,
          claimCount: 1,
          coverageComplete: true,
        },
        { env, now: () => now },
      ),
    /query arguments sha256/,
  );
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "query",
          repository,
          provider: "parity",
          snapshotId,
          paritySnapshotId,
          queryName: "gitcrawl.coverage",
          queryArgsSha256: sha256Canonical({ args: "safe" }),
          resultSha256: sha256Canonical({ result: "safe" }),
          rowCount: 1,
          claimCount: 1,
          coverageComplete: true,
        },
        { env, now: () => now },
      ),
    /parity digest does not match/,
  );
  assert.throws(
    () =>
      recordGitcrawlActionReceipt(
        root,
        {
          receipt: "snapshot",
          repository,
          provider: "invalid",
          snapshotId,
          capabilities: GITCRAWL_QUERY_NAMES,
          coverageSha256,
          coverageDatasetCount: 9,
          coverageComplete: true,
        } as never,
        { env, now: () => now },
      ),
    /unsupported Gitcrawl receipt provider/,
  );
});

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-receipts-")));
}

function trustedChildRoot(root: string, name: string): string {
  const child = path.join(root, name);
  fs.mkdirSync(child);
  return fs.realpathSync(child);
}
