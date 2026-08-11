import { createHmac } from "node:crypto";

import type {
  AdaptiveHotControlFacts,
  AdaptiveHotControlSnapshot,
  AdaptiveHotDecisionRecord,
  AdaptiveHotRepositoryObservationSnapshot,
} from "./adaptive-hot-review-contract.js";
import { ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION } from "./adaptive-hot-review-contract.js";

type JsonRecord = Record<string, unknown>;

export type AdaptiveHotControlPlaneResult =
  | {
      ok: true;
      snapshot: AdaptiveHotControlSnapshot;
      facts: AdaptiveHotControlFacts;
    }
  | { ok: false; reason: string };

export async function fetchAdaptiveHotControlPlane(options: {
  queueUrl: string;
  webhookSecret: string;
  policyVersion: string;
  targetRepositories: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdaptiveHotControlPlaneResult> {
  const request = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const baseUrl = options.queueUrl.replace(/\/+$/, "");
    if (!baseUrl.startsWith("https://")) {
      return { ok: false, reason: "adaptive hot-review URL must use HTTPS" };
    }
    if (!options.webhookSecret) {
      return { ok: false, reason: "adaptive hot-review webhook secret is required" };
    }
    const allocatorRequestBody = JSON.stringify({
      policyVersion: options.policyVersion,
      lane: "hot_intake",
      targetRepositories: options.targetRepositories,
    });
    const signature = `sha256=${createHmac("sha256", options.webhookSecret)
      .update(allocatorRequestBody)
      .digest("hex")}`;
    const [response, allocatorResponse] = await Promise.all([
      request(new URL("/api/exact-review-queue", `${baseUrl}/`), {
        signal: controller.signal,
      }),
      request(new URL("/internal/adaptive-hot-review/control-plane", `${baseUrl}/`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body: allocatorRequestBody,
        signal: controller.signal,
      }),
    ]);
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    if (!allocatorResponse.ok) {
      return { ok: false, reason: `allocator_http_${allocatorResponse.status}` };
    }
    const body = record(await response.json(), "exact-review queue status");
    const allocatorBody = record(
      await allocatorResponse.json(),
      "adaptive hot-review allocator status",
    );
    const snapshot = adaptiveHotControlSnapshot(allocatorBody.adaptive_hot_review);
    const review = record(record(body.lanes, "lanes").review, "lanes.review");
    const publication = record(record(body.lanes, "lanes").publication, "lanes.publication");
    const scheduledFeed = record(body.scheduled_feed, "scheduled_feed");
    const scheduledLanes = record(scheduledFeed.lanes, "scheduled_feed.lanes");
    const hot = record(scheduledLanes.hot_intake, "scheduled_feed.lanes.hot_intake");
    const capacity = nonNegativeInteger(review.capacity, "review capacity");
    const active = nonNegativeInteger(review.active, "review active");
    const pending = nonNegativeInteger(review.pending, "review pending");
    const throttleRecoveryAt = optionalTimestamp(scheduledFeed.throttle_recovery_at);
    const circuits: AdaptiveHotControlFacts["activeCredentialCircuits"] = Array.isArray(
      publication.credential_circuits,
    )
      ? publication.credential_circuits.flatMap<
          AdaptiveHotControlFacts["activeCredentialCircuits"][number]
        >((value) => {
          const circuit = recordOrNull(value);
          if (!circuit || circuit.active !== true) return [];
          const scope = String(circuit.scope || "");
          if (scope !== "repository_actions" && scope !== "target_app") return [];
          const blockedUntil = optionalTimestamp(circuit.blocked_until);
          const targetOwner =
            circuit.target_owner == null ? null : String(circuit.target_owner).trim().toLowerCase();
          if (!blockedUntil || (scope === "target_app" && !targetOwner)) return [];
          return [{ scope, targetOwner, blockedUntil }];
        })
      : [];
    const requestMetrics = recordOrNull(publication.github_request_metrics);
    return {
      ok: true,
      snapshot,
      facts: {
        queueCapabilityAvailable: true,
        availableCandidateCapacity: Math.max(0, capacity - active - pending),
        globalTokenBalance: nonNegativeInteger(
          scheduledFeed.token_balance,
          "scheduled_feed.token_balance",
        ),
        hotTokenBalance: nonNegativeInteger(hot.token_balance, "hot token balance"),
        scheduledAdmissionThrottled:
          throttleRecoveryAt !== null && Date.parse(throttleRecoveryAt) > Date.now(),
        repositoryObservationsAvailable: snapshot.observations.length > 0,
        activeCredentialCircuits: circuits,
        githubRequestMetricsUpdatedAt: optionalTimestamp(requestMetrics?.updated_at),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : sanitizedError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function publishAdaptiveHotDecision(options: {
  queueUrl: string;
  webhookSecret: string;
  decision: AdaptiveHotDecisionRecord;
  attempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const body = JSON.stringify(options.decision);
  await signedAdaptiveHotRequest({
    queueUrl: options.queueUrl,
    webhookSecret: options.webhookSecret,
    path: "/internal/adaptive-hot-review/decision",
    body,
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

export async function publishAdaptiveHotPlannerObservation(options: {
  queueUrl: string;
  webhookSecret: string;
  observation: unknown;
  attempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const body = JSON.stringify(options.observation);
  await signedAdaptiveHotRequest({
    queueUrl: options.queueUrl,
    webhookSecret: options.webhookSecret,
    path: "/internal/adaptive-hot-review/observation",
    body,
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

async function signedAdaptiveHotRequest(options: {
  queueUrl: string;
  webhookSecret: string;
  path: string;
  body: string;
  attempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const baseUrl = options.queueUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("adaptive hot-review URL must use HTTPS");
  if (!options.webhookSecret) throw new Error("adaptive hot-review webhook secret is required");
  const signature = `sha256=${createHmac("sha256", options.webhookSecret)
    .update(options.body)
    .digest("hex")}`;
  const request = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 3)));
  let lastFailure = "adaptive hot-review write failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(`${baseUrl}${options.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body: options.body,
        signal: AbortSignal.timeout(20_000),
      });
      const payload = recordOrNull(await response.json().catch(() => null));
      if (response.ok && payload?.ok === true) return;
      lastFailure = String(payload?.error || `http_${response.status}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = sanitizedError(error);
    }
    if (attempt < attempts) await sleep(attempt * 1_000);
  }
  throw new Error(`adaptive hot-review write failed: ${lastFailure}`);
}

function adaptiveHotControlSnapshot(value: unknown): AdaptiveHotControlSnapshot {
  const snapshot = record(value, "adaptive_hot_review");
  if (snapshot.schemaVersion !== ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("adaptive hot-review snapshot schema mismatch");
  }
  const observations = Array.isArray(snapshot.observations)
    ? (snapshot.observations as AdaptiveHotRepositoryObservationSnapshot[])
    : null;
  const recentDecisions = Array.isArray(snapshot.recentDecisions)
    ? (snapshot.recentDecisions as AdaptiveHotDecisionRecord[])
    : null;
  const readiness = record(snapshot.readiness, "adaptive hot-review readiness");
  const readinessPolicyVersion = optionalIdentifier(readiness.policyVersion, "readiness policy");
  const shadow = readinessFacts(readiness.shadow, "shadow");
  const canary = readinessFacts(readiness.canary, "canary");
  const full10 = readinessFacts(readiness.full10, "full10");
  const full50 = readinessFacts(readiness.full50, "full50");
  const generatedAt = optionalTimestamp(snapshot.generatedAt);
  if (!observations || !recentDecisions || !generatedAt) {
    throw new Error("adaptive hot-review snapshot is malformed");
  }
  return {
    schemaVersion: ADAPTIVE_HOT_CONTROL_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    observations,
    recentDecisions,
    readiness: { policyVersion: readinessPolicyVersion, shadow, canary, full10, full50 },
  };
}

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  const parsed = String(value).trim();
  const hasControlCharacter = [...parsed].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
  if (!parsed || parsed.length > 100 || hasControlCharacter) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return parsed;
}

function readinessFacts(value: unknown, label: string) {
  const facts = record(value, `${label} readiness`);
  const cycles = nonNegativeInteger(facts.dispatchedCycles, `${label} dispatched cycles`);
  return {
    firstDispatchedAt: optionalTimestamp(facts.firstDispatchedAt),
    lastDispatchedAt: optionalTimestamp(facts.lastDispatchedAt),
    dispatchedCycles: cycles,
  };
}

function optionalTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function record(value: unknown, label: string): JsonRecord {
  const parsed = recordOrNull(value);
  if (!parsed) throw new Error(`${label} must be an object`);
  return parsed;
}

function recordOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function sanitizedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200);
}
