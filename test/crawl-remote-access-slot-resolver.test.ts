import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { credentialGenerationMarker } from "../scripts/bootstrap-crawl-remote-access.mjs";
import { resolveCrawlRemoteAccessCredentials } from "../scripts/resolve-crawl-remote-access-credentials.mjs";

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
