#!/usr/bin/env node
import type { JsonObject, JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseRepairRunTitle,
  readMaxLiveWorkers,
  repoRoot,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { ghErrorText, ghJson, ghText } from "./github-cli.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { shouldSelfHealRunRecord } from "./self-heal-policy.js";
import {
  immutableJobDispatchArgs,
  immutableJobIdentityKey,
  isMissingImmutableJobError,
  resolveStateJobIdentity,
} from "./immutable-job-handoff.js";
import { activeRepairJobGenerations as listActiveRepairJobGenerations } from "./live-worker-capacity.js";
import { runRepairMutation, type RepairLifecycleInput } from "./repair-action-ledger.js";
import {
  restoreGateSequence,
  restoreGateWithFallback,
  type GateCleanupFailure,
  type GateRestoreResult,
} from "./self-heal-gate-restore.js";

const DEFAULT_REPO = currentProjectRepo();
const DEFAULT_WORKFLOW = REPAIR_CLUSTER_WORKFLOW;
const DEFAULT_RUNNER = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const DEFAULT_EXECUTION_RUNNER =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const QUEUED_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const SOURCE_JOB_PATH = /^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/;
const STATE_REVISION = /^[a-f0-9]{40}$/;
const JOB_SHA256 = /^[a-f0-9]{64}$/;
const REPAIR_MODES = new Set(["plan", "execute", "autonomous"]);
const WORKFLOW_INPUTS_BASENAME = "workflow-inputs.json";
const STATE_REVISION_FETCH_TIMEOUT_MS = 60_000;
const WORKFLOW_RUN_PAGE_SIZE = 100;
const WORKFLOW_RUN_PAGE_LIMIT = 100;
const preparedStateRevisions = new Map<string, string | null>();

type RecoveredRunCohort = {
  source_job: string;
  mode: string;
  state_revision: string;
  job_sha256: string;
  producer_attempt: number;
};

type RunGeneration = {
  latest: JsonObject;
  records: JsonObject[];
};

type RunRecordProvenance = {
  effectiveMode: string;
  immutableJobKey: string;
  jobSha256: string;
  stateRevision: string;
};

type GateState = {
  exists: boolean;
  value: string;
};

type GateRestore = {
  name: string;
  previous: GateState;
};

const runRecordProvenanceCache = new WeakMap<JsonObject, RunRecordProvenance>();

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const runner = String(args.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ?? args.execution_runner ?? DEFAULT_EXECUTION_RUNNER,
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxJobs = Number(args["max-jobs"] ?? args.limit ?? 5);
const maxAgeHours = Number(
  args["max-age-hours"] ??
    args.max_age_hours ??
    process.env.CLAWSWEEPER_SELF_HEAL_MAX_AGE_HOURS ??
    6,
);
const maxAttemptsPerJob = Number(process.env.CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB ?? 3);
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const allowRepeat = Boolean(args["allow-repeat"]);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const runRecordsDir = path.resolve(
  String(args["runs-dir"] ?? args.runs_dir ?? path.join(repoRoot(), "results", "runs")),
);
const skippedCandidates: LooseRecord[] = [];

if (!Number.isInteger(maxJobs) || maxJobs < 1) {
  throw new Error("--max-jobs must be a positive integer");
}
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  throw new Error("--max-age-hours must be a positive number");
}
if (!Number.isInteger(maxAttemptsPerJob) || maxAttemptsPerJob < 1) {
  throw new Error("CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB must be a positive integer");
}
if (requestedMode !== null && !REPAIR_MODES.has(requestedMode)) {
  throw new Error(`unsupported mode: ${requestedMode}`);
}

const candidates = selectCandidates().slice(0, maxJobs);
const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  runner,
  execution_runner: executionRunner,
  model,
  max_jobs: maxJobs,
  max_age_hours: maxAgeHours,
  max_attempts_per_job: maxAttemptsPerJob,
  max_live_workers: maxLiveWorkers,
  candidates: candidates.map((candidate: JsonValue) => summarizeCandidate(candidate)),
  skipped_candidates: skippedCandidates,
};

if (candidates.length === 0) {
  summary.status = "no_candidates";
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const gateRestores: GateRestore[] = [];
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const headSha = currentHeadSha();
const ledger = readSelfHealLedger();
const batchId = `self-heal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const attempts: LooseRecord[] = candidates.map((candidate: JsonValue) => ({
  batch_id: batchId,
  source_run_id: candidate.run_id,
  cluster_id: candidate.cluster_id,
  source_job: candidate.source_job,
  source_state_revision: candidate.source_state_revision,
  source_job_sha256: candidate.source_job_sha256,
  immutable_job_key: candidate.immutable_job_key,
  mode: candidate.mode,
  runner,
  execution_runner: executionRunner,
  model,
  workflow,
  repo,
  dispatched_at: new Date().toISOString(),
  dispatched_run_ids: [],
  status: "pending",
}));

let primaryFailure: unknown = null;
let cleanupRestoreFailures: GateCleanupFailure[] = [];
try {
  if (openExecuteWindow) {
    openGate("CLAWSWEEPER_ALLOW_EXECUTE");
    openGate("CLAWSWEEPER_ALLOW_FIX_PR");
  } else {
    assertExecuteGateOpenIfNeeded(candidates);
  }

  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: candidates.length, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: candidates.length, maxLiveWorkers });

  for (let i = 0; i < candidates.length; i += 1) {
    dispatchCandidate(candidates[i]);
    attempts[i].status = "dispatched";
  }

  const observedRuns = openExecuteWindow
    ? waitForStartedRuns({
        expectedCount: candidates.length,
        headSha,
        since: dispatchStartedAt,
      })
    : [];
  const observedRunIds = observedRuns.map((run: JsonValue) => String(run.databaseId));
  for (const attempt of attempts) {
    attempt.dispatched_run_ids = observedRunIds;
    attempt.observed_runs = observedRuns.map((run: JsonValue) => ({
      run_id: String(run.databaseId),
      status: run.status,
      conclusion: run.conclusion ?? null,
      created_at: run.createdAt,
      url: run.url,
    }));
  }

  appendAttempts(ledger, attempts);
  writeSelfHealLedger(ledger);

  summary.status = "dispatched";
  summary.batch_id = batchId;
  summary.observed_runs = attempts[0]?.observed_runs ?? [];
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  primaryFailure = error;
} finally {
  const cleanupFailures = restoreOpenedGates();
  cleanupRestoreFailures = cleanupFailures.restoreFailures;
  for (const failure of cleanupFailures.receiptFailures) {
    console.error(
      `self-heal: restored ${failure.name} but failed to record its cleanup receipt: ${errorText(failure.error)}`,
    );
  }
  for (const failure of cleanupFailures.restoreFailures) {
    console.error(`self-heal: failed to restore ${failure.name}: ${errorText(failure.error)}`);
  }
}
if (primaryFailure !== null) throw primaryFailure;
if (cleanupRestoreFailures.length > 0) {
  throw new AggregateError(
    cleanupRestoreFailures.map((failure) => failure.error),
    "self-heal failed to restore one or more execution gates",
  );
}

function selectCandidates() {
  const records = readRunRecords();
  const attempts = readSelfHealLedger().attempts ?? [];
  const activeJobGenerations = execute ? activeRepairJobGenerations() : new Map<string, string[]>();
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const attemptedIdentities = new Set<string>();
  const attemptCountsByIdentity = new Map<string, number>();
  const legacyAttemptedRunsByJob = new Set<string>();
  const legacyAttemptCountsByJob = new Map<string, number>();
  for (const attempt of attempts) {
    const immutableKey = attemptImmutableJobKey(attempt);
    const sourceRunId = String(attempt.source_run_id ?? "");
    if (immutableKey) {
      if (sourceRunId) attemptedIdentities.add(`${sourceRunId}:${immutableKey}`);
      attemptCountsByIdentity.set(
        immutableKey,
        (attemptCountsByIdentity.get(immutableKey) ?? 0) + 1,
      );
      continue;
    }
    const legacyJobPath = legacyAttemptJobPath(attempt);
    if (!legacyJobPath) continue;
    if (sourceRunId) legacyAttemptedRunsByJob.add(`${sourceRunId}:${legacyJobPath}`);
    legacyAttemptCountsByJob.set(
      legacyJobPath,
      (legacyAttemptCountsByJob.get(legacyJobPath) ?? 0) + 1,
    );
  }
  const generationsByJob = new Map<string, Map<string, RunGeneration>>();
  const unresolvedProvenanceByJob = new Map<string, { record: JsonObject; skip: LooseRecord }>();

  for (const record of records) {
    const sourceJob = record.source_job;
    if (typeof sourceJob !== "string" || !sourceJob) {
      skippedCandidates.push({ reason: "missing_source_job", run_id: record.run_id ?? null });
      continue;
    }
    let generations = generationsByJob.get(sourceJob);
    if (!generations) {
      generations = new Map();
      generationsByJob.set(sourceJob, generations);
    }
    let generationKey: string;
    try {
      generationKey = runGenerationKey(record, sourceJob);
    } catch (error) {
      const skip = {
        reason: "immutable_provenance_unavailable",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
        detail: error instanceof Error ? error.message : String(error),
      };
      skippedCandidates.push(skip);
      const unresolved = unresolvedProvenanceByJob.get(sourceJob);
      if (!unresolved || isNewerRunRecord(record, unresolved.record)) {
        unresolvedProvenanceByJob.set(sourceJob, { record, skip });
      }
      continue;
    }
    const generation = generations.get(generationKey);
    if (!generation) {
      generations.set(generationKey, { latest: record, records: [record] });
      continue;
    }
    generation.records.push(record);
    if (isNewerRunRecord(record, generation.latest)) generation.latest = record;
  }

  const latestCandidates: JsonObject[] = [];
  for (const [sourceJob, generations] of generationsByJob) {
    let latestGeneration: RunGeneration | null = null;
    for (const generation of generations.values()) {
      if (!latestGeneration || isNewerRunRecord(generation.latest, latestGeneration.latest)) {
        latestGeneration = generation;
      }
    }
    const provenanceBarrier = unresolvedProvenanceByJob.get(sourceJob);
    if (
      latestGeneration &&
      provenanceBarrier &&
      runSortKey(provenanceBarrier.record) > runSortKey(latestGeneration.latest)
    ) {
      provenanceBarrier.skip.blocks_older_generations = true;
      provenanceBarrier.skip.blocked_run_id = latestGeneration.latest.run_id ?? null;
      continue;
    }
    const candidate = latestGeneration ? selfHealCandidate(latestGeneration) : null;
    if (candidate) latestCandidates.push(candidate);
  }

  return latestCandidates
    .filter((record: JsonValue) => {
      const timestamp = recordTimestampMs(record);
      if (timestamp >= cutoffMs) return true;
      skippedCandidates.push({
        reason: "older_than_max_age",
        run_id: record.run_id ?? null,
        source_job: record.source_job ?? null,
        published_at: record.published_at ?? null,
        workflow_created_at: record.workflow_created_at ?? null,
        workflow_updated_at: record.workflow_updated_at ?? null,
      });
      return false;
    })
    .map((record: JsonValue) => {
      const sourceJob = String(record.source_job ?? "");
      try {
        const { immutableJob, effectiveMode } = resolveRunRecordJob(record, sourceJob);
        return {
          ...record,
          source_job: immutableJob.jobPath,
          source_state_revision: immutableJob.stateRevision,
          source_job_sha256: immutableJob.jobSha256,
          immutable_job_key: immutableJob.identityKey,
          mode: requestedMode ?? effectiveMode,
        };
      } catch (error) {
        skippedCandidates.push({
          reason: isMissingImmutableJobError(error)
            ? "missing_job_file"
            : "immutable_provenance_unavailable",
          run_id: record.run_id ?? null,
          source_job: sourceJob,
          detail: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })
    .filter((record: JsonValue) => record !== null)
    .filter((record: JsonValue) => {
      const activeRunIds = [
        ...(activeJobGenerations.get(
          activeJobGenerationKey(record.source_job, record.source_job_sha256),
        ) ?? []),
        ...(activeJobGenerations.get(activeLegacyJobKey(record.source_job)) ?? []),
      ].filter((runId, index, all) => all.indexOf(runId) === index);
      if (activeRunIds.length === 0) return true;
      skippedCandidates.push({
        reason: "active_repair_run",
        run_id: record.run_id ?? null,
        source_job: record.source_job,
        source_state_revision: record.source_state_revision,
        source_job_sha256: record.source_job_sha256,
        active_run_ids: activeRunIds,
      });
      return false;
    })
    .filter((record: JsonValue) => {
      if (allowRepeat) return true;
      const runId = String(record.run_id ?? "");
      const immutableKey = String(record.immutable_job_key ?? "");
      const sourceJob = String(record.source_job ?? "");
      if (
        runId &&
        (attemptedIdentities.has(`${runId}:${immutableKey}`) ||
          legacyAttemptedRunsByJob.has(`${runId}:${sourceJob}`))
      ) {
        return false;
      }
      const attemptsForJob =
        (attemptCountsByIdentity.get(immutableKey) ?? 0) +
        (legacyAttemptCountsByJob.get(sourceJob) ?? 0);
      if (attemptsForJob < maxAttemptsPerJob) return true;
      skippedCandidates.push({
        reason: "retry_limit_reached",
        run_id: runId || null,
        source_job: record.source_job,
        source_state_revision: record.source_state_revision,
        source_job_sha256: record.source_job_sha256,
        attempts: attemptsForJob,
      });
      return false;
    })
    .sort((left: JsonValue, right: JsonValue) => runSortKey(right) - runSortKey(left));
}

function runGenerationKey(record: JsonObject, sourceJob: string): string {
  const provenance = resolveRunRecordProvenance(record, sourceJob);
  return JSON.stringify([provenance.immutableJobKey, provenance.effectiveMode]);
}

function isNewerRunRecord(candidate: JsonObject, current: JsonObject): boolean {
  const candidateSortKey = runSortKey(candidate);
  const currentSortKey = runSortKey(current);
  if (candidateSortKey !== currentSortKey) return candidateSortKey > currentSortKey;
  return candidate.live_run_record === true && current.live_run_record !== true;
}

function selfHealCandidate(generation: RunGeneration): JsonObject | null {
  let candidate: JsonObject | null = null;
  const records = generation.records;
  const retryable = records.filter((record: JsonValue) => shouldSelfHealRunRecord(record));
  for (const record of retryable) {
    if (!candidate || isNewerRunRecord(record, candidate)) candidate = record;
  }
  if (!candidate) return null;
  if (generation.records.some((record) => successfulRepairExecution(record))) return null;
  return candidate;
}

function successfulRepairExecution(record: JsonObject): boolean {
  if (
    shouldSelfHealRunRecord(record) ||
    String(record.workflow_conclusion ?? "").toLowerCase() !== "success"
  ) {
    return false;
  }
  if (record.live_run_record !== true || record.published_run_record === true) return true;

  const runId = String(record.run_id ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(runId)) return true;
  try {
    const response = ghJson<LooseRecord>([
      "api",
      "--method",
      "GET",
      `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    ]);
    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    return jobs.some(
      (job: LooseRecord) =>
        job.name === "Plan and review cluster" &&
        String(job.conclusion ?? "").toLowerCase() === "success",
    );
  } catch (error) {
    console.warn(
      `self-heal: cannot verify whether successful run ${runId} executed repair work: ${ghErrorText(error)}`,
    );
    return true;
  }
}

function activeRepairJobGenerations() {
  try {
    return listActiveRepairJobGenerations({ repo, workflow });
  } catch (error) {
    throw new Error(
      `self-heal: cannot verify active repair generations; refusing dispatch: ${ghErrorText(error)}`,
    );
  }
}

function dispatchCandidate(candidate: LooseRecord) {
  const commandArgs = [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "-f",
    `job=${candidate.source_job}`,
    ...immutableJobDispatchArgs({
      stateRevision: candidate.source_state_revision,
      jobSha256: candidate.source_job_sha256,
    }),
    "-f",
    `mode=${candidate.mode}`,
    "-f",
    `runner=${runner}`,
    "-f",
    `execution_runner=${executionRunner}`,
    "-f",
    `model=${model}`,
  ];
  runRepairMutation(selfHealDispatchLifecycle(candidate), {
    kind: "repair_dispatch",
    operationName: "failed_run_self_heal",
    component: "failed_run_self_heal",
    identity: {
      repository: repo,
      workflow,
      sourceRunId: candidate.run_id,
      jobPath: candidate.source_job,
      stateRevision: candidate.source_state_revision,
      jobSha256: candidate.source_job_sha256,
      mode: candidate.mode,
      runner,
      executionRunner,
      model,
    },
    operation: () => {
      const result = spawnSync("gh", commandArgs, {
        cwd: repoRoot(),
        encoding: "utf8",
        stdio: "pipe",
      });
      if (result.status !== 0) {
        throw new Error(
          `failed to dispatch ${candidate.source_job}: ${result.stderr || result.stdout}`,
        );
      }
      return result;
    },
  });
  console.log(`dispatched ${candidate.source_job} from failed run ${candidate.run_id}`);
}

function waitForStartedRuns({ expectedCount, headSha, since }: LooseRecord) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let latest: JsonValue[] = [];
  while (Date.now() < deadline) {
    latest = listClusterRuns()
      .filter((run: JsonValue) => run.headSha === headSha)
      .filter((run: JsonValue) => Date.parse(run.createdAt) >= Date.parse(since))
      .sort(
        (left: JsonValue, right: JsonValue) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
    if (
      latest.length >= expectedCount &&
      latest.every((run: JsonValue) => !QUEUED_STATUSES.has(run.status))
    ) {
      return latest;
    }
    sleepMs(10_000);
  }
  return latest;
}

function assertExecuteGateOpenIfNeeded(candidates: LooseRecord[]) {
  if (
    !candidates.some((candidate: JsonValue) => ["execute", "autonomous"].includes(candidate.mode))
  )
    return;
  const current = readExecuteGate();
  if (current !== "1") {
    throw new Error(
      "refusing write-mode self-heal: CLAWSWEEPER_ALLOW_EXECUTE is not 1; rerun with --open-execute-window or open the gate manually",
    );
  }
  const fixCurrent = readFixGate();
  if (fixCurrent !== "1") {
    throw new Error(
      "refusing write-mode self-heal: CLAWSWEEPER_ALLOW_FIX_PR is not 1; rerun with --open-execute-window or open both gates manually",
    );
  }
}

function readRunRecords() {
  const records = fs.existsSync(runRecordsDir)
    ? fs
        .readdirSync(runRecordsDir)
        .filter((name: string) => name.endsWith(".json"))
        .map((name: string) => JSON.parse(fs.readFileSync(path.join(runRecordsDir, name), "utf8")))
    : [];
  const publishedByRunId = new Map(
    records.map((record: LooseRecord) => [String(record.run_id ?? ""), record]),
  );
  const liveRecords = liveRunRecords(liveRunDiscoveryCutoffMs(records)).map(
    (record: LooseRecord) => {
      const published = publishedByRunId.get(String(record.run_id ?? ""));
      return {
        ...record,
        published_run_record: published !== undefined,
        ...(published?.post_flight_outcome === undefined
          ? {}
          : { post_flight_outcome: published.post_flight_outcome }),
        ...(published?.post_flight_detail === undefined
          ? {}
          : { post_flight_detail: published.post_flight_detail }),
      };
    },
  );
  return [...records, ...liveRecords];
}

function liveRunDiscoveryCutoffMs(records: LooseRecord[]): number {
  const maxAgeCutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let cutoffMs = maxAgeCutoffMs;
  for (const record of records) {
    if (recordTimestampMs(record) < maxAgeCutoffMs) continue;
    const createdAtMs = Date.parse(String(record.workflow_created_at ?? record.published_at ?? ""));
    if (!Number.isFinite(createdAtMs)) return 0;
    cutoffMs = Math.min(cutoffMs, createdAtMs);
  }
  return cutoffMs;
}

function resolveRunRecordJob(record: LooseRecord, sourceJob: string) {
  const provenance = resolveRunRecordProvenance(record, sourceJob);
  ensureHistoricalStateRevision(provenance.stateRevision);
  const immutableJob = resolveStateJobIdentity({
    jobPath: sourceJob,
    stateRevision: provenance.stateRevision,
    jobSha256: provenance.jobSha256,
  });
  return { immutableJob, effectiveMode: provenance.effectiveMode };
}

function resolveRunRecordProvenance(record: JsonObject, sourceJob: string): RunRecordProvenance {
  const cached = runRecordProvenanceCache.get(record);
  if (cached) return cached;

  let stateRevision = String(record.source_state_revision ?? "").trim();
  let jobSha256 = String(record.source_job_sha256 ?? "").trim();
  const recordMode = validatedRunRecordMode(record.mode);
  let recovered: RecoveredRunCohort | null = null;
  if (!STATE_REVISION.test(stateRevision) || !JOB_SHA256.test(jobSha256) || recordMode === null) {
    const runId = String(record.run_id ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(runId)) {
      throw new Error("run record is missing a valid workflow run id for artifact recovery");
    }
    recovered = recoverRunArtifactCohort(runId, sourceJob);
    if (stateRevision && stateRevision !== recovered.state_revision) {
      throw new Error("run record state revision conflicts with its artifact cohort");
    }
    if (jobSha256 && jobSha256 !== recovered.job_sha256) {
      throw new Error("run record job digest conflicts with its artifact cohort");
    }
    if (recordMode !== null && recordMode !== recovered.mode) {
      throw new Error("run record effective mode conflicts with its artifact cohort");
    }
    stateRevision = recovered.state_revision;
    jobSha256 = recovered.job_sha256;
  }
  const effectiveMode = recovered?.mode ?? recordMode;
  if (effectiveMode === null) {
    throw new Error("run record is missing validated effective repair mode");
  }
  const provenance = {
    effectiveMode,
    immutableJobKey: immutableJobIdentityKey({
      jobPath: sourceJob,
      stateRevision,
      jobSha256,
    }),
    jobSha256,
    stateRevision,
  };
  runRecordProvenanceCache.set(record, provenance);
  return provenance;
}

function validatedRunRecordMode(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("run record has invalid effective repair mode: non-string");
  }
  const mode = value.trim();
  if (!REPAIR_MODES.has(mode)) {
    throw new Error(`run record has invalid effective repair mode: ${mode || "empty"}`);
  }
  return mode;
}

function ensureHistoricalStateRevision(stateRevision: string): void {
  if (!STATE_REVISION.test(stateRevision)) {
    throw new Error("state revision is malformed");
  }
  const previous = preparedStateRevisions.get(stateRevision);
  if (previous !== undefined) {
    if (previous) throw new Error(previous);
    return;
  }

  const stateRoot = String(process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!stateRoot) {
    throw new Error("CLAWSWEEPER_STATE_DIR is required for immutable job handoff");
  }
  if (stateCommitExists(stateRoot, stateRevision)) {
    preparedStateRevisions.set(stateRevision, null);
    return;
  }

  const fetched = spawnSync(
    "git",
    [
      "-C",
      stateRoot,
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      stateRevision,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: STATE_REVISION_FETCH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  if (fetched.status !== 0 || fetched.error || !stateCommitExists(stateRoot, stateRevision)) {
    const detail = String(fetched.stderr || fetched.stdout || fetched.error?.message || "").trim();
    const message = detail
      ? `could not fetch historical clawsweeper-state commit ${stateRevision}: ${detail}`
      : `could not fetch historical clawsweeper-state commit ${stateRevision}`;
    preparedStateRevisions.set(stateRevision, message);
    throw new Error(message);
  }
  preparedStateRevisions.set(stateRevision, null);
}

function stateCommitExists(stateRoot: string, stateRevision: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", stateRoot, "cat-file", "-e", `${stateRevision}^{commit}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    },
  );
  return result.status === 0 && !result.error;
}

function recoverRunArtifactCohort(runId: string, sourceJob: string): RecoveredRunCohort {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-self-heal-${runId}-`));
  try {
    const downloaded = spawnSync(
      "gh",
      ["run", "download", runId, "--repo", repo, "--dir", artifactDir],
      { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
    );
    if (downloaded.status !== 0) {
      throw new Error(
        `could not recover immutable provenance for run ${runId}: ${
          downloaded.stderr || downloaded.stdout
        }`,
      );
    }
    return resolveDownloadedRunCohort(artifactDir, runId, sourceJob);
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

function resolveDownloadedRunCohort(
  root: string,
  runId: string,
  expectedSourceJob: string,
): RecoveredRunCohort {
  const candidatesByAttempt = new Map<number, RecoveredRunCohort[]>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const producerAttempt = repairArtifactProducerAttempt(entry.name, runId);
    if (producerAttempt === null) continue;
    const artifactRoot = path.join(root, entry.name);
    for (const inputPath of findNamedFiles(artifactRoot, WORKFLOW_INPUTS_BASENAME)) {
      const candidate = readRecoveredWorkflowInputs({
        inputPath,
        producerAttempt,
        expectedSourceJob,
      });
      candidatesByAttempt.set(producerAttempt, [
        ...(candidatesByAttempt.get(producerAttempt) ?? []),
        candidate,
      ]);
    }
    for (const planPath of findNamedFiles(artifactRoot, "cluster-plan.json")) {
      const runDir = path.dirname(planPath);
      const resultPath = path.join(runDir, "result.json");
      const identityPath = path.join(runDir, "source-job.json");
      if (!fs.existsSync(resultPath) || !fs.existsSync(identityPath)) continue;
      const candidate = readRecoveredRunCohort({
        planPath,
        resultPath,
        identityPath,
        producerAttempt,
        expectedSourceJob,
      });
      candidatesByAttempt.set(producerAttempt, [
        ...(candidatesByAttempt.get(producerAttempt) ?? []),
        candidate,
      ]);
    }
  }

  for (const producerAttempt of [...candidatesByAttempt.keys()].sort(
    (left, right) => right - left,
  )) {
    const candidates = candidatesByAttempt.get(producerAttempt) ?? [];
    const unique = new Map(
      candidates.map((candidate) => [JSON.stringify(candidate), candidate] as const),
    );
    if (unique.size > 1) {
      throw new Error(
        `run ${runId} has an ambiguous repair artifact cohort at attempt ${producerAttempt}`,
      );
    }
    const selected = unique.values().next().value;
    if (selected) return selected;
  }
  throw new Error(
    `run ${runId} did not publish immutable workflow inputs or one complete sealed repair artifact cohort`,
  );
}

function readRecoveredWorkflowInputs({
  inputPath,
  producerAttempt,
  expectedSourceJob,
}: {
  inputPath: string;
  producerAttempt: number;
  expectedSourceJob: string;
}): RecoveredRunCohort {
  const input = readJsonObject(inputPath, "immutable workflow inputs");
  const inputKeys = Object.keys(input).sort();
  if (
    JSON.stringify(inputKeys) !==
    JSON.stringify([
      "effective_mode",
      "job_sha256",
      "requested_mode",
      "schema_version",
      "source_job",
      "state_revision",
    ])
  ) {
    throw new Error("immutable workflow inputs have unexpected fields");
  }
  const sourceJob = String(input.source_job ?? "").trim();
  const stateRevision = String(input.state_revision ?? "").trim();
  const jobSha256 = String(input.job_sha256 ?? "").trim();
  const requestedMode = String(input.requested_mode ?? "").trim();
  const effectiveMode = String(input.effective_mode ?? "").trim();
  if (
    input.schema_version !== 1 ||
    !SOURCE_JOB_PATH.test(sourceJob) ||
    !STATE_REVISION.test(stateRevision) ||
    !JOB_SHA256.test(jobSha256) ||
    sourceJob !== expectedSourceJob ||
    !REPAIR_MODES.has(requestedMode) ||
    !REPAIR_MODES.has(effectiveMode) ||
    (effectiveMode !== requestedMode && effectiveMode !== "plan")
  ) {
    throw new Error("immutable workflow inputs have invalid repair provenance");
  }
  return {
    source_job: sourceJob,
    mode: effectiveMode,
    state_revision: stateRevision,
    job_sha256: jobSha256,
    producer_attempt: producerAttempt,
  };
}

function readRecoveredRunCohort({
  planPath,
  resultPath,
  identityPath,
  producerAttempt,
  expectedSourceJob,
}: {
  planPath: string;
  resultPath: string;
  identityPath: string;
  producerAttempt: number;
  expectedSourceJob: string;
}): RecoveredRunCohort {
  const plan = readJsonObject(planPath, "cluster plan");
  const result = readJsonObject(resultPath, "repair result");
  const identity = readJsonObject(identityPath, "source job identity");
  const identityKeys = Object.keys(identity).sort();
  if (
    JSON.stringify(identityKeys) !==
    JSON.stringify(["job_sha256", "schema_version", "source_job", "state_revision"])
  ) {
    throw new Error("sealed source job identity has unexpected fields");
  }
  const sourceJob = String(identity.source_job ?? "").trim();
  const stateRevision = String(identity.state_revision ?? "").trim();
  const jobSha256 = String(identity.job_sha256 ?? "").trim();
  const planSourceJob = String(plan.source_job ?? "").trim();
  if (
    identity.schema_version !== 1 ||
    !SOURCE_JOB_PATH.test(sourceJob) ||
    !STATE_REVISION.test(stateRevision) ||
    !JOB_SHA256.test(jobSha256) ||
    sourceJob !== expectedSourceJob ||
    planSourceJob !== sourceJob
  ) {
    throw new Error("sealed repair artifact cohort has invalid source job provenance");
  }
  const planMode = String(plan.mode ?? "").trim();
  const resultMode = String(result.mode ?? planMode).trim();
  if (!REPAIR_MODES.has(planMode) || !REPAIR_MODES.has(resultMode) || planMode !== resultMode) {
    throw new Error("sealed repair artifact cohort has inconsistent repair mode");
  }
  return {
    source_job: sourceJob,
    mode: resultMode,
    state_revision: stateRevision,
    job_sha256: jobSha256,
    producer_attempt: producerAttempt,
  };
}

function repairArtifactProducerAttempt(name: string, runId: string): number | null {
  const match = name.match(
    new RegExp(`^clawsweeper-repair(?:-(?:inputs|worker))?-${runId}-([1-9][0-9]*)$`),
  );
  if (!match) return null;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) ? attempt : null;
}

function findNamedFiles(root: string, basename: string): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === basename) matches.push(candidate);
    }
  }
  return matches.sort();
}

function readJsonObject(file: string, label: string): LooseRecord {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function liveRunRecords(cutoffMs: number) {
  try {
    return listClusterRuns({ cutoffMs })
      .map((run: LooseRecord) => {
        const parsed = parseRepairRunTitle(run.displayTitle);
        if (!parsed) return null;
        return {
          run_id: String(run.databaseId ?? ""),
          source_job: parsed.jobPath,
          source_job_sha256: parsed.jobSha256,
          workflow_conclusion: run.conclusion ?? null,
          workflow_created_at: run.createdAt ?? null,
          workflow_updated_at: run.updatedAt ?? null,
          run_url: run.url ?? null,
          live_run_record: true,
        };
      })
      .filter(Boolean);
  } catch (error) {
    const detail = ghErrorText(error);
    if (execute) {
      throw new Error(`cannot list live repair runs; refusing dispatch: ${detail}`);
    }
    console.warn(`self-heal: cannot list live repair runs: ${detail}`);
    return [];
  }
}

function readSelfHealLedger() {
  const file = selfHealLedgerPath();
  if (!fs.existsSync(file)) {
    return { updated_at: null, attempts: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function appendAttempts(ledger: LooseRecord, attempts: LooseRecord[]) {
  ledger.updated_at = new Date().toISOString();
  ledger.attempts = [...(ledger.attempts ?? []), ...attempts];
}

function writeSelfHealLedger(ledger: LooseRecord) {
  const file = selfHealLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function selfHealLedgerPath() {
  return path.join(repoRoot(), "results", "self-heal.json");
}

function listClusterRuns({
  cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000,
}: {
  cutoffMs?: number;
} = {}) {
  const runs: LooseRecord[] = [];
  for (let page = 1; page <= WORKFLOW_RUN_PAGE_LIMIT; page += 1) {
    const pageRuns = ghJson<LooseRecord[]>([
      "api",
      "--method",
      "GET",
      `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${WORKFLOW_RUN_PAGE_SIZE}&page=${page}`,
      "--jq",
      ".workflow_runs",
    ]);
    if (!Array.isArray(pageRuns)) {
      throw new Error("workflow run discovery returned a non-array response");
    }
    runs.push(...pageRuns.map(normalizeClusterRun));
    if (
      pageRuns.length < WORKFLOW_RUN_PAGE_SIZE ||
      pageRuns.some((run) => {
        const createdAtMs = Date.parse(String(run.created_at ?? run.createdAt ?? ""));
        return Number.isFinite(createdAtMs) && createdAtMs <= cutoffMs;
      })
    ) {
      return runs;
    }
  }
  throw new Error(
    `workflow run discovery exceeded ${WORKFLOW_RUN_PAGE_LIMIT * WORKFLOW_RUN_PAGE_SIZE} runs before reaching the replay horizon`,
  );
}

function normalizeClusterRun(run: LooseRecord): LooseRecord {
  return {
    databaseId: run.databaseId ?? run.id,
    workflowName: run.workflowName ?? run.name,
    displayTitle: run.displayTitle ?? run.display_title,
    headSha: run.headSha ?? run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.createdAt ?? run.created_at,
    updatedAt: run.updatedAt ?? run.updated_at,
    url: run.url ?? run.html_url,
  };
}

function readExecuteGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_EXECUTE", { preferEnv: true });
}

function readFixGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_FIX_PR", { preferEnv: true });
}

function openGate(name: string) {
  const previous = readMutableGateState(name);
  gateRestores.push({ name, previous });
  if (!previous.exists || previous.value !== "1") setGate(name, "1");
}

function readMutableGateState(name: string): GateState {
  const variables = readRepoVariables({ required: true });
  const variable = variables.find((candidate: JsonValue) => candidate.name === name);
  return variable
    ? { exists: true, value: String(variable.value ?? "") }
    : { exists: false, value: "" };
}

function readGateValue(name: string, { preferEnv }: { preferEnv: boolean }) {
  const envValue = process.env[name];
  if (preferEnv && envValue !== undefined && envValue !== "") return envValue;
  const variables = readRepoVariables();
  return variables.find((variable: JsonValue) => variable.name === name)?.value ?? envValue ?? "";
}

function readRepoVariables({ required = false }: { required?: boolean } = {}) {
  try {
    return ghJson<LooseRecord[]>(["variable", "list", "--repo", repo, "--json", "name,value"]);
  } catch (error) {
    const detail = ghErrorText(error);
    if (/HTTP 403|Resource not accessible by integration/i.test(detail)) {
      if (required) {
        throw new Error(
          `cannot read repository variables before opening temporary execution gates: ${detail}`,
        );
      }
      console.warn("self-heal: cannot read repo variables; falling back to workflow env");
      return [];
    }
    throw error;
  }
}

function setGate(name: string, value: JsonValue) {
  const normalizedValue = String(value ?? "");
  runRepairMutation(selfHealGateLifecycle(name, normalizedValue), {
    kind: "repository_variable_update",
    operationName: "failed_run_self_heal",
    component: "failed_run_self_heal_gate",
    identity: { repository: repo, name, value: normalizedValue, batchId },
    operation: () => writeGateValue(name, normalizedValue),
  });
}

function restoreOpenedGates(): {
  receiptFailures: GateCleanupFailure[];
  restoreFailures: GateCleanupFailure[];
} {
  return restoreGateSequence(
    gateRestores.map((gate) => ({ name: gate.name, state: gate.previous })),
    restoreGate,
  );
}

function restoreGate(name: string, state: GateState): GateRestoreResult {
  const receiptState = state.exists ? `set:${state.value}` : "delete";
  return restoreGateWithFallback({
    runWithReceipt: (operation) =>
      runRepairMutation(selfHealGateLifecycle(name, receiptState), {
        kind: "repository_variable_update",
        operationName: "failed_run_self_heal",
        component: "failed_run_self_heal_gate",
        identity: {
          repository: repo,
          name,
          exists: state.exists,
          value: state.value,
          batchId,
        },
        operation,
      }),
    writeState: () => writeGateState(name, state),
  });
}

function writeGateState(name: string, state: GateState): string {
  if (state.exists) return writeGateValue(name, state.value);
  let result = "";
  try {
    result = ghText(["variable", "delete", name, "--repo", repo]);
  } catch (error) {
    if (!/\bHTTP 404\b|not found/i.test(ghErrorText(error))) throw error;
    if (readMutableGateState(name).exists) throw error;
  }
  console.log(`${name}=<absent>`);
  return result;
}

function writeGateValue(name: string, value: string): string {
  const result = ghText(["variable", "set", name, "--repo", repo, "--body", value]);
  console.log(`${name}=${value}`);
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentHeadSha() {
  return execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runSortKey(record: LooseRecord) {
  const runId = Number(record.run_id);
  if (Number.isFinite(runId) && runId > 0) return runId;
  return Date.parse(record.published_at ?? "") || 0;
}

function recordTimestampMs(record: LooseRecord) {
  return (
    Date.parse(
      record.workflow_updated_at ?? record.workflow_created_at ?? record.published_at ?? "",
    ) || 0
  );
}

function summarizeCandidate(candidate: LooseRecord) {
  return {
    source_run_id: candidate.run_id,
    cluster_id: candidate.cluster_id,
    source_job: candidate.source_job,
    source_state_revision: candidate.source_state_revision,
    source_job_sha256: candidate.source_job_sha256,
    mode: candidate.mode,
    result_status: candidate.result_status,
    run_url: candidate.run_url,
  };
}

function attemptImmutableJobKey(attempt: LooseRecord): string | null {
  const stateRevision = attempt.source_state_revision;
  const jobSha256 = attempt.source_job_sha256;
  if (!stateRevision && !jobSha256) return null;
  return immutableJobIdentityKey({
    jobPath: attempt.source_job,
    stateRevision,
    jobSha256,
  });
}

function legacyAttemptJobPath(attempt: LooseRecord): string | null {
  const jobPath = String(attempt.source_job ?? "").trim();
  return /^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/.test(jobPath) ? jobPath : null;
}

function selfHealDispatchLifecycle(candidate: LooseRecord): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `failed-run-self-heal:${candidate.run_id}:${candidate.immutable_job_key}`,
    clusterId: String(candidate.cluster_id ?? ""),
    sourceRevision: String(candidate.source_state_revision ?? ""),
    recordPath: String(candidate.source_job ?? ""),
    subjectKind: "workflow",
    subjectId: `failed-run-${candidate.run_id}`,
  };
}

function selfHealGateLifecycle(name: string, value: string): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `failed-run-self-heal:${batchId}:gate:${name}:${value}`,
    sourceRevision: headSha,
    subjectKind: "workflow",
    subjectId: `self-heal-gate-${name.toLowerCase()}`,
  };
}

function activeJobGenerationKey(jobPath: JsonValue, jobSha256: JsonValue): string {
  const pathText = String(jobPath ?? "").trim();
  const digest = String(jobSha256 ?? "").trim();
  if (!/^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/.test(pathText)) {
    throw new Error("active repair run contains a malformed job path");
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("active repair run contains a malformed job SHA-256");
  }
  return `${pathText}:${digest}`;
}

function activeLegacyJobKey(jobPath: JsonValue): string {
  const pathText = String(jobPath ?? "").trim();
  if (!SOURCE_JOB_PATH.test(pathText)) {
    throw new Error("active legacy repair run contains a malformed job path");
  }
  return pathText;
}
