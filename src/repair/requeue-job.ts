#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseJob,
  readMaxLiveWorkers,
  repoRoot,
  validateJob,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { ghJson, ghText } from "./github-cli.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import {
  flushCommandActionEvents,
  recordCommandLifecycleFailure,
  recordCommandRequeue,
  runCommandLifecycleMutation,
  type CommandLifecycleInput,
} from "./command-action-ledger.js";
import {
  boundedNextRequeueDepth,
  deterministicRequeueDispatchKey,
  normalizedRequeueSourceJobPath,
} from "./requeue-job-key.js";

const DEFAULT_REPO = currentProjectRepo();
const DEFAULT_WORKFLOW = REPAIR_CLUSTER_WORKFLOW;
const DEFAULT_RUNNER = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const DEFAULT_EXECUTION_RUNNER =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const runner = String(args.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ?? args.execution_runner ?? DEFAULT_EXECUTION_RUNNER,
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute || args.live);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const capturedAllowExecute = capturedGateArg(
  args["allow-execute"],
  "allow-execute",
  openExecuteWindow,
);
const capturedAllowFixPr = capturedGateArg(args["allow-fix-pr"], "allow-fix-pr", openExecuteWindow);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const requestedRunId = args["run-id"] ?? (looksLikeRunId(args._[0]) ? args._[0] : null);
const sourceRunId = String(
  args["source-run-id"] ?? requestedRunId ?? process.env.GITHUB_RUN_ID ?? "",
).trim();
const requeueDepth = nonNegativeIntegerArg(args["requeue-depth"], "requeue-depth", 0);
const maxRequeueDepth = nonNegativeIntegerArg(args["max-requeue-depth"], "max-requeue-depth", 1);

const resolved = requestedRunId
  ? resolveFromRunId(String(requestedRunId))
  : { source_job: args._[0], mode: requestedMode };

if (!resolved.source_job) {
  console.error(
    `usage: node scripts/requeue-job.ts <job.md|run-id> [--mode plan|execute|autonomous] [--execute] [--open-execute-window --allow-execute 0|1 --allow-fix-pr 0|1] [--source-run-id id] [--source-job-path path] [--requeue-depth n] [--max-requeue-depth n] [--runner label] [--execution-runner label] [--model model] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
  );
  process.exit(2);
}

const job = parseJob(resolved.source_job);
const sourceJobPath = normalizedRequeueSourceJobPath(args["source-job-path"], job.relativePath);
const authorizationSha256 = createHash("sha256").update(job.raw).digest("hex");
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(`invalid job: ${job.relativePath}`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = requestedMode ?? resolved.mode ?? job.frontmatter.mode;
if (!["plan", "execute", "autonomous"].includes(mode)) {
  throw new Error(`unsupported mode: ${mode}`);
}

const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  source_run_id: sourceRunId || null,
  source_job: sourceJobPath,
  source_authorization_sha256: authorizationSha256,
  requeue_depth: requeueDepth,
  max_requeue_depth: maxRequeueDepth,
  mode,
  runner,
  execution_runner: executionRunner,
  model,
  max_live_workers: maxLiveWorkers,
  captured_allow_execute: capturedAllowExecute,
  captured_allow_fix_pr: capturedAllowFixPr,
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const gateRestores: RepositoryVariableSnapshot[] = [];
const headSha = currentHeadSha();
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const nextRequeueDepth = boundedNextRequeueDepth(requeueDepth, maxRequeueDepth);
const dispatchKey = deterministicRequeueDispatchKey({
  repo,
  workflow,
  sourceRunId: sourceRunId || null,
  sourceJobPath,
  authorizationSha256,
  depth: nextRequeueDepth,
});
const requeueLifecycle: CommandLifecycleInput = {
  repository: repo,
  operationKey: `repair-requeue:${repo}:${sourceJobPath}:${authorizationSha256}:depth:${nextRequeueDepth}`,
  sourceRevision: authorizationSha256,
  attemptId: dispatchKey,
};
let commandError: unknown = null;

try {
  if (openExecuteWindow && ["execute", "autonomous"].includes(mode)) {
    setGateTemporarily("CLAWSWEEPER_ALLOW_EXECUTE", capturedAllowExecute!, requeueLifecycle);
    setGateTemporarily("CLAWSWEEPER_ALLOW_FIX_PR", capturedAllowFixPr!, requeueLifecycle);
  }

  assertGateOpenIfNeeded(mode);
  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers });
  dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle);
  recordCommandRequeue(requeueLifecycle, {
    dispatchKey,
    sourceJobPath,
    sourceJobSha256: authorizationSha256,
    depth: nextRequeueDepth,
  });
  const observedRuns = waitForStartedRuns({ headSha, since: dispatchStartedAt, expectedCount: 1 });

  summary.status = "dispatched";
  summary.dispatch_key = dispatchKey;
  summary.observed_runs = observedRuns.map((run: JsonValue) => ({
    run_id: String(run.databaseId),
    status: run.status,
    conclusion: run.conclusion ?? null,
    created_at: run.createdAt,
    url: run.url,
  }));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  commandError = error;
} finally {
  for (const gate of gateRestores.reverse()) {
    try {
      restoreGate(gate, requeueLifecycle);
    } catch (error) {
      if (!commandError) {
        commandError = error;
      } else {
        console.error(
          `failed to restore ${gate.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
if (commandError) {
  recordCommandLifecycleFailure(requeueLifecycle, {
    component: "repair_requeue",
    error: commandError,
  });
}
try {
  await flushCommandActionEvents();
} catch (error) {
  if (commandError) {
    console.error(
      `[action-ledger] failed to finalize repair requeue receipts: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } else {
    commandError = error;
  }
}
if (commandError) throw commandError;

function resolveFromRunId(runId: string) {
  const fromLedger = readPublishedRunRecord(runId);
  if (fromLedger?.source_job) {
    return { source_job: fromLedger.source_job, mode: fromLedger.mode };
  }

  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-repair-requeue-${runId}-`),
  );
  const downloaded = spawnSync(
    "gh",
    ["run", "download", runId, "--repo", repo, "--dir", artifactDir],
    { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
  );
  if (downloaded.status !== 0) {
    throw new Error(`could not resolve run ${runId}: ${downloaded.stderr || downloaded.stdout}`);
  }
  const planPath = findFirstFile(artifactDir, "cluster-plan.json");
  const resultPath = findFirstFile(artifactDir, "result.json");
  if (!planPath) throw new Error(`run ${runId} artifact did not include cluster-plan.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const result = resultPath ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : null;
  return { source_job: plan.source_job, mode: result?.mode ?? plan.mode };
}

function readPublishedRunRecord(runId: string) {
  const file = path.join(repoRoot(), "results", "runs", `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findFirstFile(root: string, basename: string) {
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const candidate = path.join(root, String(entry));
    if (path.basename(candidate) === basename && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function dispatchJob(
  jobPath: string,
  mode: string,
  dispatchKey: string,
  lifecycle: CommandLifecycleInput,
) {
  const result = runCommandLifecycleMutation(lifecycle, {
    kind: "requeue_dispatch",
    identity: {
      repository: repo,
      workflow,
      sourceJobPath,
      sourceJobSha256: authorizationSha256,
      depth: nextRequeueDepth,
      dispatchKey,
    },
    component: "repair_requeue",
    operation: () =>
      spawnSync(
        "gh",
        [
          "workflow",
          "run",
          workflow,
          "--repo",
          repo,
          "-f",
          `job=${jobPath}`,
          "-f",
          `dispatch_key=${dispatchKey}`,
          "-f",
          `mode=${mode}`,
          "-f",
          `runner=${runner}`,
          "-f",
          `execution_runner=${executionRunner}`,
          "-f",
          `model=${model}`,
          "-f",
          "requeue=true",
          "-f",
          `requeue_depth=${nextRequeueDepth}`,
        ],
        { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
      ),
    outcome: (dispatch) => (dispatch.status === 0 && !dispatch.error ? "accepted" : "unknown"),
  });
  if (result.status !== 0) {
    throw new Error(`failed to dispatch ${jobPath}: ${result.stderr || result.stdout}`);
  }
}

function waitForStartedRuns({ expectedCount, headSha, since }: LooseRecord) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let latest: JsonValue[] = [];
  while (Date.now() < deadline) {
    latest = listClusterRuns()
      .filter((run: JsonValue) => run.headSha === headSha)
      .filter((run: JsonValue) => Date.parse(run.createdAt) >= Date.parse(since))
      .sort(
        (left: JsonValue, right: JsonValue) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
    const selected = latest.slice(-expectedCount);
    if (
      selected.length >= expectedCount &&
      selected.every((run: JsonValue) => gateCaptureJobStarted(run.databaseId))
    ) {
      return selected;
    }
    sleepMs(5_000);
  }
  const observedRunIds = latest
    .slice(-expectedCount)
    .map((run: JsonValue) => String(run.databaseId ?? ""))
    .filter(Boolean);
  throw new Error(
    `timed out waiting for ${expectedCount} requeued run(s) to capture execution gates${
      observedRunIds.length > 0 ? `: ${observedRunIds.join(", ")}` : ""
    }`,
  );
}

function gateCaptureJobStarted(runId: JsonValue) {
  const run = ghJson<LooseRecord>(["run", "view", String(runId), "--repo", repo, "--json", "jobs"]);
  const job = (run.jobs ?? []).find(
    (candidate: JsonValue) => candidate.name === "Plan and review cluster",
  );
  if (!job) return false;
  const status = String(job.status ?? "").toLowerCase();
  const conclusion = String(job.conclusion ?? "").toLowerCase();
  return status === "in_progress" || (status === "completed" && conclusion !== "skipped");
}

function assertGateOpenIfNeeded(mode: string) {
  if (!["execute", "autonomous"].includes(mode)) return;
  if (readGateSnapshot("CLAWSWEEPER_ALLOW_EXECUTE").value !== "1") {
    throw new Error(
      "refusing write-mode requeue: CLAWSWEEPER_ALLOW_EXECUTE is not 1; use --open-execute-window",
    );
  }
}

function listClusterRuns() {
  const workflowName = workflowDisplayName(workflow);
  return ghJson<LooseRecord[]>([
    "run",
    "list",
    "--repo",
    repo,
    "--limit",
    "200",
    "--json",
    "databaseId,workflowName,headSha,status,conclusion,createdAt,url",
  ]).filter((run: LooseRecord) => run.workflowName === workflowName);
}

function workflowDisplayName(workflowNameOrFile: string): string {
  if (workflowNameOrFile === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflowNameOrFile;
}

type RepositoryVariableSnapshot = {
  name: string;
  exists: boolean;
  value: string;
};

function readGateSnapshot(name: string): RepositoryVariableSnapshot {
  const variables = ghJson<LooseRecord[]>([
    "variable",
    "list",
    "--repo",
    repo,
    "--json",
    "name,value",
  ]);
  const variable = variables.find((entry) => entry.name === name);
  return {
    name,
    exists: Boolean(variable),
    value: variable ? String(variable.value ?? "") : "",
  };
}

function setGateTemporarily(
  name: string,
  value: "0" | "1",
  lifecycle: CommandLifecycleInput,
) {
  const previous = readGateSnapshot(name);
  if (previous.exists && previous.value === value) return;
  gateRestores.push(previous);
  setGate(name, value, lifecycle);
}

function restoreGate(snapshot: RepositoryVariableSnapshot, lifecycle: CommandLifecycleInput) {
  if (snapshot.exists) {
    setGate(snapshot.name, snapshot.value, lifecycle);
    return;
  }
  runCommandLifecycleMutation(lifecycle, {
    kind: "repository_variable_delete",
    identity: { repository: repo, name: snapshot.name },
    component: "repair_requeue",
    operation: () => ghText(["variable", "delete", snapshot.name, "--repo", repo]),
  });
  console.log(`${snapshot.name}=<deleted>`);
}

function setGate(name: string, value: string, lifecycle: CommandLifecycleInput) {
  runCommandLifecycleMutation(lifecycle, {
    kind: "repository_variable_update",
    identity: { repository: repo, name, value },
    component: "repair_requeue",
    operation: () => ghText(["variable", "set", name, "--repo", repo, "--body", value]),
  });
  console.log(`${name}=${value}`);
}

function capturedGateArg(value: JsonValue, name: string, required: boolean): "0" | "1" | null {
  if (value === undefined || value === null || value === false) {
    if (required) throw new Error(`--${name} is required with --open-execute-window`);
    return null;
  }
  const normalized = String(value);
  if (normalized !== "0" && normalized !== "1") {
    throw new Error(`--${name} must be 0 or 1`);
  }
  return normalized;
}

function currentHeadSha() {
  return execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function looksLikeRunId(value: JsonValue) {
  return /^[0-9]{6,}$/.test(String(value ?? ""));
}

function nonNegativeIntegerArg(value: JsonValue, name: string, fallback: number): number {
  if (value === undefined || value === null || value === false || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}
