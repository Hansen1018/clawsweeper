import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  BOOTSTRAP_CONTRACT,
  assertCrawlRemoteDeployConsumerContract,
  bootstrapCrawlRemoteAccess,
  credentialGenerationMarker,
  createCloudflareClient,
  createGitHubClient,
  parseBareSwitch,
} from "../scripts/bootstrap-crawl-remote-access.mjs";

const quietLogger = { log() {} };

interface SecretTarget {
  repository: string;
  environment?: string;
  name: string;
  value: string;
}

interface VariableTarget extends SecretTarget {}

const credentialTargets = [
  {
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    environment: BOOTSTRAP_CONTRACT.productionEnvironment,
    prefix: "CRAWL_REMOTE_ACCESS",
    generationVariable: "CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION",
  },
  {
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    prefix: "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS",
    generationVariable: "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_CREDENTIAL_GENERATION",
  },
  {
    repository: BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    prefix: "GITCRAWL_CLOUD_ACCESS",
    generationVariable: "GITCRAWL_CLOUD_ACCESS_CREDENTIAL_GENERATION",
  },
] as const;

function targetKey(target: { repository: string; environment?: string }) {
  return `${target.repository}:${target.environment ?? "repository"}`;
}

function credentialNames(prefix: string, slot: "blue" | "green") {
  const slotName = slot.toUpperCase();
  return {
    clientId: `${prefix}_${slotName}_CLIENT_ID`,
    clientSecret: `${prefix}_${slotName}_CLIENT_SECRET`,
  };
}

function createGitHubFixture({
  activeTokenId,
  activeSlot = "blue",
}: {
  activeTokenId?: string;
  activeSlot?: "blue" | "green";
} = {}) {
  const secrets: SecretTarget[] = [];
  const variables: VariableTarget[] = [];
  const lists: Array<{ repository: string; environment?: string }> = [];
  const variableReads: Array<{ repository: string; environment?: string; name: string }> = [];
  const writes: Array<{ kind: "secret" | "variable"; name: string; repository: string }> = [];
  const mainChecks: number[] = [];
  const secretNames = new Map<string, Set<string>>();
  const variableValues = new Map<string, string>();
  if (activeTokenId) {
    for (const target of credentialTargets) {
      const names = credentialNames(target.prefix, activeSlot);
      secretNames.set(targetKey(target), new Set([names.clientId, names.clientSecret]));
      variableValues.set(
        `${targetKey(target)}:${target.generationVariable}`,
        credentialGenerationMarker(activeTokenId, activeSlot),
      );
    }
  }
  return {
    secrets,
    variables,
    lists,
    secretNames,
    variableReads,
    variableValues,
    writes,
    mainChecks,
    client: {
      async assertCurrentMain() {
        mainChecks.push(mainChecks.length + 1);
      },
      async listSecretNames(target: { repository: string; environment?: string }) {
        lists.push(target);
        return new Set(secretNames.get(targetKey(target)) ?? []);
      },
      async getVariable(target: { repository: string; environment?: string; name: string }) {
        variableReads.push(target);
        return variableValues.get(`${targetKey(target)}:${target.name}`) ?? null;
      },
      async setSecret(target: SecretTarget) {
        secrets.push(target);
        writes.push({ kind: "secret", name: target.name, repository: target.repository });
        const key = targetKey(target);
        const names = secretNames.get(key) ?? new Set<string>();
        names.add(target.name);
        secretNames.set(key, names);
      },
      async setVariable(target: VariableTarget) {
        variables.push(target);
        writes.push({ kind: "variable", name: target.name, repository: target.repository });
        variableValues.set(`${targetKey(target)}:${target.name}`, target.value);
      },
    },
  };
}

function createCloudflareFixture({
  tokens = [],
  application = null,
  policy = null,
  createdTokenId = "token-new",
}: {
  tokens?: Array<{ id: string; name: string }>;
  application?: { id: string; name?: string; domain?: string } | null;
  policy?: { id: string } | null;
  createdTokenId?: string;
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
          id: createdTokenId,
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

function validDeployConsumerSource() {
  return [
    "jobs:",
    "  preflight:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo preflight",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo deploy",
    "  crawl_remote_access_verify:",
    "    name: Verify crawl-remote Access credentials",
    "    needs: [preflight, deploy]",
    "    permissions: {}",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 2",
    "    environment:",
    "      name: crawl-remote-production",
    "    defaults:",
    "      run:",
    "        shell: bash --noprofile --norc -euo pipefail {0}",
    "    env:",
    '      BASH_ENV: ""',
    '      ENV: ""',
    '      NODE_OPTIONS: ""',
    "    steps:",
    "      - name: Checkout crawl-remote Access resolver",
    "        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    "        with:",
    "          fetch-depth: 1",
    "          persist-credentials: false",
    "          ref: ${{ github.sha }}",
    "          repository: ${{ github.repository }}",
    "          sparse-checkout: scripts/resolve-crawl-remote-access-credentials.mjs",
    "          sparse-checkout-cone-mode: false",
    "      - name: Resolve and verify crawl-remote Access credentials",
    "        env:",
    '          BASH_ENV: ""',
    "          CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: ${{ vars.CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION }}",
    "          CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: ${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID }}",
    "          CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: ${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET }}",
    "          CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID: ${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID }}",
    "          CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET: ${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET }}",
    "          CRAWL_REMOTE_ACCESS_EXPECTED_OBSERVATION_ORDER_STATE: ${{ needs.preflight.outputs.observation_order_state }}",
    "          CRAWL_REMOTE_ACCESS_EXPECTED_RELEASE_SHA: ${{ needs.preflight.outputs.deploy_sha }}",
    "          CRAWL_REMOTE_ACCESS_EXPECTED_SNAPSHOT_PROVENANCE_STATE: ${{ needs.preflight.outputs.snapshot_provenance_state }}",
    "          CRAWL_REMOTE_ACCESS_PROBE_URL: https://reports.openclaw.ai/crawl-remote",
    '          ENV: ""',
    '          NODE_OPTIONS: ""',
    "        run: node scripts/resolve-crawl-remote-access-credentials.mjs --resolve-and-verify-access",
  ].join("\n");
}

test("deploy consumer gate accepts only the isolated resolve-and-verify job", () => {
  const validSource = validDeployConsumerSource();
  assert.doesNotThrow(() => assertCrawlRemoteDeployConsumerContract(validSource));

  for (const source of [
    validSource.replace("    needs: [preflight, deploy]", "    needs: deploy"),
    validSource.replace("    permissions: {}", "    permissions:\n      contents: read"),
    validSource.replace(
      "    permissions: {}\n    runs-on: ubuntu-latest",
      "    permissions: {}\n    runs-on: self-hosted",
    ),
    validSource.replace("          ref: ${{ github.sha }}", "          ref: refs/heads/main"),
    validSource.replace(
      "      - name: Resolve and verify crawl-remote Access credentials",
      [
        "      - run: echo unreviewed",
        "      - name: Resolve and verify crawl-remote Access credentials",
      ].join("\n"),
    ),
    validSource.replace(
      "        run: node scripts/resolve-crawl-remote-access-credentials.mjs --resolve-and-verify-access",
      "        run: node scripts/resolve-crawl-remote-access-credentials.mjs",
    ),
    validSource.replace(
      '          NODE_OPTIONS: ""',
      '          NODE_OPTIONS: "--import ./unreviewed.mjs"',
    ),
  ]) {
    assert.throws(
      () => assertCrawlRemoteDeployConsumerContract(source),
      /must use the exact isolated job contract/,
    );
  }
});

test("deploy consumer gate rejects encoded and out-of-job credential access", () => {
  const validSource = validDeployConsumerSource();
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace("jobs:", ['"e\\u006ev": "--import ./bad.mjs"', "jobs:"].join("\n")),
      ),
    /canonical unescaped scalar values/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - run: echo deploy",
          "      - run: echo ${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET }}",
        ),
      ),
    /must reference CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET only in the isolated verifier job/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - run: echo deploy",
          '      - run: "${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_\\u0049D }}"',
        ),
      ),
    /canonical unescaped scalar values/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - run: echo deploy",
          "      - run: echo CRAWL_REMOTE_ACCESS_CLIENT_ID CRAWL_REMOTE_ACCESS_CLIENT_SECRET",
        ),
      ),
    /legacy unversioned references/,
  );
});

test("rotation requires an exact bare CLI switch", () => {
  assert.equal(parseBareSwitch(undefined, "rotate-service-token"), false);
  assert.equal(parseBareSwitch(true, "rotate-service-token"), true);
  for (const value of [false, "false", "0", "1"]) {
    assert.throws(
      () => parseBareSwitch(value, "rotate-service-token"),
      /must be supplied as a bare switch/,
    );
  }
});

test("bootstrap CLI rejects valued rotation switches before any contract or API work", () => {
  for (const value of ["false", "0"]) {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/bootstrap-crawl-remote-access.mjs",
        "--confirm",
        BOOTSTRAP_CONTRACT.confirmation,
        "--rotate-service-token",
        value,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {},
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--rotate-service-token must be supplied as a bare switch/);
    assert.doesNotMatch(result.stderr, /consumer contract|Cloudflare|GitHub/);
  }
});

test("optional Gitcrawl consumers remain dormant before Cloudflare reads", async () => {
  for (const [options, expected] of [
    [{ publisherEnabled: "0", runtimeProvider: "local" }, /must stage the cloud provider/],
    [{ publisherEnabled: "0", runtimeProvider: "parity" }, /must stage the cloud provider/],
    [
      { publisherEnabled: "1", runtimeProvider: "cloud" },
      /gitcrawl-store publication must remain disabled/,
    ],
  ] as const) {
    const cloudflare = createCloudflareFixture();
    const github = createGitHubFixture();
    await assert.rejects(
      bootstrapCrawlRemoteAccess(
        {
          ...options,
          rotateServiceToken: false,
          rotationLabel: "123-1",
        },
        { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
      ),
      expected,
    );
    assert.equal(cloudflare.events.length, 0);
    assert.equal(github.lists.length, 0);
    assert.equal(github.variableReads.length, 0);
  }
});

test("first bootstrap creates one service-auth policy and writes every destination", async () => {
  const cloudflare = createCloudflareFixture();
  const github = createGitHubFixture();
  const logs: string[] = [];
  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: false,
      rotationLabel: "123-1",
      runtimeProvider: "cloud",
    },
    {
      cloudflare: cloudflare.client,
      github: github.client,
      logger: { log: (message: string) => logs.push(message) },
    },
  );

  assert.equal(result.createdServiceToken, true);
  assert.equal(result.rotatedServiceToken, false);
  assert.equal(github.mainChecks.length, 8);
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
  assert.equal(github.secrets.length, 6);
  assert.equal(github.variables.length, 12);
  for (const target of credentialTargets) {
    const names = credentialNames(target.prefix, "blue");
    assert.ok(
      github.secrets.some(
        (secret) =>
          secret.repository === target.repository &&
          secret.environment === target.environment &&
          secret.name === names.clientId,
      ),
    );
    assert.ok(
      github.secrets.some(
        (secret) =>
          secret.repository === target.repository &&
          secret.environment === target.environment &&
          secret.name === names.clientSecret,
      ),
    );
    assert.equal(
      variableValue(github.variables, target.generationVariable, target.repository),
      credentialGenerationMarker("token-new", "blue"),
    );
  }
  const firstMarkerWrite = github.writes.findIndex(
    (write) => write.kind === "variable" && write.name.endsWith("_CREDENTIAL_GENERATION"),
  );
  const lastAccessSecretWrite = github.writes.findLastIndex(
    (write) => write.kind === "secret" && write.name.includes("_ACCESS_"),
  );
  assert.ok(firstMarkerWrite > lastAccessSecretWrite);
  const intakeDisableWrite = github.writes.findIndex(
    (write) =>
      write.kind === "variable" && write.name === "CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED",
  );
  const cloudProviderWrite = github.writes.findIndex(
    (write) => write.kind === "variable" && write.name === "CLAWSWEEPER_GITCRAWL_PROVIDER",
  );
  const publisherDisableWrite = github.writes.findIndex(
    (write) => write.kind === "variable" && write.name === "GITCRAWL_CLOUD_PUBLISH_ENABLED",
  );
  assert.ok(intakeDisableWrite >= 0);
  assert.ok(publisherDisableWrite >= 0);
  assert.ok(firstMarkerWrite > intakeDisableWrite);
  assert.ok(firstMarkerWrite > publisherDisableWrite);
  assert.ok(cloudProviderWrite > intakeDisableWrite);
  for (const liveDeployInput of [
    "CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN",
    "CRAWL_REMOTE_DEPLOY_AUTHORITY",
    "CRAWL_REMOTE_CUSTOM_ROUTE_PROOF",
    "CRAWL_REMOTE_CLOUDFLARE_TOKEN_SHA256",
    "CRAWL_REMOTE_CLOUDFLARE_TOKEN_FINGERPRINT",
  ]) {
    assert.equal(
      github.writes.some((write) => write.name === liveDeployInput),
      false,
      `${liveDeployInput} must remain owned by the protected deploy path`,
    );
  }
  assert.equal(
    variableValue(
      github.variables,
      "CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    "0",
  );
  assert.equal(
    variableValue(
      github.variables,
      "CLAWSWEEPER_GITCRAWL_PROVIDER",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    "cloud",
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
  assert.doesNotMatch(logs.join("\n"), /fixture-client/);
});

test("kill switches are verified before Cloudflare or credential publication", async () => {
  const cloudflare = createCloudflareFixture();
  const github = createGitHubFixture();
  const originalGetVariable = github.client.getVariable;
  github.client.getVariable = async (target: {
    repository: string;
    environment?: string;
    name: string;
  }) => {
    if (target.name === "GITCRAWL_CLOUD_PUBLISH_ENABLED") return "1";
    return originalGetVariable(target);
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: false,
        rotationLabel: "123-1",
        runtimeProvider: "cloud",
      },
      { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
    ),
    /GITCRAWL_CLOUD_PUBLISH_ENABLED did not remain disabled/,
  );

  assert.deepEqual(
    cloudflare.events.map((event) => event.event),
    ["list-tokens", "inspect-app"],
  );
  assert.equal(
    github.variables.some((variable) => variable.name.endsWith("_CREDENTIAL_GENERATION")),
    false,
  );
  assert.equal(github.secrets.length, 0);
});

test("existing token without matching credential generations fails before Cloudflare mutation", async () => {
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
        runtimeProvider: "cloud",
      },
      { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
    ),
    /credentials are not bound to the selected service token.*explicit rotation/,
  );
  assert.deepEqual(
    cloudflare.events.map((event) => event.event),
    ["list-tokens"],
  );
  assert.equal(github.secrets.length, 0);
  assert.equal(github.variables.length, 0);
});

test("populated slots bound to a stale token still require explicit rotation", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [{ id: "token-current", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
  });
  const github = createGitHubFixture({ activeTokenId: "token-deleted" });

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: false,
        rotationLabel: "123-1",
        runtimeProvider: "cloud",
      },
      { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
    ),
    /credentials are not bound to the selected service token.*explicit rotation/,
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
  const github = createGitHubFixture({ activeTokenId: "token-old" });

  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: false,
      rotationLabel: "123-1",
      runtimeProvider: "cloud",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.createdServiceToken, false);
  assert.equal(result.rotatedServiceToken, false);
  assert.equal(result.resumedServiceTokenRotation, false);
  assert.equal(github.lists.length, 3);
  assert.equal(github.variableReads.length, 5);
  assert.equal(github.secrets.length, 0);
  assert.equal(github.mainChecks.length, 5);
  assert.equal(
    variableValue(
      github.variables,
      "CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    "0",
  );
  assert.equal(
    variableValue(
      github.variables,
      "CLAWSWEEPER_GITCRAWL_PROVIDER",
      BOOTSTRAP_CONTRACT.clawsweeperRepository,
    ),
    "cloud",
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
  const github = createGitHubFixture({ activeTokenId: "token-old" });

  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: true,
      rotationLabel: "456-2",
      runtimeProvider: "cloud",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.rotatedServiceToken, true);
  assert.equal(result.resumedServiceTokenRotation, false);
  assert.equal(github.mainChecks.length, 10);
  const policies = cloudflare.events.filter((event) => event.event === "ensure-policy");
  assert.deepEqual(
    policies.map((policy) => policy.tokenIds),
    [["token-old", "token-new"], ["token-new"]],
  );
  assert.equal(github.secrets.length, 6);
  for (const target of credentialTargets) {
    const names = credentialNames(target.prefix, "green");
    assert.ok(github.secrets.some((secret) => secret.name === names.clientId));
    assert.ok(github.secrets.some((secret) => secret.name === names.clientSecret));
    assert.equal(
      variableValue(github.variables, target.generationVariable, target.repository),
      credentialGenerationMarker("token-new", "green"),
    );
  }
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

test("renamed marker-bound tokens require rotation and remain authorized until cutover", async () => {
  const renamedToken = { id: "token-renamed", name: "renamed outside bootstrap" };
  const blockedCloudflare = createCloudflareFixture({ tokens: [renamedToken] });
  const blockedGitHub = createGitHubFixture({ activeTokenId: renamedToken.id });

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: false,
        rotationLabel: "456-1",
        runtimeProvider: "cloud",
      },
      {
        cloudflare: blockedCloudflare.client,
        github: blockedGitHub.client,
        logger: quietLogger,
      },
    ),
    /marker-bound.*no longer has its managed name.*explicit rotation/,
  );
  assert.deepEqual(
    blockedCloudflare.events.map((event) => event.event),
    ["list-tokens"],
  );
  assert.equal(blockedGitHub.variables.length, 0);

  const rotationCloudflare = createCloudflareFixture({
    tokens: [renamedToken],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const rotationGitHub = createGitHubFixture({ activeTokenId: renamedToken.id });
  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: true,
      rotationLabel: "456-2",
      runtimeProvider: "cloud",
    },
    {
      cloudflare: rotationCloudflare.client,
      github: rotationGitHub.client,
      logger: quietLogger,
    },
  );

  assert.equal(result.accessServiceTokenId, "token-new");
  assert.deepEqual(
    rotationCloudflare.events
      .filter((event) => event.event === "ensure-policy")
      .map((event) => event.tokenIds),
    [["token-renamed", "token-new"], ["token-new"]],
  );
  assert.deepEqual(
    rotationCloudflare.events.filter((event) => event.event === "delete-token"),
    [{ event: "delete-token", tokenId: "token-renamed" }],
  );
});

test("main drift blocks initial mutation and old-token revocation", async () => {
  const initialCloudflare = createCloudflareFixture();
  const initialGitHub = createGitHubFixture();
  initialGitHub.client.assertCurrentMain = async () => {
    initialGitHub.mainChecks.push(1);
    throw new Error("ClawSweeper main advanced during crawl-remote Access bootstrap");
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: false,
        rotationLabel: "456-1",
        runtimeProvider: "cloud",
      },
      {
        cloudflare: initialCloudflare.client,
        github: initialGitHub.client,
        logger: quietLogger,
      },
    ),
    /main advanced/,
  );
  assert.equal(initialGitHub.mainChecks.length, 1);
  assert.deepEqual(
    initialCloudflare.events.map((event) => event.event),
    ["list-tokens", "inspect-app"],
  );

  const rotationCloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const rotationGitHub = createGitHubFixture({ activeTokenId: "token-old" });
  rotationGitHub.client.assertCurrentMain = async () => {
    rotationGitHub.mainChecks.push(rotationGitHub.mainChecks.length + 1);
    if (rotationGitHub.mainChecks.length === 10) {
      throw new Error("ClawSweeper main advanced during crawl-remote Access bootstrap");
    }
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: true,
        rotationLabel: "456-2",
        runtimeProvider: "cloud",
      },
      {
        cloudflare: rotationCloudflare.client,
        github: rotationGitHub.client,
        logger: quietLogger,
      },
    ),
    /main advanced/,
  );
  assert.equal(rotationGitHub.mainChecks.length, 10);
  assert.deepEqual(
    rotationCloudflare.events
      .filter((event) => event.event === "ensure-policy")
      .map((event) => event.tokenIds),
    [["token-old", "token-new"], ["token-new"]],
  );
  assert.equal(
    rotationCloudflare.events.some((event) => event.event === "delete-token"),
    false,
  );
});

test("rotation keeps active markers and the old token when an inactive pair write fails", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const github = createGitHubFixture({ activeTokenId: "token-old" });
  github.client.setSecret = async (target: SecretTarget) => {
    github.secrets.push(target);
    github.writes.push({ kind: "secret", name: target.name, repository: target.repository });
    if (target.name === "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_GREEN_CLIENT_SECRET") {
      throw new Error("injected GitHub write failure");
    }
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: true,
        rotationLabel: "789-1",
        runtimeProvider: "cloud",
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
  assert.equal(
    github.variables.some((variable) => variable.name.endsWith("_CREDENTIAL_GENERATION")),
    false,
  );
  for (const target of credentialTargets) {
    assert.equal(
      github.variableValues.get(`${targetKey(target)}:${target.generationVariable}`),
      credentialGenerationMarker("token-old", "blue"),
    );
  }
});

test("retry after an inactive pair failure supersedes every ambiguous token", async () => {
  const github = createGitHubFixture({ activeTokenId: "token-old" });
  const originalSetSecret = github.client.setSecret;
  let failInactiveWrite = true;
  github.client.setSecret = async (target: SecretTarget) => {
    if (
      failInactiveWrite &&
      target.name === "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_GREEN_CLIENT_SECRET"
    ) {
      failInactiveWrite = false;
      throw new Error("injected GitHub write failure");
    }
    await originalSetSecret(target);
  };
  const interruptedCloudflare = createCloudflareFixture({
    tokens: [{ id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName }],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
    createdTokenId: "token-partial",
  });

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: true,
        rotationLabel: "789-1",
        runtimeProvider: "cloud",
      },
      {
        cloudflare: interruptedCloudflare.client,
        github: github.client,
        logger: quietLogger,
      },
    ),
    /injected GitHub write failure/,
  );

  const retryCloudflare = createCloudflareFixture({
    tokens: [
      { id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName },
      {
        id: "token-partial",
        name: `${BOOTSTRAP_CONTRACT.accessServiceTokenName} rotation 789-1`,
      },
    ],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
    createdTokenId: "token-retry",
  });

  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: true,
      rotationLabel: "790-1",
      runtimeProvider: "cloud",
    },
    { cloudflare: retryCloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.accessServiceTokenId, "token-retry");
  assert.equal(result.createdServiceToken, true);
  assert.equal(result.rotatedServiceToken, true);
  assert.equal(result.resumedServiceTokenRotation, false);
  assert.deepEqual(
    retryCloudflare.events
      .filter((event) => event.event === "ensure-policy")
      .map((event) => event.tokenIds),
    [["token-old", "token-retry"], ["token-retry"]],
  );
  assert.deepEqual(
    retryCloudflare.events.filter((event) => event.event === "delete-token"),
    [
      { event: "delete-token", tokenId: "token-old" },
      { event: "delete-token", tokenId: "token-partial" },
    ],
  );
  for (const target of credentialTargets) {
    assert.equal(
      github.variableValues.get(`${targetKey(target)}:${target.generationVariable}`),
      credentialGenerationMarker("token-retry", "green"),
    );
  }
});

test("explicit rotation resumes finalization when markers bind the newest managed token", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [
      { id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName },
      {
        id: "token-new",
        name: `${BOOTSTRAP_CONTRACT.accessServiceTokenName} rotation 456-1`,
      },
    ],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const github = createGitHubFixture({ activeTokenId: "token-new", activeSlot: "green" });

  const result = await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: "0",
      rotateServiceToken: true,
      rotationLabel: "456-2",
      runtimeProvider: "cloud",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.createdServiceToken, false);
  assert.equal(result.rotatedServiceToken, true);
  assert.equal(result.resumedServiceTokenRotation, true);
  assert.equal(
    cloudflare.events.some((event) => event.event === "create-token"),
    false,
  );
  assert.deepEqual(
    cloudflare.events
      .filter((event) => event.event === "ensure-policy")
      .map((event) => event.tokenIds),
    [["token-new"]],
  );
  assert.deepEqual(
    cloudflare.events.filter((event) => event.event === "delete-token"),
    [{ event: "delete-token", tokenId: "token-old" }],
  );
  assert.equal(github.secrets.length, 0);
  assert.equal(github.mainChecks.length, 6);
});

test("resumed rotation reauthorizes immediately before narrowing Access", async () => {
  const cloudflare = createCloudflareFixture({
    tokens: [
      { id: "token-old", name: BOOTSTRAP_CONTRACT.accessServiceTokenName },
      {
        id: "token-new",
        name: `${BOOTSTRAP_CONTRACT.accessServiceTokenName} rotation 456-1`,
      },
    ],
    application: {
      id: "app-existing",
      name: BOOTSTRAP_CONTRACT.accessAppName,
      domain: BOOTSTRAP_CONTRACT.accessDomain,
    },
    policy: { id: "policy-existing" },
  });
  const github = createGitHubFixture({ activeTokenId: "token-new", activeSlot: "green" });
  github.client.assertCurrentMain = async () => {
    github.mainChecks.push(github.mainChecks.length + 1);
    if (github.mainChecks.length === 3) {
      throw new Error("ClawSweeper main advanced during crawl-remote Access bootstrap");
    }
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: true,
        rotationLabel: "456-2",
        runtimeProvider: "cloud",
      },
      { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
    ),
    /main advanced/,
  );
  assert.equal(github.mainChecks.length, 3);
  assert.equal(
    cloudflare.events.some((event) => event.event === "ensure-policy"),
    false,
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

test("Cloudflare client replaces a managed policy with any extra include selector", async () => {
  const requests: Array<{ method: string; body?: unknown }> = [];
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", body });
    return Response.json({ success: true, result: { id: "policy-existing", ...body } });
  };
  const client = createCloudflareClient({
    token: "fixture-config-credential",
    fetchImpl,
    apiBase: "https://cloudflare.invalid/client/v4",
  });

  await client.ensureAccessPolicy({
    applicationId: "app-existing",
    existingPolicy: {
      id: "policy-existing",
      name: BOOTSTRAP_CONTRACT.accessPolicyName,
      decision: "non_identity",
      include: [{ service_token: { token_id: "token-existing" } }, { everyone: {} }],
      exclude: [],
      require: [],
      precedence: 1,
      session_duration: "24h",
    },
    tokenIds: ["token-existing"],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "PUT");
  assert.deepEqual(requests[0]?.body, {
    name: BOOTSTRAP_CONTRACT.accessPolicyName,
    decision: "non_identity",
    include: [{ service_token: { token_id: "token-existing" } }],
    exclude: [],
    require: [],
    precedence: 1,
    session_duration: "24h",
  });
});

test("GitHub client routes repository tokens and sends secret values only over standard input", async () => {
  const commands: Array<{
    args: string[];
    options: { input: string; env: NodeJS.ProcessEnv };
  }> = [];
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const expectedMainSha = "1".repeat(40);
  let returnedMainSha = expectedMainSha;
  const client = createGitHubClient({
    expectedMainSha,
    mainReadToken: "fixture-main-read-credential",
    tokensByRepository: {
      [BOOTSTRAP_CONTRACT.clawsweeperRepository]: "fixture-clawsweeper-credential",
      [BOOTSTRAP_CONTRACT.gitcrawlStoreRepository]: "fixture-store-credential",
    },
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (String(url).endsWith("/repos/openclaw/clawsweeper/commits/main")) {
        return Response.json({ sha: returnedMainSha });
      }
      if (String(url).includes("/variables/")) {
        return Response.json({ message: "not found" }, { status: 404 });
      }
      return Response.json({
        total_count: 2,
        secrets: [{ name: "ONE" }, { name: "TWO" }],
      });
    },
    apiBase: "https://github.invalid",
    runGh: async (args, options) => {
      commands.push({ args, options });
      return { status: 0, stderr: "" };
    },
  });

  await client.assertCurrentMain();
  const clawsweeperNames = await client.listSecretNames({
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
  });
  const storeNames = await client.listSecretNames({
    repository: BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
  });
  const missingVariable = await client.getVariable({
    repository: BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    name: "MISSING_VARIABLE",
  });
  assert.deepEqual([...clawsweeperNames], ["ONE", "TWO"]);
  assert.deepEqual([...storeNames], ["ONE", "TWO"]);
  assert.equal(missingVariable, null);
  assert.deepEqual(
    requests.map((request) => request.authorization),
    [
      "Bearer fixture-main-read-credential",
      "Bearer fixture-clawsweeper-credential",
      "Bearer fixture-store-credential",
      "Bearer fixture-store-credential",
    ],
  );
  returnedMainSha = "2".repeat(40);
  await assert.rejects(client.assertCurrentMain(), /main advanced/);
  await client.setSecret({
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    name: "FIXTURE_SECRET",
    value: "fixture-secret-value",
  });
  await client.setVariable({
    repository: BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    name: "FIXTURE_VARIABLE",
    value: "fixture-variable-value",
  });

  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0]?.args, [
    "secret",
    "set",
    "FIXTURE_SECRET",
    "--repo",
    BOOTSTRAP_CONTRACT.clawsweeperRepository,
  ]);
  assert.deepEqual(commands[1]?.args, [
    "variable",
    "set",
    "FIXTURE_VARIABLE",
    "--repo",
    BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
  ]);
  assert.equal(commands[0]?.options.input, "fixture-secret-value");
  assert.equal(commands[0]?.options.env.GH_TOKEN, "fixture-clawsweeper-credential");
  assert.equal(commands[1]?.options.input, "fixture-variable-value");
  assert.equal(commands[1]?.options.env.GH_TOKEN, "fixture-store-credential");
  for (const command of commands) {
    assert.equal(command.options.env.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN, undefined);
    assert.equal(command.options.env.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN, undefined);
    assert.equal(command.options.env.CLAWSWEEPER_BOOTSTRAP_GH_TOKEN, undefined);
    assert.equal(command.options.env.CLAWSWEEPER_MAIN_READ_GH_TOKEN, undefined);
    assert.equal(command.options.env.GITCRAWL_STORE_BOOTSTRAP_GH_TOKEN, undefined);
  }
  assert.doesNotMatch(commands[0]?.args.join(" ") ?? "", /fixture-secret-value/);
});
