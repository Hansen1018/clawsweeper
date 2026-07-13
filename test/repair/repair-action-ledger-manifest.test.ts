import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../../dist/action-ledger.js";
import {
  assertRepairActionLedgerManifestSource,
  finalizeRepairActionLedgerManifest,
  parseRepairActionLedgerManifest,
  serializeRepairActionLedgerManifest,
} from "../../dist/repair/repair-action-ledger-manifest.js";
import {
  flushRepairActionEvents,
  recordRepairLifecycleEvent,
} from "../../dist/repair/repair-action-ledger.js";
import { recordCommandReceived } from "../../dist/repair/command-action-ledger.js";
import { finalizeCommandActionLedgerManifest } from "../../dist/repair/command-action-ledger-manifest.js";

test("repair manifests bind the exact lane, producer run, and complete shard set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-manifest-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    recordRepairLifecycleEvent(repairLifecycle(), {
      type: ACTION_EVENT_TYPES.repairPlan,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "repair_worker",
      state: "planned",
    });
    const manifest = await finalizeRepairActionLedgerManifest("cluster");
    const content = serializeRepairActionLedgerManifest(manifest);
    const expectedProducer = {
      repository: "openclaw/clawsweeper",
      sha: "a".repeat(40),
      workflow: "repair-cluster-worker.yml",
      job: "cluster",
      runId: "4242",
      runAttempt: 3,
    };
    assert.deepEqual(
      parseRepairActionLedgerManifest(content, "cluster", expectedProducer),
      manifest,
    );
    assert.doesNotThrow(() => assertRepairActionLedgerManifestSource(outputRoot, manifest));
    assert.throws(
      () =>
        parseRepairActionLedgerManifest(content, "cluster", {
          ...expectedProducer,
          runId: "9999",
        }),
      /identity mismatch for run_id/,
    );

    const foreignRoot = path.join(root, "foreign");
    const foreignOutputRoot = path.join(foreignRoot, "output");
    fs.mkdirSync(foreignOutputRoot, { recursive: true });
    Object.assign(process.env, workflowEnv(foreignRoot, foreignOutputRoot), {
      GITHUB_RUN_ID: "9999",
      GITHUB_ACTION: "foreign_repair",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "foreign",
    });
    recordRepairLifecycleEvent(
      { ...repairLifecycle(), workKey: "openclaw/openclaw:foreign" },
      {
        type: ACTION_EVENT_TYPES.repairPlan,
        status: ACTION_EVENT_STATUSES.completed,
        reasonCode: ACTION_EVENT_REASON_CODES.completed,
        mutation: false,
        component: "repair_worker",
        state: "foreign",
      },
    );
    const foreignManifest = await finalizeRepairActionLedgerManifest("cluster");
    assert.throws(
      () =>
        assertRepairActionLedgerManifestSource(foreignOutputRoot, {
          ...manifest,
          event_paths: foreignManifest.event_paths,
        }),
      /mixed producer runs for run_id/,
    );

    Object.assign(process.env, workflowEnv(root, outputRoot));
    process.env.GITHUB_ACTION = "forged_extra";
    process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = "forged";
    recordRepairLifecycleEvent(
      { ...repairLifecycle(), workKey: "openclaw/openclaw:forged" },
      {
        type: ACTION_EVENT_TYPES.repairPlan,
        status: ACTION_EVENT_STATUSES.completed,
        reasonCode: ACTION_EVENT_REASON_CODES.completed,
        mutation: false,
        component: "repair_worker",
        state: "forged",
      },
    );
    await flushRepairActionEvents();
    assert.throws(
      () => assertRepairActionLedgerManifestSource(outputRoot, manifest),
      /shard set mismatch: .*extra=ledger\//,
    );

    fs.rmSync(path.join(outputRoot, manifest.event_paths[0]!));
    assert.throws(
      () => assertRepairActionLedgerManifestSource(outputRoot, manifest),
      /shard set mismatch: .*missing=ledger\//,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair manifests allow an explicitly empty producer run without weakening shard checks", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-empty-manifest-")));
  const outputRoot = path.join(root, "output");
  const manifestPath = path.join(root, "repair-action-ledger-manifest.json");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const expectedProducer = {
    repository: "openclaw/clawsweeper",
    sha: "a".repeat(40),
    workflow: "repair-cluster-worker.yml",
    job: "cluster",
    runId: "4242",
    runAttempt: 3,
  };

  try {
    await assert.rejects(
      finalizeRepairActionLedgerManifest("cluster"),
      /finalized no event shards/,
    );
    const content = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist", "repair", "action-ledger-cli.js"),
        "finalize",
        "--repair-lane",
        "cluster",
        "--allow-empty",
      ],
      { encoding: "utf8", env: { ...process.env } },
    );
    fs.writeFileSync(manifestPath, content);
    const manifest = parseRepairActionLedgerManifest(content, "cluster", expectedProducer, {
      allowEmpty: true,
    });
    assert.deepEqual(manifest.event_paths, []);
    assert.throws(
      () => parseRepairActionLedgerManifest(content, "cluster", expectedProducer),
      /manifest identity is invalid/,
    );
    assert.doesNotThrow(() => assertRepairActionLedgerManifestSource(outputRoot, manifest));
    assert.doesNotThrow(() =>
      execFileSync(
        process.execPath,
        [
          path.join(process.cwd(), "dist", "repair", "action-ledger-cli.js"),
          "verify",
          "--repair-lane",
          "cluster",
          "--allow-empty",
          "--manifest",
          manifestPath,
          "--source-root",
          outputRoot,
        ],
        { env: { ...process.env }, stdio: "pipe" },
      ),
    );

    recordRepairLifecycleEvent(repairLifecycle(), {
      type: ACTION_EVENT_TYPES.repairPlan,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "repair_worker",
      state: "unexpected",
    });
    await flushRepairActionEvents();
    assert.throws(
      () => assertRepairActionLedgerManifestSource(outputRoot, manifest),
      /shard set mismatch: .*extra=ledger\//,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair manifests exclude command shards from a shared workflow output root", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mixed-manifest-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    recordRepairLifecycleEvent(repairLifecycle(), {
      type: ACTION_EVENT_TYPES.repairPlan,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "repair_worker",
      state: "planned",
    });
    recordCommandReceived({
      repo: "openclaw/openclaw",
      issue_number: 42,
      idempotency_key: "report-requeue:openclaw/openclaw:42",
      comment_body_sha256: null,
      status: "pending",
      target: {
        kind: "pull_request",
        head_sha: "b".repeat(40),
      },
      actions: [],
    });

    const repairManifest = await finalizeRepairActionLedgerManifest("report-status");
    const commandManifest = await finalizeCommandActionLedgerManifest("report-requeue");
    assert.ok(commandManifest);
    assert.equal(repairManifest.event_paths.length, 1);
    assert.equal(commandManifest.event_paths.length, 1);
    assert.equal(
      repairManifest.event_paths.some((eventPath) =>
        commandManifest.event_paths.includes(eventPath),
      ),
      false,
    );
    assert.doesNotThrow(() => assertRepairActionLedgerManifestSource(outputRoot, repairManifest));
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function repairLifecycle() {
  return {
    repository: "openclaw/openclaw",
    workKey: "openclaw/openclaw:repair-pr-42",
    clusterId: "repair-pr-42",
    number: 42,
    sourceRevision: "b".repeat(40),
  };
}

function workflowEnv(root: string, outputRoot: string): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "cluster",
    GITHUB_ACTION: "repair",
    GITHUB_JOB: "cluster",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_RUN_ID: "4242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
