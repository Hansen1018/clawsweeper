import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { GithubEgressPoolCoordinator } from "../dashboard/github-egress-pool-coordinator.ts";
import { GithubEgressPoolCoordinatorClient } from "../dist/repair/github-egress-pool-client.js";
import worker from "../dashboard/worker.ts";
import { MemoryDurableStorage } from "./dashboard-worker-harness.ts";

const baseEnv = {
  GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
  GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
  GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
  GITHUB_EGRESS_POOL_FALLBACK_BASE_MS: "60000",
  GITHUB_EGRESS_POOL_FALLBACK_MAX_MS: "600000",
  GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO: "0",
  GITHUB_EGRESS_POOL_RAMP_SUCCESS_MULTIPLIER: "1",
};

test("first throttle advances one shared epoch and stops all not-started siblings", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T12:00:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const permits = [];
  for (let index = 0; index < 8; index += 1) {
    const response = await post(coordinator, "/acquire", {
      caller_hash: digest24(`batch-${index}`),
      declared_budget: 1,
    });
    assert.equal(response.status, 200);
    permits.push((await response.json()).permit);
  }

  for (let index = 0; index < 3; index += 1) {
    const response = await post(coordinator, "/start", startBody(permits[index]));
    assert.equal(response.status, 200);
  }
  const resetAt = now + 10 * 60_000;
  const opened = await post(coordinator, "/throttle", {
    ...startBody(permits[0]),
    receipt_id: digest64("first-throttle"),
    status: 403,
    observed_at: new Date(now).toISOString(),
    headers: {
      retry_after_present: false,
      retry_after_seconds: null,
      rate_limit_reset_present: true,
      rate_limit_reset_epoch_seconds: Math.floor(resetAt / 1000),
    },
  });
  assert.equal(opened.status, 200);
  const openedState = (await opened.json()).state;
  assert.equal(openedState.state, "open");
  assert.equal(openedState.epoch, 2);
  assert.equal(openedState.permits_in_flight_at_open, 2);
  assert.equal(openedState.reset_provenance, "rate_limit_reset");
  assert.equal(openedState.reset_authoritative, true);
  assert.equal(openedState.blocked_until, new Date(resetAt).toISOString());

  for (let index = 3; index < 8; index += 1) {
    const response = await post(coordinator, "/start", startBody(permits[index]));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "stale_epoch");
  }
  const replayedRejection = await post(coordinator, "/start", startBody(permits[3]));
  assert.equal(replayedRejection.status, 409);
  assert.equal((await replayedRejection.json()).reason, "stale_epoch");
  for (let index = 1; index < 3; index += 1) {
    const response = await post(coordinator, "/finish", {
      ...startBody(permits[index]),
      receipt_id: digest64(`wire-finish-${index}`),
      outcome: "success",
    });
    assert.equal(response.status, 200);
  }

  const duplicate = await post(coordinator, "/throttle", {
    ...startBody(permits[0]),
    receipt_id: digest64("first-throttle"),
    status: 403,
    observed_at: new Date(now).toISOString(),
    headers: {
      retry_after_present: false,
      retry_after_seconds: null,
      rate_limit_reset_present: true,
      rate_limit_reset_epoch_seconds: Math.floor(resetAt / 1000),
    },
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const snapshot = await observability(coordinator);
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.rejected_before_start, 5);
  assert.equal(snapshot.avoided_operations, 5);
  assert.equal(snapshot.already_on_wire_completions, 2);
  assert.equal(snapshot.throttle_observations, 1);
  assert.equal(snapshot.telemetry_complete, true);

  const restarted = createCoordinator(
    storage,
    () => now,
    () => `restart-${++permitSequence}`,
  );
  assert.deepEqual(
    pick(await observability(restarted), [
      "state",
      "epoch",
      "blocked_until",
      "reset_provenance",
      "reset_authoritative",
      "rejected_before_start",
      "already_on_wire_completions",
    ]),
    pick(snapshot, [
      "state",
      "epoch",
      "blocked_until",
      "reset_provenance",
      "reset_authoritative",
      "rejected_before_start",
      "already_on_wire_completions",
    ]),
  );

  now = resetAt;
  const probe = await acquire(restarted, "probe-1");
  assert.equal(probe.mode, "probe");
  const rejectedProbe = await post(restarted, "/acquire", {
    caller_hash: digest24("probe-2"),
    declared_budget: 1,
  });
  assert.equal(rejectedProbe.status, 409);
  assert.equal((await rejectedProbe.json()).reason, "probe_in_flight");
});

test("replayed acquire and start rejections do not inflate avoided-operation counters", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.parse("2026-08-12T12:30:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const permits = [];
  for (let index = 0; index < 8; index += 1) {
    permits.push(await acquire(coordinator, `capacity-${index}`));
  }

  const acquireBody = { caller_hash: digest24("capacity-rejected"), declared_budget: 1 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await post(coordinator, "/acquire", acquireBody);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "capacity_deferred");
  }

  await start(coordinator, permits[0]);
  await throttle(coordinator, permits[0], "idempotent-throttle", now, {});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await post(coordinator, "/start", startBody(permits[1]));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "stale_epoch");
  }

  const snapshot = await observability(coordinator);
  assert.equal(snapshot.rejected_before_start, 2);
  assert.equal(snapshot.avoided_operations, 2);
  assert.equal(sqlCount(storage, "github_egress_pool_rejections"), 2);
});

test("a lost successful start response cannot replay across a throttle epoch", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.parse("2026-08-12T12:45:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const lostResponsePermit = await acquire(coordinator, "lost-start-response");
  const throttlingPermit = await acquire(coordinator, "interleaved-throttle");

  const committedStart = await post(coordinator, "/start", startBody(lostResponsePermit));
  assert.equal(committedStart.status, 200);
  assert.equal((await committedStart.json()).started, true);
  await start(coordinator, throttlingPermit);
  await throttle(coordinator, throttlingPermit, "interleaved-throttle", now, {});

  const replay = await post(coordinator, "/start", startBody(lostResponsePermit));
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).reason, "stale_epoch");
  const duplicateReplay = await post(coordinator, "/start", startBody(lostResponsePermit));
  assert.equal(duplicateReplay.status, 409);
  assert.equal((await duplicateReplay.json()).reason, "stale_epoch");

  const snapshot = await observability(coordinator);
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.permits_in_flight_at_open, 1);
  assert.equal(snapshot.rejected_before_start, 1);
  assert.equal(snapshot.avoided_operations, 1);
});

test("a completed start replay stays idempotent across later epochs", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.parse("2026-08-12T12:50:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `completed-replay-permit-${++permitSequence}`,
  );
  const permit = await acquire(coordinator, "completed-replay");
  const laterPermit = await acquire(coordinator, "later-throttle");
  await start(coordinator, permit);
  await finish(coordinator, permit, "completed-replay", "success");
  await start(coordinator, laterPermit);
  await throttle(coordinator, laterPermit, "later-throttle", now, {});

  const replay = await post(coordinator, "/start", startBody(permit));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ok: true,
    started: false,
    already_completed: true,
    epoch: 1,
  });
  const snapshot = await observability(coordinator);
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.rejected_before_start, 0);
  assert.equal(snapshot.avoided_operations, 0);

  const client = new GithubEgressPoolCoordinatorClient({
    baseUrl: "http://127.0.0.1",
    webhookSecret: "completed-replay-test",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const operation = new URL(request.url).pathname.split("/").at(-1);
      return coordinator.fetch(
        new Request(`https://pool.test/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        }),
      );
    },
  });
  const parsedReplay = await client.start({
    permit: {
      permitId: String(permit.permit_id),
      epoch: Number(permit.epoch),
      mode: String(permit.mode) as "normal",
      declaredBudget: Number(permit.declared_budget),
      expiresAt: String(permit.expires_at),
    },
    operationIndex: 1,
  });
  assert.deepEqual(parsedReplay, {
    granted: false,
    reason: "already_completed",
    epoch: 1,
    blockedUntil: null,
    resetProvenance: "none",
    resetAuthoritative: false,
  });
});

test("legacy recovery state backfills fixed-cohort admissions", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE github_egress_pool_state (
       singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
       epoch INTEGER NOT NULL CHECK (epoch >= 1),
       state TEXT NOT NULL CHECK (state IN ('closed', 'open', 'half_open', 'recovering')),
       blocked_until INTEGER NOT NULL,
       reset_provenance TEXT NOT NULL CHECK (reset_provenance IN ('none', 'retry_after', 'rate_limit_reset', 'fallback')),
       reset_authoritative INTEGER NOT NULL CHECK (reset_authoritative IN (0, 1)),
       fallback_attempt INTEGER NOT NULL CHECK (fallback_attempt >= 0),
       ramp_limit INTEGER NOT NULL CHECK (ramp_limit >= 1),
       ramp_successes INTEGER NOT NULL CHECK (ramp_successes >= 0),
       last_opened_at INTEGER,
       permits_in_flight_at_open INTEGER NOT NULL CHECK (permits_in_flight_at_open >= 0),
       already_on_wire_completions INTEGER NOT NULL CHECK (already_on_wire_completions >= 0),
       rejected_before_start INTEGER NOT NULL CHECK (rejected_before_start >= 0),
       throttle_observations INTEGER NOT NULL CHECK (throttle_observations >= 0),
       telemetry_complete INTEGER NOT NULL CHECK (telemetry_complete IN (0, 1))
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO github_egress_pool_state VALUES
       (1, 7, 'recovering', 0, 'none', 0, 0, 4, 2, NULL, 0, 0, 0, 0, 1)`,
  );
  storage.sql.exec(
    `CREATE TABLE github_egress_pool_permits (
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
  const legacyNow = Date.parse("2026-08-12T12:55:00Z");
  storage.sql.exec(
    `INSERT INTO github_egress_pool_permits VALUES
       ('legacy-acquired', ?, 7, 'ramp', 1, 'acquired', ?, ?, NULL),
       ('legacy-started', ?, 7, 'ramp', 1, 'started', ?, ?, NULL),
       ('legacy-complete', ?, 7, 'ramp', 1, 'completed', ?, ?, ?),
       ('other-epoch', ?, 6, 'ramp', 1, 'started', ?, ?, NULL)`,
    digest24("legacy-acquired"),
    legacyNow,
    legacyNow + 5_000,
    digest24("legacy-started"),
    legacyNow,
    legacyNow + 60_000,
    digest24("legacy-complete"),
    legacyNow,
    legacyNow + 60_000,
    legacyNow,
    digest24("other-epoch"),
    legacyNow,
    legacyNow + 60_000,
  );
  const coordinator = createCoordinator(
    storage,
    () => legacyNow,
    () => "migrated-permit-1",
  );
  const snapshot = await observability(coordinator);
  assert.equal(snapshot.ramp.admitted, 4);
  assert.equal(snapshot.ramp.outstanding, 2);
  assert.equal(
    Array.from(
      storage.sql.exec(
        `SELECT name FROM pragma_table_info('github_egress_pool_state')
          WHERE name = 'ramp_admissions'`,
      ),
    ).length,
    1,
  );
  const replacement = await post(coordinator, "/acquire", {
    caller_hash: digest24("legacy-replacement"),
    declared_budget: 1,
  });
  assert.equal(replacement.status, 409);
  assert.equal((await replacement.json()).reason, "ramp_cohort_full");
});

test("headerless throttled probe persists shared backoff and successful probe ramps 1-2-4-8", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:00:00Z");
  let permitSequence = 0;
  let coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial");
  await start(coordinator, first);
  const resetAt = now + 60_000;
  await throttle(coordinator, first, "initial-throttle", now, {
    reset: Math.floor(resetAt / 1000),
  });

  now = resetAt;
  const failedProbe = await acquire(coordinator, "failed-probe");
  assert.equal(failedProbe.mode, "probe");
  await start(coordinator, failedProbe);
  await throttle(coordinator, failedProbe, "failed-probe", now, {});
  let snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.epoch, 3);
  assert.equal(snapshot.reset_provenance, "fallback");
  assert.equal(snapshot.reset_authoritative, false);
  assert.equal(snapshot.fallback_attempt, 1);
  assert.equal(snapshot.blocked_until, new Date(now + 60_000).toISOString());

  coordinator = createCoordinator(
    storage,
    () => now,
    () => `restart-${++permitSequence}`,
  );
  assert.equal((await observability(coordinator)).fallback_attempt, 1);
  now += 60_000;
  const successfulProbe = await acquire(coordinator, "successful-probe");
  await start(coordinator, successfulProbe);
  await finish(coordinator, successfulProbe, "successful-probe", "success");
  snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "recovering");
  assert.equal(snapshot.ramp.limit, 1);

  for (const limit of [1, 2, 4, 8]) {
    const wave = [];
    for (let index = 0; index < limit; index += 1) {
      const permit = await acquire(coordinator, `ramp-${limit}-${index}`);
      assert.equal(permit.mode, "ramp");
      wave.push(permit);
    }
    const beyond = await post(coordinator, "/acquire", {
      caller_hash: digest24(`ramp-${limit}-beyond`),
      declared_budget: 1,
    });
    assert.equal(beyond.status, 409);
    assert.equal((await beyond.json()).reason, "ramp_cohort_full");
    for (const permit of wave) await start(coordinator, permit);
    for (const [index, permit] of wave.entries()) {
      await finish(coordinator, permit, `ramp-${limit}-${index}`, "success");
    }
    snapshot = await observability(coordinator);
    if (limit < 8) {
      assert.equal(snapshot.state, "recovering");
      assert.equal(snapshot.ramp.limit, limit * 2);
    }
  }
  assert.equal(snapshot.state, "closed");
  assert.equal(snapshot.ramp.limit, 8);
  assert.equal(snapshot.fallback_attempt, 0);
});

test("an expired started recovery operation reopens instead of advancing the ramp", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:20:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "initial-throttle", now, {});
  now += 60_000;

  const probe = await acquire(coordinator, "successful-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "successful-probe", "success");
  assert.equal((await observability(coordinator)).state, "recovering");

  const ramp = await acquire(coordinator, "expired-ramp");
  assert.equal(ramp.mode, "ramp");
  await start(coordinator, ramp);
  now += 60_001;
  const reopened = await observability(coordinator);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.epoch, 3);
  assert.equal(reopened.reset_provenance, "fallback");
  assert.equal(reopened.fallback_attempt, 2);
  assert.equal(reopened.blocked_until, new Date(now + 120_000).toISOString());
  assert.equal(reopened.telemetry_complete, false);
  const rejected = await post(coordinator, "/acquire", {
    caller_hash: digest24("must-not-advance"),
    declared_budget: 1,
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).reason, "circuit_open");
});

test("non-throttled command failures advance probe and ramp recovery", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:20:30Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "initial-throttle", now, {});
  now += 60_000;

  const probe = await acquire(coordinator, "non-throttled-failed-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "non-throttled-failed-probe", "failure");
  let recovery = await observability(coordinator);
  assert.equal(recovery.state, "recovering");
  assert.equal(recovery.epoch, 2);
  assert.equal(recovery.ramp.limit, 1);

  const firstRamp = await acquire(coordinator, "non-throttled-failed-ramp");
  await start(coordinator, firstRamp);
  await finish(coordinator, firstRamp, "non-throttled-failed-ramp", "failure");
  recovery = await observability(coordinator);
  assert.equal(recovery.state, "recovering");
  assert.equal(recovery.epoch, 2);
  assert.equal(recovery.ramp.limit, 2);
  assert.equal(recovery.reset_provenance, "fallback");
});

test("unexecuted probe failure reopens recovery without claiming quota health", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:20:35Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "initial-throttle", now, {});
  now += 60_000;

  const probe = await acquire(coordinator, "unexecuted-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "unexecuted-probe", "unexecuted_failure");
  const reopened = await observability(coordinator);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.epoch, 3);
  assert.equal(reopened.reset_provenance, "fallback");
});

test("unexecuted ramp failure reopens recovery and snapshots on-wire siblings", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:20:40Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "initial-throttle", now, {});
  now += 60_000;
  const probe = await acquire(coordinator, "successful-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "successful-probe", "success");
  const firstRamp = await acquire(coordinator, "first-ramp");
  await start(coordinator, firstRamp);
  await finish(coordinator, firstRamp, "first-ramp", "success");

  const failed = await acquire(coordinator, "unexecuted-ramp");
  const sibling = await acquire(coordinator, "on-wire-ramp-sibling");
  await start(coordinator, failed);
  await start(coordinator, sibling);
  await finish(coordinator, failed, "unexecuted-ramp", "unexecuted_failure");
  let reopened = await observability(coordinator);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.epoch, 3);
  assert.equal(reopened.permits_in_flight_at_open, 1);
  await finish(coordinator, sibling, "on-wire-ramp-sibling", "success");
  reopened = await observability(coordinator);
  assert.equal(reopened.already_on_wire_completions, 1);
});

test("an expired recovery operation snapshots a later-started sibling already on wire", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:20:45Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "initial-throttle", now, {});
  now += 60_000;

  const probe = await acquire(coordinator, "successful-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "successful-probe", "success");
  const firstRamp = await acquire(coordinator, "first-ramp");
  await start(coordinator, firstRamp);
  await finish(coordinator, firstRamp, "first-ramp", "success");

  const expiring = await acquire(coordinator, "expiring-ramp");
  const sibling = await acquire(coordinator, "later-on-wire-ramp-sibling");
  await start(coordinator, expiring);
  now += 1_000;
  await start(coordinator, sibling);
  now += 59_001;

  let reopened = await observability(coordinator);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.epoch, 3);
  assert.equal(reopened.permits_in_flight_at_open, 1);
  assert.equal(reopened.telemetry_complete, false);
  await finish(coordinator, sibling, "later-on-wire-ramp-sibling", "success");
  reopened = await observability(coordinator);
  assert.equal(reopened.permits_in_flight_at_open, 1);
  assert.equal(reopened.already_on_wire_completions, 1);
});

test("an expired acquired recovery permit reopens rather than replenishing its cohort", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:21:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "initial-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "initial-throttle", now, {});
  now += 60_000;

  const probe = await acquire(coordinator, "successful-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "successful-probe", "success");
  const unstarted = await acquire(coordinator, "unstarted-ramp");
  assert.equal(unstarted.mode, "ramp");
  assert.equal((await observability(coordinator)).ramp.admitted, 1);

  now += 5_001;
  const reopened = await observability(coordinator);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.epoch, 3);
  assert.equal(reopened.reset_provenance, "fallback");
  assert.equal(reopened.ramp.admitted, 0);
  assert.equal(reopened.telemetry_complete, true);
  const replacement = await post(coordinator, "/acquire", {
    caller_hash: digest24("expired-ramp-replacement"),
    declared_budget: 1,
  });
  assert.equal(replacement.status, 409);
  assert.equal((await replacement.json()).reason, "circuit_open");
});

test("the final recovery cohort cannot replenish or close with unresolved work", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:22:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "final-cohort-throttle");
  await start(coordinator, first);
  await throttle(coordinator, first, "final-cohort-throttle", now, {});
  now += 60_000;

  const probe = await acquire(coordinator, "final-cohort-probe");
  await start(coordinator, probe);
  await finish(coordinator, probe, "final-cohort-probe", "success");

  for (const limit of [1, 2, 4]) {
    const wave = [];
    for (let index = 0; index < limit; index += 1) {
      wave.push(await acquire(coordinator, `pre-final-${limit}-${index}`));
    }
    for (const permit of wave) await start(coordinator, permit);
    for (const [index, permit] of wave.entries()) {
      await finish(coordinator, permit, `pre-final-${limit}-${index}`, "success");
    }
  }

  const finalWave = [];
  for (let index = 0; index < 8; index += 1) {
    finalWave.push(await acquire(coordinator, `final-${index}`));
  }
  for (const permit of finalWave) await start(coordinator, permit);
  await finish(coordinator, finalWave[0], "final-0", "success");

  const replacement = await post(coordinator, "/acquire", {
    caller_hash: digest24("final-replacement"),
    declared_budget: 1,
  });
  assert.equal(replacement.status, 409);
  assert.equal((await replacement.json()).reason, "ramp_cohort_full");
  let snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "recovering");
  assert.equal(snapshot.ramp.limit, 8);
  assert.equal(snapshot.ramp.admitted, 8);
  assert.equal(snapshot.ramp.successes, 1);
  assert.equal(snapshot.ramp.outstanding, 7);

  for (let index = 1; index < 7; index += 1) {
    await finish(coordinator, finalWave[index], `final-${index}`, "success");
  }
  snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "recovering");
  assert.equal(snapshot.ramp.successes, 7);
  assert.equal(snapshot.ramp.outstanding, 1);

  now += 60_001;
  snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.epoch, 3);
  assert.equal(snapshot.reset_provenance, "fallback");
  assert.equal(snapshot.telemetry_complete, false);
});

test("started work from an obsolete epoch does not consume probe or ramp capacity", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:25:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const throttled = await acquire(coordinator, "throttled-sibling");
  const lateSibling = await acquire(coordinator, "late-sibling");
  await start(coordinator, throttled);
  await start(coordinator, lateSibling);
  const resetAt = now + 30_000;
  await throttle(coordinator, throttled, "first-throttle", now, {
    reset: Math.floor(resetAt / 1000),
  });

  now = resetAt;
  const probe = await acquire(coordinator, "new-epoch-probe");
  assert.equal(probe.mode, "probe");
  assert.equal(probe.epoch, 2);
  await start(coordinator, probe);
  await finish(coordinator, probe, "new-epoch-probe", "success");

  const ramp = await acquire(coordinator, "new-epoch-ramp");
  assert.equal(ramp.mode, "ramp");
  assert.equal(ramp.epoch, 2);
  await start(coordinator, ramp);
  const snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "recovering");
  assert.equal(snapshot.permits_in_flight, 1);
});

test("a fresh headerless stale-epoch throttle extends the shared fallback boundary", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:27:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "first-throttle");
  const lateSibling = await acquire(coordinator, "late-headerless-sibling");
  await start(coordinator, first);
  await start(coordinator, lateSibling);
  await throttle(coordinator, first, "first-headerless-throttle", now, {});
  const originalBoundary = now + 60_000;
  let snapshot = await observability(coordinator);
  assert.equal(snapshot.blocked_until, new Date(originalBoundary).toISOString());
  assert.equal(snapshot.fallback_attempt, 1);
  const openedAt = snapshot.last_opened_at;

  now = originalBoundary - 1_000;
  await throttle(coordinator, lateSibling, "late-headerless-throttle", now, {});
  snapshot = await observability(coordinator);
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.fallback_attempt, 2);
  assert.equal(snapshot.blocked_until, new Date(now + 120_000).toISOString());
  assert.equal(snapshot.reset_provenance, "fallback");
  assert.equal(snapshot.reset_authoritative, false);
  assert.equal(snapshot.throttle_observations, 2);
  assert.equal(snapshot.already_on_wire_completions, 1);
  assert.equal(snapshot.last_opened_at, openedAt);

  const duplicate = await throttle(coordinator, lateSibling, "late-headerless-throttle", now, {});
  assert.equal(duplicate.duplicate, true);
  assert.equal((await observability(coordinator)).blocked_until, snapshot.blocked_until);
});

test("a late stale-epoch throttle reopens a recovered pool", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T13:30:00Z");
  let permitSequence = 0;
  const coordinator = createCoordinator(
    storage,
    () => now,
    () => `permit-${++permitSequence}`,
  );
  const first = await acquire(coordinator, "first-throttle");
  const lateSibling = await acquire(coordinator, "late-sibling");
  await start(coordinator, first);
  await start(coordinator, lateSibling);
  const resetAt = now + 60_000;
  await throttle(coordinator, first, "first-throttle", now, {
    reset: Math.floor(resetAt / 1000),
  });

  // The late sibling crosses its started-operation TTL and remains a bounded,
  // telemetry-incomplete old wire. Recovery of the new epoch must not make a
  // later throttle from that old wire safe to ignore.
  now = resetAt;
  const probe = await acquire(coordinator, "probe-after-late-wire");
  await start(coordinator, probe);
  await finish(coordinator, probe, "probe-after-late-wire", "success");
  for (const limit of [1, 2, 4, 8]) {
    const wave = [];
    for (let index = 0; index < limit; index += 1) {
      const permit = await acquire(coordinator, `late-ramp-${limit}-${index}`);
      await start(coordinator, permit);
      wave.push(permit);
    }
    for (const [index, permit] of wave.entries()) {
      await finish(coordinator, permit, `late-ramp-${limit}-${index}`, "success");
    }
  }
  assert.equal((await observability(coordinator)).state, "closed");

  const lateResetAt = now + 2 * 60_000;
  await throttle(coordinator, lateSibling, "late-sibling-throttle", now, {
    reset: Math.floor(lateResetAt / 1000),
  });
  const reopened = await observability(coordinator);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.epoch, 3);
  assert.equal(reopened.reset_provenance, "rate_limit_reset");
  assert.equal(reopened.blocked_until, new Date(lateResetAt).toISOString());
  assert.equal(reopened.already_on_wire_completions, 1);
  assert.equal(reopened.telemetry_complete, false);
});

test("expired permits reject before wire and separate pool objects remain independent", async () => {
  const repositoryStorage = new MemoryDurableStorage();
  const otherStorage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T14:00:00Z");
  let repositoryPermitSequence = 0;
  const repository = createCoordinator(
    repositoryStorage,
    () => now,
    () => `repository-permit-${++repositoryPermitSequence}`,
  );
  const healthyOther = createCoordinator(
    otherStorage,
    () => now,
    () => "other-pool-permit",
  );
  const expired = await acquire(repository, "expired");
  now += 5_001;
  const rejected = await post(repository, "/start", startBody(expired));
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).reason, "permit_expired");

  const repositoryPermit = await acquire(repository, "repository-throttle");
  await start(repository, repositoryPermit);
  await throttle(repository, repositoryPermit, "repository-throttle", now, {});
  assert.equal((await observability(repository)).state, "open");

  const independent = await acquire(healthyOther, "healthy-other");
  await start(healthyOther, independent);
  await finish(healthyOther, independent, "healthy-other", "success");
  assert.equal((await observability(healthyOther)).state, "closed");

  const publicJson = JSON.stringify(await observability(repository));
  for (const sentinel of [
    "openclaw/clawsweeper",
    "repository-throttle",
    repositoryPermit.permit_id,
    digest24("repository-throttle"),
    "https://",
    "installation",
  ]) {
    assert.doesNotMatch(publicJson, new RegExp(escapeRegExp(sentinel)));
  }
});

test("Worker derives the repository pool shard, authenticates mutations, and exposes sanitized state", async () => {
  const storage = new MemoryDurableStorage();
  const coordinator = createCoordinator(
    storage,
    () => Date.parse("2026-08-12T15:00:00Z"),
    () => "route-permit-1",
  );
  let shardName = "";
  const namespace = {
    idFromName(name: string) {
      shardName = name;
      return name;
    },
    get() {
      return coordinator;
    },
  };
  const secret = "route-test-secret";
  const env = {
    CLAWSWEEPER_REPO: "OpenClaw/ClawSweeper",
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    GITHUB_EGRESS_POOL_COORDINATOR: namespace,
  };
  const url = "https://clawsweeper.openclaw.ai/internal/github-egress-pool/acquire";
  const body = JSON.stringify({ caller_hash: digest24("route-caller"), declared_budget: 1 });
  const unsigned = await worker.fetch(new Request(url, { method: "POST", body }), env);
  assert.equal(unsigned.status, 401);

  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const acquired = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body,
    }),
    env,
  );
  assert.equal(acquired.status, 200, await acquired.clone().text());
  assert.equal((await acquired.json()).granted, true);
  assert.equal(shardName, "repository_actions:openclaw/clawsweeper");

  const publicResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/github-egress-pool-coordinator"),
    env,
  );
  assert.equal(publicResponse.status, 200);
  const publicText = await publicResponse.text();
  assert.match(publicText, /"pool_class":"repository_actions"/);
  for (const sentinel of ["OpenClaw/ClawSweeper", "route-caller", "route-permit-1", secret]) {
    assert.doesNotMatch(publicText, new RegExp(escapeRegExp(sentinel), "i"));
  }
});

test("unsafe coordinator configuration fails before serving permits", () => {
  assert.throws(
    () =>
      new GithubEgressPoolCoordinator(
        { storage: new MemoryDurableStorage() },
        { ...baseEnv, GITHUB_EGRESS_POOL_MAX_PERMITS: "3" },
      ),
    /must be 1, 2, 4, or 8/,
  );
  assert.throws(
    () =>
      new GithubEgressPoolCoordinator(
        { storage: new MemoryDurableStorage() },
        { ...baseEnv, GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO: "0.75" },
      ),
    /must be between 0 and 0.5/,
  );
});

test("completed permit operations and idempotence receipts have bounded retention", async () => {
  const storage = new MemoryDurableStorage();
  let now = Date.parse("2026-08-12T16:00:00Z");
  const coordinator = new GithubEgressPoolCoordinator(
    { storage },
    { ...baseEnv, GITHUB_EGRESS_POOL_MAX_PERMITS: "1" },
    {
      now: () => now,
      permitId: () => "retained-permit-1",
      random: () => 0.5,
    },
  );
  const permit = await acquire(coordinator, "retention");
  const rejected = await post(coordinator, "/acquire", {
    caller_hash: digest24("retention-rejected"),
    declared_budget: 1,
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).reason, "capacity_deferred");
  await start(coordinator, permit);
  await finish(coordinator, permit, "retention", "success");
  assert.equal(sqlCount(storage, "github_egress_pool_permits"), 1);
  assert.equal(sqlCount(storage, "github_egress_pool_operations"), 1);
  assert.equal(sqlCount(storage, "github_egress_pool_receipts"), 1);
  assert.equal(sqlCount(storage, "github_egress_pool_rejections"), 1);

  now += 24 * 60 * 60_000 + 1;
  await observability(coordinator);
  assert.equal(sqlCount(storage, "github_egress_pool_permits"), 0);
  assert.equal(sqlCount(storage, "github_egress_pool_operations"), 0);
  assert.equal(sqlCount(storage, "github_egress_pool_receipts"), 0);
  assert.equal(sqlCount(storage, "github_egress_pool_rejections"), 0);
});

function createCoordinator(
  storage: MemoryDurableStorage,
  now: () => number,
  permitId: () => string,
) {
  return new GithubEgressPoolCoordinator({ storage }, baseEnv, {
    now,
    permitId,
    random: () => 0.5,
  });
}

async function post(
  coordinator: GithubEgressPoolCoordinator,
  path: string,
  body: Record<string, unknown>,
) {
  return coordinator.fetch(
    new Request(`https://pool.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function observability(coordinator: GithubEgressPoolCoordinator) {
  const response = await coordinator.fetch(new Request("https://pool.test/observability"));
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, any>>;
}

async function acquire(coordinator: GithubEgressPoolCoordinator, key: string) {
  const response = await post(coordinator, "/acquire", {
    caller_hash: digest24(key),
    declared_budget: 1,
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return (await response.json()).permit;
}

async function start(coordinator: GithubEgressPoolCoordinator, permit: Record<string, unknown>) {
  const response = await post(coordinator, "/start", startBody(permit));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
}

async function finish(
  coordinator: GithubEgressPoolCoordinator,
  permit: Record<string, unknown>,
  receipt: string,
  outcome: "success" | "failure" | "unexecuted_failure",
) {
  const response = await post(coordinator, "/finish", {
    ...startBody(permit),
    receipt_id: digest64(receipt),
    outcome,
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
}

async function throttle(
  coordinator: GithubEgressPoolCoordinator,
  permit: Record<string, unknown>,
  receipt: string,
  observedAt: number,
  options: { reset?: number },
) {
  const response = await post(coordinator, "/throttle", {
    ...startBody(permit),
    receipt_id: digest64(receipt),
    status: 403,
    observed_at: new Date(observedAt).toISOString(),
    headers: {
      retry_after_present: false,
      retry_after_seconds: null,
      rate_limit_reset_present: options.reset !== undefined,
      rate_limit_reset_epoch_seconds: options.reset ?? null,
    },
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return response.json();
}

function startBody(permit: Record<string, unknown>) {
  return {
    permit_id: permit.permit_id,
    epoch: permit.epoch,
    operation_index: 1,
  };
}

function digest24(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function digest64(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function pick(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sqlCount(storage: MemoryDurableStorage, table: string) {
  return Number(Array.from(storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count);
}
