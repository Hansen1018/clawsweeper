import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import {
  buildGitcrawlEvidencePacket,
  renderGitcrawlEvidencePacket,
} from "../../dist/repair/gitcrawl-evidence-graph.js";
import {
  listPendingGitcrawlDispatches,
  prepareGitcrawlPublicationTransaction,
  recordGitcrawlDispatchReceipt,
} from "../../dist/repair/gitcrawl-publication-transaction.js";

const GITCRAWL_PUBLICATION_CLI = path.join(
  process.cwd(),
  "dist/repair/gitcrawl-publication-transaction.js",
);
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

test("Gitcrawl durable publication transaction binds jobs, cursor, and event shards", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-transaction-")),
  );
  const stagedRoot = path.join(root, "staged");
  fs.mkdirSync(stagedRoot);
  const coverage = completeCoverage();
  const claim = createGitcrawlEvidenceClaim({
    provider: "local",
    snapshotId: "snapshot-a",
    queryName: "gitcrawl.clusters.members",
    subject: "openclaw/openclaw#issue:42",
    data: { number: 42, state: "open" },
  });
  const packet = buildGitcrawlEvidencePacket({
    provider: "local",
    repository: "openclaw/openclaw",
    snapshotId: "snapshot-a",
    coverage,
    claims: [claim],
    generatedAt: now.toISOString(),
  });
  const jobPath = "jobs/openclaw/inbox/gitcrawl-evidence-v1-test.md";
  const ledger = beginGitcrawlActionLedger(
    root,
    {
      repository: "openclaw/openclaw",
      consumer: "cluster_intake",
      provider: "local",
      snapshotId: "snapshot-a",
      coverage,
    },
    { env, now: () => now },
  );
  ledger.recordBinding({
    phaseSeq: 20,
    identity: { clusterId: 7 },
    packet,
    recordPath: jobPath,
    itemCount: 1,
    subject: {
      repository: "openclaw/openclaw",
      kind: "cluster",
      clusterId: "gitcrawl-evidence-v1-test",
    },
  });
  const [shardPath] = await flushWorkflowActionEvents(root, { env, outputRoot: stagedRoot });
  assert.ok(shardPath);
  fs.mkdirSync(path.dirname(path.join(root, shardPath)), { recursive: true });
  fs.copyFileSync(path.join(stagedRoot, shardPath), path.join(root, shardPath));
  fs.mkdirSync(path.dirname(path.join(root, jobPath)), { recursive: true });
  fs.writeFileSync(
    path.join(root, jobPath),
    ["# Generated repair job", "", ...renderGitcrawlEvidencePacket(packet)].join("\n"),
  );
  const cursorPath = "jobs/openclaw/inbox/.gitcrawl-scan-cursors.json";
  const intakePath = "results/cluster-repair-intake/openclaw-openclaw.json";
  fs.writeFileSync(path.join(root, cursorPath), "{}\n");
  fs.mkdirSync(path.dirname(path.join(root, intakePath)), { recursive: true });
  fs.writeFileSync(path.join(root, intakePath), "{}\n");

  const transaction = prepareGitcrawlPublicationTransaction({
    root,
    eventPaths: [shardPath],
    generatedPaths: [jobPath],
    cursorPath,
    intakePath,
    manifestPath: "results/cluster-repair-intake/transactions/123-1.json",
    runId: "123",
    runAttempt: "1",
  });
  assert.equal(transaction.generated_jobs.length, 1);
  assert.deepEqual(
    {
      path: transaction.generated_jobs[0]!.path,
      packet_sha256: transaction.generated_jobs[0]!.packet_sha256,
      binding_event_id: transaction.generated_jobs[0]!.binding_event_id,
    },
    {
      path: jobPath,
      packet_sha256: packet.sha256,
      binding_event_id: readActionEventShard(path.join(root, shardPath)).at(-1)!.event_id,
    },
  );
  assert.match(transaction.generated_jobs[0]!.dispatch_key, /^gitcrawl-[a-f0-9]{64}$/);
  for (const requiredPath of [jobPath, shardPath, cursorPath, intakePath]) {
    assert.ok(transaction.publish_paths.includes(requiredPath), requiredPath);
  }
  assert.ok(
    transaction.publish_paths.includes("results/cluster-repair-intake/transactions/123-1.json"),
  );
  const durableRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitcrawl-durable-")),
  );
  fs.mkdirSync(path.join(durableRoot, path.dirname(jobPath)), { recursive: true });
  fs.copyFileSync(path.join(root, jobPath), path.join(durableRoot, jobPath));
  const durableTransactionPath = "results/cluster-repair-intake/transactions/123-1.json";
  fs.mkdirSync(path.join(durableRoot, path.dirname(durableTransactionPath)), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(root, durableTransactionPath),
    path.join(durableRoot, durableTransactionPath),
  );
  const pendingInput = {
    root,
    transactionsDirectory: "results/cluster-repair-intake/transactions",
    receiptsDirectory: "results/cluster-repair-intake/dispatch-receipts",
  };
  const pending = listPendingGitcrawlDispatches(pendingInput);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.job_path, jobPath);
  assert.equal(pending[0]!.dispatch_key, transaction.generated_jobs[0]!.dispatch_key);
  const dispatchReceipt = recordGitcrawlDispatchReceipt({
    root,
    transactionPath: "results/cluster-repair-intake/transactions/123-1.json",
    jobPath,
    dispatchKey: transaction.generated_jobs[0]!.dispatch_key,
    receiptsDirectory: "results/cluster-repair-intake/dispatch-receipts",
    runId: "456",
    runAttempt: "2",
    dispatchedAt: now.toISOString(),
  });
  assert.equal(fs.existsSync(path.join(root, dispatchReceipt.path)), true);
  assert.deepEqual(listPendingGitcrawlDispatches(pendingInput), []);

  prepareGitcrawlPublicationTransaction({
    root,
    eventPaths: [shardPath],
    generatedPaths: [jobPath],
    cursorPath,
    intakePath,
    manifestPath: "results/cluster-repair-intake/transactions/unpublished.json",
    runId: "unpublished",
    runAttempt: "1",
  });
  const pendingFile = ".artifacts/cluster-repair-intake/pending.tsv";
  execFileSync(
    process.execPath,
    [
      GITCRAWL_PUBLICATION_CLI,
      "pending",
      "--root",
      durableRoot,
      "--transactions-dir",
      "results/cluster-repair-intake/transactions",
      "--receipts-dir",
      "results/cluster-repair-intake/dispatch-receipts",
      "--pending-file",
      pendingFile,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const durablePending = fs.readFileSync(path.join(root, pendingFile), "utf8").trim().split("\n");
  assert.equal(durablePending.length, 1);
  assert.match(durablePending[0]!, /transactions\/123-1\.json/);
  assert.doesNotMatch(durablePending[0]!, /unpublished\.json/);

  const differentPacket = buildGitcrawlEvidencePacket({
    provider: "local",
    repository: "openclaw/openclaw",
    snapshotId: "snapshot-a",
    coverage,
    claims: [claim],
    generatedAt: "2026-07-12T11:59:00.000Z",
  });
  fs.writeFileSync(
    path.join(root, jobPath),
    ["# Generated repair job", "", ...renderGitcrawlEvidencePacket(differentPacket)].join("\n"),
  );
  assert.throws(
    () =>
      prepareGitcrawlPublicationTransaction({
        root,
        eventPaths: [shardPath],
        generatedPaths: [jobPath],
        manifestPath: "results/cluster-repair-intake/transactions/digest-mismatch.json",
      }),
    /binding packet digest does not match job/,
  );

  fs.unlinkSync(path.join(root, jobPath));
  assert.throws(
    () =>
      prepareGitcrawlPublicationTransaction({
        root,
        eventPaths: [shardPath],
        generatedPaths: [jobPath],
        manifestPath: "results/cluster-repair-intake/transactions/missing-job.json",
      }),
    /generated job is missing or is not a regular file/,
  );
  assert.throws(
    () =>
      prepareGitcrawlPublicationTransaction({
        root,
        eventPaths: [shardPath],
        generatedPaths: [],
        manifestPath: "results/cluster-repair-intake/transactions/missing-binding.json",
      }),
    /generated jobs do not exactly match binding events/,
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

test("cluster intake publishes jobs, cursor, and Gitcrawl bindings in one durable transaction", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  const dispatchSource = fs.readFileSync("src/repair/dispatch-jobs.ts", "utf8");
  assert.match(workflow, /name: Setup Gitcrawl evidence action ledger/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /name: Finalize Gitcrawl evidence action ledger/);
  assert.match(workflow, /repair:action-ledger -- finalize/);
  assert.match(workflow, /name: Stage immutable Gitcrawl evidence action ledger/);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && steps\.gitcrawl-action-ledger-finalize\.outcome == 'success' \}\}/,
  );
  assert.match(workflow, /repair:action-ledger -- publish/);
  assert.match(workflow, /--state-root "\$CLAWSWEEPER_STATE_DIR"/);
  assert.match(workflow, /name: Prepare Gitcrawl intake publication transaction/);
  assert.match(
    workflow,
    /steps\.prepare\.outputs\.should_import == 'true' && steps\.import\.outcome == 'success'/,
  );
  assert.match(workflow, /repair:gitcrawl-publication/);
  assert.match(workflow, /--generated-paths-file "\$generated_paths_file"/);
  assert.match(workflow, /--cursor "\$cursor_path"/);
  assert.match(workflow, /name: Publish Gitcrawl intake transaction/);
  assert.match(workflow, /name: Recover pending Gitcrawl dispatches/);
  assert.match(workflow, /repair:gitcrawl-publication -- pending/);
  assert.match(workflow, /--root "\$CLAWSWEEPER_STATE_DIR"/);
  assert.match(workflow, /--dispatch-key "\$dispatch_key"/);
  assert.match(workflow, /repair:gitcrawl-publication -- receipt/);
  assert.match(workflow, /name: Publish Gitcrawl dispatch receipts/);
  assert.match(dispatchSource, /if \(dispatchKey\) return true;/);
  assert.match(dispatchSource, /`dispatch_key=\$\{dispatchKey\}`/);
  const recoveryCondition = workflow.match(
    /- name: Recover pending Gitcrawl dispatches\n[\s\S]*?\n\s+if: (\$\{\{[^\n]+\}\})/,
  )?.[1];
  assert.ok(recoveryCondition);
  assert.match(recoveryCondition, /steps\.gitcrawl-publication-publish\.outcome != 'failure'/);
  assert.doesNotMatch(recoveryCondition, /steps\.import\.outcome == 'success'/);
  assert.equal(workflow.match(/pnpm run repair:publish-main/g)?.length, 2);
  assert.doesNotMatch(workflow, /chore: append Gitcrawl evidence action ledger/);
  assert.ok(
    workflow.indexOf("Stage immutable Gitcrawl evidence action ledger") <
      workflow.indexOf("Prepare Gitcrawl intake publication transaction"),
  );
  assert.ok(
    workflow.indexOf("Prepare Gitcrawl intake publication transaction") <
      workflow.indexOf("Publish Gitcrawl intake transaction"),
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
