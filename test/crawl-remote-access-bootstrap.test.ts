import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BOOTSTRAP_CONTRACT,
  assertCrawlRemoteDeployConsumerContract,
  bootstrapCrawlRemoteAccess,
  credentialGenerationMarker,
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

test("deploy consumer gate rejects comment-only claims and accepts a structural resolver", () => {
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        [
          "jobs:",
          "  deploy:",
          "    steps:",
          "      - name: Placeholder",
          "        run: |",
          "          # - name: Resolve crawl-remote Access credentials",
          "          # node scripts/resolve-crawl-remote-access-credentials.mjs",
        ].join("\n"),
      ),
    /requires exactly one "Resolve crawl-remote Access credentials" step/,
  );

  const validSource = [
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
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
    "          sparse-checkout: scripts/resolve-crawl-remote-access-credentials.mjs",
    "          sparse-checkout-cone-mode: false",
    "      - name: Resolve crawl-remote Access credentials",
    "        id: crawl-remote-access-credentials",
    "        env:",
    '          BASH_ENV: ""',
    "          CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION: ${{ vars.CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION }}",
    "          CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: ${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID }}",
    "          CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: ${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET }}",
    "          CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID: ${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID }}",
    "          CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET: ${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET }}",
    '          ENV: ""',
    '          NODE_OPTIONS: ""',
    "        run: |",
    "          node scripts/resolve-crawl-remote-access-credentials.mjs",
    "      - name: Validate protected production proof credentials",
    "        env:",
    "          CF_ACCESS_CLIENT_ID: ${{ steps.crawl-remote-access-credentials.outputs.client_id }}",
    "          CF_ACCESS_CLIENT_SECRET: ${{ steps.crawl-remote-access-credentials.outputs.client_secret }}",
    "        run: |",
    '          test -n "$CF_ACCESS_CLIENT_ID"',
    '          test -n "$CF_ACCESS_CLIENT_SECRET"',
  ].join("\n");
  assert.doesNotThrow(() => assertCrawlRemoteDeployConsumerContract(validSource));
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "          fetch-depth: 1",
          [
            "          fetch-depth: 1",
            "          repository: untrusted/example",
            "          ref: unreviewed",
          ].join("\n"),
        ),
      ),
    /requires its pinned sparse checkout immediately before it/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "          CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION:",
          [
            "          NODE_PATH: ./unreviewed",
            "          CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION:",
          ].join("\n"),
        ),
      ),
    /unsafe step contract/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "        id: crawl-remote-access-credentials",
          ['        "if": false', "        id: crawl-remote-access-credentials"].join("\n"),
        ),
      ),
    /invalid step syntax/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace('      NODE_OPTIONS: ""', '      NODE_OPTIONS: "--import ./bad.mjs"'),
      ),
    /unsafe inherited NODE_OPTIONS binding/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "        shell: bash --noprofile --norc -euo pipefail {0}",
          "        shell: bash",
        ),
      ),
    /unsafe inherited run controls/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource
          .replace("    env:", "    env :")
          .replace(
            '      NODE_OPTIONS: ""',
            ['      NODE_OPTIONS: ""', "      PATH: /tmp"].join("\n"),
          ),
      ),
    /unsafe inherited PATH binding/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource
          .replace("    defaults:", "    defaults :")
          .replace(
            "        shell: bash --noprofile --norc -euo pipefail {0}",
            [
              "        shell: bash --noprofile --norc -euo pipefail {0}",
              "        working-directory: /tmp",
            ].join("\n"),
          ),
      ),
    /unsafe inherited run controls/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace("    runs-on: ubuntu-latest", "    runs-on: self-hosted"),
      ),
    /unsafe inherited run controls/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "    runs-on: ubuntu-latest",
          ["    runs-on: ubuntu-latest", "    container: untrusted/image"].join("\n"),
        ),
      ),
    /unsafe inherited run controls/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          '          NODE_OPTIONS: ""',
          ['          NODE_OPTIONS: "--import ./bad.mjs"', '          NODE_OPTIONS: ""'].join("\n"),
        ),
      ),
    /duplicate step env field: NODE_OPTIONS/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - name: Resolve crawl-remote Access credentials",
          [
            "      - run: |",
            "          printf unreviewed > scripts/resolve-crawl-remote-access-credentials.mjs",
            "      - name: Resolve crawl-remote Access credentials",
          ].join("\n"),
        ),
      ),
    /requires its pinned sparse checkout immediately before it/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "${{ steps.crawl-remote-access-credentials.outputs.client_id }}",
          "${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID }}",
        ),
      ),
    /must reference CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID only in the resolver/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - name: Validate protected production proof credentials",
          [
            "      - name: Unrelated direct slot access",
            "        env:",
            "          UNRELATED_SECRET: ${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET }}",
            "        run: echo unrelated",
            "      - name: Validate protected production proof credentials",
          ].join("\n"),
        ),
      ),
    /must reference CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET only in the resolver/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - name: Validate protected production proof credentials",
          [
            "      - name: Unrelated resolver output access",
            "        env:",
            "          UNRELATED_SECRET: ${{ steps.crawl-remote-access-credentials.outputs.client_secret }}",
            "        run: echo unrelated",
            "      - name: Validate protected production proof credentials",
          ].join("\n"),
        ),
      ),
    /resolver outputs must be scoped to credential consumers/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - name: Validate protected production proof credentials",
          [
            "      - name: Alternate resolver output access",
            "        env:",
            "          UNRELATED_SECRET: ${{ steps['crawl-remote-access-credentials'].outputs['client_secret'] }}",
            "        run: echo unrelated",
            "      - name: Validate protected production proof credentials",
          ].join("\n"),
        ),
      ),
    /resolver outputs must use only allowlisted consumer bindings/,
  );
  assert.throws(
    () =>
      assertCrawlRemoteDeployConsumerContract(
        validSource.replace(
          "      - name: Validate protected production proof credentials",
          [
            "      - name: Legacy credential audit",
            "        run: echo CRAWL_REMOTE_ACCESS_CLIENT_ID CRAWL_REMOTE_ACCESS_CLIENT_SECRET",
            "      - name: Validate protected production proof credentials",
          ].join("\n"),
        ),
      ),
    /legacy unversioned references/,
  );
});

test("optional Gitcrawl consumers remain dormant before Cloudflare reads", async () => {
  for (const [options, expected] of [
    [
      { publisherEnabled: "0", runtimeProvider: "parity" },
      /ClawSweeper Gitcrawl must remain local/,
    ],
    [
      { publisherEnabled: "1", runtimeProvider: "local" },
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
          workersApiToken: "fixture-workers-credential",
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
  assert.equal(github.mainChecks.length, 1);
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
  assert.equal(github.variables.length, 14);
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
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
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
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
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
      runtimeProvider: "local",
      workersApiToken: "fixture-workers-credential",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.createdServiceToken, false);
  assert.equal(result.rotatedServiceToken, false);
  assert.equal(result.resumedServiceTokenRotation, false);
  assert.equal(github.lists.length, 3);
  assert.equal(github.variableReads.length, 3);
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
      runtimeProvider: "local",
      workersApiToken: "fixture-workers-credential",
    },
    { cloudflare: cloudflare.client, github: github.client, logger: quietLogger },
  );

  assert.equal(result.rotatedServiceToken, true);
  assert.equal(result.resumedServiceTokenRotation, false);
  assert.equal(github.mainChecks.length, 2);
  const policies = cloudflare.events.filter((event) => event.event === "ensure-policy");
  assert.deepEqual(
    policies.map((policy) => policy.tokenIds),
    [["token-old", "token-new"], ["token-new"]],
  );
  assert.equal(github.secrets.length, 7);
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
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
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
    if (rotationGitHub.mainChecks.length === 2) {
      throw new Error("ClawSweeper main advanced during crawl-remote Access bootstrap");
    }
  };

  await assert.rejects(
    bootstrapCrawlRemoteAccess(
      {
        publisherEnabled: "0",
        rotateServiceToken: true,
        rotationLabel: "456-2",
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
      },
      {
        cloudflare: rotationCloudflare.client,
        github: rotationGitHub.client,
        logger: quietLogger,
      },
    ),
    /main advanced/,
  );
  assert.equal(rotationGitHub.mainChecks.length, 2);
  assert.deepEqual(
    rotationCloudflare.events
      .filter((event) => event.event === "ensure-policy")
      .map((event) => event.tokenIds),
    [["token-old", "token-new"]],
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
        runtimeProvider: "local",
        workersApiToken: "fixture-workers-credential",
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
      runtimeProvider: "local",
      workersApiToken: "fixture-workers-credential",
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
      runtimeProvider: "local",
      workersApiToken: "fixture-workers-credential",
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
  assert.deepEqual(
    github.secrets.map((secret) => secret.name),
    ["CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN"],
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
