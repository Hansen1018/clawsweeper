import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { credentialGenerationMarker } from "../scripts/bootstrap-crawl-remote-access.mjs";
import {
  resolveCrawlRemoteAccessCredentials,
  verifyCrawlRemoteAccessCredentials,
} from "../scripts/resolve-crawl-remote-access-credentials.mjs";

test("slot resolver selects one complete generation without mixing pairs", () => {
  const common = {
    CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: "fixture-blue-id",
    CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: "fixture-blue-credential",
    CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID: "fixture-green-id",
    CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET: "fixture-green-credential",
  };
  assert.deepEqual(
    resolveCrawlRemoteAccessCredentials({
      ...common,
      CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: credentialGenerationMarker("token-blue", "blue"),
    }),
    {
      slot: "blue",
      clientId: "fixture-blue-id",
      clientSecret: "fixture-blue-credential",
    },
  );
  assert.deepEqual(
    resolveCrawlRemoteAccessCredentials({
      ...common,
      CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: credentialGenerationMarker("token-green", "green"),
    }),
    {
      slot: "green",
      clientId: "fixture-green-id",
      clientSecret: "fixture-green-credential",
    },
  );
});

test("slot resolver rejects malformed markers and incomplete selected pairs", () => {
  assert.throws(
    () =>
      resolveCrawlRemoteAccessCredentials({
        CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: "v1:blue:not-a-generation",
      }),
    /generation marker is invalid/,
  );
  assert.throws(
    () =>
      resolveCrawlRemoteAccessCredentials({
        CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: credentialGenerationMarker("token-blue", "blue"),
        CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: "fixture-blue-id",
        CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: "",
      }),
    /BLUE_CLIENT_SECRET must be a non-empty single-line value/,
  );
});

test("slot resolver writes selected credentials only to step outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-access-resolver-"));
  const githubEnvironment = join(directory, "github-env");
  const githubOutput = join(directory, "github-output");
  try {
    const result = spawnSync("node", ["scripts/resolve-crawl-remote-access-credentials.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: credentialGenerationMarker(
          "token-green",
          "green",
        ),
        CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: "fixture-blue-id",
        CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: "fixture-blue-credential",
        CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID: "fixture-green-id",
        CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET: "fixture-green-credential",
        GITHUB_ENV: githubEnvironment,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(githubOutput, "utf8"),
      "client_id=fixture-green-id\n" + "client_secret=fixture-green-credential\n",
    );
    assert.equal(existsSync(githubEnvironment), false);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-green-(id|credential)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Access verifier consumes both resolved credentials through the canonical route", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const releaseSha = "1".repeat(40);
  const result = await verifyCrawlRemoteAccessCredentials(
    {
      CF_ACCESS_CLIENT_ID: "fixture-client-id",
      CF_ACCESS_CLIENT_SECRET: "fixture-client-credential",
      CRAWL_REMOTE_ACCESS_PROBE_URL: "https://reports.openclaw.ai/crawl-remote",
    },
    {
      nonce: "fixture-probe",
      fetchImpl: async (url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers) });
        return Response.json(
          String(url).includes("/v1/contract")
            ? {
                service: "crawl-remote",
                protocol_version: "v1",
                release_sha: releaseSha,
                routes: [
                  { method: "GET", path: "/health" },
                  { method: "GET", path: "/v1/contract" },
                ],
              }
            : { ok: true, release_sha: releaseSha },
        );
      },
    },
  );

  assert.deepEqual(result, { releaseSha });
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/crawl-remote/health", "/crawl-remote/v1/contract"],
  );
  for (const request of requests) {
    assert.equal(new URL(request.url).searchParams.get("access_preflight"), "fixture-probe");
    assert.equal(request.headers.get("CF-Access-Client-Id"), "fixture-client-id");
    assert.equal(request.headers.get("CF-Access-Client-Secret"), "fixture-client-credential");
  }
});

test("Access verifier rejects alternate routes and inconsistent releases", async () => {
  const environment = {
    CF_ACCESS_CLIENT_ID: "fixture-client-id",
    CF_ACCESS_CLIENT_SECRET: "fixture-client-credential",
    CRAWL_REMOTE_ACCESS_PROBE_URL: "https://alternate.invalid/crawl-remote",
  };
  await assert.rejects(
    verifyCrawlRemoteAccessCredentials(environment, {
      fetchImpl: async () => Response.json({}),
    }),
    /must use the canonical crawl-remote route/,
  );

  await assert.rejects(
    verifyCrawlRemoteAccessCredentials(
      {
        ...environment,
        CRAWL_REMOTE_ACCESS_PROBE_URL: "https://reports.openclaw.ai/crawl-remote",
      },
      {
        nonce: "fixture-probe",
        fetchImpl: async (url: string | URL) =>
          Response.json(
            String(url).includes("/v1/contract")
              ? {
                  service: "crawl-remote",
                  protocol_version: "v1",
                  release_sha: "2".repeat(40),
                  routes: [],
                }
              : { ok: true, release_sha: "1".repeat(40) },
          ),
      },
    ),
    /did not reach one consistent crawl-remote release/,
  );
});
