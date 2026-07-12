import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flushWorkflowActionEvents } from "../../dist/action-ledger-runtime.js";
import {
  recordProofBindingCompleted,
  recordProofStageCompleted,
  recordProofStageFailed,
} from "../../dist/repair/proof-action-ledger.js";
import {
  buildStagedProofPlan,
  executeStagedProofPlan,
  stagedProofBundle,
  stagedProofPlanArtifact,
} from "../../dist/repair/staged-proof-gates.js";
import { readText } from "../helpers.ts";

test("independent staged proof events preserve immutable source and dispatch identity", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proof-action-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "validation",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    GITHUB_JOB: "validate",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_ACTION: "validate",
    GITHUB_RUN_STARTED_AT: "2026-07-12T16:00:00Z",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
  });

  try {
    const plan = buildStagedProofPlan({
      commands: [
        {
          parts: ["git", "diff", "--check"],
          source: "configured",
          canonical: true,
          required: true,
          originalIndex: 0,
        },
      ],
      changedFiles: ["src/example.ts"],
    });
    const planArtifact = stagedProofPlanArtifact(plan);
    const trace = executeStagedProofPlan(plan, {
      commandTimeoutMs: 1_000,
      budgetMs: 5_000,
      validatedHeadSha: "b".repeat(40),
      validatedBaseSha: "c".repeat(40),
      nowMs: () => 10,
      runCommand: (command) => ({
        executedCommands: [command.parts.join(" ")],
        reason: "passed",
      }),
    }).trace;
    const proof = stagedProofBundle([trace]);
    const context = {
      repository: "openclaw/openclaw",
      clusterId: "automerge-514",
      source: {
        repo: "openclaw/openclaw",
        kind: "pull_request",
        number: 514,
        expected_head_sha: "d".repeat(40),
      },
      dispatchKey: "router-command-514",
      authorizationSha256: "1".repeat(64),
      executionManifestSha256: "2".repeat(64),
      executionIntentSha256: "3".repeat(64),
      actionIdentitySha256: "4".repeat(64),
      preparedPublicationSha256: "5".repeat(64),
      repairDeltaBaseSha: "d".repeat(40),
      validatedHeadSha: "b".repeat(40),
      validatedBaseSha: "c".repeat(40),
    };

    const stage = recordProofStageCompleted({
      context,
      plan: planArtifact,
      trace,
      proof,
    });
    assert.ok(stage);
    const binding = recordProofBindingCompleted({
      context,
      plan: planArtifact,
      proof,
      receiptSha256: "6".repeat(64),
      parentEventId: stage.event_id,
    });
    assert.ok(binding);
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["proof.stage", "proof.binding"],
    );
    assert.deepEqual(
      events.map((event) => event.phase_seq),
      [1, 2],
    );
    assert.equal(events[0]?.parent_event_id, null);
    assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
    assert.equal(events[0]?.operation_id, events[1]?.operation_id);
    assert.equal(events[0]?.attempt_id, events[1]?.attempt_id);
    assert.equal(events[0]?.subject.cluster_id, "automerge-514");
    assert.equal(events[0]?.subject.source_revision, "b".repeat(40));

    const stageEvidence = evidenceByKind(events[0]);
    assert.equal(stageEvidence.get("command_dispatch")?.snapshot_id, "router-command-514");
    assert.equal(stageEvidence.get("repair_source")?.snapshot_id, "d".repeat(40));
    assert.equal(stageEvidence.get("execution_authorization")?.sha256, "1".repeat(64));
    assert.equal(stageEvidence.get("execution_manifest")?.sha256, "2".repeat(64));
    assert.equal(stageEvidence.get("execution_intent")?.sha256, "3".repeat(64));
    assert.equal(stageEvidence.get("repair_action")?.sha256, "4".repeat(64));
    assert.equal(stageEvidence.get("prepared_publication")?.sha256, "5".repeat(64));
    assert.equal(stageEvidence.get("repair_delta_base")?.snapshot_id, "d".repeat(40));
    assert.equal(stageEvidence.get("validated_head")?.snapshot_id, "b".repeat(40));
    assert.equal(stageEvidence.get("validated_base")?.snapshot_id, "c".repeat(40));
    assert.equal(stageEvidence.get("proof_plan")?.snapshot_id, plan.plan_id);
    assert.match(String(stageEvidence.get("proof_trace")?.sha256), /^[a-f0-9]{64}$/);
    assert.match(String(stageEvidence.get("proof_bundle")?.sha256), /^[a-f0-9]{64}$/);

    const bindingEvidence = evidenceByKind(events[1]);
    assert.equal(bindingEvidence.get("validation_receipt")?.sha256, "6".repeat(64));
    assert.equal(bindingEvidence.get("validation_receipt")?.snapshot_id, plan.plan_id);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("failed proof stages preserve the available trace without claiming a binding", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "failed-proof-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_JOB: "validate",
    GITHUB_RUN_ID: "12346",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTION: "validate",
    GITHUB_RUN_STARTED_AT: "2026-07-12T16:01:00Z",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
  });

  try {
    const plan = buildStagedProofPlan({
      commands: [
        {
          parts: ["pnpm", "test"],
          source: "configured",
          canonical: true,
          required: true,
          originalIndex: 0,
        },
      ],
      changedFiles: ["src/example.ts"],
    });
    const planArtifact = stagedProofPlanArtifact(plan);
    const trace = executeStagedProofPlan(plan, {
      commandTimeoutMs: 1_000,
      budgetMs: 5_000,
      validatedHeadSha: "b".repeat(40),
      validatedBaseSha: "c".repeat(40),
      nowMs: () => 10,
      runCommand: (command) => ({
        executedCommands: [command.parts.join(" ")],
        reason: "passed",
      }),
    }).trace;
    const event = recordProofStageFailed({
      context: {
        repository: "openclaw/openclaw",
        clusterId: "automerge-514",
        source: {
          repo: "openclaw/openclaw",
          kind: "pull_request",
          number: 514,
          expected_head_sha: "d".repeat(40),
        },
        dispatchKey: "router-command-514",
        authorizationSha256: "1".repeat(64),
        executionManifestSha256: "2".repeat(64),
        executionIntentSha256: "3".repeat(64),
        actionIdentitySha256: "4".repeat(64),
        preparedPublicationSha256: "5".repeat(64),
        repairDeltaBaseSha: "d".repeat(40),
        validatedHeadSha: "b".repeat(40),
        validatedBaseSha: "c".repeat(40),
      },
      plan: planArtifact,
      trace,
      error: new Error("validation command failed"),
    });
    assert.ok(event);
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, "proof.stage");
    assert.equal(events[0]?.action.status, "failed");
    assert.equal(events[0]?.action.reason_code, "validation_failed");
    assert.equal(events[0]?.parent_event_id, null);
    const evidence = evidenceByKind(events[0]);
    assert.match(String(evidence.get("proof_trace")?.sha256), /^[a-f0-9]{64}$/);
    assert.equal(evidence.has("proof_bundle"), false);
    assert.equal(evidence.has("validation_receipt"), false);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("proof lifecycle emission stays behind proof creation and receipt binding", () => {
  const source = readText("src/repair/execution-handoff.ts");
  const replay = source.indexOf("independentProof = replayStagedValidationProof(");
  const stage = source.indexOf("const proofStageEvent = recordProofStageCompleted(", replay);
  const receiptWrite = source.indexOf("writeJson(outputPath, receipt);", stage);
  const binding = source.indexOf("recordProofBindingCompleted(", receiptWrite);

  assert.ok(replay >= 0);
  assert.ok(stage > replay);
  assert.ok(receiptWrite > stage);
  assert.ok(binding > receiptWrite);
  assert.match(
    source.slice(replay, stage),
    /recordProofStageFailed\(\{[\s\S]*stagedProofTraceFromError\(error\)/,
  );

  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const validateJob = workflow.indexOf("\n  validate:");
  const setupLedger = workflow.indexOf("uses: ./.github/actions/setup-action-ledger", validateJob);
  const replayStep = workflow.indexOf(
    "- name: Independently replay exact repair proof",
    validateJob,
  );
  const finalize = workflow.indexOf(
    "- name: Finalize independent staged proof action ledger",
    replayStep,
  );
  const upload = workflow.indexOf(
    "- name: Upload independent staged proof action ledger",
    finalize,
  );
  const publishJob = workflow.indexOf("\n  publish-proof-action-ledger:", upload);
  const mutateJob = workflow.indexOf("\n  mutate:", publishJob);

  assert.ok(validateJob >= 0);
  assert.ok(setupLedger > validateJob);
  assert.ok(replayStep > setupLedger);
  assert.ok(finalize > replayStep);
  assert.ok(upload > finalize);
  assert.ok(publishJob > upload);
  assert.ok(mutateJob > publishJob);
  assert.match(workflow.slice(validateJob, replayStep), /CLAWSWEEPER_ACTION_LEDGER_DISPATCH_KEY/);
  assert.match(
    workflow.slice(validateJob, publishJob),
    /action_ledger_artifact_digest:[\s\S]*artifact-digest[\s\S]*checkpoint_recovered != '1'[\s\S]*if-no-files-found: error/,
  );
  assert.match(
    workflow.slice(publishJob, mutateJob),
    /--message "chore: append staged proof action ledger"/,
  );
  assert.match(
    workflow.slice(mutateJob, mutateJob + 800),
    /publish-proof-action-ledger[\s\S]*needs\.publish-proof-action-ledger\.result == 'success'[\s\S]*needs\.publish-proof-action-ledger\.result == 'skipped'[\s\S]*needs\.authorize\.outputs\.checkpoint_recovered == '1'/,
  );

  const cli = readText("src/repair/action-ledger-cli.ts");
  assert.match(cli, /flushWorkflowActionEvents\(actionLedgerRoot\(\)\)/);
  assert.doesNotMatch(cli, /command-action-ledger/);
});

function evidenceByKind(event: Record<string, any>): Map<string, Record<string, any>> {
  return new Map(
    (event.evidence ?? []).map((entry: Record<string, any>) => [String(entry.kind), entry]),
  );
}

function readEvents(root: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const file of walk(root)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
      if (line) events.push(JSON.parse(line));
    }
  }
  return events.sort((left, right) => Number(left.phase_seq) - Number(right.phase_seq));
}

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
