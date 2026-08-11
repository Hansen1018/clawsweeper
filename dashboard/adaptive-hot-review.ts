import {
  ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION,
  type AdaptiveHotAllocationDecision,
  type AdaptiveHotAllocationReason,
  type AdaptiveHotAllocationStatus,
  type AdaptiveHotObservationStatus,
} from "../src/repair/adaptive-hot-allocation.ts";
import {
  ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION,
  ADAPTIVE_HOT_DECISION_RECORD_SCHEMA_VERSION,
  ADAPTIVE_HOT_PLANNER_OBSERVATION_SCHEMA_VERSION,
  isAdaptiveHotActivationApproval,
  isAdaptiveHotMode,
  isAdaptiveHotRepositorySlug,
  type AdaptiveHotControlSnapshot,
  type AdaptiveHotControlFacts,
  type AdaptiveHotDecisionRecord,
  type AdaptiveHotExecutionObservation,
  type AdaptiveHotActualAllocation,
  type AdaptiveHotPlannerObservation,
  type AdaptiveHotRepositoryObservationSnapshot,
} from "../src/repair/adaptive-hot-review-contract.ts";

type DurableStorage = {
  sql: { exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>> };
  transactionSync: <T>(callback: () => T) => T;
};

const ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE = "adaptive_hot_planner_observations";
const ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE = "adaptive_hot_execution_observations";
const ADAPTIVE_HOT_DECISION_TABLE = "adaptive_hot_decisions";
const ADAPTIVE_HOT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const ADAPTIVE_HOT_PLANNER_RETENTION_MAX = 20_000;
const ADAPTIVE_HOT_EXECUTION_RETENTION_MAX = 20_000;
const ADAPTIVE_HOT_DECISION_RETENTION_MAX = 640;
const ADAPTIVE_HOT_PUBLIC_OBSERVATION_LIMIT = 100;
const ADAPTIVE_HOT_PUBLIC_DECISION_LIMIT = 100;
const ADAPTIVE_HOT_ALLOCATION_STATUSES = new Set<AdaptiveHotAllocationStatus>([
  "allocated",
  "observation_fallback",
  "scheduled_throttle",
  "queue_unavailable",
  "no_capacity",
  "no_eligible_demand",
]);
const ADAPTIVE_HOT_ALLOCATION_REASONS = new Set<AdaptiveHotAllocationReason>([
  "overdue_fairness",
  "source_novelty",
  "unknown_probe",
  "ordinary_demand",
  "residual_expansion",
  "observation_fallback",
]);
const ADAPTIVE_HOT_OBSERVATION_STATUSES = new Set<AdaptiveHotObservationStatus>([
  "fresh",
  "missing",
  "stale",
  "malformed",
  "unavailable",
]);

export class AdaptiveHotReviewStore {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE} (
         observation_id TEXT PRIMARY KEY,
         target_repo TEXT NOT NULL,
         lane TEXT NOT NULL CHECK (lane IN ('hot_intake', 'normal_backfill')),
         policy_version TEXT NOT NULL,
         observed_at INTEGER NOT NULL,
         observation_json TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS adaptive_hot_planner_repo_lane_time
         ON ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE} (target_repo, lane, observed_at DESC)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS adaptive_hot_planner_retention
         ON ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE} (observed_at, observation_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE} (
         receipt_id TEXT PRIMARY KEY,
         target_repo TEXT NOT NULL,
         lane TEXT NOT NULL CHECK (lane IN ('hot_intake', 'normal_backfill')),
         observed_at INTEGER NOT NULL,
         outcome TEXT NOT NULL CHECK (outcome IN ('success', 'retried', 'failed')),
         early_noop INTEGER NOT NULL CHECK (early_noop IN (0, 1)),
         structural_hit INTEGER NOT NULL CHECK (structural_hit >= 0),
         semantic_hit INTEGER NOT NULL CHECK (semantic_hit >= 0),
         content_hit INTEGER NOT NULL CHECK (content_hit >= 0),
         hydrated INTEGER NOT NULL CHECK (hydrated >= 0),
         review_runtime_ms INTEGER NOT NULL CHECK (review_runtime_ms >= 0)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS adaptive_hot_execution_repo_lane_time
         ON ${ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE} (target_repo, lane, observed_at DESC)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS adaptive_hot_execution_retention
         ON ${ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE} (observed_at, receipt_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ADAPTIVE_HOT_DECISION_TABLE} (
         decision_id TEXT PRIMARY KEY,
         observed_at INTEGER NOT NULL,
         requested_mode TEXT NOT NULL,
         effective_mode TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('planned', 'dispatched')),
         decision_json TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS adaptive_hot_decision_retention
         ON ${ADAPTIVE_HOT_DECISION_TABLE} (observed_at, decision_id)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS adaptive_hot_decision_readiness
         ON ${ADAPTIVE_HOT_DECISION_TABLE} (effective_mode, status, observed_at)`,
    );
  }

  recordPlannerObservation(value: unknown, now = Date.now()) {
    const observation = normalizeAdaptiveHotPlannerObservation(value, now);
    if (!observation) return { ok: false as const, error: "invalid_adaptive_hot_observation" };
    const observedAt = Date.parse(observation.observedAt);
    const result = this.storage.transactionSync(() => {
      this.pruneSync(now);
      const existing = firstRow(
        this.storage.sql.exec(
          `SELECT observation_json FROM ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE}
            WHERE observation_id = ?`,
          observation.observationId,
        ),
      );
      if (existing) return "duplicate" as const;
      this.storage.sql.exec(
        `INSERT INTO ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE}
           (observation_id, target_repo, lane, policy_version, observed_at, observation_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        observation.observationId,
        observation.targetRepo,
        observation.lane,
        observation.policyVersion,
        observedAt,
        JSON.stringify(observation),
      );
      this.capRowsSync(
        ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE,
        "observation_id",
        ADAPTIVE_HOT_PLANNER_RETENTION_MAX,
      );
      return "accepted" as const;
    });
    return {
      ok: true as const,
      accepted: result === "accepted",
      duplicate: result === "duplicate",
    };
  }

  recordDecision(value: unknown, now = Date.now()) {
    const decision = normalizeAdaptiveHotDecisionRecord(value, now);
    if (!decision) return { ok: false as const, error: "invalid_adaptive_hot_decision" };
    const observedAt = Date.parse(decision.observedAt);
    const result = this.storage.transactionSync(() => {
      this.pruneSync(now);
      const existing = firstRow(
        this.storage.sql.exec(
          `SELECT status, observed_at FROM ${ADAPTIVE_HOT_DECISION_TABLE} WHERE decision_id = ?`,
          decision.decisionId,
        ),
      );
      if (
        existing &&
        (Number(existing.observed_at) > observedAt ||
          (String(existing.status) === "dispatched" && decision.status === "planned"))
      ) {
        return "stale" as const;
      }
      this.storage.sql.exec(
        `INSERT INTO ${ADAPTIVE_HOT_DECISION_TABLE}
           (decision_id, observed_at, requested_mode, effective_mode, status, decision_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(decision_id) DO UPDATE SET
           observed_at = excluded.observed_at,
           requested_mode = excluded.requested_mode,
           effective_mode = excluded.effective_mode,
           status = excluded.status,
           decision_json = excluded.decision_json`,
        decision.decisionId,
        observedAt,
        decision.requestedMode,
        decision.effectiveMode,
        decision.status,
        JSON.stringify(decision),
      );
      this.capRowsSync(
        ADAPTIVE_HOT_DECISION_TABLE,
        "decision_id",
        ADAPTIVE_HOT_DECISION_RETENTION_MAX,
      );
      return existing ? ("updated" as const) : ("accepted" as const);
    });
    return {
      ok: true as const,
      accepted: result === "accepted" || result === "updated",
      updated: result === "updated",
      stale: result === "stale",
    };
  }

  recordExecution(options: {
    receiptId: string;
    targetRepo: string;
    lane: "hot_intake" | "normal_backfill";
    observedAt: number;
    outcome: "success" | "retried" | "failed";
    observation: AdaptiveHotExecutionObservation;
  }) {
    if (
      !validId(options.receiptId, 300) ||
      !isAdaptiveHotRepositorySlug(options.targetRepo) ||
      !Number.isSafeInteger(options.observedAt) ||
      options.observedAt < 0 ||
      !["success", "retried", "failed"].includes(options.outcome) ||
      !validExecutionObservation(options.observation)
    ) {
      throw new Error("invalid adaptive hot-review execution observation");
    }
    this.storage.transactionSync(() => {
      this.pruneSync(options.observedAt);
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO ${ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE}
           (receipt_id, target_repo, lane, observed_at, outcome, early_noop, structural_hit,
            semantic_hit, content_hit, hydrated, review_runtime_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        options.receiptId,
        options.targetRepo.toLowerCase(),
        options.lane,
        options.observedAt,
        options.outcome,
        options.observation.earlyNoop ? 1 : 0,
        options.observation.structuralHit,
        options.observation.semanticHit,
        options.observation.contentHit,
        options.observation.hydrated,
        options.observation.reviewRuntimeMs,
      );
      this.capRowsSync(
        ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE,
        "receipt_id",
        ADAPTIVE_HOT_EXECUTION_RETENTION_MAX,
      );
    });
  }

  snapshot(now = Date.now()): AdaptiveHotControlSnapshot {
    this.storage.transactionSync(() => this.pruneSync(now));
    const plannerTotals = new Map<string, Record<string, number>>();
    for (const row of this.storage.sql.exec(
      `SELECT target_repo, lane, policy_version, COUNT(*) AS samples,
              SUM(json_extract(observation_json, '$.offered')) AS offered,
              SUM(json_extract(observation_json, '$.attempted')) AS attempted,
              SUM(json_extract(observation_json, '$.admitted')) AS admitted,
              SUM(json_extract(observation_json, '$.deduped')) AS deduped,
              SUM(json_extract(observation_json, '$.shed')) AS shed,
              SUM(json_extract(observation_json, '$.deferred')) AS deferred,
              MAX(CASE WHEN json_extract(observation_json, '$.admitted') > 0
                       THEN observed_at END) AS last_admitted_at
         FROM ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE}
        GROUP BY target_repo, lane, policy_version`,
    )) {
      plannerTotals.set(
        repoLanePolicyKey(String(row.target_repo), String(row.lane), String(row.policy_version)),
        {
          plannerSamples: Number(row.samples || 0),
          offered: Number(row.offered || 0),
          attempted: Number(row.attempted || 0),
          admitted: Number(row.admitted || 0),
          deduped: Number(row.deduped || 0),
          shed: Number(row.shed || 0),
          deferred: Number(row.deferred || 0),
          lastAdmittedAt: Number(row.last_admitted_at || 0),
        },
      );
    }
    const executionTotals = new Map<string, Record<string, number>>();
    for (const row of this.storage.sql.exec(
      `SELECT target_repo, lane, COUNT(*) AS samples,
              SUM(early_noop) AS early_noop,
              SUM(structural_hit) AS structural_hit,
              SUM(semantic_hit) AS semantic_hit,
              SUM(content_hit) AS content_hit,
              SUM(hydrated) AS hydrated,
              SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN outcome = 'retried' THEN 1 ELSE 0 END) AS retried,
              SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(review_runtime_ms) AS review_runtime_ms,
              MAX(CASE WHEN outcome = 'success' THEN observed_at END) AS last_successful_at
         FROM ${ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE}
        GROUP BY target_repo, lane`,
    )) {
      executionTotals.set(repoLaneKey(String(row.target_repo), String(row.lane)), {
        executionSamples: Number(row.samples || 0),
        earlyNoop: Number(row.early_noop || 0),
        structuralHit: Number(row.structural_hit || 0),
        semanticHit: Number(row.semantic_hit || 0),
        contentHit: Number(row.content_hit || 0),
        hydrated: Number(row.hydrated || 0),
        successful: Number(row.successful || 0),
        retried: Number(row.retried || 0),
        failed: Number(row.failed || 0),
        reviewRuntimeMs: Number(row.review_runtime_ms || 0),
        lastSuccessfulAt: Number(row.last_successful_at || 0),
      });
    }
    const observations: AdaptiveHotRepositoryObservationSnapshot[] = [];
    for (const row of this.storage.sql.exec(
      `SELECT observation_json FROM (
         SELECT observation_json, target_repo, lane, policy_version, observed_at, observation_id,
                ROW_NUMBER() OVER (
                  PARTITION BY target_repo, lane, policy_version
                  ORDER BY observed_at DESC, observation_id DESC
                ) AS rank
           FROM ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE}
       ) WHERE rank = 1
         ORDER BY observed_at DESC, observation_id DESC, target_repo, lane, policy_version
         LIMIT ?`,
      ADAPTIVE_HOT_PUBLIC_OBSERVATION_LIMIT,
    )) {
      const latest = normalizeAdaptiveHotPlannerObservationJson(String(row.observation_json || ""));
      if (!latest) continue;
      const planner =
        plannerTotals.get(
          repoLanePolicyKey(latest.targetRepo, latest.lane, latest.policyVersion),
        ) || {};
      const execution = executionTotals.get(repoLaneKey(latest.targetRepo, latest.lane)) || {};
      observations.push({
        targetRepo: latest.targetRepo,
        lane: latest.lane,
        policyVersion: latest.policyVersion,
        observedAt: latest.observedAt,
        windowStartedAt: latest.windowStartedAt,
        eligibleDue: latest.eligibleDue,
        selected: latest.selected,
        offered: latest.offered,
        attempted: latest.attempted,
        admitted: latest.admitted,
        deduped: latest.deduped,
        shed: latest.shed,
        deferred: latest.deferred,
        rejected: latest.rejected,
        throttled: latest.throttled,
        sourceNovelDue: latest.sourceNovelDue,
        oldestDueAt: latest.oldestDueAt,
        oldestUnservedAt: latest.oldestUnservedAt,
        lastAdmittedAt:
          (planner.lastAdmittedAt ?? 0) > 0
            ? new Date(planner.lastAdmittedAt!).toISOString()
            : null,
        lastSuccessfulAt:
          (execution.lastSuccessfulAt ?? 0) > 0
            ? new Date(execution.lastSuccessfulAt!).toISOString()
            : null,
        plannerSamples: planner.plannerSamples ?? 0,
        executionSamples: execution.executionSamples ?? 0,
        earlyNoop: execution.earlyNoop ?? 0,
        structuralHit: execution.structuralHit ?? 0,
        semanticHit: execution.semanticHit ?? 0,
        contentHit: execution.contentHit ?? 0,
        hydrated: execution.hydrated ?? 0,
        successful: execution.successful ?? 0,
        retried: execution.retried ?? 0,
        failed: execution.failed ?? 0,
        reviewRuntimeMs: execution.reviewRuntimeMs ?? 0,
      });
    }
    observations.sort(
      (left, right) =>
        left.targetRepo.localeCompare(right.targetRepo) ||
        left.lane.localeCompare(right.lane) ||
        left.policyVersion.localeCompare(right.policyVersion),
    );
    const recentDecisions: AdaptiveHotDecisionRecord[] = [];
    for (const row of this.storage.sql.exec(
      `SELECT decision_json FROM ${ADAPTIVE_HOT_DECISION_TABLE}
        ORDER BY observed_at DESC, decision_id DESC LIMIT ?`,
      ADAPTIVE_HOT_PUBLIC_DECISION_LIMIT,
    )) {
      const decision = normalizeAdaptiveHotDecisionJson(String(row.decision_json || ""));
      if (decision) recentDecisions.push(decision);
    }
    const readinessPolicyVersion = recentDecisions[0]?.policyVersion ?? null;
    return {
      schemaVersion: ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      observations,
      recentDecisions,
      readiness: {
        policyVersion: readinessPolicyVersion,
        shadow: this.readinessFacts(readinessPolicyVersion, "shadow"),
        canary: this.readinessFacts(readinessPolicyVersion, "canary"),
        full10: this.readinessFacts(readinessPolicyVersion, "full", 10),
        full50: this.readinessFacts(readinessPolicyVersion, "full", 50),
      },
    };
  }

  private readinessFacts(
    policyVersion: string | null,
    mode: "shadow" | "canary" | "full",
    rolloutPercent?: 10 | 50,
  ) {
    if (!policyVersion) {
      return { firstDispatchedAt: null, lastDispatchedAt: null, dispatchedCycles: 0 };
    }
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT MIN(observed_at) AS first_at, MAX(observed_at) AS last_at, COUNT(*) AS cycles
           FROM ${ADAPTIVE_HOT_DECISION_TABLE}
          WHERE effective_mode = ? AND status = 'dispatched'
            AND json_extract(decision_json, '$.policyVersion') = ?
            AND json_extract(decision_json, '$.proposed.status') = 'allocated'
            AND (
              effective_mode = 'shadow'
              OR EXISTS (
                SELECT 1 FROM json_each(decision_json, '$.actual')
                 WHERE json_extract(value, '$.source') = 'adaptive'
              )
            )
            AND (? IS NULL OR json_extract(decision_json, '$.rolloutPercent') = ?)`,
        mode,
        policyVersion,
        rolloutPercent ?? null,
        rolloutPercent ?? null,
      ),
    );
    const first = Number(row?.first_at);
    const last = Number(row?.last_at);
    return {
      firstDispatchedAt: Number.isFinite(first) && first > 0 ? new Date(first).toISOString() : null,
      lastDispatchedAt: Number.isFinite(last) && last > 0 ? new Date(last).toISOString() : null,
      dispatchedCycles: Number(row?.cycles || 0),
    };
  }

  private pruneSync(now: number) {
    const cutoff = now - ADAPTIVE_HOT_RETENTION_MS;
    this.storage.sql.exec(
      `DELETE FROM ${ADAPTIVE_HOT_PLANNER_OBSERVATION_TABLE} WHERE observed_at < ?`,
      cutoff,
    );
    this.storage.sql.exec(
      `DELETE FROM ${ADAPTIVE_HOT_EXECUTION_OBSERVATION_TABLE} WHERE observed_at < ?`,
      cutoff,
    );
    this.storage.sql.exec(
      `DELETE FROM ${ADAPTIVE_HOT_DECISION_TABLE} WHERE observed_at < ?`,
      cutoff,
    );
  }

  private capRowsSync(table: string, idColumn: string, maximum: number) {
    this.storage.sql.exec(
      `DELETE FROM ${table}
        WHERE ${idColumn} IN (
          SELECT ${idColumn} FROM ${table}
           ORDER BY observed_at DESC, ${idColumn} DESC
           LIMIT -1 OFFSET ?
        )`,
      maximum,
    );
  }
}

function normalizeAdaptiveHotPlannerObservation(
  value: unknown,
  now: number,
): AdaptiveHotPlannerObservation | null {
  const record = objectValue(value);
  if (record.schemaVersion !== ADAPTIVE_HOT_PLANNER_OBSERVATION_SCHEMA_VERSION) return null;
  const observationId = String(record.observationId || "").trim();
  const policyVersion = String(record.policyVersion || "").trim();
  const runId = String(record.runId || "").trim();
  const runAttempt = integer(record.runAttempt);
  const targetRepo = String(record.targetRepo || "")
    .trim()
    .toLowerCase();
  const lane = String(record.lane || "");
  const observedAt = timestamp(record.observedAt, now);
  const windowStartedAt = timestamp(record.windowStartedAt, now);
  const counts = {
    eligibleDue: integer(record.eligibleDue),
    selected: integer(record.selected),
    offered: integer(record.offered),
    attempted: integer(record.attempted),
    admitted: integer(record.admitted),
    deduped: integer(record.deduped),
    shed: integer(record.shed),
    deferred: integer(record.deferred),
    rejected: integer(record.rejected),
    throttled: integer(record.throttled),
    sourceNovelDue: integer(record.sourceNovelDue),
  };
  const oldestDueAt = nullableTimestamp(record.oldestDueAt, now);
  const oldestUnservedAt = nullableTimestamp(record.oldestUnservedAt, now);
  if (
    !validId(observationId, 300) ||
    !validId(policyVersion, 100) ||
    !/^\d+$/.test(runId) ||
    runAttempt === null ||
    runAttempt < 1 ||
    !isAdaptiveHotRepositorySlug(targetRepo) ||
    (lane !== "hot_intake" && lane !== "normal_backfill") ||
    !observedAt ||
    !windowStartedAt ||
    Date.parse(windowStartedAt) > Date.parse(observedAt) ||
    Object.values(counts).some((count) => count === null || count > 1_000_000) ||
    counts.sourceNovelDue! > counts.eligibleDue! ||
    counts.attempted! > counts.offered! ||
    counts.admitted! + counts.deduped! + counts.shed! + counts.rejected! > counts.attempted!
  ) {
    return null;
  }
  return {
    schemaVersion: ADAPTIVE_HOT_PLANNER_OBSERVATION_SCHEMA_VERSION,
    observationId,
    policyVersion,
    runId,
    runAttempt,
    targetRepo,
    lane,
    observedAt,
    windowStartedAt,
    eligibleDue: counts.eligibleDue!,
    selected: counts.selected!,
    offered: counts.offered!,
    attempted: counts.attempted!,
    admitted: counts.admitted!,
    deduped: counts.deduped!,
    shed: counts.shed!,
    deferred: counts.deferred!,
    rejected: counts.rejected!,
    throttled: counts.throttled!,
    sourceNovelDue: counts.sourceNovelDue!,
    oldestDueAt,
    oldestUnservedAt,
  };
}

function normalizeAdaptiveHotDecisionRecord(
  value: unknown,
  now: number,
): AdaptiveHotDecisionRecord | null {
  const record = objectValue(value);
  const decisionId = String(record.decisionId || "").trim();
  const runId = String(record.runId || "").trim();
  const runAttempt = integer(record.runAttempt);
  const observedAt = timestamp(record.observedAt, now);
  const requestedMode = String(record.requestedMode || "");
  const effectiveMode = String(record.effectiveMode || "");
  const status = String(record.status || "");
  const policyVersion = String(record.policyVersion || "").trim();
  const activationApproval = String(record.activationApproval || "");
  const rolloutPercent = Number(record.rolloutPercent);
  const canaryRepositories = Array.isArray(record.canaryRepositories)
    ? record.canaryRepositories.map((repository) => String(repository).trim().toLowerCase())
    : null;
  const reason = String(record.reason || "");
  const legacyCursor = normalizeCursorPair(record.legacyCursor);
  const adaptiveCursor = normalizeCursorPair(record.adaptiveCursor);
  const adaptiveProbeCursor = normalizeCursorPair(record.adaptiveProbeCursor);
  const actual = normalizeActualAllocations(record.actual);
  const proposed = normalizeAdaptiveHotAllocationDecision(record.proposed);
  const control = normalizeAdaptiveHotControlFacts(record.control, now);
  const comparison = normalizeDecisionComparison(record.comparison);
  const serialized = JSON.stringify(value);
  if (
    record.schemaVersion !== ADAPTIVE_HOT_DECISION_RECORD_SCHEMA_VERSION ||
    !validId(decisionId, 300) ||
    !/^\d+$/.test(runId) ||
    runAttempt === null ||
    runAttempt < 1 ||
    !observedAt ||
    !isAdaptiveHotMode(requestedMode) ||
    !isAdaptiveHotMode(effectiveMode) ||
    (status !== "planned" && status !== "dispatched") ||
    !validId(policyVersion, 100) ||
    typeof record.killSwitch !== "boolean" ||
    !isAdaptiveHotActivationApproval(activationApproval) ||
    ![10, 50, 100].includes(rolloutPercent) ||
    !canaryRepositories ||
    canaryRepositories.length > 5 ||
    canaryRepositories.some((repository) => !isAdaptiveHotRepositorySlug(repository)) ||
    !validId(reason, 200) ||
    !legacyCursor ||
    !adaptiveCursor ||
    !adaptiveProbeCursor ||
    !actual ||
    !proposed ||
    !control ||
    !comparison ||
    serialized.length > 128 * 1024
  ) {
    return null;
  }
  return {
    schemaVersion: ADAPTIVE_HOT_DECISION_RECORD_SCHEMA_VERSION,
    decisionId,
    runId,
    runAttempt,
    observedAt,
    requestedMode,
    effectiveMode,
    status,
    policyVersion,
    killSwitch: record.killSwitch,
    activationApproval,
    rolloutPercent: rolloutPercent as 10 | 50 | 100,
    canaryRepositories,
    reason,
    legacyCursor,
    adaptiveCursor,
    adaptiveProbeCursor,
    actual,
    proposed,
    control,
    comparison,
  };
}

function normalizeDecisionComparison(
  value: unknown,
): AdaptiveHotDecisionRecord["comparison"] | null {
  const record = objectValue(value);
  const legacyRepositoryCount = integer(record.legacyRepositoryCount);
  const legacyOfferBudget = integer(record.legacyOfferBudget);
  const adaptiveRepositoryCount = integer(record.adaptiveRepositoryCount);
  const adaptiveOfferBudget = integer(record.adaptiveOfferBudget);
  const predictedOfferReduction = integer(record.predictedOfferReduction);
  const observedPlannerSamples = integer(record.observedPlannerSamples);
  const observedAttempted = integer(record.observedAttempted);
  const observedDedupedOrShed = integer(record.observedDedupedOrShed);
  const estimatedAvoidedDedupeOrShed = nullableInteger(record.estimatedAvoidedDedupeOrShed);
  const overdueRepositoriesBefore = integer(record.overdueRepositoriesBefore);
  const overdueRepositoriesSelected = integer(record.overdueRepositoriesSelected);
  const oldestUnservedAgeBeforeMs = nullableInteger(record.oldestUnservedAgeBeforeMs);
  const oldestUnservedAgeAfterProposalMs = nullableInteger(record.oldestUnservedAgeAfterProposalMs);
  if (
    legacyRepositoryCount === null ||
    legacyOfferBudget === null ||
    adaptiveRepositoryCount === null ||
    adaptiveOfferBudget === null ||
    predictedOfferReduction === null ||
    observedPlannerSamples === null ||
    observedAttempted === null ||
    observedDedupedOrShed === null ||
    estimatedAvoidedDedupeOrShed === undefined ||
    overdueRepositoriesBefore === null ||
    overdueRepositoriesSelected === null ||
    oldestUnservedAgeBeforeMs === undefined ||
    oldestUnservedAgeAfterProposalMs === undefined
  ) {
    return null;
  }
  return {
    legacyRepositoryCount,
    legacyOfferBudget,
    adaptiveRepositoryCount,
    adaptiveOfferBudget,
    predictedOfferReduction,
    observedPlannerSamples,
    observedAttempted,
    observedDedupedOrShed,
    estimatedAvoidedDedupeOrShed,
    overdueRepositoriesBefore,
    overdueRepositoriesSelected,
    oldestUnservedAgeBeforeMs,
    oldestUnservedAgeAfterProposalMs,
  };
}

function normalizeAdaptiveHotPlannerObservationJson(value: string) {
  try {
    return normalizeAdaptiveHotPlannerObservation(JSON.parse(value), Number.MAX_SAFE_INTEGER);
  } catch {
    return null;
  }
}

function normalizeAdaptiveHotDecisionJson(value: string) {
  try {
    return normalizeAdaptiveHotDecisionRecord(JSON.parse(value), Number.MAX_SAFE_INTEGER);
  } catch {
    return null;
  }
}

function normalizeActualAllocations(value: unknown): AdaptiveHotActualAllocation[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const allocations: AdaptiveHotActualAllocation[] = [];
  for (const raw of value) {
    const allocation = objectValue(raw);
    const targetRepo = String(allocation.targetRepo || "")
      .trim()
      .toLowerCase();
    const candidateCapacity = integer(allocation.candidateCapacity);
    if (
      !isAdaptiveHotRepositorySlug(targetRepo) ||
      candidateCapacity === null ||
      candidateCapacity < 1 ||
      (allocation.source !== "legacy" && allocation.source !== "adaptive")
    ) {
      return null;
    }
    allocations.push({ targetRepo, candidateCapacity, source: allocation.source });
  }
  return allocations;
}

function normalizeAdaptiveHotAllocationDecision(
  value: unknown,
): AdaptiveHotAllocationDecision | null {
  const record = objectValue(value);
  const policyVersion = String(record.policyVersion || "").trim();
  const status = String(record.status || "") as AdaptiveHotAllocationStatus;
  const serviceCapacity = integer(record.serviceCapacity);
  const offerBudget = integer(record.offerBudget);
  const perRepositoryLimit = integer(record.perRepositoryLimit);
  const repositoryLimit = integer(record.repositoryLimit);
  const repositoriesConsidered = integer(record.repositoriesConsidered);
  const credentialBlockedRepositories = integer(record.credentialBlockedRepositories);
  const unknownProbeCount = integer(record.unknownProbeCount);
  const allocations = normalizeProposedAllocations(record.allocations);
  const allocationTrace = normalizeAllocationTrace(record.allocationTrace);
  const unusedOfferBudget = integer(record.unusedOfferBudget);
  const inputCursor = integer(record.inputCursor);
  const nextCursor = integer(record.nextCursor);
  const inputProbeCursor = integer(record.inputProbeCursor);
  const nextProbeCursor = integer(record.nextProbeCursor);
  if (
    record.schemaVersion !== ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION ||
    !validId(policyVersion, 100) ||
    !ADAPTIVE_HOT_ALLOCATION_STATUSES.has(status) ||
    serviceCapacity === null ||
    offerBudget === null ||
    perRepositoryLimit === null ||
    repositoryLimit === null ||
    repositoriesConsidered === null ||
    credentialBlockedRepositories === null ||
    unknownProbeCount === null ||
    !allocations ||
    !allocationTrace ||
    unusedOfferBudget === null ||
    inputCursor === null ||
    nextCursor === null ||
    typeof record.cursorAdvanced !== "boolean" ||
    inputProbeCursor === null ||
    nextProbeCursor === null ||
    typeof record.probeCursorAdvanced !== "boolean"
  ) {
    return null;
  }
  return {
    schemaVersion: ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION,
    policyVersion,
    status,
    serviceCapacity,
    offerBudget,
    perRepositoryLimit,
    repositoryLimit,
    repositoriesConsidered,
    credentialBlockedRepositories,
    unknownProbeCount,
    allocations,
    allocationTrace,
    unusedOfferBudget,
    inputCursor,
    nextCursor,
    cursorAdvanced: record.cursorAdvanced,
    inputProbeCursor,
    nextProbeCursor,
    probeCursorAdvanced: record.probeCursorAdvanced,
  };
}

function normalizeProposedAllocations(
  value: unknown,
): AdaptiveHotAllocationDecision["allocations"] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const allocations: AdaptiveHotAllocationDecision["allocations"] = [];
  for (const raw of value) {
    const allocation = objectValue(raw);
    const targetRepo = String(allocation.targetRepo || "")
      .trim()
      .toLowerCase();
    const candidateCapacity = integer(allocation.candidateCapacity);
    const initialReason = String(allocation.initialReason || "") as AdaptiveHotAllocationReason;
    const observationStatus = String(
      allocation.observationStatus || "",
    ) as AdaptiveHotObservationStatus;
    if (
      !isAdaptiveHotRepositorySlug(targetRepo) ||
      candidateCapacity === null ||
      candidateCapacity < 1 ||
      !ADAPTIVE_HOT_ALLOCATION_REASONS.has(initialReason) ||
      !ADAPTIVE_HOT_OBSERVATION_STATUSES.has(observationStatus)
    ) {
      return null;
    }
    allocations.push({ targetRepo, candidateCapacity, initialReason, observationStatus });
  }
  return allocations;
}

function normalizeAllocationTrace(
  value: unknown,
): AdaptiveHotAllocationDecision["allocationTrace"] | null {
  if (!Array.isArray(value) || value.length > 30) return null;
  const trace: AdaptiveHotAllocationDecision["allocationTrace"] = [];
  for (const raw of value) {
    const step = objectValue(raw);
    const sequence = integer(step.sequence);
    const targetRepo = String(step.targetRepo || "")
      .trim()
      .toLowerCase();
    const reason = String(step.reason || "") as AdaptiveHotAllocationReason;
    const candidateNumber = integer(step.candidateNumber);
    if (
      sequence === null ||
      sequence < 1 ||
      !isAdaptiveHotRepositorySlug(targetRepo) ||
      !ADAPTIVE_HOT_ALLOCATION_REASONS.has(reason) ||
      candidateNumber === null ||
      candidateNumber < 1
    ) {
      return null;
    }
    trace.push({ sequence, targetRepo, reason, candidateNumber });
  }
  return trace;
}

function normalizeAdaptiveHotControlFacts(
  value: unknown,
  now: number,
): AdaptiveHotControlFacts | null {
  const record = objectValue(value);
  const availableCandidateCapacity = integer(record.availableCandidateCapacity);
  const globalTokenBalance = integer(record.globalTokenBalance);
  const hotTokenBalance = integer(record.hotTokenBalance);
  const activeCredentialCircuits = normalizeCredentialCircuits(record.activeCredentialCircuits);
  const githubRequestMetricsUpdatedAt = nullableTimestamp(
    record.githubRequestMetricsUpdatedAt,
    now,
  );
  if (
    typeof record.queueCapabilityAvailable !== "boolean" ||
    availableCandidateCapacity === null ||
    globalTokenBalance === null ||
    hotTokenBalance === null ||
    typeof record.scheduledAdmissionThrottled !== "boolean" ||
    typeof record.repositoryObservationsAvailable !== "boolean" ||
    !activeCredentialCircuits ||
    (record.githubRequestMetricsUpdatedAt != null && githubRequestMetricsUpdatedAt === null)
  ) {
    return null;
  }
  return {
    queueCapabilityAvailable: record.queueCapabilityAvailable,
    availableCandidateCapacity,
    globalTokenBalance,
    hotTokenBalance,
    scheduledAdmissionThrottled: record.scheduledAdmissionThrottled,
    repositoryObservationsAvailable: record.repositoryObservationsAvailable,
    activeCredentialCircuits,
    githubRequestMetricsUpdatedAt,
  };
}

function normalizeCredentialCircuits(
  value: unknown,
): AdaptiveHotControlFacts["activeCredentialCircuits"] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const circuits: AdaptiveHotControlFacts["activeCredentialCircuits"] = [];
  for (const raw of value) {
    const circuit = objectValue(raw);
    const scope = String(circuit.scope || "");
    const targetOwner =
      circuit.targetOwner == null ? null : String(circuit.targetOwner).trim().toLowerCase();
    const blockedUntil = timestamp(circuit.blockedUntil, Number.MAX_SAFE_INTEGER);
    if (
      (scope !== "repository_actions" && scope !== "target_app") ||
      (targetOwner !== null && !/^[a-z0-9_.-]{1,100}$/.test(targetOwner)) ||
      (scope === "target_app" && !targetOwner) ||
      !blockedUntil
    ) {
      return null;
    }
    circuits.push({ scope, targetOwner, blockedUntil });
  }
  return circuits;
}

function normalizeCursorPair(value: unknown) {
  const cursor = objectValue(value);
  const input = integer(cursor.input);
  const next = integer(cursor.next);
  return input === null || next === null ? null : { input, next };
}

function validExecutionObservation(value: AdaptiveHotExecutionObservation) {
  return (
    typeof value.earlyNoop === "boolean" &&
    [value.structuralHit, value.semanticHit, value.contentHit, value.hydrated].every(
      (entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 10_000,
    ) &&
    Number.isSafeInteger(value.reviewRuntimeMs) &&
    value.reviewRuntimeMs >= 0 &&
    value.reviewRuntimeMs <= 3 * 60 * 60_000
  );
}

export function normalizeAdaptiveHotExecutionObservation(
  value: unknown,
): AdaptiveHotExecutionObservation | null {
  const observation = objectValue(value);
  const normalized: AdaptiveHotExecutionObservation = {
    earlyNoop: observation.earlyNoop === true,
    structuralHit: Number(observation.structuralHit),
    semanticHit: Number(observation.semanticHit),
    contentHit: Number(observation.contentHit),
    hydrated: Number(observation.hydrated),
    reviewRuntimeMs: Number(observation.reviewRuntimeMs),
  };
  return validExecutionObservation(normalized) ? normalized : null;
}

function repoLaneKey(repo: string, lane: string) {
  return `${repo.toLowerCase()}\u0000${lane}`;
}

function repoLanePolicyKey(repo: string, lane: string, policyVersion: string) {
  return `${repoLaneKey(repo, lane)}\u0000${policyVersion}`;
}

function timestamp(value: unknown, now: number) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= now + 5 * 60_000
    ? new Date(parsed).toISOString()
    : null;
}

function nullableTimestamp(value: unknown, now: number) {
  return value == null || value === "" ? null : timestamp(value, now);
}

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return integer(value) ?? undefined;
}

function validId(value: string, max: number) {
  return (
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\r") &&
    !value.includes("\n") &&
    !value.includes(String.fromCodePoint(0))
  );
}

function firstRow(rows: Iterable<Record<string, unknown>>) {
  for (const row of rows) return row;
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
