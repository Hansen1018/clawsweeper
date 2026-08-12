#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const INTERNAL_QUEUE_PROTOCOL_VERSION = "1";
export const INTERNAL_QUEUE_REQUEST_TIMEOUT_MS = 8_000;

export function internalQueueRequestHeaders({
  secret,
  method,
  path,
  body,
  timestampSeconds = Math.floor(Date.now() / 1_000),
}) {
  if (!secret) throw new Error("internal exact-review queue secret is required");
  if (!/^(GET|POST|PUT)$/.test(method)) {
    throw new Error(`unsupported internal queue method: ${method}`);
  }
  if (!path.startsWith("/internal/")) throw new Error("internal queue path is invalid");
  const timestamp = String(timestampSeconds);
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = [INTERNAL_QUEUE_PROTOCOL_VERSION, timestamp, method, path, digest].join("\n");
  return {
    "content-type": "application/json",
    "x-clawsweeper-internal-protocol": INTERNAL_QUEUE_PROTOCOL_VERSION,
    "x-clawsweeper-internal-timestamp": timestamp,
    "x-clawsweeper-internal-signature": `sha256=${createHmac("sha256", secret)
      .update(canonical)
      .digest("hex")}`,
  };
}

export async function signedInternalQueueRequest({
  baseUrl,
  path,
  secret,
  body = "",
  method = "POST",
  timeoutMs = INTERNAL_QUEUE_REQUEST_TIMEOUT_MS,
  timestampSeconds,
  fetchImpl = fetch,
}) {
  const url = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("internal queue URL is invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 10_000) {
    throw new Error("internal queue timeout must be between 1 and 9999 ms");
  }
  const headers = internalQueueRequestHeaders({
    secret,
    method,
    path,
    body,
    timestampSeconds,
  });
  return fetchImpl(`${url}${path}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid internal queue request argument: ${name || "<missing>"}`);
    }
    values.set(name.slice(2), value);
  }
  const method = String(values.get("method") || "POST").toUpperCase();
  const timeoutMs = Number(values.get("timeout-ms") || INTERNAL_QUEUE_REQUEST_TIMEOUT_MS);
  if (!/^(GET|POST|PUT)$/.test(method)) {
    throw new Error(`unsupported internal queue method: ${method}`);
  }
  return {
    baseUrl: String(values.get("url") || ""),
    path: String(values.get("path") || ""),
    method,
    timeoutMs,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const secret =
    process.env.CLAWSWEEPER_INTERNAL_QUEUE_SECRET || process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  const body = options.method === "GET" ? "" : readFileSync(0, "utf8");
  const response = await signedInternalQueueRequest({ ...options, secret, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `internal queue ${options.method} ${options.path} failed (HTTP ${response.status})${
        text ? `: ${text.slice(0, 500)}` : ""
      }`,
    );
  }
  process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
