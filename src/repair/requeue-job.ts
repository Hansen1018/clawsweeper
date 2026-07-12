#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseJob,
  readMaxLiveWorkers,
  repairRunNameForJob,
  repoRoot,
  validateJob,
  waitForLiveWorkerCapacity,
  workflowRunsForExactDispatch,
} from "./lib.js";
import { ghJson } from "./github-cli.js";
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
const sourceRunId = optionalSourceRunIdArg(
  args["source-run-id"] ?? requestedRunId ?? process.env.GITHUB_RUN_ID,
);
const requeueDepth = nonNegativeIntegerArg(args["requeue-depth"], "requeue-depth", 0);
const maxRequeueDepth = nonNegativeIntegerArg(args["max-requeue-depth"], "max-requeue-depth", 1);
const requeueAuthority = optionalRequeueAuthorityArg(args["requeue-authority"]);
const deadlineAtMs = deadlineTimestampArg(
  args["deadline-at-ms"],
  Date.now() + (waitForCapacity ? 35 * 60 * 1000 : 5 * 60 * 1000),
);

const resolved = requestedRunId
  ? resolveFromRunId(String(requestedRunId))
  : { source_job: args._[0], mode: requestedMode };

if (!resolved.source_job) {
  console.error(
    `usage: node scripts/requeue-job.ts <job.md|run-id> [--source-job-path jobs/.../job.md] [--source-run-id run-id] [--mode plan|execute|autonomous] [--execute --requeue-authority clawsweeper-app|maintainer] [--open-execute-window --allow-execute 0|1 --allow-fix-pr 0|1] [--requeue-depth N] [--max-requeue-depth N] [--deadline-at-ms N] [--runner label] [--execution-runner label] [--model model] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
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
  source_run_id: sourceRunId,
  source_job: sourceJobPath,
  source_authorization_sha256: authorizationSha256,
  local_job: job.relativePath,
  requeue_depth: requeueDepth,
  max_requeue_depth: maxRequeueDepth,
  mode,
  runner,
  execution_runner: executionRunner,
  model,
  max_live_workers: maxLiveWorkers,
  captured_allow_execute: capturedAllowExecute,
  captured_allow_fix_pr: capturedAllowFixPr,
  requeue_authority: requeueAuthority,
  deadline_at_ms: deadlineAtMs,
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (maxRequeueDepth !== null && requeueDepth >= maxRequeueDepth) {
  throw new Error(
    `requeue depth ${requeueDepth} reached the maximum ${maxRequeueDepth}; refusing another dispatch`,
  );
}
if (!requeueAuthority) {
  throw new Error("live requeue dispatch requires --requeue-authority clawsweeper-app|maintainer");
}

summary.live_worker_capacity_before_dispatch = waitForCapacity
  ? waitForLiveWorkerCapacity({
      repo,
      workflow,
      requested: 1,
      maxLiveWorkers,
      timeoutMs: remainingDeadlineMs(deadlineAtMs, "live worker capacity"),
    })
  : assertLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers });

const forwardedGates = openExecuteWindow
  ? {
      allowExecute: capturedAllowExecute!,
      allowFixPr: capturedAllowFixPr!,
    }
  : {
      allowExecute: normalizedGateValue("CLAWSWEEPER_ALLOW_EXECUTE"),
      allowFixPr: normalizedGateValue("CLAWSWEEPER_ALLOW_FIX_PR"),
    };
assertGateOpenIfNeeded(mode, forwardedGates.allowExecute);
summary.forwarded_allow_execute = forwardedGates.allowExecute;
summary.forwarded_allow_fix_pr = forwardedGates.allowFixPr;

remainingDeadlineMs(deadlineAtMs, "requeue dispatch");
const nextRequeueDepth = boundedNextRequeueDepth(requeueDepth, maxRequeueDepth);
const dispatchKey = deterministicRequeueDispatchKey({
  repo,
  workflow,
  sourceRunId,
  sourceJobPath,
  authorizationSha256,
  depth: nextRequeueDepth,
});
const expectedTitle = repairRunNameForJob(sourceJobPath, "automerge repair ", dispatchKey);
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const requeueLifecycle: CommandLifecycleInput = {
  repository: repo,
  operationKey: `repair-requeue:${repo}:${sourceJobPath}:${authorizationSha256}:depth:${nextRequeueDepth}`,
  sourceRevision: authorizationSha256,
  attemptId: dispatchKey,
};
let commandError: unknown = null;

try {
  dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle, {
    schema_version: 2,
    authority: requeueAuthority,
    depth: nextRequeueDepth,
    allow_execute: forwardedGates.allowExecute,
    allow_fix_pr: forwardedGates.allowFixPr,
    dispatch_key: dispatchKey,
    job_path: sourceJobPath,
    job_sha256: authorizationSha256,
  });
  recordCommandRequeue(requeueLifecycle, {
    dispatchKey,
    sourceJobPath,
    sourceJobSha256: authorizationSha256,
    depth: nextRequeueDepth,
  });
  const observedRuns = waitForStartedRuns({
    expectedTitle,
    since: dispatchStartedAt,
    deadlineAtMs,
  });

  summary.status = "dispatched";
  summary.dispatch_key = dispatchKey;
  summary.expected_run_title = expectedTitle;
  summary.observed_runs = observedRuns.map((run: JsonValue) => ({
    run_id: String(run.databaseId),
    display_title: run.displayTitle,
    status: run.status,
    conclusion: run.conclusion ?? null,
    created_at: run.createdAt,
    url: run.url,
  }));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  commandError = error;
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
  requeueContext: {
    schema_version: 2;
    authority: "clawsweeper-app" | "maintainer";
    depth: number;
    allow_execute: "0" | "1";
    allow_fix_pr: "0" | "1";
    dispatch_key: string;
    job_path: string;
    job_sha256: string;
  },
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
      requeueContext,
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
          `dispatch_key=${requeueContext.dispatch_key}`,
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
          "-f",
          `requeue_authority=${requeueContext.authority}`,
          "-f",
          `requeue_context=${Buffer.from(JSON.stringify(requeueContext)).toString("base64url")}`,
        ],
        { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
      ),
    outcome: (dispatch) => (dispatch.status === 0 && !dispatch.error ? "accepted" : "unknown"),
  });
  if (result.status !== 0) {
    throw new Error(`failed to dispatch ${jobPath}: ${result.stderr || result.stdout}`);
  }
}

function waitForStartedRuns({
  expectedTitle,
  since,
  deadlineAtMs,
}: {
  expectedTitle: string;
  since: string;
  deadlineAtMs: number;
}) {
  let latest: JsonValue[] = [];
  while (Date.now() < deadlineAtMs) {
    latest = workflowRunsForExactDispatch({
      runs: listClusterRuns(),
      expectedTitle,
      since,
    });
    if (latest.length > 0) return latest.slice(-1);
    sleepMs(Math.min(5_000, remainingDeadlineMs(deadlineAtMs, "requeue visibility")));
  }
  const observedRunIds = latest
    .slice(-1)
    .map((run: JsonValue) => String(run.databaseId ?? ""))
    .filter(Boolean);
  throw new Error(
    `timed out waiting for requeued run ${expectedTitle} to become visible${
      observedRunIds.length > 0 ? `: ${observedRunIds.join(", ")}` : ""
    }`,
  );
}

function assertGateOpenIfNeeded(mode: string, allowExecute: "0" | "1") {
  if (!["execute", "autonomous"].includes(mode)) return;
  if (allowExecute !== "1") {
    throw new Error("refusing write-mode requeue: captured CLAWSWEEPER_ALLOW_EXECUTE is not 1");
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
    "databaseId,workflowName,displayTitle,status,conclusion,createdAt,url",
  ]).filter((run: LooseRecord) => run.workflowName === workflowName);
}

function workflowDisplayName(workflowNameOrFile: string): string {
  if (workflowNameOrFile === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflowNameOrFile;
}

function normalizedGateValue(name: string): "0" | "1" {
  const variables = ghJson<LooseRecord[]>([
    "variable",
    "list",
    "--repo",
    repo,
    "--json",
    "name,value",
  ]);
  const variable = variables.find((entry) => entry.name === name);
  return String(variable?.value ?? "") === "1" ? "1" : "0";
}

function optionalRequeueAuthorityArg(value: JsonValue): "clawsweeper-app" | "maintainer" | null {
  if (value === undefined || value === null || value === false || value === "") return null;
  if (value === "clawsweeper-app" || value === "maintainer") return value;
  throw new Error("requeue-authority must be clawsweeper-app or maintainer");
}

function optionalSourceRunIdArg(value: JsonValue): string | null {
  if (value === undefined || value === null || value === false || value === "") return null;
  const runId = String(value);
  if (!looksLikeRunId(runId)) throw new Error("source-run-id must be a positive integer");
  return runId;
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

function nonNegativeIntegerArg(value: JsonValue, name: string, fallback: number): number {
  if (value === undefined || value === null || value === false || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function deadlineTimestampArg(value: JsonValue, fallback: number) {
  const deadline = nonNegativeIntegerArg(value, "deadline-at-ms", fallback);
  if (deadline <= Date.now()) {
    throw new Error("--deadline-at-ms must be in the future");
  }
  return deadline;
}

function remainingDeadlineMs(deadline: number, label: string) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} deadline expired`);
  return remaining;
}

function looksLikeRunId(value: JsonValue) {
  return /^[0-9]{6,}$/.test(String(value ?? ""));
}
