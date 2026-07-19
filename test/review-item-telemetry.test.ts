import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildReviewTelemetryRecord,
  reviewTelemetryAttribution,
} from "../scripts/review-item-telemetry.mjs";

test("review telemetry producer attributes all review lanes independently", () => {
  assert.deepEqual(
    reviewTelemetryAttribution({
      exact: true,
      sourceEvent: "pull_request",
      eventName: "repository_dispatch",
    }),
    { lane: "exact_event", origin: "webhook" },
  );
  assert.deepEqual(reviewTelemetryAttribution({ hotIntake: true, eventName: "schedule" }), {
    lane: "hot_intake",
    origin: "schedule",
  });
  assert.deepEqual(reviewTelemetryAttribution({ eventName: "schedule" }), {
    lane: "normal_backfill",
    origin: "schedule",
  });
  assert.deepEqual(reviewTelemetryAttribution({ sourceAction: "failed_review_shard_recovery" }), {
    lane: "recovery",
    origin: "system",
  });
});

test("review telemetry terminal preserves identity, start time, and accumulated phases", () => {
  const existing = {
    started_at: "2026-07-19T00:00:00.000Z",
    phase_durations_ms: { queue: 120, claim: 40, review: 900 },
  };
  const record = buildReviewTelemetryRecord(
    {
      action: "terminal",
      repo: "openclaw/clawsweeper",
      itemNumber: 674,
      runId: "123",
      runAttempt: 2,
      generation: 7,
      operationId: "operation-12345678901234567890",
      triggerLane: "exact_event",
      triggerOrigin: "command",
      sourceEvent: "issue_comment",
      sourceAction: "review_command",
      outcome: "superseded",
      terminalReason: "generation_superseded",
      phaseDurations: { publication: 300 },
    },
    existing,
    new Date("2026-07-19T00:00:02.000Z"),
  );
  assert.equal(record.status, "completed");
  assert.equal(record.started_at, existing.started_at);
  assert.equal(record.outcome, "superseded");
  assert.equal(record.terminal_reason, "generation_superseded");
  assert.deepEqual(record.phase_durations_ms, {
    queue: 120,
    claim: 40,
    review: 900,
    publication: 300,
    total: 2_000,
  });
});

test("review telemetry heartbeat advances total wall-clock duration", () => {
  const record = buildReviewTelemetryRecord(
    {
      action: "heartbeat",
      repo: "openclaw/clawsweeper",
      itemNumber: 674,
      runId: "123",
      runAttempt: 2,
      triggerLane: "normal_backfill",
      triggerOrigin: "schedule",
      phaseDurations: { review: 900 },
    },
    {
      started_at: "2026-07-19T00:00:00.000Z",
      phase_durations_ms: { total: 1, queue: 120 },
    },
    new Date("2026-07-19T00:00:02.000Z"),
  );

  assert.deepEqual(record.phase_durations_ms, { total: 2_000, queue: 120, review: 900 });
});

test("review telemetry CLI warns and reports a failed optional write", () => {
  const script = fileURLToPath(new URL("../scripts/review-item-telemetry.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {},
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /::warning::Review telemetry producer skipped:/);
});
