import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_EVENT_TYPES } from "../dist/action-ledger.js";
import {
  flushWorkflowActionEvents,
  importActionEventShards,
} from "../dist/action-ledger-runtime.js";
import {
  commitReviewLifecycleSucceeded,
  recordCommitWorkflowEvent,
  runCommitMutation,
} from "../dist/commit-action-ledger.js";

test("commit review terminal success requires requested check publication", () => {
  assert.equal(
    commitReviewLifecycleSucceeded({
      reviewOutcome: "success",
      checkOutcome: "skipped",
      checksRequested: false,
      reportResult: "nothing_found",
    }),
    true,
  );
  for (const checkOutcome of ["skipped", "failure", "cancelled"]) {
    assert.equal(
      commitReviewLifecycleSucceeded({
        reviewOutcome: "success",
        checkOutcome,
        checksRequested: true,
        reportResult: "nothing_found",
      }),
      false,
    );
  }
  assert.equal(
    commitReviewLifecycleSucceeded({
      reviewOutcome: "success",
      checkOutcome: "success",
      checksRequested: true,
      reportResult: "findings",
    }),
    true,
  );
  for (const reportResult of ["failed", "missing", "invalid", "unknown"]) {
    assert.equal(
      commitReviewLifecycleSucceeded({
        reviewOutcome: "success",
        checkOutcome: "success",
        checksRequested: true,
        reportResult,
      }),
      false,
    );
  }
  assert.equal(
    commitReviewLifecycleSucceeded({
      reviewOutcome: "success",
      checkOutcome: "skipped",
      checksRequested: false,
      reportResult: "inconclusive",
    }),
    true,
  );
});

test("failed commit review reports cannot complete the workflow lifecycle", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-failed-report-")));
  const outputRoot = path.join(root, "output");
  const reportPath = path.join(root, `${"b".repeat(40)}.md`);
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(reportPath, "---\nresult: failed\n---\n\nReview failed.\n");
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist/commit-sweeper.js"),
        "finish-review",
        "--target-repo",
        "openclaw/openclaw",
        "--commit-sha",
        "b".repeat(40),
        "--report-path",
        reportPath,
        "--review-outcome",
        "success",
        "--check-outcome",
        "skipped",
        "--checks-requested",
        "false",
      ],
      { env: { ...process.env }, stdio: "pipe" },
    );
    await flushWorkflowActionEvents(root);

    const workflowStates = readEvents(outputRoot)
      .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
      .sort((left, right) => left.phase_seq - right.phase_seq)
      .map((event) => event.attributes?.state);
    assert.deepEqual(workflowStates, ["failed", "finalized"]);
    assert.doesNotMatch(workflowStates.join(","), /completed/);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit publication uncertainty is preserved by terminal workflow receipts", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-action-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = {
    repository: "openclaw/openclaw",
    sha: "b".repeat(40),
  };

  try {
    assert.throws(
      () =>
        runCommitMutation(lifecycle, {
          kind: "commit_check_publication",
          identity: { repo: "openclaw/openclaw", sha: lifecycle.sha },
          operation: () => {
            throw new Error("connection reset after check request");
          },
        }),
      /connection reset/,
    );
    recordCommitWorkflowEvent(lifecycle, "failed", new Error("later publication failed"));
    recordCommitWorkflowEvent(lifecycle, "finalized");
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot);
    const unknown = events.find(
      (event) => event.attributes?.completion_reason === "mutation_outcome_unknown",
    );
    const failed = events.find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
        event.attributes?.state === "failed",
    );
    assert.equal(unknown?.action.mutation, true);
    assert.equal(failed?.action.mutation, true);
    assert.equal(failed?.action.retryable, true);
    assert.equal(failed?.attributes?.completion_reason, "mutation_outcome_unknown");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit publication preserves its primary failure when receipt recording also fails", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-primary-error-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  const originalConsoleError = console.error;
  const receiptErrors: string[] = [];
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    console.error = (message?: unknown) => receiptErrors.push(String(message));
    const primary = new Error("primary publication failure");
    assert.throws(
      () =>
        runCommitMutation(
          { repository: "openclaw/openclaw", sha: "b".repeat(40) },
          {
            kind: "commit_check_publication",
            identity: { sha: "b".repeat(40) },
            operation: () => {
              process.env.GITHUB_REPOSITORY = "invalid";
              throw primary;
            },
          },
        ),
      (error) => error === primary,
    );
    assert.match(receiptErrors.join("\n"), /after the primary failure/);
  } finally {
    console.error = originalConsoleError;
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit review matrix invocations publish distinct importable shard paths", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-matrix-ledger-")));
  const outputRoot = path.join(root, "output");
  const destination = path.join(root, "destination");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(destination);
  const previous = { ...process.env };
  const paths: string[] = [];
  const commits = ["b".repeat(40), "c".repeat(40)];

  try {
    for (const sha of commits) {
      const spoolRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "commit-matrix-spool-")),
      );
      Object.assign(process.env, workflowEnv(spoolRoot, outputRoot), {
        CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `commit-${sha}`,
      });
      const lifecycle = { repository: "openclaw/openclaw", sha };
      recordCommitWorkflowEvent(lifecycle, "started");
      recordCommitWorkflowEvent(lifecycle, "completed");
      recordCommitWorkflowEvent(lifecycle, "finalized");
      paths.push(...(await flushWorkflowActionEvents(spoolRoot)));
      fs.rmSync(spoolRoot, { force: true, recursive: true });
    }

    assert.equal(new Set(paths).size, commits.length);
    assert.ok(paths.every((entry, index) => entry.includes(`commit-${commits[index]}`)));
    const imported = importActionEventShards(outputRoot, destination);
    assert.equal(imported.created, commits.length);
    const subjects = new Set(
      readEvents(destination).map((event) => String(event.subject?.source_revision)),
    );
    assert.deepEqual(subjects, new Set(commits));
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit review check publication completes before the workflow is finalized", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-lifecycle-order-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };

  try {
    recordCommitWorkflowEvent(lifecycle, "started");
    runCommitMutation(lifecycle, {
      kind: "commit_check_publication",
      identity: { sha: lifecycle.sha },
      operation: () => undefined,
    });
    recordCommitWorkflowEvent(lifecycle, "completed");
    recordCommitWorkflowEvent(lifecycle, "finalized");
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot).sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
        .map((event) => event.attributes?.state),
      ["started", "completed", "finalized"],
    );
    assert.equal(events.at(-1)?.attributes?.state, "finalized");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function workflowEnv(root: string, outputRoot: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "commit_review",
    GITHUB_JOB: "review",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "5252",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "commit review",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/commit-review.yml@refs/heads/main",
    GITHUB_RUN_STARTED_AT: "2026-07-12T00:00:00Z",
  };
}

function readEvents(root: string): Record<string, any>[] {
  return walk(root)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function restoreEnv(previous: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
