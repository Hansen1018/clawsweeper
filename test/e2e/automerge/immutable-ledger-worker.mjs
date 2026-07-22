#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [candidateRoot, ledgerRoot] = process.argv.slice(2);
if (!candidateRoot || !ledgerRoot) {
  throw new Error("usage: immutable-ledger-worker.mjs <candidate-root> <ledger-root>");
}

const ledger = await import(pathToFileURL(path.join(candidateRoot, "dist/action-ledger.js")).href);
const input = actionEventInput(ledger, "keep_open");
const created = ledger.writeActionEvent(ledgerRoot, input, {
  now: () => new Date("2026-07-20T00:00:01.000Z"),
});
const originalBytes = fs.readFileSync(created.path);
let conflict = null;
let conflictDetected = false;
try {
  ledger.writeActionEvent(ledgerRoot, actionEventInput(ledger, "close"), {
    now: () => new Date("2026-07-20T00:00:02.000Z"),
  });
} catch (error) {
  if (error instanceof ledger.ActionEventConflictError) {
    conflict = error.message;
    conflictDetected = true;
  } else throw error;
}
const finalBytes = fs.readFileSync(created.path);
process.stdout.write(
  `${JSON.stringify({
    conflict,
    conflict_detected: conflictDetected,
    original_text: originalBytes.toString("utf8"),
    original_preserved: originalBytes.equals(finalBytes),
    relative_path: created.relativePath,
    status: created.status,
  })}\n`,
);

function actionEventInput(ledgerModule, reasonCode) {
  const repository = "openclaw/openclaw";
  const sourceRevision = "incident-head";
  const operationId = ledgerModule.actionOperationId(repository, "review", {
    number: 110725,
    sourceRevision,
  });
  return {
    eventKey: ledgerModule.actionEventKey("review.completed", {
      repository,
      number: 110725,
      sourceRevision,
    }),
    operationId,
    attemptId: ledgerModule.actionAttemptId(operationId, {
      workflow: "automerge-e2e",
      runId: "1",
      runAttempt: 1,
    }),
    parentEventId: null,
    phaseSeq: 1,
    idempotencyKeySha256: ledgerModule.actionIdempotencyKey({
      repository,
      number: 110725,
      sourceRevision,
      action: "review",
    }),
    type: ledgerModule.ACTION_EVENT_TYPES.reviewCompleted,
    producer: {
      repository: "openclaw/clawsweeper",
      sha: "e2e-candidate",
      workflow: "automerge-e2e",
      job: "immutable-path",
      runId: "1",
      runAttempt: 1,
      component: "review",
    },
    subject: {
      repository,
      kind: "pull_request",
      number: 110725,
      sourceRevision,
      recordPath: "records/openclaw-openclaw/items/110725.md",
    },
    action: {
      name: "review",
      status: "completed",
      reasonCode,
      retryable: false,
      mutation: false,
    },
    privacy: {
      classification: "internal",
      redactionVersion: "v1",
      fieldsDropped: [],
    },
    occurredAt: "2026-07-20T00:00:00.000Z",
  };
}
