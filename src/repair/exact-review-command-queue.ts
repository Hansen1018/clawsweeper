import { spawnSync } from "node:child_process";

import type { DirectReReviewIntake } from "./direct-re-review-admission.js";
import {
  INTERNAL_QUEUE_PROTOCOL_VERSION,
  INTERNAL_QUEUE_REQUEST_TIMEOUT_MS,
  internalQueueRequestHeaders,
  signedInternalQueueRequest,
} from "../../scripts/internal-queue-request.mjs";

export {
  INTERNAL_QUEUE_PROTOCOL_VERSION,
  INTERNAL_QUEUE_REQUEST_TIMEOUT_MS,
  internalQueueRequestHeaders,
};

export type CommandIntakeAdmissionResult =
  | { kind: "accepted"; deduped: boolean; commandVersionId: string }
  | { kind: "stale"; reason: string };

type SignedInternalQueueRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
};

export function signedExactReviewQueueRequest(options: {
  queueUrl: string;
  secret: string;
  path: string;
  body: unknown;
  method?: "POST";
  timestampSeconds?: number;
}): SignedInternalQueueRequest {
  if (!options.secret) throw new Error("internal exact-review queue secret is required");
  const method = options.method ?? "POST";
  const body = JSON.stringify(options.body);
  const headers = internalQueueRequestHeaders({
    secret: options.secret,
    path: options.path,
    body,
    method,
    ...(options.timestampSeconds === undefined
      ? {}
      : { timestampSeconds: options.timestampSeconds }),
  });
  return {
    url: `${options.queueUrl.replace(/\/$/, "")}${options.path}`,
    body,
    headers,
  };
}

export function postExactReviewCommandIntakeSync(options: {
  queueUrl: string;
  secret: string;
  intake: DirectReReviewIntake;
}) {
  const request = signedExactReviewQueueRequest({
    queueUrl: options.queueUrl,
    secret: options.secret,
    path: "/internal/exact-review/command-intake",
    body: options.intake,
  });
  const headerArgs = Object.entries(request.headers).flatMap(([name, value]) => [
    "--header",
    `${name}: ${value}`,
  ]);
  const response = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--max-time",
      String(INTERNAL_QUEUE_REQUEST_TIMEOUT_MS / 1_000),
      ...headerArgs,
      "--data-binary",
      "@-",
      request.url,
    ],
    { encoding: "utf8", input: request.body },
  );
  if (response.status !== 0) {
    throw new Error(`exact re-review command intake failed: ${response.stderr || response.stdout}`);
  }
  return commandIntakeAdmissionResult(JSON.parse(response.stdout || "null"));
}

export async function postSignedExactReviewQueue(options: {
  queueUrl: string;
  secret: string;
  path: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  timestampSeconds?: number;
}) {
  const request = signedExactReviewQueueRequest(options);
  const response = await signedInternalQueueRequest({
    baseUrl: options.queueUrl,
    path: options.path,
    secret: options.secret,
    body: request.body,
    ...(options.timestampSeconds === undefined
      ? {}
      : { timestampSeconds: options.timestampSeconds }),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result !== "object") {
    throw new Error(`exact-review queue ${options.path} failed (HTTP ${response.status})`);
  }
  return result as Record<string, unknown>;
}

export function commandIntakeAdmissionResult(value: unknown): CommandIntakeAdmissionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("exact-review command intake returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true) throw new Error("exact-review command intake was not accepted");
  if (result.accepted === false && typeof result.reason === "string") {
    return { kind: "stale", reason: result.reason };
  }
  if (
    result.accepted === true &&
    typeof result.command_version_id === "string" &&
    typeof result.deduped === "boolean"
  ) {
    return {
      kind: "accepted",
      deduped: result.deduped,
      commandVersionId: result.command_version_id,
    };
  }
  throw new Error("exact-review command intake did not establish durable ownership");
}
