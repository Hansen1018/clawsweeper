import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("repair sessions, statuses, and result publication flush immutable receipts", () => {
  const session = readText("src/repair/action-session.ts");
  const status = readText("src/repair/issue-implementation-status.ts");
  const publisher = readText("src/repair/publish-result.ts");

  assert.match(session, /ACTION_EVENT_TYPES\.sessionRegistered/);
  assert.match(session, /ACTION_EVENT_TYPES\.repairQueue/);
  assert.match(session, /repairEventType\(state, phase\)/);
  assert.match(session, /await flushRepairActionEvents\(\)/);

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

  assert.match(cluster, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(cluster, /Finalize cluster repair action ledger/);
  assert.match(cluster, /clawsweeper-repair-action-ledger-cluster-/);
  assert.match(mutate, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(mutate, /Finalize mutation repair action ledger/);
  assert.match(mutate, /clawsweeper-repair-action-ledger-mutate-/);
  assert.doesNotMatch(mutate, /create-state-token|setup-state/);

  assert.match(publisher, /name: Publish immutable repair action ledger/);
  assert.match(publisher, /create-state-token/);
  assert.match(publisher, /pattern: clawsweeper-repair-action-ledger-\*/);
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
  assert.match(finalizer, /append repair finalizer action ledger/);
});

test("the shared action ledger finalizer is operation-family agnostic", () => {
  const source = readText("src/repair/action-ledger-cli.ts");

  assert.match(source, /flushWorkflowActionEvents\(repoRoot\(\)\)/);
  assert.doesNotMatch(source, /flushCommandActionEvents/);
});
