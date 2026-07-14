import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BOOTSTRAP_CONTRACT,
  bootstrapCrawlRemoteAccess,
  createCloudflareClient,
  createGitHubClient,
} from "../scripts/bootstrap-crawl-remote-access.mjs";

const quietLogger = { log() {} };

interface SecretTarget {
  repository: string;
  environment?: string;
  name: string;
  value: string;
}

interface VariableTarget extends SecretTarget {}

function createGitHubFixture({ completeAccessSecrets = false } = {}) {
  const secrets: SecretTarget[] = [];
  const variables: VariableTarget[] = [];
  const lists: Array<{ repository: string; environment?: string }> = [];
  return {
    secrets,
    variables,
    lists,
    client: {
      async listSecretNames(target: { repository: string; environment?: string }) {
        lists.push(target);
        if (!completeAccessSecrets) return new Set<string>();
        if (target.environment === BOOTSTRAP_CONTRACT.productionEnvironment) {
          return new Set(["CRAWL_REMOTE_ACCESS_CLIENT_ID", "CRAWL_REMOTE_ACCESS_CLIENT_SECRET"]);
        }
        if (target.repository === BOOTSTRAP_CONTRACT.clawsweeperRepository) {
          return new Set([
            "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_CLIENT_ID",
            "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_CLIENT_SECRET",
          ]);
        }
        return new Set(["GITCRAWL_CLOUD_ACCESS_CLIENT_ID", "GITCRAWL_CLOUD_ACCESS_CLIENT_SECRET"]);
      },
      async setSecret(target: SecretTarget) {
        secrets.push(target);
      },
      async setVariable(target: VariableTarget) {
        variables.push(target);
      },
    },
  };
}

function createCloudflareFixture({
  tokens = [],
  application = null,
  policy = null,
}: {
  tokens?: Array<{ id: string; name: string }>;
  application?: { id: string; name?: string; domain?: string } | null;
  policy?: { id: string } | null;
} = {}) {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    client: {
      async listServiceTokens() {
        events.push({ event: "list-tokens" });
        return tokens;
      },
      async inspectAccessApplication() {
        events.push({ event: "inspect-app" });
        return { application, policy };
      },
      async createServiceToken(input: { name: string; duration: string }) {
        events.push({ event: "create-token", ...input });
        return {
          id: "token-new",
          client_id: "fixture-client-id",
          client_secret: "fixture-client-credential",
          ...input,
        };
      },
      async ensureAccessApplication(existing: typeof application) {
        events.push({ event: "ensure-app", existing });
        return (
          existing ?? {
            id: "app-new",
            name: BOOTSTRAP_CONTRACT.accessAppName,
            domain: BOOTSTRAP_CONTRACT.accessDomain,
          }
        );
      },
      async ensureAccessPolicy(input: {
        applicationId: string;
        existingPolicy: { id: string } | null;
        tokenIds: string[];
      }) {
        events.push({ event: "ensure-policy", ...input });
        return { id: input.existingPolicy?.id ?? "policy-new" };
      },
      async deleteServiceToken(tokenId: string) {
        events.push({ event: "delete-token", tokenId });
      },
    },
  };
}

function variableValue(variables: VariableTarget[], name: string, repository: string) {
  return variables.find((variable) => variable.name === name && variable.repository === repository)
    ?.value;
}

test("first bootstrap creates one service-auth policy and writes every destination", async () => {
  const cloudflare = createCloudflareFixture();
  const github = createGitHubFixture();
  const logs: string[] = [];
  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: false,
      rotationLabel: "123-1",
      runtimeProvider: "local",
      workersApiToken: "fixture-workers-credential",
    },
    {
      cloudflare: cloudflare.client,
      github: github.client,
      logger: { log: (message: string) => logs.push(message) },
    },
  );

  assert.equal(result.createdServiceToken, true);
  assert.equal(result.rotatedServiceToken, false);
  assert.deepEqual(
    cloudflare.events.find((event) => event.event === "create-token"),
    {
      event: "create-token",
      name: BOOTSTRAP_CONTRACT.accessServiceTokenName,
      duration: BOOTSTRAP_CONTRACT.accessServiceTokenDuration,
    },
  );
  const policies = cloudflare.events.filter((event) => event.event === "ensure-policy");
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0]?.tokenIds, ["token-new"]);
  assert.equal(github.secrets.length, 7);
  assert.equal(github.variables.length, 11);
  assert.equal(
    variableValue(
      github.variables,
      "CRAWL_REMOTE_CLOUDFLARE_TOKEN_SHA256",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    createHash("sha256").update("fixture-workers-credential").digest("hex"),
  );
  assert.equal(
    variableValue(
      github.variables,
      "CLAWSWEEPER_GITCRAWL_PROVIDER",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    "local",
  );
  assert.equal(
    variableValue(
      github.variables,
      "GITCRAWL_CLOUD_PUBLISH_ENABLED",
      BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    ),
    "0",
  );
  assert.equal(
    variableValue(
      github.variables,
      "GITCRAWL_CLOUD_STAGE_ONLY",
      BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    ),
    "1",
  );
  assert.doesNotMatch(logs.join("\n"), /fixture-(workers|client)/);
});

test("existing token with missing GitHub slots fails before Cloudflare mutation", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
  });
  const github = createGitHubFixture();

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: false,
        rotationLabel: "123-1",
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
      },
      { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
    ),
    /existing crawl-remote Access service token secret cannot be recovered.*explicit rotation/,
  );
  assert.deepEqual(
    cloudflare.events.map((event) => event.event),
    ["list-tokens"],
  );
  assert.equal(github.secrets.length, 0);
  assert.equal(github.variables.length, 0);
});

test("complete existing bootstrap reconciles without rewriting Access secrets", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const github = createGitHubFixture({ completeAccessSecrets: true });

  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "1",
      rotateServiceToken: false,
      rotationLabel: "123-1",
      runtimeProvider: "parity",
      workersApiToken: "fixture-workers-credential",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.createdServiceToken, false);
  assert.equal(result.rotatedServiceToken, false);
  assert.equal(github.lists.length, 3);
  assert.deepEqual(
    github.secrets.map((secret) => secret.name),
    ["CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN"],
  );
  assert.equal(
    variableValue(
      github.variables,
      "CLAWSWEEPER_GITCRAWL_PROVIDER",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    "parity",
  );
  assert.equal(
    variableValue(
      github.variables,
      "GITCRAWL_CLOUD_PUBLISH_ENABLED",
      BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    ),
    "1",
  );
  assert.equal(
    cloudflare.events.some((event) => event.event === "create-token"),
    false,
  );
  assert.equal(
    cloudflare.events.some((event) => event.event === "delete-token"),
    false,
  );
});

test("rotation authorizes both tokens until all GitHub credentials are replaced", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const github = createGitHubFixture();

  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: true,
      rotationLabel: "456-2",
      runtimeProvider: "local",
      workersApiToken: "fixture-workers-credential",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.rotatedServiceToken, true);
  const policies = cloudflare.events.filter((event) => event.event === "ensure-policy");
  assert.deepEqual(
    policies.map((policy) => policy.tokenIds),
    [["token-old", "token-new"], ["token-new"]],
  );
  assert.equal(github.secrets.length, 7);
  const deleteIndex = cloudflare.events.findIndex((event) => event.event === "delete-token");
  const finalPolicyIndex = cloudflare.events.findLastIndex(
    (event) => event.event === "ensure-policy",
  );
  assert.ok(deleteIndex > finalPolicyIndex);
  assert.deepEqual(cloudflare.events[deleteIndex], {
    event: "delete-token",
    tokenId: "token-old",
  });
});

test("rotation keeps the old token authorized when GitHub publication fails", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const github = createGitHubFixture();
  github.client.setSecret = async (target: SecretTarget) => {
    github.secrets.push(target);
    if (target.name === "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_CLIENT_ID") {
      throw new Error("injected GitHub write failure");
    }
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: true,
        rotationLabel: "789-1",
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
      },
      { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
    ),
    /injected GitHub write failure/,
  );

  const policies = cloudflare.events.filter((event) => event.event === "ensure-policy");
  assert.deepEqual(
    policies.map((policy) => policy.tokenIds),
    [["token-old", "token-new"]],
  );
  assert.equal(
    cloudflare.events.some((event) => event.event === "delete-token"),
    false,
  );
});

test("Cloudflare client uses exact account-scoped application and policy contracts", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", url: String(url), body });
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/access/service_tokens")) {
      return Response.json({
        success: true,
        result: {
          id: "token-new",
          client_id: "fixture-client-id",
          client_secret: "fixture-client-credential",
        },
      });
    }
    if (path.endsWith("/access/apps")) {
      return Response.json({ success: true, result: { id: "app-new" } });
    }
    return Response.json({ success: true, result: { id: "policy-new" } });
  };
  const client = createCloudflareClient({
    token: "fixture-config-credential",
    fetchImpl,
    apiBase: "https://cloudflare.invalid/client/v4",
  });

  await client.createServiceToken({
    name: BOOTSTRAP_CONTRACT.accessServiceTokenName,
    duration: BOOTSTRAP_CONTRACT.accessServiceTokenDuration,
  });
  const application = await client.ensureAccessApplication(null);
  await client.ensureAccessPolicy({
    applicationId: application.id,
    existingPolicy: null,
    tokenIds: ["token-new"],
  });

  assert.equal(requests.length, 3);
  assert.match(
    requests[0]?.url ?? "",
    new RegExp(`/accounts/${BOOTSTRAP_CONTRACT.accountId}/access/service_tokens$`),
  );
  assert.deepEqual(requests[1]?.body, {
    name: BOOTSTRAP_CONTRACT.accessAppName,
    domain: BOOTSTRAP_CONTRACT.accessDomain,
    type: "self_hosted",
    session_duration: "24h",
    allowed_idps: [],
    auto_redirect_to_identity: false,
    enable_binding_cookie: false,
  });
  assert.deepEqual(requests[2]?.body, {
    name: BOOTSTRAP_CONTRACT.accessPolicyName,
    decision: "non_identity",
    include: [{ service_token: { token_id: "token-new" } }],
    exclude: [],
    require: [],
    precedence: 1,
    session_duration: "24h",
  });
});

test("GitHub client sends secret values only over standard input", async () => {
  const commands: Array<{
    args: string[];
    options: { input: string; env: NodeJS.ProcessEnv };
  }> = [];
  const client = createGitHubClient({
    token: "fixture-github-credential",
    fetchImpl: async () =>
      Response.json({
        total_count: 2,
        secrets: [{ name: "ONE" }, { name: "TWO" }],
      }),
    apiBase: "https://github.invalid",
    runGh: async (args, options) => {
      commands.push({ args, options });
      return { status: 0, stderr: "" };
    },
  });

  const names = await client.listSecretNames({
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
  });
  assert.deepEqual([...names], ["ONE", "TWO"]);
  await client.setSecret({
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    name: "FIXTURE_SECRET",
    value: "fixture-secret-value",
  });

  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]?.args, [
    "secret",
    "set",
    "FIXTURE_SECRET",
    "--repo",
    BOOTSTRAP_CONTRACT.clawsweeperRepository,
  ]);
  assert.equal(commands[0]?.options.input, "fixture-secret-value");
  assert.equal(commands[0]?.options.env.GH_TOKEN, "fixture-github-credential");
  assert.equal(commands[0]?.options.env.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN, undefined);
  assert.equal(commands[0]?.options.env.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN, undefined);
  assert.equal(commands[0]?.options.env.OPENCLAW_GH_TOKEN, undefined);
  assert.doesNotMatch(commands[0]?.args.join(" "), /fixture-secret-value/);
});
