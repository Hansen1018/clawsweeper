import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeRepairJobGenerations,
  fetchRecentWorkflowRuns,
} from "../../dist/repair/live-worker-capacity.js";

const JOB = "jobs/openclaw/inbox/cluster-self-heal.md";

test("self-heal indexes active immutable generations beyond 200 workflow runs", () => {
  const digest = "a".repeat(64);
  const calls = [];
  const active = activeRepairJobGenerations({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster-worker.yml",
    fetchWorkflowRuns: (options) =>
      fetchRecentWorkflowRuns({
        ...options,
        fetchPage: (args) => {
          const query = new URL(`https://github.test/${args[3]}`).searchParams;
          const status = query.get("status");
          const page = Number(query.get("page"));
          calls.push({ status, page });
          if (status !== "in_progress") return [];
          if (page <= 2) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: (page - 1) * 100 + index + 1,
              status,
              display_title: `repair cluster jobs/openclaw/inbox/other-${page}-${index}.md (${digest})`,
            }));
          }
          return [
            {
              id: 201,
              status,
              display_title: `repair cluster ${JOB} (${digest})`,
            },
          ];
        },
      }),
  });

  assert.deepEqual(active.get(`${JOB}:${digest}`), ["201"]);
  assert.deepEqual(
    calls.filter((call) => call.status === "in_progress"),
    [
      { status: "in_progress", page: 1 },
      { status: "in_progress", page: 2 },
      { status: "in_progress", page: 3 },
    ],
  );
});

test("self-heal excludes stale queued immutable generations", () => {
  const digest = "b".repeat(64);
  const active = activeRepairJobGenerations({
    nowMs: Date.parse("2026-07-13T12:00:00.000Z"),
    staleQueuedMs: 60 * 60 * 1000,
    fetchWorkflowRuns: () => [
      {
        id: 1,
        status: "queued",
        display_title: `repair cluster ${JOB} (${digest})`,
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:00:00.000Z",
      },
    ],
  });

  assert.equal(active.has(`${JOB}:${digest}`), false);
});

test("self-heal matches active immutable generations by exact job digest", () => {
  const oldDigest = "c".repeat(64);
  const newDigest = "d".repeat(64);
  const active = activeRepairJobGenerations({
    fetchWorkflowRuns: () => [
      {
        id: 7,
        status: "in_progress",
        display_title: `repair cluster ${JOB} (${oldDigest})`,
      },
    ],
  });

  assert.deepEqual(active.get(`${JOB}:${oldDigest}`), ["7"]);
  assert.equal(active.has(`${JOB}:${newDigest}`), false);
});

test("self-heal indexes digestless active workers as a conservative job lock", () => {
  const active = activeRepairJobGenerations({
    fetchWorkflowRuns: () => [
      {
        id: 8,
        status: "in_progress",
        display_title: `repair cluster ${JOB}`,
      },
    ],
  });

  assert.deepEqual(active.get(JOB), ["8"]);
});

test("execute-mode self-heal fails closed when active generation discovery fails", () => {
  assert.throws(
    () =>
      activeRepairJobGenerations({
        fetchWorkflowRuns: () => {
          throw new Error("GitHub unavailable");
        },
      }),
    /GitHub unavailable/,
  );

  const source = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");
  const discovery = source.slice(
    source.indexOf("function activeRepairJobGenerations()"),
    source.indexOf("function dispatchCandidate"),
  );
  assert.match(discovery, /cannot verify active repair generations; refusing dispatch/);
  assert.doesNotMatch(discovery, /return new Map/);
});

test("failed-run self-heal replays the recorded sealed job generation", () => {
  const fixture = createSelfHealFixture("sealed");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.status, "dry_run");
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
    assert.equal(summary.candidates[0].source_job_sha256, fixture.originalDigest);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal restores both gates after receipt failure and dispatches payload v2", () => {
  const fixture = createSelfHealFixture("cleanup-receipt", "autonomous");
  const actionLedgerRootPath = path.join(fixture.root, "action-ledger");
  const actionLedgerOutputPath = path.join(fixture.root, "action-ledger-output");
  fs.mkdirSync(actionLedgerRootPath);
  fs.mkdirSync(actionLedgerOutputPath);
  const actionLedgerRoot = fs.realpathSync(actionLedgerRootPath);
  const actionLedgerOutput = fs.realpathSync(actionLedgerOutputPath);
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "autonomous",
    });
    const headSha = execFileSync("git", ["rev-parse", "origin/main"], {
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(
      fixture.postDispatchRunListFixture,
      `${JSON.stringify([
        {
          databaseId: 920001,
          workflowName: "repair cluster worker",
          displayTitle: `repair cluster ${fixture.jobPath} (${fixture.originalDigest})`,
          headSha,
          status: "in_progress",
          conclusion: null,
          createdAt: new Date(Date.now() + 60_000).toISOString(),
          updatedAt: new Date(Date.now() + 60_000).toISOString(),
          url: "https://github.test/actions/runs/920001",
        },
      ])}\n`,
    );

    const result = runSelfHealProcess(fixture, {
      args: ["--execute", "--open-execute-window"],
      env: {
        CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
        CLAWSWEEPER_ACTION_LEDGER_ROOT: actionLedgerRoot,
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: actionLedgerOutput,
        CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "self-heal-test",
        CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
        CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
        CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
        GH_BREAK_ACTION_LEDGER_ON_DISPATCH: "1",
        GITHUB_ACTION: "self-heal",
        GITHUB_JOB: "self-heal",
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "920000",
        GITHUB_SHA: headSha,
        GITHUB_WORKFLOW: "repair self-heal",
        GITHUB_WORKFLOW_REF:
          "openclaw/clawsweeper/.github/workflows/repair-self-heal.yml@refs/heads/main",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = fs.readFileSync(fixture.commandLogPath, "utf8").trim().split("\n");
    const dispatch = commands.find((command) => command.startsWith("workflow run "));
    assert.ok(dispatch);
    assert.ok(
      dispatch.includes(
        `-f payload_version=2 -f state_revision=${fixture.originalRevision} -f job_sha256=${fixture.originalDigest}`,
      ),
    );
    assert.deepEqual(
      commands.filter((command) => command.startsWith("variable set ")),
      [
        "variable set CLAWSWEEPER_ALLOW_EXECUTE --repo openclaw/clawsweeper --body 1",
        "variable set CLAWSWEEPER_ALLOW_FIX_PR --repo openclaw/clawsweeper --body 1",
        "variable set CLAWSWEEPER_ALLOW_FIX_PR --repo openclaw/clawsweeper --body 0",
        "variable set CLAWSWEEPER_ALLOW_EXECUTE --repo openclaw/clawsweeper --body 0",
      ],
    );
    assert.match(
      result.stderr,
      /restored CLAWSWEEPER_ALLOW_FIX_PR but failed to record its cleanup receipt/,
    );
    assert.match(
      result.stderr,
      /restored CLAWSWEEPER_ALLOW_EXECUTE but failed to record its cleanup receipt/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal preserves a durable gate-downgraded effective mode", () => {
  const fixture = createSelfHealFixture("downgraded", "autonomous");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal keeps a later autonomous failure after a successful plan downgrade", () => {
  const fixture = createSelfHealFixture("cross-mode-generation", "autonomous");
  const autonomousRunId = String(Number(fixture.runId) + 1);
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
      workflow_conclusion: "success",
    });
    writeRunRecord(fixture.runsDir, autonomousRunId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "autonomous",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_run_id, autonomousRunId);
    assert.equal(summary.candidates[0].source_job_sha256, fixture.originalDigest);
    assert.equal(summary.candidates[0].mode, "autonomous");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal recovers an early gate downgrade before worker results exist", () => {
  const fixture = createSelfHealFixture("early-downgrade", "autonomous");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
    });
    writeWorkflowInputs(fixture.artifactFixture, fixture.runId, 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
    assert.equal(summary.candidates[0].source_job_sha256, fixture.originalDigest);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal prefers the newest replay-safe input receipt", () => {
  const fixture = createSelfHealFixture("latest-inputs", "autonomous");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "autonomous",
    });
    writeWorkflowInputs(fixture.artifactFixture, fixture.runId, 2, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });
    writeLiveRunList(fixture, [
      {
        databaseId: Number(fixture.runId),
        workflowName: "repair cluster worker",
        displayTitle: `repair cluster ${fixture.jobPath} (${fixture.originalDigest})`,
        status: "completed",
        conclusion: "failure",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: `https://github.test/actions/runs/${fixture.runId}`,
      },
    ]);

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal ignores a newer receipt-only duplicate success", () => {
  const fixture = createSelfHealFixture("receipt-only-duplicate");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });
    writeLiveRunList(fixture, [
      {
        databaseId: Number(fixture.runId) + 1,
        workflowName: "repair cluster worker",
        displayTitle: `repair cluster ${fixture.jobPath} (${fixture.originalDigest})`,
        status: "completed",
        conclusion: "success",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: `https://github.test/actions/runs/${Number(fixture.runId) + 1}`,
      },
    ]);
    writeWorkflowInputs(fixture.artifactFixture, String(Number(fixture.runId) + 1), 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "plan",
      effectiveMode: "plan",
    });
    writeRunJobs(fixture, [
      { name: "Deduplicate command dispatch receipt", conclusion: "success" },
      { name: "Plan and review cluster", conclusion: "skipped" },
    ]);

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_run_id, fixture.runId);
    assert.equal(summary.candidates[0].source_job, fixture.jobPath);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal does not replay an older immutable generation after success", () => {
  const fixture = createSelfHealFixture("newer-success");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });
    writeLiveRunList(fixture, [
      {
        databaseId: Number(fixture.runId) + 1,
        workflowName: "repair cluster worker",
        displayTitle: `repair cluster ${fixture.jobPath} (${fixture.replacementDigest})`,
        status: "completed",
        conclusion: "success",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: `https://github.test/actions/runs/${Number(fixture.runId) + 1}`,
      },
    ]);
    writeWorkflowInputs(fixture.artifactFixture, String(Number(fixture.runId) + 1), 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.replacementRevision,
      jobSha256: fixture.replacementDigest,
      requestedMode: "autonomous",
      effectiveMode: "autonomous",
    });
    writeRunJobs(fixture, [{ name: "Plan and review cluster", conclusion: "success" }]);

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal honors a newer executed success in the same generation", () => {
  const fixture = createSelfHealFixture("same-generation-success");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });
    writeLiveRunList(fixture, [
      {
        databaseId: Number(fixture.runId) + 1,
        workflowName: "repair cluster worker",
        displayTitle: `repair cluster ${fixture.jobPath} (${fixture.originalDigest})`,
        status: "completed",
        conclusion: "success",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: `https://github.test/actions/runs/${Number(fixture.runId) + 1}`,
      },
    ]);
    writeWorkflowInputs(fixture.artifactFixture, String(Number(fixture.runId) + 1), 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "plan",
      effectiveMode: "plan",
    });
    writeRunJobs(fixture, [{ name: "Plan and review cluster", conclusion: "success" }]);

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal retains durable post-flight outcomes on live run refresh", () => {
  const fixture = createSelfHealFixture("live-post-flight", "autonomous");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "autonomous",
      post_flight_outcome: "blocked",
    });
    writeLiveRunList(fixture, [
      {
        databaseId: Number(fixture.runId),
        workflowName: "repair cluster worker",
        displayTitle: `repair cluster ${fixture.jobPath} (${fixture.originalDigest})`,
        status: "completed",
        conclusion: "failure",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: `https://github.test/actions/runs/${fixture.runId}`,
      },
    ]);

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal rejects conflicting input and result provenance", () => {
  const fixture = createSelfHealFixture("conflicting-inputs", "autonomous");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
    });
    writeWorkflowInputs(fixture.artifactFixture, fixture.runId, 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });
    writeArtifactCohort(fixture.artifactFixture, fixture.runId, 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      mode: "autonomous",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
    assert.equal(summary.skipped_candidates.length, 1);
    assert.equal(summary.skipped_candidates[0].reason, "immutable_provenance_unavailable");
    assert.match(summary.skipped_candidates[0].detail, /ambiguous repair artifact cohort/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal recovers a missing effective mode from the sealed artifact cohort", () => {
  const fixture = createSelfHealFixture("artifact-mode", "autonomous");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
    });
    writeArtifactCohort(fixture.artifactFixture, fixture.runId, 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal rejects an invalid durable effective mode", () => {
  const fixture = createSelfHealFixture("invalid-mode");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "unsafe",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
    assert.equal(summary.skipped_candidates.length, 1);
    assert.equal(summary.skipped_candidates[0].reason, "immutable_provenance_unavailable");
    assert.match(summary.skipped_candidates[0].detail, /invalid effective repair mode/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal fetches an exact historical revision from a depth-one state checkout", () => {
  const fixture = createSelfHealFixture("shallow");
  try {
    replaceStateWithDepthOneClone(fixture);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", `${fixture.originalRevision}^{commit}`], {
        cwd: fixture.stateRoot,
      }).status,
      0,
    );
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
    assert.equal(
      spawnSync("git", ["cat-file", "-e", `${fixture.originalRevision}^{commit}`], {
        cwd: fixture.stateRoot,
      }).status,
      0,
    );
    assert.equal(fs.existsSync(path.join(fixture.stateRoot, ".git", "shallow")), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal skips an unavailable historical revision without dropping valid jobs", () => {
  const fixture = createSelfHealFixture("bounded");
  try {
    replaceStateWithDepthOneClone(fixture);
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });
    writeRunRecord(fixture.runsDir, "910002", {
      source_job: "jobs/openclaw/inbox/missing-history.md",
      source_state_revision: "f".repeat(40),
      source_job_sha256: "e".repeat(64),
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_job, fixture.jobPath);
    assert.equal(summary.skipped_candidates.length, 1);
    assert.equal(summary.skipped_candidates[0].reason, "immutable_provenance_unavailable");
    assert.match(summary.skipped_candidates[0].detail, /could not fetch historical/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy self-heal records recover one complete sealed producer cohort", () => {
  const fixture = createSelfHealFixture("legacy");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
    });
    writeArtifactCohort(fixture.artifactFixture, fixture.runId, 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
    assert.equal(summary.candidates[0].source_job_sha256, fixture.originalDigest);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy self-heal records reject identity and plan split across attempts", () => {
  const fixture = createSelfHealFixture("split");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
    });
    const firstRunDir = artifactRunDir(fixture.artifactFixture, fixture.runId, 1);
    fs.mkdirSync(firstRunDir, { recursive: true });
    writeSourceIdentity(firstRunDir, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
    });
    const secondRunDir = artifactRunDir(fixture.artifactFixture, fixture.runId, 2);
    fs.mkdirSync(secondRunDir, { recursive: true });
    writePlanAndResult(secondRunDir, fixture.jobPath, "autonomous");

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
    assert.equal(summary.skipped_candidates.length, 1);
    assert.equal(summary.skipped_candidates[0].reason, "immutable_provenance_unavailable");
    assert.match(
      summary.skipped_candidates[0].detail,
      /did not publish immutable workflow inputs or one complete sealed repair artifact cohort/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repair workflow uploads immutable inputs before worker setup and reuses the persisted mode", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const persistIndex = workflow.indexOf("- name: Persist immutable recovery inputs");
  const uploadIndex = workflow.indexOf("- name: Upload immutable recovery inputs");
  const tokenIndex = workflow.indexOf("- name: Create GitHub App token");
  const setupIndex = workflow.indexOf("- uses: ./.github/actions/setup-pnpm");
  assert.ok(persistIndex >= 0);
  assert.ok(uploadIndex > persistIndex);
  assert.ok(tokenIndex > uploadIndex);
  assert.ok(setupIndex > uploadIndex);
  assert.match(workflow, /requested_mode: process\.env\.REQUESTED_MODE/);
  assert.match(workflow, /effective_mode: process\.env\.EFFECTIVE_MODE/);
  assert.match(
    workflow,
    /name: clawsweeper-repair-inputs-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    workflow,
    /worker_mode="\$\{\{ steps\.recovery_inputs\.outputs\.effective_mode \}\}"/,
  );
});

function createSelfHealFixture(label: string, originalMode: "plan" | "autonomous" = "plan") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-self-heal-${label}-`));
  const stateRoot = path.join(root, "state");
  const runsDir = path.join(root, "runs");
  const artifactFixture = path.join(root, "artifacts");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(artifactFixture, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const runListFixture = path.join(root, "run-list.json");
  const postDispatchRunListFixture = path.join(root, "post-dispatch-run-list.json");
  const runJobsFixture = path.join(root, "run-jobs.json");
  const variablesFixture = path.join(root, "variables.json");
  const commandLogPath = path.join(root, "gh-commands.log");
  const selfHealLedgerPath = path.join(root, "self-heal-ledger.json");
  fs.writeFileSync(runListFixture, "[]\n");
  fs.writeFileSync(postDispatchRunListFixture, "[]\n");
  fs.writeFileSync(runJobsFixture, '{"jobs":[]}\n');
  fs.writeFileSync(
    variablesFixture,
    `${JSON.stringify([
      { name: "CLAWSWEEPER_ALLOW_EXECUTE", value: "0" },
      { name: "CLAWSWEEPER_ALLOW_FIX_PR", value: "0" },
    ])}\n`,
  );
  fs.writeFileSync(commandLogPath, "");
  execFileSync("git", ["init", "-q"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: stateRoot });
  const jobPath = `jobs/openclaw/inbox/cluster-${label}.md`;
  const original = repairJob(originalMode, `${label}-original`);
  const originalRevision = commitJob(stateRoot, jobPath, original, "original");
  const originalDigest = createHash("sha256").update(original).digest("hex");
  const replacement = repairJob("autonomous", `${label}-replacement`);
  const replacementRevision = commitJob(stateRoot, jobPath, replacement, "replacement");
  const replacementDigest = createHash("sha256").update(replacement).digest("hex");
  writeFakeGh(binDir);
  return {
    root,
    stateRoot,
    runsDir,
    artifactFixture,
    binDir,
    runListFixture,
    postDispatchRunListFixture,
    runJobsFixture,
    variablesFixture,
    commandLogPath,
    selfHealLedgerPath,
    jobPath,
    originalRevision,
    originalDigest,
    replacementRevision,
    replacementDigest,
    runId: "910001",
  };
}

function runSelfHeal(fixture: ReturnType<typeof createSelfHealFixture>) {
  const result = runSelfHealProcess(fixture);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runSelfHealProcess(
  fixture: ReturnType<typeof createSelfHealFixture>,
  options: { args?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/repair/self-heal-failed-runs.js"),
      "--runs-dir",
      fixture.runsDir,
      "--ledger-path",
      fixture.selfHealLedgerPath,
      "--max-age-hours",
      "24",
      ...(options.args ?? []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        CLAWSWEEPER_STATE_DIR: fixture.stateRoot,
        GH_ARTIFACT_FIXTURE: fixture.artifactFixture,
        GH_COMMAND_LOG: fixture.commandLogPath,
        GH_POST_DISPATCH_RUN_LIST_FIXTURE: fixture.postDispatchRunListFixture,
        GH_RUN_LIST_FIXTURE: fixture.runListFixture,
        GH_RUN_JOBS_FIXTURE: fixture.runJobsFixture,
        GH_VARIABLES_FIXTURE: fixture.variablesFixture,
        ...options.env,
      },
    },
  );
  return result;
}

function replaceStateWithDepthOneClone(fixture: ReturnType<typeof createSelfHealFixture>): void {
  const sourceRoot = path.join(fixture.root, "state-source");
  const remoteRoot = path.join(fixture.root, "state-origin.git");
  fs.renameSync(fixture.stateRoot, sourceRoot);
  execFileSync("git", ["clone", "-q", "--bare", sourceRoot, remoteRoot]);
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${remoteRoot}`, fixture.stateRoot]);
}

function writeRunRecord(runsDir: string, runId: string, provenance: Record<string, string>): void {
  fs.writeFileSync(
    path.join(runsDir, `${runId}.json`),
    `${JSON.stringify(
      {
        run_id: runId,
        workflow_conclusion: "failure",
        workflow_updated_at: new Date().toISOString(),
        ...provenance,
      },
      null,
      2,
    )}\n`,
  );
}

function writeLiveRunList(
  fixture: ReturnType<typeof createSelfHealFixture>,
  runs: Record<string, unknown>[],
): void {
  fs.writeFileSync(fixture.runListFixture, `${JSON.stringify(runs)}\n`);
}

function writeRunJobs(
  fixture: ReturnType<typeof createSelfHealFixture>,
  jobs: Record<string, unknown>[],
): void {
  fs.writeFileSync(fixture.runJobsFixture, `${JSON.stringify({ jobs })}\n`);
}

function writeArtifactCohort(
  root: string,
  runId: string,
  attempt: number,
  input: {
    sourceJob: string;
    stateRevision: string;
    jobSha256: string;
    mode: "plan" | "autonomous";
  },
): void {
  const runDir = artifactRunDir(root, runId, attempt);
  fs.mkdirSync(runDir, { recursive: true });
  writeSourceIdentity(runDir, input);
  writePlanAndResult(runDir, input.sourceJob, input.mode);
}

function writeWorkflowInputs(
  root: string,
  runId: string,
  attempt: number,
  input: {
    sourceJob: string;
    stateRevision: string;
    jobSha256: string;
    requestedMode: "plan" | "execute" | "autonomous";
    effectiveMode: "plan" | "execute" | "autonomous";
  },
): void {
  const inputDir = path.join(
    root,
    `clawsweeper-repair-inputs-${runId}-${attempt}`,
    "recovery-inputs",
  );
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "workflow-inputs.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source_job: input.sourceJob,
        state_revision: input.stateRevision,
        job_sha256: input.jobSha256,
        requested_mode: input.requestedMode,
        effective_mode: input.effectiveMode,
      },
      null,
      2,
    )}\n`,
  );
}

function artifactRunDir(root: string, runId: string, attempt: number): string {
  return path.join(root, `clawsweeper-repair-worker-${runId}-${attempt}`, "runs", "fixture");
}

function writeSourceIdentity(
  runDir: string,
  input: { sourceJob: string; stateRevision: string; jobSha256: string },
): void {
  fs.writeFileSync(
    path.join(runDir, "source-job.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source_job: input.sourceJob,
        state_revision: input.stateRevision,
        job_sha256: input.jobSha256,
      },
      null,
      2,
    )}\n`,
  );
}

function writePlanAndResult(runDir: string, sourceJob: string, mode: "plan" | "autonomous"): void {
  fs.writeFileSync(
    path.join(runDir, "cluster-plan.json"),
    `${JSON.stringify({ source_job: sourceJob, mode })}\n`,
  );
  fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify({ mode })}\n`);
}

function commitJob(stateRoot: string, jobPath: string, contents: string, message: string): string {
  const absolute = path.join(stateRoot, jobPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  execFileSync("git", ["add", jobPath], { cwd: stateRoot });
  execFileSync("git", ["commit", "-qm", message], { cwd: stateRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: stateRoot,
    encoding: "utf8",
  }).trim();
}

function repairJob(mode: "plan" | "autonomous", clusterId: string): string {
  return `---
repo: openclaw/openclaw
cluster_id: ${clusterId}
mode: ${mode}
allowed_actions:
  - fix
candidates:
  - "#1"
---

# fixture
`;
}

function writeFakeGh(binDir: string): void {
  const file = path.join(binDir, "gh");
  fs.writeFileSync(
    file,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$GH_COMMAND_LOG"
if [ "$1" = "variable" ] && [ "$2" = "list" ]; then
  cat "$GH_VARIABLES_FIXTURE"
  exit 0
fi
if [ "$1" = "variable" ] && [ "$2" = "set" ]; then
  exit 0
fi
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  cp "$GH_POST_DISPATCH_RUN_LIST_FIXTURE" "$GH_RUN_LIST_FIXTURE"
  if [ "\${GH_BREAK_ACTION_LEDGER_ON_DISPATCH:-}" = "1" ]; then
    rm -rf "$CLAWSWEEPER_ACTION_LEDGER_ROOT"
    printf 'broken\\n' > "$CLAWSWEEPER_ACTION_LEDGER_ROOT"
  fi
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  cat "$GH_RUN_LIST_FIXTURE"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then
      shift
      cp -R "$GH_ARTIFACT_FIXTURE"/. "$1"/
      exit 0
    fi
    shift
  done
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *"/actions/workflows/"*)
      printf '[]\\n'
      exit 0
      ;;
  esac
  cat "$GH_RUN_JOBS_FIXTURE"
  exit 0
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`,
  );
  fs.chmodSync(file, 0o755);
}
