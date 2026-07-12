import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("repair sessions, statuses, and result publication flush immutable receipts", () => {
  const session = readText("src/repair/action-session.ts");
  const status = readText("src/repair/issue-implementation-status.ts");
  const publisher = readText("src/repair/publish-result.ts");

  assert.match(session, /ACTION_EVENT_TYPES\.sessionRegistered/);
  assert.match(session, /ACTION_EVENT_TYPES\.repairQueue/);
  assert.match(session, /repairEventType\(state, phase, completionReason\)/);
  assert.match(session, /withActionSessionReceiptFinalization/);
  assert.match(session, /metadata\.remoteEnabled === true/);
  const registration = session.slice(
    session.indexOf("async function registerActionSession"),
    session.indexOf("async function updateActionSession"),
  );
  const update = session.slice(
    session.indexOf("async function updateActionSession"),
    session.indexOf("function actionSessionLifecycle"),
  );
  assert.ok(
    registration.indexOf("type: ACTION_EVENT_TYPES.repairQueue") <
      registration.indexOf("if (remoteEnabled)"),
  );
  assert.ok(
    update.indexOf("type: repairEventType(state, phase, completionReason)") <
      update.indexOf("if (metadata.remoteEnabled === true)"),
  );

  const statusMutation = status.indexOf("mutateComment();");
  const statusReceipt = status.indexOf("type: ACTION_EVENT_TYPES.statusLifecycle", statusMutation);
  assert.ok(statusMutation >= 0);
  assert.ok(statusReceipt > statusMutation);
  assert.match(status, /ACTION_EVENT_TYPES\.dashboardLifecycle/);
  assert.match(status, /await flushRepairActionEvents\(\)/);

  const resultWrite = publisher.indexOf("writeClosedRecord");
  const resultReceipt = publisher.indexOf("type: ACTION_EVENT_TYPES.repairPublish", resultWrite);
  assert.ok(resultWrite >= 0);
  assert.ok(resultReceipt > resultWrite);
  assert.match(publisher, /ACTION_EVENT_TYPES\.publicationLifecycle/);
  assert.match(publisher, /ACTION_EVENT_TYPES\.dashboardLifecycle/);
  assert.match(publisher, /await flushRepairActionEvents\(\)/);
  assert.doesNotMatch(publisher, /recordAggregatePublication\([^)]*,/);
});

test("repair worker jobs upload shards and one credentialed job publishes them", () => {
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const cluster = workflow.slice(
    workflow.indexOf("\n  cluster:"),
    workflow.indexOf("\n  authorize:"),
  );
  const mutate = workflow.slice(
    workflow.indexOf("\n  mutate:"),
    workflow.indexOf("\n  publish-repair-action-ledger:"),
  );
  const publisher = workflow.slice(workflow.indexOf("\n  publish-repair-action-ledger:"));
  const clusterRegistration = cluster.slice(
    cluster.indexOf("- name: Register repair lifecycle"),
    cluster.indexOf("- name: Verify GitHub read token"),
  );
  const mutationRegistration = mutate.slice(
    mutate.indexOf("- name: Resume repair lifecycle"),
    mutate.indexOf("- name: Create exact-repository mutation token"),
  );

  assert.match(cluster, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(cluster, /Finalize cluster repair action ledger/);
  assert.match(cluster, /clawsweeper-repair-action-ledger-cluster-/);
  assert.match(clusterRegistration, /CLAWSWEEPER_ACTION_SESSION_REMOTE:/);
  assert.doesNotMatch(clusterRegistration, /if:.*CLAWSWEEPER_STEERABLE_CODEX/);
  assert.match(mutate, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(mutate, /Finalize mutation repair action ledger/);
  assert.match(mutate, /clawsweeper-repair-action-ledger-mutate-/);
  assert.match(mutationRegistration, /CLAWSWEEPER_ACTION_SESSION_REMOTE:/);
  assert.match(mutationRegistration, /--skip-repair-receipt/);
  assert.doesNotMatch(mutationRegistration, /if:.*CLAWSWEEPER_STEERABLE_CODEX/);
  assert.match(
    mutate,
    /Resolve planning action ledger context[\s\S]*--expected-artifact-id "\$\{\{ needs\.cluster\.outputs\.action_ledger_artifact_id \}\}"[\s\S]*Download planning action ledger context[\s\S]*artifact-ids: \$\{\{ steps\.planning_action_ledger\.outputs\.artifact_id \}\}/,
  );
  assert.match(mutate, /CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS:/);
  assert.doesNotMatch(mutate, /create-state-token|setup-state/);

  assert.match(publisher, /name: Publish immutable repair action ledger/);
  assert.match(publisher, /create-state-token/);
  assert.match(publisher, /name: Resolve repair action ledger shards/);
  assert.match(publisher, /has_artifacts=0/);
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ steps\.repair-action-ledger-artifacts\.outputs\.artifact_ids \}\}/,
  );
  assert.doesNotMatch(
    publisher,
    /continue-on-error: true[\s\S]*Download repair action ledger shards/,
  );
  assert.match(publisher, /repair:action-ledger -- publish/);
  assert.match(publisher, /--message "chore: append repair action ledger"/);
});

test("result and finalizer workflows publish their repair operation receipts", () => {
  const results = readText(".github/workflows/repair-publish-results.yml");
  const finalizer = readText(".github/workflows/repair-finalize-open-prs.yml");

  for (const workflow of [results, finalizer]) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, /repair:action-ledger -- finalize/);
    assert.match(workflow, /repair:action-ledger -- publish/);
    assert.match(workflow, /steps\.setup-pnpm\.outcome == 'success'/);
  }
  assert.match(results, /append repair publication action ledger/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=cluster-results/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=open-pr-finalizer/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=finalizer-results/);
  assert.match(finalizer, /append repair finalizer action ledger/);
});

test("the shared action ledger finalizer is operation-family agnostic", () => {
  const source = readText("src/repair/action-ledger-cli.ts");

  assert.match(source, /flushWorkflowActionEvents\(repoRoot\(\)\)/);
  assert.doesNotMatch(source, /flushCommandActionEvents/);
});
