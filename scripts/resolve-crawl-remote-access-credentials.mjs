#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CRAWL_REMOTE_ACCESS_PROBE_URL = "https://reports.openclaw.ai/crawl-remote";
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

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
  const probeNonce = requiredSingleLineValue(String(nonce), "crawl-remote Access probe nonce");
  const headers = {
    accept: "application/json",
    "cache-control": "no-cache",
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
  const request = async (path) => {
    const url = new URL(`${probeUrl}${path}`);
    url.searchParams.set("access_preflight", probeNonce);
    const response = await fetchImpl(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`crawl-remote Access verification failed with HTTP ${response.status}`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_PROBE_RESPONSE_BYTES) {
      throw new Error("crawl-remote Access verification response exceeded the size limit");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("crawl-remote Access verification returned invalid JSON");
    }
  };

  const health = await request("/health");
  const contract = await request("/v1/contract");
  const releaseSha = health?.release_sha;
  if (
    health?.ok !== true ||
    typeof releaseSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(releaseSha) ||
    contract?.service !== "crawl-remote" ||
    contract?.protocol_version !== "v1" ||
    contract?.release_sha !== releaseSha
  ) {
    throw new Error(
      "crawl-remote Access verification did not reach one consistent crawl-remote release",
    );
  }
  const routes = Array.isArray(contract.routes) ? contract.routes : [];
  for (const path of ["/health", "/v1/contract"]) {
    if (!routes.some((route) => route?.method === "GET" && route?.path === path)) {
      throw new Error(`crawl-remote Access verification is missing GET ${path}`);
    }
  }
  return { releaseSha };
}

function requiredSingleLineValue(value, name) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
  return value;
}

function writeGitHubOutputs(path, credentials) {
  const outputPath = requiredSingleLineValue(path, "GITHUB_OUTPUT");
  appendFileSync(
    outputPath,
    `client_id=${credentials.clientId}\n` + `client_secret=${credentials.clientSecret}\n`,
    "utf8",
  );
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 0) {
    if (argumentsList.length !== 1 || argumentsList[0] !== "--verify-access") {
      throw new Error("unsupported crawl-remote Access resolver arguments");
    }
    const result = await verifyCrawlRemoteAccessCredentials(process.env);
    console.log(`verified crawl-remote Access release ${result.releaseSha}`);
    return;
  }
  const credentials = resolveCrawlRemoteAccessCredentials(process.env);
  writeGitHubOutputs(process.env.GITHUB_OUTPUT, credentials);
  console.log(`selected crawl-remote Access ${credentials.slot} credential generation`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
