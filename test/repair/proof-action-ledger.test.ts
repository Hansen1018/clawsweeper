import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flushWorkflowActionEvents } from "../../dist/action-ledger-runtime.js";
import {
  recordProofBindingCompleted,
  recordProofStageCompleted,
  recordProofStageFailed,
  validateProofActionLedgerArtifact,
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

    const paths = walk(outputRoot)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.relative(outputRoot, file).split(path.sep).join("/"))
      .sort();
    const identity = {
      schema_version: 1 as const,
      authorization_sha256: "1".repeat(64),
      validation_receipt_sha256: "6".repeat(64),
      paths,
      events: [stage, binding],
    };
    const manifest = {
      ...identity,
      identity_sha256: crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    };
    assert.deepEqual(
      validateProofActionLedgerArtifact({
        sourceRoot: outputRoot,
        manifest,
        expectedAuthorizationSha256: "1".repeat(64),
        expectedReceiptSha256: "6".repeat(64),
      }),
      events,
    );

    process.env.GITHUB_WORKFLOW_REF =
      "openclaw/clawsweeper/.github/workflows/forged.yml@refs/heads/main";
    assert.throws(
      () =>
        validateProofActionLedgerArtifact({
          sourceRoot: outputRoot,
          manifest,
          expectedAuthorizationSha256: "1".repeat(64),
          expectedReceiptSha256: "6".repeat(64),
        }),
      /producer identity is invalid/,
    );
    process.env.GITHUB_WORKFLOW_REF =
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main";

    const forged = path.join(outputRoot, "ledger", "forged.jsonl");
    fs.writeFileSync(forged, `${JSON.stringify(events[0])}\n`);
    assert.throws(
      () =>
        validateProofActionLedgerArtifact({
          sourceRoot: outputRoot,
          manifest,
          expectedAuthorizationSha256: "1".repeat(64),
          expectedReceiptSha256: "6".repeat(64),
        }),
      /unexpected shard set/,
    );
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

test("proof lifecycle is created in an isolated trusted job before state credentials", () => {
  const source = readText("src/repair/execution-handoff.ts");
  assert.match(source, /independentProof = replayStagedValidationProof\(/);
  assert.match(source, /writeJson\(outputPath, receipt\)/);
  assert.doesNotMatch(source, /recordProof(?:Stage|Binding)/);

  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const validateJob = workflow.indexOf("\n  validate:");
  const replayStep = workflow.indexOf(
    "- name: Independently replay exact repair proof",
    validateJob,
  );
  const publishJob = workflow.indexOf("\n  publish-proof-action-ledger:", replayStep);
  const mutateJob = workflow.indexOf("\n  mutate:", publishJob);
  const publishBlock = workflow.slice(publishJob, mutateJob);
  const validateIsolation = workflow.indexOf(
    "- name: Provision isolated target validation account",
    validateJob,
  );
  const setupLedger = publishBlock.indexOf("uses: ./.github/actions/setup-action-ledger");
  const createProof = publishBlock.indexOf("- name: Create and validate exact staged proof events");
  const stateToken = publishBlock.indexOf("- name: Create proof ledger state token");
  const publishProof = publishBlock.indexOf(
    "- name: Revalidate and publish exact staged proof events",
  );

  assert.ok(validateJob >= 0);
  assert.ok(validateIsolation > validateJob);
  assert.ok(validateIsolation < replayStep);
  assert.ok(replayStep > validateJob);
  assert.ok(publishJob > replayStep);
  assert.ok(mutateJob > publishJob);
  assert.doesNotMatch(workflow.slice(validateJob, publishJob), /setup-action-ledger/);
  assert.doesNotMatch(workflow.slice(validateJob, publishJob), /repair:action-ledger/);
  assert.match(
    workflow.slice(validateJob, publishJob),
    /Provision isolated target validation account[\s\S]*CLAWSWEEPER_TARGET_VALIDATION_ISOLATION_REQUIRED=1[\s\S]*github_output="\$GITHUB_OUTPUT"[\s\S]*GITHUB_\*\|RUNNER_\*\|ACTIONS_\*\|CLAWSWEEPER_ACTION_LEDGER_\*\|CLAWSWEEPER_CRABFLEET_\*[\s\S]*\*_PRIVATE_KEY\|\*_API_KEY[\s\S]*unset "\$name"[\s\S]*repair:execution-handoff -- validate[\s\S]*receipt_sha256=.*jq[\s\S]*>> "\$github_output"/,
  );
  assert.ok(setupLedger >= 0);
  assert.ok(createProof > setupLedger);
  assert.ok(stateToken > createProof);
  assert.ok(publishProof > stateToken);
  assert.match(publishBlock, /Download sealed execution handoff/);
  assert.match(publishBlock, /Download validation receipt/);
  assert.match(publishBlock, /GH_TOKEN:\s*""[\s\S]*GITHUB_TOKEN:\s*""[\s\S]*create-proof/);
  assert.match(publishBlock, /publish-proof[\s\S]*--authorization-sha256[\s\S]*--receipt-sha256/);
  assert.match(publishBlock, /--message "chore: append staged proof action ledger"/);
  assert.match(
    workflow.slice(mutateJob, mutateJob + 800),
    /needs\.publish-proof-action-ledger\.result == 'success'/,
  );
  assert.doesNotMatch(
    workflow.slice(mutateJob, mutateJob + 800),
    /publish-proof-action-ledger\.result == 'skipped'/,
  );

  const cli = readText("src/repair/action-ledger-cli.ts");
  assert.match(cli, /finalizeCommandActionLedgerManifest/);
  assert.match(cli, /parseCommandActionLedgerManifest/);
  assert.match(cli, /createProofActionLedgerArtifact/);
  assert.match(cli, /publishProofActionLedgerArtifact/);

  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  assert.match(setupAction, /ledger_root="\$worktree_root"/);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_ROOT=\$ledger_root/);
  assert.match(publishBlock, /storage: worktree/);

  const targetValidation = readText("src/repair/target-validation.ts");
  assert.match(targetValidation, /key\.startsWith\("GITHUB_"\)/);
  assert.match(targetValidation, /key\.startsWith\("RUNNER_"\)/);
  assert.match(targetValidation, /key\.startsWith\("ACTIONS_"\)/);
  assert.match(targetValidation, /key\.startsWith\("CLAWSWEEPER_ACTION_LEDGER_"\)/);
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
