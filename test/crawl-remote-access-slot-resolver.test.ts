import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { credentialGenerationMarker } from "../scripts/bootstrap-crawl-remote-access.mjs";
import {
  resolveAndVerifyCrawlRemoteAccessCredentials,
  resolveCrawlRemoteAccessCredentials,
  verifyCrawlRemoteAccessCredentials,
} from "../scripts/resolve-crawl-remote-access-credentials.mjs";

const observationFenceNote =
  "Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated.";
const snapshotProvenanceNote =
  "Gitcrawl content-addressed snapshots bind manifest.source_sha256, status, queries, and SQLite bundle manifests to one source image.";

function verificationEnvironment(releaseSha = "1".repeat(40)) {
  return {
    CRAWL_REMOTE_ACCESS_EXPECTED_OBSERVATION_ORDER_STATE: "active",
    CRAWL_REMOTE_ACCESS_EXPECTED_RELEASE_SHA: releaseSha,
    CRAWL_REMOTE_ACCESS_EXPECTED_SNAPSHOT_PROVENANCE_STATE: "dormant",
    CRAWL_REMOTE_ACCESS_PROBE_URL: "https://reports.openclaw.ai/crawl-remote",
  };
}

function contractResponse(releaseSha = "1".repeat(40)) {
  return {
    service: "crawl-remote",
    protocol_version: "v1",
    release_sha: releaseSha,
    notes: [observationFenceNote, snapshotProvenanceNote],
    apps: [
      {
        app: "gitcrawl",
        capabilities: ["gitcrawl.observation-order.v1"],
      },
    ],
    routes: [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/v1/contract" },
    ],
  };
}

function deniedAccessResponse() {
  return new Response(null, { status: 403 });
}

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

test("resolver exposes no GitHub output channel", () => {
  const source = readFileSync("scripts/resolve-crawl-remote-access-credentials.mjs", "utf8");
  assert.doesNotMatch(source, /GITHUB_OUTPUT|appendFileSync|client_id=/);
  assert.match(source, /--resolve-and-verify-access/);
});

test("resolver selects and verifies one generation in the same process", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const releaseSha = "1".repeat(40);
  const result = await resolveAndVerifyCrawlRemoteAccessCredentials(
    {
      ...verificationEnvironment(releaseSha),
      CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: credentialGenerationMarker("token-green", "green"),
      CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: "fixture-blue-id",
      CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: "fixture-blue-credential",
      CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID: "fixture-green-id",
      CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET: "fixture-green-credential",
    },
    {
      nonce: "fixture-probe",
      fetchImpl: async (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({ url: String(url), headers });
        if (!headers.has("CF-Access-Client-Id")) return deniedAccessResponse();
        return Response.json(
          String(url).includes("/v1/contract")
            ? contractResponse(releaseSha)
            : { ok: true, release_sha: releaseSha },
        );
      },
    },
  );

  assert.deepEqual(result, { releaseSha, slot: "green" });
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/crawl-remote/health", "/crawl-remote/health", "/crawl-remote/v1/contract"],
  );
  assert.equal(
    new URL(requests[0]!.url).searchParams.get("access_preflight"),
    "fixture-probe-denied",
  );
  assert.equal(requests[0]!.headers.has("CF-Access-Client-Id"), false);
  assert.equal(requests[0]!.headers.has("CF-Access-Client-Secret"), false);
  for (const request of requests.slice(1)) {
    assert.equal(new URL(request.url).searchParams.get("access_preflight"), "fixture-probe");
    assert.equal(request.headers.get("CF-Access-Client-Id"), "fixture-green-id");
    assert.equal(request.headers.get("CF-Access-Client-Secret"), "fixture-green-credential");
  }
});

test("Access verifier rejects alternate routes and unapproved releases", async () => {
  const environment = {
    CF_ACCESS_CLIENT_ID: "fixture-client-id",
    CF_ACCESS_CLIENT_SECRET: "fixture-client-credential",
    ...verificationEnvironment(),
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
        fetchImpl: async (url: string | URL, init?: RequestInit) => {
          if (!new Headers(init?.headers).has("CF-Access-Client-Id")) {
            return deniedAccessResponse();
          }
          return Response.json(
            String(url).includes("/v1/contract")
              ? contractResponse("2".repeat(40))
              : { ok: true, release_sha: "2".repeat(40) },
          );
        },
      },
    ),
    /did not reach the approved release/,
  );
});

test("Access verifier rejects a publicly reachable route before accepting credentials", async () => {
  await assert.rejects(
    verifyCrawlRemoteAccessCredentials(
      {
        CF_ACCESS_CLIENT_ID: "fixture-client-id",
        CF_ACCESS_CLIENT_SECRET: "fixture-client-credential",
        ...verificationEnvironment(),
      },
      {
        nonce: "fixture-probe",
        fetchImpl: async () => Response.json({ ok: true }),
      },
    ),
    /did not deny the unauthenticated probe \(HTTP 200\)/,
  );
});

test("Access verifier cancels oversized responses before buffering the body", async () => {
  let pulls = 0;
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(512 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    verifyCrawlRemoteAccessCredentials(
      {
        CF_ACCESS_CLIENT_ID: "fixture-client-id",
        CF_ACCESS_CLIENT_SECRET: "fixture-client-credential",
        ...verificationEnvironment(),
      },
      {
        nonce: "fixture-probe",
        fetchImpl: async (_url: string | URL, init?: RequestInit) =>
          new Headers(init?.headers).has("CF-Access-Client-Id")
            ? new Response(oversized)
            : deniedAccessResponse(),
      },
    ),
    /response exceeded the size limit/,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, `oversized response produced ${pulls} chunks before cancellation`);
});

test("Access verifier binds notes and capability states to the approved deployment", async () => {
  const environment = {
    CF_ACCESS_CLIENT_ID: "fixture-client-id",
    CF_ACCESS_CLIENT_SECRET: "fixture-client-credential",
    ...verificationEnvironment(),
  };
  await assert.rejects(
    verifyCrawlRemoteAccessCredentials(environment, {
      nonce: "fixture-probe",
      fetchImpl: async (url: string | URL, init?: RequestInit) => {
        if (!new Headers(init?.headers).has("CF-Access-Client-Id")) {
          return deniedAccessResponse();
        }
        return Response.json(
          String(url).includes("/v1/contract")
            ? { ...contractResponse(), notes: [] }
            : { ok: true, release_sha: "1".repeat(40) },
        );
      },
    }),
    /missing the observation-order fence/,
  );

  await assert.rejects(
    verifyCrawlRemoteAccessCredentials(
      {
        ...environment,
        CRAWL_REMOTE_ACCESS_EXPECTED_SNAPSHOT_PROVENANCE_STATE: "active",
      },
      {
        nonce: "fixture-probe",
        fetchImpl: async (url: string | URL, init?: RequestInit) => {
          if (!new Headers(init?.headers).has("CF-Access-Client-Id")) {
            return deniedAccessResponse();
          }
          return Response.json(
            String(url).includes("/v1/contract")
              ? contractResponse()
              : { ok: true, release_sha: "1".repeat(40) },
          );
        },
      },
    ),
    /does not match expected active gitcrawl\.snapshot\.provenance\.v1 state/,
  );
});
