import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readActionEventShard } from "../../dist/action-ledger.js";
import { flushWorkflowActionEvents } from "../../dist/action-ledger-runtime.js";
import { beginGitcrawlActionLedger } from "../../dist/repair/gitcrawl-action-ledger.js";
import {
  GITCRAWL_DATASETS,
  createGitcrawlEvidenceClaim,
  type GitcrawlCoverageRow,
} from "../../dist/repair/gitcrawl-evidence-contract.js";
import { buildGitcrawlEvidencePacket } from "../../dist/repair/gitcrawl-evidence-graph.js";

const now = new Date("2026-07-12T12:00:00.000Z");
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW: "repair cluster intake",
  GITHUB_JOB: "intake",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTION: "gitcrawl-evidence-test",
  GITHUB_RUN_STARTED_AT: now.toISOString(),
  CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
  CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
} satisfies NodeJS.ProcessEnv;

test("Gitcrawl evidence emits snapshot, query, and packet binding events without raw data", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-ledger-")),
  );
  const outputRoot = path.join(root, "state");
  fs.mkdirSync(outputRoot);
  const coverage = completeCoverage();
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId: "snapshot-a",
    queryName: "gitcrawl.threads.search",
    subject: "openclaw/openclaw#pull_request:42",
    data: { number: 42, state: "open" },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "cloud",
    repository: "openclaw/openclaw",
    snapshotId: "snapshot-a",
    coverage,
    claims: [claim],
    generatedAt: now.toISOString(),
  });
  const ledger = beginGitcrawlActionLedger(
    root,
    {
      repository: "openclaw/openclaw",
      consumer: "low_signal_intake",
      provider: "cloud",
      snapshotId: "snapshot-a",
      coverage,
    },
    { env, now: () => now },
  );
  const query = ledger.recordQuery({
    queryName: "gitcrawl.threads.search",
    phaseSeq: 10,
    identity: { order: "oldest", scanOffset: 0 },
    rowCount: 1,
    claims: [claim],
    subject: {
      repository: "openclaw/openclaw",
      kind: "repository",
    },
  });
  ledger.recordBinding({
    phaseSeq: 20,
    identity: { clusterId: "low-signal-pr-sweep-v1-test" },
    packet,
    recordPath: "jobs/openclaw/inbox/low-signal-pr-sweep-v1-test.md",
    itemCount: 1,
    subject: {
      repository: "openclaw/openclaw",
      kind: "cluster",
      clusterId: "low-signal-pr-sweep-v1-test",
    },
    parentEventId: query?.event_id ?? null,
  });

  const [shardPath] = await flushWorkflowActionEvents(root, { env, outputRoot });
  assert.ok(shardPath);
  const events = readActionEventShard(path.join(outputRoot, shardPath));
  assert.deepEqual(
    events.map((event) => event.event_type),
    ["gitcrawl.snapshot", "gitcrawl.query", "gitcrawl.binding"],
  );
  assert.equal(events[1]!.parent_event_id, events[0]!.event_id);
  assert.equal(events[2]!.parent_event_id, events[1]!.event_id);
  assert.equal(
    events[0]!.evidence?.find((entry) => entry.kind === "gitcrawl_snapshot")?.snapshot_id,
    "snapshot-a",
  );
  assert.equal(events[1]!.attributes?.result_count, 1);
  assert.equal(events[2]!.attributes?.publication_kind, "gitcrawl_evidence_packet");
  assert.equal(
    events[2]!.evidence?.find((entry) => entry.kind === "gitcrawl_evidence_packet")?.sha256,
    packet.sha256,
  );
  assert.equal(
    events[2]!.evidence?.find((entry) => entry.kind === "gitcrawl_evidence_packet")?.report_path,
    "jobs/openclaw/inbox/low-signal-pr-sweep-v1-test.md",
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /"data":|"query_args":\{|"query_rows":\[|SELECT secret/);
  assert.deepEqual(events[0]!.privacy.fields_dropped, [
    "logs",
    "prompt",
    "query_args",
    "query_rows",
    "raw_payload",
    "sql",
  ]);
});

test("Gitcrawl ledger hashes snapshot identifiers that are not machine-safe", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-ledger-")),
  );
  const outputRoot = path.join(root, "state");
  fs.mkdirSync(outputRoot);
  beginGitcrawlActionLedger(
    root,
    {
      repository: "openclaw/openclaw",
      consumer: "cluster_intake",
      provider: "local",
      snapshotId: "snapshot id with spaces",
      coverage: completeCoverage(),
    },
    { env, now: () => now },
  );
  const [shardPath] = await flushWorkflowActionEvents(root, { env, outputRoot });
  assert.ok(shardPath);
  const [event] = readActionEventShard(path.join(outputRoot, shardPath));
  const snapshotEvidence = event!.evidence?.find((entry) => entry.kind === "gitcrawl_snapshot");
  assert.match(snapshotEvidence?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(snapshotEvidence?.snapshot_id, undefined);
  assert.doesNotMatch(JSON.stringify(event), /snapshot id with spaces/);
});

test("Gitcrawl evidence records no binding when no job is published", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-ledger-")),
  );
  const outputRoot = path.join(root, "state");
  fs.mkdirSync(outputRoot);
  const coverage = completeCoverage();
  const claim = createGitcrawlEvidenceClaim({
    provider: "cloud",
    snapshotId: "snapshot-a",
    queryName: "gitcrawl.threads.search",
    subject: "openclaw/openclaw#pull_request:42",
    data: { number: 42, state: "open" },
  });
  const ledger = beginGitcrawlActionLedger(
    root,
    {
      repository: "openclaw/openclaw",
      consumer: "low_signal_intake",
      provider: "cloud",
      snapshotId: "snapshot-a",
      coverage,
    },
    { env, now: () => now },
  );
  ledger.recordQuery({
    queryName: "gitcrawl.threads.search",
    phaseSeq: 10,
    identity: { order: "oldest", scanOffset: 0 },
    rowCount: 0,
    claims: [claim],
  });

  const [shardPath] = await flushWorkflowActionEvents(root, { env, outputRoot });
  assert.ok(shardPath);
  const events = readActionEventShard(path.join(outputRoot, shardPath));
  assert.deepEqual(
    events.map((event) => event.event_type),
    ["gitcrawl.snapshot", "gitcrawl.query"],
  );
});

test("Gitcrawl importers bind only after atomic publication and before cursor advancement", () => {
  for (const file of [
    "src/repair/import-gitcrawl-clusters.ts",
    "src/repair/import-gitcrawl-low-signal-prs.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    const publish = source.indexOf("publishGitcrawlGeneratedJob(filePath, markdown)");
    const binding = source.indexOf("actionLedger.recordBinding", publish);
    const writeJobCall = source.indexOf(
      file.endsWith("clusters.ts") ? "await writeClusterJob({" : "writeJob(actionLedger,",
    );
    const cursor = source.indexOf("writeGitcrawlScanOffset({", writeJobCall);
    assert.ok(publish >= 0, file);
    assert.ok(binding > publish, file);
    assert.ok(writeJobCall >= 0, file);
    assert.ok(cursor > writeJobCall, file);
  }
});

test("cluster intake publishes finalized Gitcrawl evidence shards to state", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  assert.match(workflow, /name: Setup Gitcrawl evidence action ledger/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /name: Finalize Gitcrawl evidence action ledger/);
  assert.match(workflow, /repair:action-ledger -- finalize/);
  assert.match(workflow, /name: Publish immutable Gitcrawl evidence action ledger/);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && steps\.gitcrawl-action-ledger\.outcome == 'success' \}\}/,
  );
  assert.match(workflow, /repair:action-ledger -- publish/);
  assert.match(workflow, /--state-root "\$CLAWSWEEPER_STATE_DIR"/);
  assert.match(workflow, /--message "chore: append Gitcrawl evidence action ledger"/);
  assert.ok(
    workflow.indexOf("Publish immutable Gitcrawl evidence action ledger") <
      workflow.indexOf("Publish intake jobs and ledger"),
  );
});

function completeCoverage(): GitcrawlCoverageRow[] {
  return GITCRAWL_DATASETS.map((dataset) => ({
    dataset,
    row_count: 1,
    eligible_count: 1,
    covered_count: 1,
    max_source_at: now.toISOString(),
    dataset_generated_at: now.toISOString(),
    complete: true,
  }));
}
