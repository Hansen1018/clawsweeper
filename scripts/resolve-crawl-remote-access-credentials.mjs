#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CRAWL_REMOTE_ACCESS_PROBE_URL = "https://reports.openclaw.ai/crawl-remote";
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;
const OBSERVATION_FENCE_NOTE =
  "Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated.";
const SNAPSHOT_PROVENANCE_NOTE =
  "Gitcrawl content-addressed snapshots bind manifest.source_sha256, status, queries, and SQLite bundle manifests to one source image.";

export function resolveCrawlRemoteAccessCredentials(environment) {
  const marker = String(environment.CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION ?? "");
  const match = /^v1:(blue|green):[0-9a-f]{64}$/.exec(marker);
  if (!match) {
    throw new Error("crawl-remote Access credential generation marker is invalid");
  }
  const slot = match[1];
  const prefix = `CRAWL_REMOTE_ACCESS_${slot.toUpperCase()}`;
  const clientId = requiredSingleLineValue(
    environment[`${prefix}_CLIENT_ID`],
    `${prefix}_CLIENT_ID`,
  );
  const clientSecret = requiredSingleLineValue(
    environment[`${prefix}_CLIENT_SECRET`],
    `${prefix}_CLIENT_SECRET`,
  );
  return { slot, clientId, clientSecret };
}

export async function verifyCrawlRemoteAccessCredentials(
  environment,
  { fetchImpl = fetch, nonce = randomUUID() } = {},
) {
  const clientId = requiredSingleLineValue(environment.CF_ACCESS_CLIENT_ID, "CF_ACCESS_CLIENT_ID");
  const clientSecret = requiredSingleLineValue(
    environment.CF_ACCESS_CLIENT_SECRET,
    "CF_ACCESS_CLIENT_SECRET",
  );
  const probeUrl = requiredSingleLineValue(
    environment.CRAWL_REMOTE_ACCESS_PROBE_URL,
    "CRAWL_REMOTE_ACCESS_PROBE_URL",
  );
  if (probeUrl !== CRAWL_REMOTE_ACCESS_PROBE_URL) {
    throw new Error("CRAWL_REMOTE_ACCESS_PROBE_URL must use the canonical crawl-remote route");
  }
  const expectedReleaseSha = requiredSingleLineValue(
    environment.CRAWL_REMOTE_ACCESS_EXPECTED_RELEASE_SHA,
    "CRAWL_REMOTE_ACCESS_EXPECTED_RELEASE_SHA",
  );
  if (!/^[0-9a-f]{40}$/.test(expectedReleaseSha)) {
    throw new Error("CRAWL_REMOTE_ACCESS_EXPECTED_RELEASE_SHA must be a full lowercase commit SHA");
  }
  const expectedObservationOrderState = requiredRolloutState(
    environment.CRAWL_REMOTE_ACCESS_EXPECTED_OBSERVATION_ORDER_STATE,
    "CRAWL_REMOTE_ACCESS_EXPECTED_OBSERVATION_ORDER_STATE",
  );
  const expectedSnapshotProvenanceState = requiredRolloutState(
    environment.CRAWL_REMOTE_ACCESS_EXPECTED_SNAPSHOT_PROVENANCE_STATE,
    "CRAWL_REMOTE_ACCESS_EXPECTED_SNAPSHOT_PROVENANCE_STATE",
  );
  const probeNonce = requiredSingleLineValue(String(nonce), "crawl-remote Access probe nonce");
  const headers = {
    accept: "application/json",
    "cache-control": "no-cache",
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
  const denialUrl = new URL(`${probeUrl}/health`);
  denialUrl.searchParams.set("access_preflight", `${probeNonce}-denied`);
  const denialResponse = await fetchImpl(denialUrl, {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const accessDenied =
    (denialResponse.status >= 300 && denialResponse.status < 400) ||
    denialResponse.status === 401 ||
    denialResponse.status === 403;
  try {
    await denialResponse.body?.cancel();
  } catch {}
  if (!accessDenied) {
    throw new Error(
      `crawl-remote Access verification did not deny the unauthenticated probe (HTTP ${denialResponse.status})`,
    );
  }
  const request = async (path) => {
    const url = new URL(`${probeUrl}${path}`);
    url.searchParams.set("access_preflight", probeNonce);
    const response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`crawl-remote Access verification failed with HTTP ${response.status}`);
    }
    const body = await readBoundedResponseBody(response);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("crawl-remote Access verification returned invalid JSON");
    }
  };

  const health = await request("/health");
  const contract = await request("/v1/contract");
  if (
    health?.ok !== true ||
    health?.release_sha !== expectedReleaseSha ||
    contract?.service !== "crawl-remote" ||
    contract?.protocol_version !== "v1" ||
    contract?.release_sha !== expectedReleaseSha
  ) {
    throw new Error("crawl-remote Access verification did not reach the approved release");
  }
  const notes = Array.isArray(contract.notes) ? contract.notes : [];
  if (!notes.includes(OBSERVATION_FENCE_NOTE)) {
    throw new Error("crawl-remote Access verification is missing the observation-order fence");
  }
  if (!notes.includes(SNAPSHOT_PROVENANCE_NOTE)) {
    throw new Error("crawl-remote Access verification is missing snapshot provenance");
  }
  const apps = Array.isArray(contract.apps) ? contract.apps : [];
  const gitcrawl = apps.find((app) => app?.app === "gitcrawl");
  if (!Array.isArray(gitcrawl?.capabilities)) {
    throw new Error("crawl-remote Access verification has malformed Gitcrawl capabilities");
  }
  assertCapabilityState(
    gitcrawl.capabilities,
    "gitcrawl.observation-order.v1",
    expectedObservationOrderState,
  );
  assertCapabilityState(
    gitcrawl.capabilities,
    "gitcrawl.snapshot.provenance.v1",
    expectedSnapshotProvenanceState,
  );
  const routes = Array.isArray(contract.routes) ? contract.routes : [];
  for (const path of ["/health", "/v1/contract"]) {
    if (!routes.some((route) => route?.method === "GET" && route?.path === path)) {
      throw new Error(`crawl-remote Access verification is missing GET ${path}`);
    }
  }
  return { releaseSha: expectedReleaseSha };
}

export async function resolveAndVerifyCrawlRemoteAccessCredentials(environment, options = {}) {
  const credentials = resolveCrawlRemoteAccessCredentials(environment);
  const result = await verifyCrawlRemoteAccessCredentials(
    {
      ...environment,
      CF_ACCESS_CLIENT_ID: credentials.clientId,
      CF_ACCESS_CLIENT_SECRET: credentials.clientSecret,
    },
    options,
  );
  return { ...result, slot: credentials.slot };
}

async function readBoundedResponseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("crawl-remote Access verification response body is unavailable");
  }
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_PROBE_RESPONSE_BYTES) {
        throw new Error("crawl-remote Access verification response exceeded the size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function requiredSingleLineValue(value, name) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
  return value;
}

function requiredRolloutState(value, name) {
  const state = requiredSingleLineValue(value, name);
  if (state !== "dormant" && state !== "active") {
    throw new Error(`${name} must be dormant or active`);
  }
  return state;
}

function assertCapabilityState(capabilities, capability, expectedState) {
  const active = capabilities.includes(capability);
  if ((expectedState === "active" && !active) || (expectedState === "dormant" && active)) {
    throw new Error(
      `crawl-remote Access verification does not match expected ${expectedState} ${capability} state`,
    );
  }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length !== 1 || argumentsList[0] !== "--resolve-and-verify-access") {
    throw new Error("crawl-remote Access resolver requires --resolve-and-verify-access");
  }
  const result = await resolveAndVerifyCrawlRemoteAccessCredentials(process.env);
  console.log(
    `verified crawl-remote Access ${result.slot} generation for release ${result.releaseSha}`,
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
