#!/usr/bin/env node

import { createHmac } from "node:crypto";

const PHASES = ["queue", "claim", "review", "publication", "total"];

export function reviewTelemetryAttribution(input) {
  const sourceAction = String(input.sourceAction || "").toLowerCase();
  const sourceEvent = String(input.sourceEvent || "").toLowerCase();
  const eventName = String(input.eventName || "").toLowerCase();
  const recovery = sourceAction.includes("recovery") || input.recovery === true;
  const command =
    sourceAction.includes("command") ||
    sourceAction.includes("router") ||
    sourceEvent === "issue_comment";
  const lane = recovery
    ? "recovery"
    : input.exact === true
      ? "exact_event"
      : input.hotIntake === true
        ? "hot_intake"
        : "normal_backfill";
  const origin = command
    ? "command"
    : eventName === "schedule"
      ? "schedule"
      : eventName === "workflow_dispatch"
        ? "manual"
        : eventName === "repository_dispatch" &&
            (sourceEvent === "issues" || sourceEvent === "pull_request")
          ? "webhook"
          : "system";
  return { lane, origin };
}

export function buildReviewTelemetryRecord(input, existing, now = new Date()) {
  const nowIso = now.toISOString();
  const startedAt = existing?.started_at || input.startedAt || nowIso;
  const phaseDurations = { ...existing?.phase_durations_ms };
  for (const phase of PHASES) {
    const value = input.phaseDurations?.[phase];
    if (Number.isSafeInteger(value) && value >= 0) phaseDurations[phase] = value;
  }
  // Total is a live wall-clock duration, so carrying the start payload's value
  // forward would make healthy heartbeats look permanently stalled.
  phaseDurations.total =
    input.phaseDurations?.total ?? Math.max(0, now.getTime() - Date.parse(startedAt));
  const terminal = input.action === "terminal";
  return {
    repo: input.repo,
    item_number: input.itemNumber,
    run_id: input.runId,
    run_attempt: input.runAttempt,
    status: terminal ? "completed" : "refreshing",
    outcome: terminal ? input.outcome : null,
    started_at: startedAt,
    updated_at: nowIso,
    lease_expires_at: terminal ? null : input.leaseExpiresAt,
    phase_durations_ms: phaseDurations,
    generation: input.generation,
    operation_id: input.operationId,
    trigger_lane: input.triggerLane,
    trigger_origin: input.triggerOrigin,
    ...(input.sourceEvent && { source_event: input.sourceEvent }),
    ...(input.sourceAction && { source_action: input.sourceAction }),
    ...(terminal ? { terminal_reason: input.terminalReason, terminal_at: nowIso } : {}),
  };
}

function elapsed(start, end) {
  const startMs = Date.parse(String(start || ""));
  const endMs = Date.parse(String(end || ""));
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? endMs - startMs
    : undefined;
}

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function optionalDuration(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function existingRecord(queueUrl, input) {
  if (input.action === "start") return undefined;
  const url = new URL("/api/exact-review-queue/reviews", queueUrl);
  url.searchParams.set("repo", input.repo);
  url.searchParams.set("item_number", String(input.itemNumber));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`telemetry read returned HTTP ${response.status}`);
  const body = await response.json();
  return body.reviews?.find(
    (record) => record.run_id === input.runId && Number(record.run_attempt) === input.runAttempt,
  );
}

async function writeRecord(queueUrl, secret, record) {
  const payload = JSON.stringify(record);
  const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const response = await fetch(new URL("/internal/exact-review/review-telemetry", queueUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body: payload,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`telemetry write returned HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function runReviewTelemetryProducer() {
  const action = required("REVIEW_TELEMETRY_ACTION");
  if (!["start", "heartbeat", "terminal"].includes(action)) {
    throw new Error("REVIEW_TELEMETRY_ACTION must be start, heartbeat, or terminal");
  }
  const sourceEvent = String(process.env.REVIEW_TELEMETRY_SOURCE_EVENT || "").trim();
  const sourceAction = String(process.env.REVIEW_TELEMETRY_SOURCE_ACTION || "").trim();
  const attribution = reviewTelemetryAttribution({
    sourceEvent,
    sourceAction,
    eventName: process.env.GITHUB_EVENT_NAME,
    exact: process.env.REVIEW_TELEMETRY_EXACT === "true",
    hotIntake: process.env.REVIEW_TELEMETRY_HOT_INTAKE === "true",
    recovery: process.env.REVIEW_TELEMETRY_RECOVERY === "true",
  });
  const leaseMs = optionalDuration("REVIEW_TELEMETRY_LEASE_MS");
  const now = new Date();
  const input = {
    action,
    repo: required("REVIEW_TELEMETRY_REPO"),
    itemNumber: positiveInteger("item number", process.env.REVIEW_TELEMETRY_ITEM_NUMBER),
    runId: required("REVIEW_TELEMETRY_RUN_ID"),
    runAttempt: positiveInteger("run attempt", process.env.REVIEW_TELEMETRY_RUN_ATTEMPT),
    generation: process.env.REVIEW_TELEMETRY_GENERATION
      ? positiveInteger("generation", process.env.REVIEW_TELEMETRY_GENERATION)
      : undefined,
    operationId: String(process.env.REVIEW_TELEMETRY_OPERATION_ID || "").trim() || undefined,
    triggerLane: String(process.env.REVIEW_TELEMETRY_TRIGGER_LANE || attribution.lane),
    triggerOrigin: String(process.env.REVIEW_TELEMETRY_TRIGGER_ORIGIN || attribution.origin),
    sourceEvent,
    sourceAction,
    startedAt:
      String(
        process.env.REVIEW_TELEMETRY_STARTED_AT || process.env.REVIEW_TELEMETRY_QUEUED_AT || "",
      ).trim() || undefined,
    leaseExpiresAt: leaseMs === undefined ? null : new Date(now.getTime() + leaseMs).toISOString(),
    outcome: String(process.env.REVIEW_TELEMETRY_OUTCOME || "").trim(),
    terminalReason: String(process.env.REVIEW_TELEMETRY_TERMINAL_REASON || "").trim(),
    phaseDurations: Object.fromEntries(
      PHASES.map((phase) => [
        phase,
        optionalDuration(`REVIEW_TELEMETRY_${phase.toUpperCase()}_MS`),
      ]).filter(([, value]) => value !== undefined),
    ),
  };
  const derivedPhases = {
    queue: elapsed(
      process.env.REVIEW_TELEMETRY_QUEUED_AT,
      process.env.REVIEW_TELEMETRY_DISPATCHED_AT,
    ),
    claim: elapsed(
      process.env.REVIEW_TELEMETRY_DISPATCHED_AT || process.env.REVIEW_TELEMETRY_QUEUED_AT,
      process.env.REVIEW_TELEMETRY_CLAIMED_AT,
    ),
    review: elapsed(
      process.env.REVIEW_TELEMETRY_REVIEW_STARTED_AT,
      process.env.REVIEW_TELEMETRY_REVIEW_COMPLETED_AT,
    ),
    publication: elapsed(process.env.REVIEW_TELEMETRY_PUBLICATION_STARTED_AT, nowIso(now)),
  };
  for (const [phase, duration] of Object.entries(derivedPhases)) {
    if (input.phaseDurations[phase] === undefined && duration !== undefined) {
      input.phaseDurations[phase] = duration;
    }
  }
  if (action === "terminal" && (!input.outcome || !input.terminalReason)) {
    throw new Error("terminal telemetry requires outcome and terminal reason");
  }
  const queueUrl = required("REVIEW_TELEMETRY_QUEUE_URL").replace(/\/$/, "");
  const existing = await existingRecord(queueUrl, input);
  // First terminal truth is immutable in the Durable Object. Avoid a redundant
  // write so retries also preserve that decision before crossing the network.
  if (existing?.status === "completed") return;
  if (action !== "start" && !existing) {
    throw new Error("refreshing telemetry row is unavailable for update");
  }
  await writeRecord(
    queueUrl,
    required("CLAWSWEEPER_WEBHOOK_SECRET"),
    buildReviewTelemetryRecord(input, existing, now),
  );
}

function nowIso(now) {
  return now.toISOString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReviewTelemetryProducer().catch((error) => {
    console.log(`::warning::Review telemetry producer skipped: ${error?.message || error}`);
    process.exitCode = 0;
  });
}
