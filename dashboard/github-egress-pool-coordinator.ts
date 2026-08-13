type SqlCursor = Iterable<Record<string, unknown>> & { rowsWritten?: number };

type DurableStorage = {
  sql: { exec: (query: string, ...bindings: unknown[]) => SqlCursor };
  transactionSync: <T>(callback: () => T) => T;
};

type DurableObjectState = { storage: DurableStorage };

type PoolStateName = "closed" | "open" | "half_open" | "recovering";
type PermitMode = "normal" | "probe" | "ramp";
type ResetProvenance = "none" | "retry_after" | "rate_limit_reset" | "fallback";

type PoolState = {
  epoch: number;
  state: PoolStateName;
  blockedUntil: number;
  resetProvenance: ResetProvenance;
  resetAuthoritative: boolean;
  fallbackAttempt: number;
  rampLimit: number;
  rampSuccesses: number;
  rampAdmissions: number;
  lastOpenedAt: number | null;
  permitsInFlightAtOpen: number;
  alreadyOnWireCompletions: number;
  rejectedBeforeStart: number;
  throttleObservations: number;
  telemetryComplete: boolean;
};

type PoolConfig = {
  maxPermits: number;
  acquiredPermitTtlMs: number;
  startedPermitTtlMs: number;
  fallbackBaseMs: number;
  fallbackMaxMs: number;
  fallbackJitterRatio: number;
  rampSuccessMultiplier: number;
  receiptTtlMs: number;
};

type CoordinatorRuntime = {
  now: () => number;
  random: () => number;
  permitId: () => string;
};

const STATE_TABLE = "github_egress_pool_state";
const PERMIT_TABLE = "github_egress_pool_permits";
const OPERATION_TABLE = "github_egress_pool_operations";
const RECEIPT_TABLE = "github_egress_pool_receipts";
const REJECTION_TABLE = "github_egress_pool_rejections";
const DEFAULT_MAX_PERMITS = 8;
const DEFAULT_ACQUIRED_PERMIT_TTL_MS = 15_000;
const DEFAULT_STARTED_PERMIT_TTL_MS = 10 * 60_000;
const DEFAULT_FALLBACK_BASE_MS = 5 * 60_000;
const DEFAULT_FALLBACK_MAX_MS = 60 * 60_000;
const DEFAULT_FALLBACK_JITTER_RATIO = 0.2;
const DEFAULT_RAMP_SUCCESS_MULTIPLIER = 1;
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60_000;
// Phase 1 deliberately grants one wire operation per permit. The declared
// budget remains explicit so a later calibrated multi-request permit cannot be
// introduced accidentally by a caller-only change.
const MAX_DECLARED_BUDGET = 1;
const MAX_RESET_HORIZON_MS = 2 * 60 * 60_000;

export class GithubEgressPoolCoordinator {
  private readonly storage: DurableStorage;
  private readonly config: PoolConfig;
  private readonly runtime: CoordinatorRuntime;

  constructor(
    state: DurableObjectState,
    env: Record<string, unknown> = {},
    runtime: Partial<CoordinatorRuntime> = {},
  ) {
    this.storage = state.storage;
    this.config = poolConfig(env);
    this.runtime = {
      now: runtime.now ?? Date.now,
      random: runtime.random ?? Math.random,
      permitId: runtime.permitId ?? (() => crypto.randomUUID()),
    };
    this.ensureSchemaSync();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/observability") {
      return this.observability();
    }
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    const body = await request.json().catch(() => null);
    if (url.pathname === "/acquire") return this.acquire(body);
    if (url.pathname === "/start") return this.start(body);
    if (url.pathname === "/finish") return this.finish(body);
    if (url.pathname === "/throttle") return this.throttle(body);
    return json({ error: "not_found" }, 404);
  }

  private acquire(value: unknown): Response {
    const body = objectValue(value);
    const callerHash = safeDigest(body.caller_hash);
    const declaredBudget = Number(body.declared_budget);
    if (
      !callerHash ||
      !Number.isInteger(declaredBudget) ||
      declaredBudget < 1 ||
      declaredBudget > MAX_DECLARED_BUDGET
    ) {
      return json({ error: "invalid_permit_request" }, 400);
    }
    const now = this.runtime.now();
    const rejectionKey = `acquire:${callerHash}:${declaredBudget}`;
    return this.storage.transactionSync(() => {
      this.cleanupSync(now);
      let state = this.readStateSync();
      const existing = this.activePermitForCallerSync(callerHash, now);
      if (existing) return json({ ok: true, granted: true, permit: permitJson(existing) });

      if (state.state === "open") {
        if (now < state.blockedUntil)
          return this.rejectBeforeStartSync(state, "circuit_open", rejectionKey, now);
        state = { ...state, state: "half_open", blockedUntil: 0 };
        this.writeStateSync(state);
      }

      let mode: PermitMode = "normal";
      let capacity = this.config.maxPermits;
      if (state.state === "half_open") {
        const probe = this.activeProbeSync(now, state.epoch);
        if (probe) return this.rejectBeforeStartSync(state, "probe_in_flight", rejectionKey, now);
        mode = "probe";
        capacity = 1;
      } else if (state.state === "recovering") {
        mode = "ramp";
        capacity = Math.min(state.rampLimit, this.config.maxPermits);
        const target = capacity * this.config.rampSuccessMultiplier;
        if (state.rampAdmissions >= target) {
          return this.rejectBeforeStartSync(state, "ramp_cohort_full", rejectionKey, now);
        }
      }
      if (this.activePermitCountSync(now, state.epoch) >= capacity) {
        return this.rejectBeforeStartSync(state, "capacity_deferred", rejectionKey, now);
      }

      const permitId = this.runtime.permitId();
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(permitId)) {
        state.telemetryComplete = false;
        this.writeStateSync(state);
        return json({ error: "permit_identity_unavailable" }, 503);
      }
      const expiresAt = now + this.config.acquiredPermitTtlMs;
      this.storage.sql.exec(
        `INSERT INTO ${PERMIT_TABLE}
           (permit_id, caller_hash, epoch, mode, declared_budget, status,
            acquired_at, expires_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'acquired', ?, ?, NULL)`,
        permitId,
        callerHash,
        state.epoch,
        mode,
        declaredBudget,
        now,
        expiresAt,
      );
      if (mode === "ramp") {
        state.rampAdmissions += 1;
        this.writeStateSync(state);
      }
      return json({
        ok: true,
        granted: true,
        permit: {
          permit_id: permitId,
          epoch: state.epoch,
          mode,
          declared_budget: declaredBudget,
          expires_at: new Date(expiresAt).toISOString(),
        },
      });
    });
  }

  private start(value: unknown): Response {
    const body = objectValue(value);
    const permitId = safePermitId(body.permit_id);
    const epoch = positiveInteger(body.epoch);
    const operationIndex = positiveInteger(body.operation_index);
    if (!permitId || !epoch || !operationIndex)
      return json({ error: "invalid_start_request" }, 400);
    const now = this.runtime.now();
    const rejectionKey = `start:${permitId}:${epoch}:${operationIndex}`;
    return this.storage.transactionSync(() => {
      this.cleanupSync(now);
      const state = this.readStateSync();
      const permit = this.readPermitSync(permitId);
      const operation = this.readOperationSync(permitId, operationIndex);
      if (operation) {
        if (operation.state === "completed" && permit?.epoch === epoch) {
          return json({
            ok: true,
            started: false,
            already_completed: true,
            epoch: permit.epoch,
          });
        }
        if (!permit || permit.epoch !== epoch || epoch !== state.epoch) {
          return this.rejectBeforeStartSync(state, "stale_epoch", rejectionKey, now);
        }
        if (!this.permitModeMatchesState(permit.mode, state.state)) {
          return this.rejectBeforeStartSync(state, "circuit_state_changed", rejectionKey, now);
        }
        return json({
          ok: true,
          started: true,
          epoch: permit.epoch,
        });
      }
      if (!permit || permit.status === "expired" || permit.expiresAt <= now) {
        return this.rejectBeforeStartSync(state, "permit_expired", rejectionKey, now);
      }
      if (permit.epoch !== epoch || epoch !== state.epoch) {
        return this.rejectBeforeStartSync(state, "stale_epoch", rejectionKey, now);
      }
      if (permit.status !== "acquired" && permit.status !== "started") {
        return this.rejectBeforeStartSync(state, "permit_not_active", rejectionKey, now);
      }
      if (operationIndex > permit.declaredBudget) {
        return json({ error: "operation_budget_exceeded" }, 409);
      }
      if (!this.permitModeMatchesState(permit.mode, state.state)) {
        return this.rejectBeforeStartSync(state, "circuit_state_changed", rejectionKey, now);
      }
      const startedExpiry = now + this.config.startedPermitTtlMs;
      this.storage.sql.exec(
        `INSERT INTO ${OPERATION_TABLE}
           (permit_id, operation_index, state, started_at, completed_at)
         VALUES (?, ?, 'started', ?, NULL)`,
        permitId,
        operationIndex,
        now,
      );
      this.storage.sql.exec(
        `UPDATE ${PERMIT_TABLE}
            SET status = 'started', expires_at = ?
          WHERE permit_id = ?`,
        startedExpiry,
        permitId,
      );
      return json({
        ok: true,
        started: true,
        epoch,
        expires_at: new Date(startedExpiry).toISOString(),
      });
    });
  }

  private finish(value: unknown): Response {
    const body = objectValue(value);
    const permitId = safePermitId(body.permit_id);
    const epoch = positiveInteger(body.epoch);
    const operationIndex = positiveInteger(body.operation_index);
    const receiptId = safeReceipt(body.receipt_id);
    const outcome =
      body.outcome === "success" ||
      body.outcome === "failure" ||
      body.outcome === "unexecuted_failure"
        ? body.outcome
        : null;
    if (!permitId || !epoch || !operationIndex || !receiptId || !outcome) {
      return json({ error: "invalid_finish_request" }, 400);
    }
    const now = this.runtime.now();
    return this.storage.transactionSync(() => {
      this.cleanupSync(now);
      if (this.hasReceiptSync(receiptId))
        return json({ ok: true, duplicate: true, state: this.publicStateSync(now) });
      let state = this.readStateSync();
      const permit = this.readPermitSync(permitId);
      const operation = this.readOperationSync(permitId, operationIndex);
      if (!permit || !operation || operation.state !== "started" || permit.epoch !== epoch) {
        return json({ error: "operation_not_started" }, 409);
      }
      this.completeOperationSync(permitId, operationIndex, now);
      this.completePermitIfDoneSync(permit, now);

      if (epoch !== state.epoch) {
        state.alreadyOnWireCompletions += 1;
        this.writeStateSync(state);
      } else if (permit.mode === "probe") {
        state =
          outcome === "unexecuted_failure"
            ? this.openFallbackSync(state, now)
            : {
                ...state,
                state: "recovering",
                blockedUntil: 0,
                rampLimit: 1,
                rampSuccesses: 0,
                rampAdmissions: 0,
              };
        this.writeStateSync(state);
      } else if (permit.mode === "ramp") {
        state =
          outcome === "unexecuted_failure"
            ? this.openFallbackSync(state, now, this.startedOperationCountSync(state.epoch))
            : this.advanceRampSync(state);
        this.writeStateSync(state);
      }
      this.insertReceiptSync(receiptId, "finish", now);
      return json({ ok: true, duplicate: false, state: this.publicStateSync(now) });
    });
  }

  private throttle(value: unknown): Response {
    const body = objectValue(value);
    const permitId = safePermitId(body.permit_id);
    const epoch = positiveInteger(body.epoch);
    const operationIndex = positiveInteger(body.operation_index);
    const receiptId = safeReceipt(body.receipt_id);
    const status = Number(body.status);
    const observedAt = Date.parse(String(body.observed_at || ""));
    const headers = rateLimitHeaders(body.headers, observedAt);
    if (
      !permitId ||
      !epoch ||
      !operationIndex ||
      !receiptId ||
      (status !== 403 && status !== 429) ||
      !Number.isFinite(observedAt) ||
      !headers
    ) {
      return json({ error: "invalid_throttle_observation" }, 400);
    }
    const now = this.runtime.now();
    if (observedAt < now - 10 * 60_000 || observedAt > now + 60_000) {
      return json({ error: "invalid_throttle_time" }, 400);
    }
    return this.storage.transactionSync(() => {
      this.cleanupSync(now);
      if (this.hasReceiptSync(receiptId))
        return json({ ok: true, duplicate: true, state: this.publicStateSync(now) });
      let state = this.readStateSync();
      const permit = this.readPermitSync(permitId);
      const operation = this.readOperationSync(permitId, operationIndex);
      if (!permit || !operation || operation.state !== "started" || permit.epoch !== epoch) {
        return json({ error: "operation_not_started" }, 409);
      }
      this.completeOperationSync(permitId, operationIndex, now);
      this.completePermitIfDoneSync(permit, now);
      state.throttleObservations += 1;
      const reset = credibleReset(observedAt, headers);
      if (epoch === state.epoch) {
        const onWire = this.startedOperationCountSync(epoch, permitId);
        state = reset
          ? this.openAuthoritativeSync(state, now, reset.blockedUntil, reset.provenance, onWire)
          : this.openFallbackSync(state, now, onWire);
      } else {
        state.alreadyOnWireCompletions += 1;
        if (state.state !== "open") {
          // An old operation can outlive a reset/probe/ramp boundary. Its
          // throttle is new evidence about the credential pool, even though
          // the operation's permit epoch is stale. Reopen the current epoch so
          // recovered capacity cannot remain live after that observation.
          const onWire = this.startedOperationCountSync(state.epoch);
          state = reset
            ? this.openAuthoritativeSync(state, now, reset.blockedUntil, reset.provenance, onWire)
            : this.openFallbackSync(state, now, onWire);
        } else if (reset && reset.blockedUntil > state.blockedUntil) {
          state.blockedUntil = reset.blockedUntil;
          state.resetProvenance = reset.provenance;
          state.resetAuthoritative = true;
        } else if (!reset) {
          state = this.extendFallbackSync(state, now);
        }
      }
      this.writeStateSync(state);
      this.insertReceiptSync(receiptId, "throttle", now);
      return json({ ok: true, duplicate: false, state: this.publicStateSync(now) });
    });
  }

  private observability(): Response {
    const now = this.runtime.now();
    return this.storage.transactionSync(() => {
      this.cleanupSync(now);
      return json({
        ok: true,
        generated_at: new Date(now).toISOString(),
        pool_class: "repository_actions",
        ...this.publicStateSync(now),
        config: {
          max_permits: this.config.maxPermits,
          acquired_permit_ttl_ms: this.config.acquiredPermitTtlMs,
          started_permit_ttl_ms: this.config.startedPermitTtlMs,
          fallback_base_ms: this.config.fallbackBaseMs,
          fallback_max_ms: this.config.fallbackMaxMs,
          fallback_jitter_ratio: this.config.fallbackJitterRatio,
          ramp_success_multiplier: this.config.rampSuccessMultiplier,
        },
      });
    });
  }

  private ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         epoch INTEGER NOT NULL CHECK (epoch >= 1),
         state TEXT NOT NULL CHECK (state IN ('closed', 'open', 'half_open', 'recovering')),
         blocked_until INTEGER NOT NULL,
         reset_provenance TEXT NOT NULL CHECK (reset_provenance IN ('none', 'retry_after', 'rate_limit_reset', 'fallback')),
         reset_authoritative INTEGER NOT NULL CHECK (reset_authoritative IN (0, 1)),
         fallback_attempt INTEGER NOT NULL CHECK (fallback_attempt >= 0),
         ramp_limit INTEGER NOT NULL CHECK (ramp_limit >= 1),
         ramp_successes INTEGER NOT NULL CHECK (ramp_successes >= 0),
         ramp_admissions INTEGER NOT NULL CHECK (ramp_admissions >= 0),
         last_opened_at INTEGER,
         permits_in_flight_at_open INTEGER NOT NULL CHECK (permits_in_flight_at_open >= 0),
         already_on_wire_completions INTEGER NOT NULL CHECK (already_on_wire_completions >= 0),
         rejected_before_start INTEGER NOT NULL CHECK (rejected_before_start >= 0),
         throttle_observations INTEGER NOT NULL CHECK (throttle_observations >= 0),
         telemetry_complete INTEGER NOT NULL CHECK (telemetry_complete IN (0, 1))
       ) STRICT`,
    );
    const stateColumns = new Set(
      Array.from(this.storage.sql.exec(`SELECT name FROM pragma_table_info('${STATE_TABLE}')`)).map(
        (row) => String(row.name || ""),
      ),
    );
    const needsRampAdmissionsBackfill = !stateColumns.has("ramp_admissions");
    if (needsRampAdmissionsBackfill) {
      this.storage.sql.exec(
        `ALTER TABLE ${STATE_TABLE}
           ADD COLUMN ramp_admissions INTEGER NOT NULL DEFAULT 0
             CHECK (ramp_admissions >= 0)`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${PERMIT_TABLE} (
         permit_id TEXT PRIMARY KEY,
         caller_hash TEXT NOT NULL,
         epoch INTEGER NOT NULL CHECK (epoch >= 1),
         mode TEXT NOT NULL CHECK (mode IN ('normal', 'probe', 'ramp')),
         declared_budget INTEGER NOT NULL CHECK (declared_budget >= 1),
         status TEXT NOT NULL CHECK (status IN ('acquired', 'started', 'completed', 'expired')),
         acquired_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         completed_at INTEGER
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS github_egress_pool_permits_active
         ON ${PERMIT_TABLE} (status, expires_at, epoch)`,
    );
    if (needsRampAdmissionsBackfill) {
      this.storage.sql.exec(
        `UPDATE ${STATE_TABLE}
            SET ramp_admissions = CASE
              WHEN state = 'recovering' THEN ramp_successes + (
                SELECT COUNT(*) FROM ${PERMIT_TABLE}
                 WHERE epoch = ${STATE_TABLE}.epoch
                   AND mode = 'ramp'
                   AND status IN ('acquired', 'started')
              )
              ELSE 0
            END
          WHERE singleton_id = 1`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${OPERATION_TABLE} (
         permit_id TEXT NOT NULL,
         operation_index INTEGER NOT NULL CHECK (operation_index >= 1),
         state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
         started_at INTEGER NOT NULL,
         completed_at INTEGER,
         PRIMARY KEY (permit_id, operation_index),
         FOREIGN KEY (permit_id) REFERENCES ${PERMIT_TABLE} (permit_id) ON DELETE CASCADE
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
         receipt_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL CHECK (kind IN ('finish', 'throttle')),
         observed_at INTEGER NOT NULL
      ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${REJECTION_TABLE} (
         request_key TEXT PRIMARY KEY,
         reason TEXT NOT NULL,
         epoch INTEGER NOT NULL CHECK (epoch >= 1),
         blocked_until INTEGER NOT NULL,
         reset_provenance TEXT NOT NULL CHECK (reset_provenance IN ('none', 'retry_after', 'rate_limit_reset', 'fallback')),
         reset_authoritative INTEGER NOT NULL CHECK (reset_authoritative IN (0, 1)),
         observed_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${STATE_TABLE}
         (singleton_id, epoch, state, blocked_until, reset_provenance,
          reset_authoritative, fallback_attempt, ramp_limit, ramp_successes,
          ramp_admissions,
          last_opened_at, permits_in_flight_at_open, already_on_wire_completions,
          rejected_before_start, throttle_observations, telemetry_complete)
       VALUES (1, 1, 'closed', 0, 'none', 0, 0, 1, 0, 0, NULL, 0, 0, 0, 0, 1)`,
    );
  }

  private cleanupSync(now: number) {
    const expired = Array.from(
      this.storage.sql.exec(
        `SELECT permit_id, epoch, mode, status FROM ${PERMIT_TABLE}
          WHERE status IN ('acquired', 'started') AND expires_at <= ?`,
        now,
      ),
    );
    if (expired.length) {
      let state = this.readStateSync();
      for (const permit of expired) {
        this.storage.sql.exec(
          `UPDATE ${PERMIT_TABLE} SET status = 'expired', completed_at = ? WHERE permit_id = ?`,
          now,
          String(permit.permit_id),
        );
        if (permit.status === "started") state.telemetryComplete = false;
        const expiredProbe = permit.mode === "probe" && state.state === "half_open";
        const expiredRamp = permit.mode === "ramp" && state.state === "recovering";
        if (
          Number(permit.epoch) === state.epoch &&
          ((permit.status === "started" && expiredProbe) || expiredRamp)
        ) {
          state = this.openFallbackSync(state, now, this.startedOperationCountSync(state.epoch));
        }
      }
      this.writeStateSync(state);
    }
    const retentionCutoff = now - this.config.receiptTtlMs;
    this.storage.sql.exec(`DELETE FROM ${RECEIPT_TABLE} WHERE observed_at < ?`, retentionCutoff);
    this.storage.sql.exec(`DELETE FROM ${REJECTION_TABLE} WHERE observed_at < ?`, retentionCutoff);
    this.storage.sql.exec(
      `DELETE FROM ${OPERATION_TABLE}
        WHERE permit_id IN (
          SELECT permit_id FROM ${PERMIT_TABLE}
           WHERE status IN ('completed', 'expired') AND completed_at < ?
        )`,
      retentionCutoff,
    );
    this.storage.sql.exec(
      `DELETE FROM ${PERMIT_TABLE}
        WHERE status IN ('completed', 'expired') AND completed_at < ?`,
      retentionCutoff,
    );
  }

  private openAuthoritativeSync(
    state: PoolState,
    now: number,
    blockedUntil: number,
    provenance: "retry_after" | "rate_limit_reset",
    onWire = 0,
  ): PoolState {
    return {
      ...state,
      epoch: state.epoch + 1,
      state: "open",
      blockedUntil,
      resetProvenance: provenance,
      resetAuthoritative: true,
      rampLimit: 1,
      rampSuccesses: 0,
      rampAdmissions: 0,
      lastOpenedAt: now,
      permitsInFlightAtOpen: onWire,
    };
  }

  private openFallbackSync(state: PoolState, now: number, onWire = 0): PoolState {
    const extended = this.extendFallbackSync(state, now);
    return {
      ...extended,
      epoch: state.epoch + 1,
      state: "open",
      rampLimit: 1,
      rampSuccesses: 0,
      rampAdmissions: 0,
      lastOpenedAt: now,
      permitsInFlightAtOpen: onWire,
    };
  }

  private extendFallbackSync(state: PoolState, now: number): PoolState {
    const attempt = Math.min(30, state.fallbackAttempt + 1);
    const exponential = Math.min(
      this.config.fallbackMaxMs,
      this.config.fallbackBaseMs * 2 ** Math.max(0, attempt - 1),
    );
    const jitter = Math.floor(
      exponential * this.config.fallbackJitterRatio * boundedRandom(this.runtime.random()),
    );
    const fallbackUntil = now + exponential + jitter;
    const extendsBoundary = fallbackUntil > state.blockedUntil;
    return {
      ...state,
      blockedUntil: Math.max(state.blockedUntil, fallbackUntil),
      resetProvenance: extendsBoundary ? "fallback" : state.resetProvenance,
      resetAuthoritative: extendsBoundary ? false : state.resetAuthoritative,
      fallbackAttempt: attempt,
    };
  }

  private advanceRampSync(state: PoolState): PoolState {
    const successes = state.rampSuccesses + 1;
    const threshold = state.rampLimit * this.config.rampSuccessMultiplier;
    if (successes < threshold) return { ...state, rampSuccesses: successes };
    if (this.activePermitCountSync(this.runtime.now(), state.epoch) > 0) {
      return { ...state, rampSuccesses: successes };
    }
    if (state.rampLimit >= this.config.maxPermits) {
      return {
        ...state,
        state: "closed",
        blockedUntil: 0,
        resetProvenance: "none",
        resetAuthoritative: false,
        fallbackAttempt: 0,
        rampLimit: this.config.maxPermits,
        rampSuccesses: 0,
        rampAdmissions: 0,
      };
    }
    return {
      ...state,
      rampLimit: Math.min(this.config.maxPermits, state.rampLimit * 2),
      rampSuccesses: 0,
      rampAdmissions: 0,
    };
  }

  private permitModeMatchesState(mode: PermitMode, state: PoolStateName): boolean {
    return (
      (state === "closed" && mode === "normal") ||
      (state === "half_open" && mode === "probe") ||
      (state === "recovering" && mode === "ramp")
    );
  }

  private rejectBeforeStartSync(
    state: PoolState,
    reason: string,
    requestKey: string,
    now: number,
  ): Response {
    const prior = Array.from(
      this.storage.sql.exec(
        `SELECT reason, epoch, blocked_until, reset_provenance, reset_authoritative
           FROM ${REJECTION_TABLE} WHERE request_key = ?`,
        requestKey,
      ),
    )[0];
    if (prior) {
      return rejectionResponse(
        String(prior.reason),
        Number(prior.epoch),
        Number(prior.blocked_until),
        String(prior.reset_provenance) as ResetProvenance,
        Number(prior.reset_authoritative) === 1,
      );
    }
    state.rejectedBeforeStart += 1;
    this.writeStateSync(state);
    this.storage.sql.exec(
      `INSERT INTO ${REJECTION_TABLE}
         (request_key, reason, epoch, blocked_until, reset_provenance,
          reset_authoritative, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      requestKey,
      reason,
      state.epoch,
      state.blockedUntil,
      state.resetProvenance,
      state.resetAuthoritative ? 1 : 0,
      now,
    );
    return rejectionResponse(
      reason,
      state.epoch,
      state.blockedUntil,
      state.resetProvenance,
      state.resetAuthoritative,
    );
  }

  private publicStateSync(now: number) {
    const state = this.readStateSync();
    return {
      state: state.state,
      epoch: state.epoch,
      blocked_until: state.blockedUntil ? new Date(state.blockedUntil).toISOString() : null,
      reset_provenance: state.resetProvenance,
      reset_authoritative: state.resetAuthoritative,
      fallback_attempt: state.fallbackAttempt,
      permits_in_flight: this.startedOperationCountSync(state.epoch),
      permits_in_flight_at_open: state.permitsInFlightAtOpen,
      already_on_wire_completions: state.alreadyOnWireCompletions,
      rejected_before_start: state.rejectedBeforeStart,
      avoided_operations: state.rejectedBeforeStart,
      throttle_observations: state.throttleObservations,
      last_opened_at: state.lastOpenedAt ? new Date(state.lastOpenedAt).toISOString() : null,
      probe_in_flight: Boolean(this.activeProbeSync(now, state.epoch)),
      ramp: {
        active: state.state === "recovering",
        limit: state.rampLimit,
        successes: state.rampSuccesses,
        admitted: state.rampAdmissions,
        target: state.rampLimit * this.config.rampSuccessMultiplier,
        outstanding: Math.max(0, state.rampAdmissions - state.rampSuccesses),
      },
      telemetry_complete: state.telemetryComplete,
    };
  }

  private activePermitForCallerSync(callerHash: string, now: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT permit_id, caller_hash, epoch, mode, declared_budget, status,
                acquired_at, expires_at, completed_at
           FROM ${PERMIT_TABLE}
          WHERE caller_hash = ? AND status IN ('acquired', 'started') AND expires_at > ?
          ORDER BY acquired_at DESC LIMIT 1`,
        callerHash,
        now,
      ),
    )[0];
    return row ? permitFromRow(row) : null;
  }

  private activeProbeSync(now: number, epoch: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT permit_id, caller_hash, epoch, mode, declared_budget, status,
                acquired_at, expires_at, completed_at
           FROM ${PERMIT_TABLE}
          WHERE mode = 'probe' AND epoch = ?
            AND status IN ('acquired', 'started') AND expires_at > ?
          ORDER BY acquired_at DESC LIMIT 1`,
        epoch,
        now,
      ),
    )[0];
    return row ? permitFromRow(row) : null;
  }

  private activePermitCountSync(now: number, epoch: number): number {
    return Number(
      Array.from(
        this.storage.sql.exec(
          `SELECT COUNT(*) AS count FROM ${PERMIT_TABLE}
            WHERE epoch = ? AND status IN ('acquired', 'started') AND expires_at > ?`,
          epoch,
          now,
        ),
      )[0]?.count ?? 0,
    );
  }

  private startedOperationCountSync(epoch: number, excludedPermitId?: string): number {
    const bindings: unknown[] = [epoch];
    const exclusion = excludedPermitId ? " AND operation.permit_id <> ?" : "";
    if (excludedPermitId) bindings.push(excludedPermitId);
    return Number(
      Array.from(
        this.storage.sql.exec(
          `SELECT COUNT(*) AS count
             FROM ${OPERATION_TABLE} AS operation
             JOIN ${PERMIT_TABLE} AS permit ON permit.permit_id = operation.permit_id
            WHERE operation.state = 'started' AND permit.status = 'started'
              AND permit.epoch = ?${exclusion}`,
          ...bindings,
        ),
      )[0]?.count ?? 0,
    );
  }

  private readPermitSync(permitId: string) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT permit_id, caller_hash, epoch, mode, declared_budget, status,
                acquired_at, expires_at, completed_at
           FROM ${PERMIT_TABLE} WHERE permit_id = ?`,
        permitId,
      ),
    )[0];
    return row ? permitFromRow(row) : null;
  }

  private readOperationSync(permitId: string, operationIndex: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT state, started_at, completed_at FROM ${OPERATION_TABLE}
          WHERE permit_id = ? AND operation_index = ?`,
        permitId,
        operationIndex,
      ),
    )[0];
    return row
      ? {
          state: String(row.state) as "started" | "completed",
          startedAt: Number(row.started_at),
          completedAt: row.completed_at === null ? null : Number(row.completed_at),
        }
      : null;
  }

  private completeOperationSync(permitId: string, operationIndex: number, now: number) {
    this.storage.sql.exec(
      `UPDATE ${OPERATION_TABLE} SET state = 'completed', completed_at = ?
        WHERE permit_id = ? AND operation_index = ? AND state = 'started'`,
      now,
      permitId,
      operationIndex,
    );
  }

  private completePermitIfDoneSync(permit: ReturnType<typeof permitFromRow>, now: number) {
    const completed = Number(
      Array.from(
        this.storage.sql.exec(
          `SELECT COUNT(*) AS count FROM ${OPERATION_TABLE}
            WHERE permit_id = ? AND state = 'completed'`,
          permit.permitId,
        ),
      )[0]?.count ?? 0,
    );
    if (completed < permit.declaredBudget) return;
    this.storage.sql.exec(
      `UPDATE ${PERMIT_TABLE} SET status = 'completed', completed_at = ? WHERE permit_id = ?`,
      now,
      permit.permitId,
    );
  }

  private hasReceiptSync(receiptId: string): boolean {
    return Boolean(
      Array.from(
        this.storage.sql.exec(
          `SELECT 1 FROM ${RECEIPT_TABLE} WHERE receipt_id = ? LIMIT 1`,
          receiptId,
        ),
      )[0],
    );
  }

  private insertReceiptSync(receiptId: string, kind: "finish" | "throttle", now: number) {
    this.storage.sql.exec(
      `INSERT INTO ${RECEIPT_TABLE} (receipt_id, kind, observed_at) VALUES (?, ?, ?)`,
      receiptId,
      kind,
      now,
    );
  }

  private readStateSync(): PoolState {
    const row = Array.from(
      this.storage.sql.exec(`SELECT * FROM ${STATE_TABLE} WHERE singleton_id = 1`),
    )[0]!;
    return {
      epoch: Number(row.epoch),
      state: String(row.state) as PoolStateName,
      blockedUntil: Number(row.blocked_until),
      resetProvenance: String(row.reset_provenance) as ResetProvenance,
      resetAuthoritative: Number(row.reset_authoritative) === 1,
      fallbackAttempt: Number(row.fallback_attempt),
      rampLimit: Number(row.ramp_limit),
      rampSuccesses: Number(row.ramp_successes),
      rampAdmissions: Number(row.ramp_admissions),
      lastOpenedAt: row.last_opened_at === null ? null : Number(row.last_opened_at),
      permitsInFlightAtOpen: Number(row.permits_in_flight_at_open),
      alreadyOnWireCompletions: Number(row.already_on_wire_completions),
      rejectedBeforeStart: Number(row.rejected_before_start),
      throttleObservations: Number(row.throttle_observations),
      telemetryComplete: Number(row.telemetry_complete) === 1,
    };
  }

  private writeStateSync(state: PoolState) {
    this.storage.sql.exec(
      `UPDATE ${STATE_TABLE}
          SET epoch = ?, state = ?, blocked_until = ?, reset_provenance = ?,
              reset_authoritative = ?, fallback_attempt = ?, ramp_limit = ?,
              ramp_successes = ?, ramp_admissions = ?, last_opened_at = ?, permits_in_flight_at_open = ?,
              already_on_wire_completions = ?, rejected_before_start = ?,
              throttle_observations = ?, telemetry_complete = ?
        WHERE singleton_id = 1`,
      state.epoch,
      state.state,
      state.blockedUntil,
      state.resetProvenance,
      state.resetAuthoritative ? 1 : 0,
      state.fallbackAttempt,
      state.rampLimit,
      state.rampSuccesses,
      state.rampAdmissions,
      state.lastOpenedAt,
      state.permitsInFlightAtOpen,
      state.alreadyOnWireCompletions,
      state.rejectedBeforeStart,
      state.throttleObservations,
      state.telemetryComplete ? 1 : 0,
    );
  }
}

function permitFromRow(row: Record<string, unknown>) {
  return {
    permitId: String(row.permit_id),
    callerHash: String(row.caller_hash),
    epoch: Number(row.epoch),
    mode: String(row.mode) as PermitMode,
    declaredBudget: Number(row.declared_budget),
    status: String(row.status) as "acquired" | "started" | "completed" | "expired",
    acquiredAt: Number(row.acquired_at),
    expiresAt: Number(row.expires_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function permitJson(permit: ReturnType<typeof permitFromRow>) {
  return {
    permit_id: permit.permitId,
    epoch: permit.epoch,
    mode: permit.mode,
    declared_budget: permit.declaredBudget,
    expires_at: new Date(permit.expiresAt).toISOString(),
  };
}

function credibleReset(
  observedAt: number,
  headers: ReturnType<typeof rateLimitHeaders>,
): { blockedUntil: number; provenance: "retry_after" | "rate_limit_reset" } | null {
  if (!headers) return null;
  const candidates: Array<{
    blockedUntil: number;
    provenance: "retry_after" | "rate_limit_reset";
  }> = [];
  if (
    headers.retryAfterPresent &&
    headers.retryAfterSeconds !== null &&
    headers.retryAfterSeconds >= 1 &&
    headers.retryAfterSeconds * 1_000 <= MAX_RESET_HORIZON_MS
  ) {
    candidates.push({
      blockedUntil: observedAt + headers.retryAfterSeconds * 1_000,
      provenance: "retry_after",
    });
  }
  if (headers.resetPresent && headers.resetEpochSeconds !== null) {
    const blockedUntil = headers.resetEpochSeconds * 1_000;
    if (blockedUntil >= observedAt - 5_000 && blockedUntil <= observedAt + MAX_RESET_HORIZON_MS) {
      candidates.push({
        blockedUntil: Math.max(observedAt + 1_000, blockedUntil),
        provenance: "rate_limit_reset",
      });
    }
  }
  return candidates.sort((left, right) => right.blockedUntil - left.blockedUntil)[0] ?? null;
}

function rateLimitHeaders(
  value: unknown,
  observedAt: number,
): {
  retryAfterPresent: boolean;
  retryAfterSeconds: number | null;
  resetPresent: boolean;
  resetEpochSeconds: number | null;
} | null {
  const item = objectValue(value);
  if (!item) return null;
  const retryAfterPresent = item.retry_after_present === true;
  const resetPresent = item.rate_limit_reset_present === true;
  const rawRetryAfterSeconds = nullableBoundedInteger(item.retry_after_seconds, 10_000_000_000);
  const rawResetEpochSeconds = nullableBoundedInteger(
    item.rate_limit_reset_epoch_seconds,
    10_000_000_000,
  );
  if (
    (item.retry_after_seconds !== null &&
      item.retry_after_seconds !== undefined &&
      rawRetryAfterSeconds === null) ||
    (item.rate_limit_reset_epoch_seconds !== null &&
      item.rate_limit_reset_epoch_seconds !== undefined &&
      rawResetEpochSeconds === null)
  ) {
    return null;
  }
  const retryAfterSeconds =
    rawRetryAfterSeconds !== null &&
    rawRetryAfterSeconds >= 1 &&
    rawRetryAfterSeconds * 1_000 <= MAX_RESET_HORIZON_MS
      ? rawRetryAfterSeconds
      : null;
  const resetEpochSeconds =
    rawResetEpochSeconds !== null &&
    rawResetEpochSeconds * 1_000 >= observedAt - 5_000 &&
    rawResetEpochSeconds * 1_000 <= observedAt + MAX_RESET_HORIZON_MS
      ? rawResetEpochSeconds
      : null;
  return { retryAfterPresent, retryAfterSeconds, resetPresent, resetEpochSeconds };
}

function poolConfig(env: Record<string, unknown>): PoolConfig {
  const maxPermits = boundedInteger(env.GITHUB_EGRESS_POOL_MAX_PERMITS, DEFAULT_MAX_PERMITS, 1, 8);
  if (![1, 2, 4, 8].includes(maxPermits))
    throw new Error("GITHUB_EGRESS_POOL_MAX_PERMITS must be 1, 2, 4, or 8");
  const fallbackBaseMs = boundedInteger(
    env.GITHUB_EGRESS_POOL_FALLBACK_BASE_MS,
    DEFAULT_FALLBACK_BASE_MS,
    60_000,
    30 * 60_000,
  );
  const fallbackMaxMs = boundedInteger(
    env.GITHUB_EGRESS_POOL_FALLBACK_MAX_MS,
    DEFAULT_FALLBACK_MAX_MS,
    fallbackBaseMs,
    MAX_RESET_HORIZON_MS,
  );
  const jitter = Number(
    env.GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO ?? DEFAULT_FALLBACK_JITTER_RATIO,
  );
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 0.5) {
    throw new Error("GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO must be between 0 and 0.5");
  }
  return {
    maxPermits,
    acquiredPermitTtlMs: boundedInteger(
      env.GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS,
      DEFAULT_ACQUIRED_PERMIT_TTL_MS,
      5_000,
      60_000,
    ),
    startedPermitTtlMs: boundedInteger(
      env.GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS,
      DEFAULT_STARTED_PERMIT_TTL_MS,
      60_000,
      30 * 60_000,
    ),
    fallbackBaseMs,
    fallbackMaxMs,
    fallbackJitterRatio: jitter,
    rampSuccessMultiplier: boundedInteger(
      env.GITHUB_EGRESS_POOL_RAMP_SUCCESS_MULTIPLIER,
      DEFAULT_RAMP_SUCCESS_MULTIPLIER,
      1,
      10,
    ),
    receiptTtlMs: boundedInteger(
      env.GITHUB_EGRESS_POOL_RECEIPT_TTL_MS,
      DEFAULT_RECEIPT_TTL_MS,
      60 * 60_000,
      7 * 24 * 60 * 60_000,
    ),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function nullableBoundedInteger(value: unknown, maximum: number): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
}

function safeDigest(value: unknown): string {
  const text = String(value || "");
  return /^[a-f0-9]{24}$/.test(text) ? text : "";
}

function safeReceipt(value: unknown): string {
  const text = String(value || "");
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function safePermitId(value: unknown): string {
  const text = String(value || "");
  return /^[A-Za-z0-9._:-]{8,100}$/.test(text) ? text : "";
}

function boundedRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rejectionResponse(
  reason: string,
  epoch: number,
  blockedUntil: number,
  resetProvenance: ResetProvenance,
  resetAuthoritative: boolean,
): Response {
  return json(
    {
      ok: true,
      granted: false,
      started: false,
      reason,
      epoch,
      blocked_until: blockedUntil ? new Date(blockedUntil).toISOString() : null,
      reset_provenance: resetProvenance,
      reset_authoritative: resetAuthoritative,
    },
    409,
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
