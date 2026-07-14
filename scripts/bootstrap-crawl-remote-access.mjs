#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_CONTRACT = Object.freeze({
  accountId: "91b59577e757131d68d55a471fe32aca",
  accessAppName: "OpenClaw crawl-remote service access",
  accessDomain: "reports.openclaw.ai/crawl-remote/*",
  accessPolicyName: "OpenClaw crawl-remote service token",
  accessServiceTokenName: "OpenClaw crawl-remote Access",
  accessServiceTokenDuration: "8760h",
  archive: "gitcrawl/openclaw__openclaw",
  clawsweeperRepository: "openclaw/clawsweeper",
  cloudEndpoint: "https://reports.openclaw.ai/crawl-remote",
  confirmation: "bootstrap crawl-remote access",
  gitcrawlStoreRepository: "openclaw/gitcrawl-store",
  productionEnvironment: "crawl-remote-production",
});

const ACCESS_CREDENTIAL_SLOTS = Object.freeze(["blue", "green"]);
const ACCESS_CREDENTIAL_TARGETS = Object.freeze([
  {
    label: "crawl-remote-production",
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    environment: BOOTSTRAP_CONTRACT.productionEnvironment,
    secretPrefix: "CRAWL_REMOTE_ACCESS",
    generationVariable: "CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION",
  },
  {
    label: "ClawSweeper runtime",
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    secretPrefix: "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS",
    generationVariable: "CLAWSWEEPER_GITCRAWL_CLOUD_ACCESS_CREDENTIAL_GENERATION",
  },
  {
    label: "gitcrawl-store publisher",
    repository: BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
    secretPrefix: "GITCRAWL_CLOUD_ACCESS",
    generationVariable: "GITCRAWL_CLOUD_ACCESS_CREDENTIAL_GENERATION",
  },
]);

export async function bootstrapCrawlRemoteAccess(options, dependencies) {
  const runtimeProvider = normalizeRuntimeProvider(options.runtimeProvider);
  const publisherEnabled = normalizeBinaryFlag(options.publisherEnabled, "publisher enabled");
  const rotateServiceToken = Boolean(options.rotateServiceToken);
  const rotationLabel = normalizeRotationLabel(options.rotationLabel);
  const cloudflare = dependencies.cloudflare;
  const github = dependencies.github;
  const logger = dependencies.logger ?? console;

  const matchingTokens = (await cloudflare.listServiceTokens()).filter(isManagedServiceToken);
  if (matchingTokens.length > 1 && !rotateServiceToken) {
    throw new Error(
      "multiple managed crawl-remote Access service tokens exist; rerun with explicit rotation",
    );
  }

  const credentialStates = await inspectAccessCredentialStates(github);
  if (matchingTokens.length === 1 && !rotateServiceToken) {
    assertCredentialStatesBoundToToken(credentialStates, matchingTokens[0]);
  }

  const applicationState = await cloudflare.inspectAccessApplication();
  let oldTokens = [];
  let activeToken = null;
  let createdCredentials = null;
  let resumedRotation = false;

  if (rotateServiceToken && matchingTokens.length > 1) {
    const boundTokens = matchingTokens.filter((token) =>
      credentialStates.every((state) => credentialStateBindsToken(state, token)),
    );
    if (boundTokens.length > 1) {
      throw new Error("multiple managed service tokens match the active credential generation");
    }
    if (boundTokens.length === 1) {
      activeToken = boundTokens[0];
      oldTokens = matchingTokens.filter((token) => token.id !== activeToken.id);
      resumedRotation = true;
    }
  }

  if (!activeToken && matchingTokens.length === 1 && !rotateServiceToken) {
    activeToken = matchingTokens[0];
  }

  if (!activeToken) {
    oldTokens = matchingTokens;
    const tokenName =
      oldTokens.length === 0
        ? BOOTSTRAP_CONTRACT.accessServiceTokenName
        : `${BOOTSTRAP_CONTRACT.accessServiceTokenName} rotation ${rotationLabel}`;
    createdCredentials = await cloudflare.createServiceToken({
      name: tokenName,
      duration: BOOTSTRAP_CONTRACT.accessServiceTokenDuration,
    });
    assertCreatedServiceToken(createdCredentials);
    activeToken = createdCredentials;
  }

  const application = await cloudflare.ensureAccessApplication(applicationState.application);
  const oldTokenIds = oldTokens.map((token) => token.id);
  const transitionalTokenIds =
    createdCredentials && oldTokenIds.length > 0
      ? [...new Set([...oldTokenIds, activeToken.id])]
      : [activeToken.id];

  let configuredPolicy = await cloudflare.ensureAccessPolicy({
    applicationId: application.id,
    existingPolicy: applicationState.policy,
    tokenIds: transitionalTokenIds,
  });

  if (createdCredentials) {
    await publishAccessCredentials({
      github,
      accessCredentials: createdCredentials,
      credentialStates,
    });
  }

  await writeGitHubConfiguration({
    github,
    workersApiToken: options.workersApiToken,
    runtimeProvider,
    publisherEnabled,
  });

  if (oldTokenIds.length > 0) {
    if (createdCredentials) {
      configuredPolicy = await cloudflare.ensureAccessPolicy({
        applicationId: application.id,
        existingPolicy: configuredPolicy,
        tokenIds: [activeToken.id],
      });
    }
    for (const token of oldTokens) {
      await cloudflare.deleteServiceToken(token.id);
    }
  }

  logger.log(
    createdCredentials
      ? `configured crawl-remote Access with a ${oldTokens.length > 0 ? "rotated" : "new"} service token`
      : resumedRotation
        ? "completed an interrupted crawl-remote Access service-token rotation"
        : "reconciled crawl-remote Access without rotating its service token",
  );
  logger.log(
    `configured protected deployment inputs, ClawSweeper ${runtimeProvider} intake, ` +
      `and gitcrawl-store publisher=${publisherEnabled}`,
  );

  return {
    accessApplicationId: application.id,
    accessServiceTokenId: activeToken.id,
    createdServiceToken: createdCredentials !== null,
    rotatedServiceToken: oldTokens.length > 0,
    resumedServiceTokenRotation: resumedRotation,
    runtimeProvider,
    publisherEnabled,
    accessPolicyId: configuredPolicy.id,
  };
}

async function inspectAccessCredentialStates(github) {
  return Promise.all(
    ACCESS_CREDENTIAL_TARGETS.map(async (target) => ({
      target,
      marker: parseCredentialGenerationMarker(
        await github.getVariable({
          repository: target.repository,
          environment: target.environment,
          name: target.generationVariable,
        }),
      ),
      secretNames: await github.listSecretNames(target),
    })),
  );
}

function assertCredentialStatesBoundToToken(states, token) {
  const invalidTargets = states
    .filter((state) => !credentialStateBindsToken(state, token))
    .map((state) => state.target.label);
  if (invalidTargets.length > 0) {
    throw new Error(
      "the existing crawl-remote Access credentials are not bound to the selected service " +
        `token for: ${invalidTargets.join(", ")}; rerun with explicit rotation`,
    );
  }
}

async function publishAccessCredentials({ github, accessCredentials, credentialStates }) {
  const prepared = credentialStates.map((state) => {
    const slot = inactiveCredentialSlot(state.marker?.slot);
    const names = credentialSecretNames(state.target, slot);
    return {
      ...state,
      markerValue: credentialGenerationMarker(accessCredentials.id, slot),
      names,
    };
  });

  for (const state of prepared) {
    await github.setSecret({
      repository: state.target.repository,
      environment: state.target.environment,
      name: state.names.clientId,
      value: accessCredentials.client_id,
    });
    await github.setSecret({
      repository: state.target.repository,
      environment: state.target.environment,
      name: state.names.clientSecret,
      value: accessCredentials.client_secret,
    });
  }

  for (const state of prepared) {
    await github.setVariable({
      repository: state.target.repository,
      environment: state.target.environment,
      name: state.target.generationVariable,
      value: state.markerValue,
    });
  }
}

async function writeGitHubConfiguration({
  github,
  workersApiToken,
  runtimeProvider,
  publisherEnabled,
}) {
  assertSecretValue(workersApiToken, "OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN");
  const workersTokenHash = createHash("sha256").update(workersApiToken).digest("hex");
  const environmentTarget = {
    repository: BOOTSTRAP_CONTRACT.clawsweeperRepository,
    environment: BOOTSTRAP_CONTRACT.productionEnvironment,
  };

  await github.setSecret({
    ...environmentTarget,
    name: "CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN",
    value: workersApiToken,
  });
  await github.setVariable({
    ...environmentTarget,
    name: "CRAWL_REMOTE_DEPLOY_AUTHORITY",
    value: "clawsweeper-v1",
  });
  await github.setVariable({
    ...environmentTarget,
    name: "CRAWL_REMOTE_CUSTOM_ROUTE_PROOF",
    value: "access-service-token",
  });
  await github.setVariable({
    ...environmentTarget,
    name: "CRAWL_REMOTE_CLOUDFLARE_TOKEN_SHA256",
    value: workersTokenHash,
  });

  const clawsweeperTarget = { repository: BOOTSTRAP_CONTRACT.clawsweeperRepository };
  await github.setVariable({
    ...clawsweeperTarget,
    name: "CLAWSWEEPER_GITCRAWL_PROVIDER",
    value: runtimeProvider,
  });
  await github.setVariable({
    ...clawsweeperTarget,
    name: "CLAWSWEEPER_GITCRAWL_CLOUD_URL",
    value: BOOTSTRAP_CONTRACT.cloudEndpoint,
  });
  await github.setVariable({
    ...clawsweeperTarget,
    name: "CLAWSWEEPER_GITCRAWL_CLOUD_ARCHIVE",
    value: BOOTSTRAP_CONTRACT.archive,
  });

  const storeTarget = { repository: BOOTSTRAP_CONTRACT.gitcrawlStoreRepository };
  for (const [name, value] of [
    ["GITCRAWL_CLOUD_PUBLISH_ENABLED", publisherEnabled],
    ["GITCRAWL_CLOUD_STAGE_ONLY", "1"],
    ["GITCRAWL_CLOUD_OBSERVATION_ORDER", "0"],
    ["GITCRAWL_CLOUD_ENDPOINT", BOOTSTRAP_CONTRACT.cloudEndpoint],
    ["GITCRAWL_CLOUD_ARCHIVE", BOOTSTRAP_CONTRACT.archive],
  ]) {
    await github.setVariable({ ...storeTarget, name, value });
  }
}

export function createCloudflareClient({
  token,
  fetchImpl = fetch,
  apiBase = "https://api.cloudflare.com/client/v4",
}) {
  assertSecretValue(token, "OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN");
  const accountPath = `/accounts/${BOOTSTRAP_CONTRACT.accountId}`;

  async function request(method, path, body) {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Cloudflare ${method} ${path} returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || payload?.success === false) {
      const messages = Array.isArray(payload?.errors)
        ? payload.errors
            .map((error) => `${String(error?.code ?? "unknown")}: ${String(error?.message ?? "")}`)
            .join("; ")
        : "";
      throw new Error(
        `Cloudflare ${method} ${path} failed with HTTP ${response.status}` +
          (messages ? ` (${messages.slice(0, 500)})` : ""),
      );
    }
    return payload;
  }

  async function list(path) {
    const entries = [];
    for (let page = 1; page <= 20; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const payload = await request("GET", `${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(payload?.result)) {
        throw new Error(`Cloudflare GET ${path} returned an invalid list`);
      }
      entries.push(...payload.result);
      const totalPages = Number(payload?.result_info?.total_pages ?? 0);
      if (
        (totalPages > 0 && page >= totalPages) ||
        (totalPages === 0 && payload.result.length < 100)
      ) {
        return entries;
      }
    }
    throw new Error(`Cloudflare GET ${path} exceeded the pagination limit`);
  }

  return {
    async listServiceTokens() {
      const tokens = await list(`${accountPath}/access/service_tokens`);
      for (const tokenEntry of tokens) {
        if (
          typeof tokenEntry?.id !== "string" ||
          tokenEntry.id.length === 0 ||
          typeof tokenEntry?.name !== "string"
        ) {
          throw new Error("Cloudflare returned an invalid Access service token");
        }
      }
      return tokens;
    },

    async inspectAccessApplication() {
      const applications = await list(`${accountPath}/access/apps`);
      const matches = applications.filter(
        (application) =>
          application?.name === BOOTSTRAP_CONTRACT.accessAppName ||
          application?.domain === BOOTSTRAP_CONTRACT.accessDomain,
      );
      if (matches.length > 1) {
        throw new Error("multiple Cloudflare Access applications match the crawl-remote contract");
      }
      const application = matches[0] ?? null;
      if (
        application &&
        application.name === BOOTSTRAP_CONTRACT.accessAppName &&
        application.domain !== BOOTSTRAP_CONTRACT.accessDomain
      ) {
        throw new Error("the managed crawl-remote Access application name targets another domain");
      }
      if (!application) return { application: null, policy: null };
      if (typeof application.id !== "string" || application.id.length === 0) {
        throw new Error("Cloudflare returned an invalid crawl-remote Access application");
      }
      const policies = await list(`${accountPath}/access/apps/${application.id}/policies`);
      const unexpected = policies.filter(
        (policy) => policy?.name !== BOOTSTRAP_CONTRACT.accessPolicyName,
      );
      if (unexpected.length > 0) {
        throw new Error(
          "the crawl-remote Access application has unmanaged policies: " +
            unexpected.map((policy) => String(policy?.name ?? policy?.id ?? "unknown")).join(", "),
        );
      }
      if (policies.length > 1) {
        throw new Error("multiple managed policies exist on the crawl-remote Access application");
      }
      return { application, policy: policies[0] ?? null };
    },

    async createServiceToken({ name, duration }) {
      const payload = await request("POST", `${accountPath}/access/service_tokens`, {
        name,
        duration,
      });
      return payload?.result;
    },

    async ensureAccessApplication(existingApplication) {
      const body = canonicalAccessApplication();
      if (!existingApplication) {
        const payload = await request("POST", `${accountPath}/access/apps`, body);
        assertAccessApplication(payload?.result);
        return payload.result;
      }
      assertAccessApplication(existingApplication);
      if (accessApplicationMatches(existingApplication, body)) {
        return existingApplication;
      }
      const payload = await request(
        "PUT",
        `${accountPath}/access/apps/${existingApplication.id}`,
        body,
      );
      assertAccessApplication(payload?.result);
      return payload.result;
    },

    async ensureAccessPolicy({ applicationId, existingPolicy, tokenIds }) {
      const body = canonicalAccessPolicy(tokenIds);
      if (existingPolicy && accessPolicyMatches(existingPolicy, body)) {
        return existingPolicy;
      }
      const method = existingPolicy ? "PUT" : "POST";
      const path = existingPolicy
        ? `${accountPath}/access/apps/${applicationId}/policies/${existingPolicy.id}`
        : `${accountPath}/access/apps/${applicationId}/policies`;
      const payload = await request(method, path, body);
      if (typeof payload?.result?.id !== "string" || payload.result.id.length === 0) {
        throw new Error("Cloudflare returned an invalid crawl-remote Access policy");
      }
      return payload.result;
    },

    async deleteServiceToken(tokenId) {
      await request("DELETE", `${accountPath}/access/service_tokens/${tokenId}`);
    },
  };
}

export function createGitHubClient({
  tokensByRepository,
  fetchImpl = fetch,
  apiBase = "https://api.github.com",
  runGh = defaultRunGh,
}) {
  const repositoryTokens = new Map();
  for (const repository of [
    BOOTSTRAP_CONTRACT.clawsweeperRepository,
    BOOTSTRAP_CONTRACT.gitcrawlStoreRepository,
  ]) {
    const token = tokensByRepository?.[repository];
    assertSecretValue(token, `${repository} GitHub token`);
    repositoryTokens.set(repository, token);
  }

  function tokenFor(repository) {
    const token = repositoryTokens.get(repository);
    if (!token) {
      throw new Error(`no GitHub token is configured for ${repository}`);
    }
    return token;
  }

  async function get(repository, path, { allowNotFound = false } = {}) {
    const token = tokenFor(repository);
    const response = await fetchImpl(`${apiBase}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
    });
    if (allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`GitHub GET ${path} failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  return {
    async listSecretNames({ repository, environment }) {
      const prefix = `/repos/${repository}`;
      const path = environment
        ? `${prefix}/environments/${encodeURIComponent(environment)}/secrets?per_page=100`
        : `${prefix}/actions/secrets?per_page=100`;
      const payload = await get(repository, path);
      if (
        !Number.isSafeInteger(payload?.total_count) ||
        payload.total_count < 0 ||
        !Array.isArray(payload?.secrets) ||
        payload.total_count !== payload.secrets.length
      ) {
        throw new Error(`GitHub GET ${path} returned an invalid or truncated secret list`);
      }
      return new Set(payload.secrets.map((secret) => secret?.name).filter(Boolean));
    },

    async getVariable({ repository, environment, name }) {
      const prefix = `/repos/${repository}`;
      const path = environment
        ? `${prefix}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`
        : `${prefix}/actions/variables/${encodeURIComponent(name)}`;
      const payload = await get(repository, path, { allowNotFound: true });
      if (payload === null) return null;
      if (payload?.name !== name || !isNonEmptyString(payload?.value)) {
        throw new Error(`GitHub GET ${path} returned an invalid variable`);
      }
      return payload.value;
    },

    async setSecret({ repository, environment, name, value }) {
      assertSecretValue(value, name);
      const args = ["secret", "set", name, "--repo", repository];
      if (environment) args.push("--env", environment);
      await runGhCommand({ args, input: value, token: tokenFor(repository), runGh });
    },

    async setVariable({ repository, environment, name, value }) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${name} must be non-empty`);
      }
      const args = ["variable", "set", name, "--repo", repository];
      if (environment) args.push("--env", environment);
      await runGhCommand({ args, input: value, token: tokenFor(repository), runGh });
    },
  };
}

async function runGhCommand({ args, input, token, runGh }) {
  const childEnvironment = { ...process.env };
  delete childEnvironment.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN;
  delete childEnvironment.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN;
  delete childEnvironment.CLAWSWEEPER_BOOTSTRAP_GH_TOKEN;
  delete childEnvironment.GITCRAWL_STORE_BOOTSTRAP_GH_TOKEN;
  delete childEnvironment.GH_TOKEN;
  const result = await runGh(args, {
    input,
    env: {
      ...childEnvironment,
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: token,
    },
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "")
      .trim()
      .slice(0, 1000);
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function defaultRunGh(args, options) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function canonicalAccessApplication() {
  return {
    name: BOOTSTRAP_CONTRACT.accessAppName,
    domain: BOOTSTRAP_CONTRACT.accessDomain,
    type: "self_hosted",
    session_duration: "24h",
    allowed_idps: [],
    auto_redirect_to_identity: false,
    enable_binding_cookie: false,
  };
}

function canonicalAccessPolicy(tokenIds) {
  const canonicalIds = [...new Set(tokenIds)].sort();
  if (canonicalIds.length === 0 || canonicalIds.some((tokenId) => !isNonEmptyString(tokenId))) {
    throw new Error("crawl-remote Access policy requires valid service token IDs");
  }
  return {
    name: BOOTSTRAP_CONTRACT.accessPolicyName,
    decision: "non_identity",
    include: canonicalIds.map((tokenId) => ({ service_token: { token_id: tokenId } })),
    exclude: [],
    require: [],
    precedence: 1,
    session_duration: "24h",
  };
}

function accessApplicationMatches(application, canonical) {
  return (
    application.name === canonical.name &&
    application.domain === canonical.domain &&
    application.type === canonical.type &&
    application.session_duration === canonical.session_duration &&
    JSON.stringify(application.allowed_idps ?? []) === JSON.stringify(canonical.allowed_idps) &&
    application.auto_redirect_to_identity === canonical.auto_redirect_to_identity &&
    application.enable_binding_cookie === canonical.enable_binding_cookie
  );
}

function accessPolicyMatches(policy, canonical) {
  const policyIncludes = normalizeExactPolicyIncludes(policy.include);
  const canonicalIncludes = normalizeExactPolicyIncludes(canonical.include);
  return (
    policyIncludes !== null &&
    canonicalIncludes !== null &&
    policy.name === canonical.name &&
    policy.decision === canonical.decision &&
    policy.precedence === canonical.precedence &&
    policy.session_duration === canonical.session_duration &&
    JSON.stringify(policy.exclude ?? []) === JSON.stringify(canonical.exclude) &&
    JSON.stringify(policy.require ?? []) === JSON.stringify(canonical.require) &&
    JSON.stringify(policyIncludes) === JSON.stringify(canonicalIncludes)
  );
}

function normalizeExactPolicyIncludes(includes) {
  if (!Array.isArray(includes)) return null;
  const tokenIds = [];
  for (const entry of includes) {
    if (
      !isPlainObject(entry) ||
      Object.keys(entry).length !== 1 ||
      !isPlainObject(entry.service_token) ||
      Object.keys(entry.service_token).length !== 1 ||
      !isNonEmptyString(entry.service_token.token_id)
    ) {
      return null;
    }
    tokenIds.push(entry.service_token.token_id);
  }
  return tokenIds.sort().map((tokenId) => ({ service_token: { token_id: tokenId } }));
}

export function credentialGenerationMarker(tokenId, slot) {
  if (!isNonEmptyString(tokenId) || !ACCESS_CREDENTIAL_SLOTS.includes(slot)) {
    throw new Error("credential generation requires a valid token ID and slot");
  }
  const generation = createHash("sha256").update(tokenId).digest("hex");
  return `v1:${slot}:${generation}`;
}

function parseCredentialGenerationMarker(value) {
  if (typeof value !== "string") return null;
  const match = /^v1:(blue|green):([0-9a-f]{64})$/.exec(value);
  if (!match) return null;
  return { slot: match[1], generation: match[2] };
}

function credentialStateBindsToken(state, token) {
  const marker = state.marker;
  if (!marker || !isNonEmptyString(token?.id)) return false;
  const expectedMarker = parseCredentialGenerationMarker(
    credentialGenerationMarker(token.id, marker.slot),
  );
  const names = credentialSecretNames(state.target, marker.slot);
  return (
    marker.generation === expectedMarker.generation &&
    state.secretNames.has(names.clientId) &&
    state.secretNames.has(names.clientSecret)
  );
}

function inactiveCredentialSlot(activeSlot) {
  return activeSlot === "blue" ? "green" : "blue";
}

function credentialSecretNames(target, slot) {
  const slotName = slot.toUpperCase();
  return {
    clientId: `${target.secretPrefix}_${slotName}_CLIENT_ID`,
    clientSecret: `${target.secretPrefix}_${slotName}_CLIENT_SECRET`,
  };
}

function isManagedServiceToken(token) {
  return (
    isNonEmptyString(token?.id) &&
    isNonEmptyString(token?.name) &&
    (token.name === BOOTSTRAP_CONTRACT.accessServiceTokenName ||
      token.name.startsWith(`${BOOTSTRAP_CONTRACT.accessServiceTokenName} rotation `))
  );
}

function assertCreatedServiceToken(token) {
  if (
    !isNonEmptyString(token?.id) ||
    !isNonEmptyString(token?.client_id) ||
    !isNonEmptyString(token?.client_secret)
  ) {
    throw new Error("Cloudflare did not return complete one-time Access service credentials");
  }
}

function assertAccessApplication(application) {
  if (!isNonEmptyString(application?.id)) {
    throw new Error("Cloudflare returned an invalid crawl-remote Access application");
  }
}

function assertSecretValue(value, name) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} is required`);
  }
}

function normalizeRuntimeProvider(value) {
  const provider = String(value ?? "local").trim();
  if (!["local", "parity", "cloud"].includes(provider)) {
    throw new Error("runtime provider must be local, parity, or cloud");
  }
  return provider;
}

function normalizeBinaryFlag(value, label) {
  const normalized = String(value ?? "0").trim();
  if (normalized !== "0" && normalized !== "1") {
    throw new Error(`${label} must be 0 or 1`);
  }
  return normalized;
}

function normalizeRotationLabel(value) {
  const label = String(value ?? Date.now()).trim();
  if (!/^[0-9]+(?:-[0-9]+)?$/.test(label)) {
    throw new Error("rotation label must contain a run ID and optional attempt");
  }
  return label;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[name] = true;
    } else {
      result[name] = next;
      index += 1;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.confirm !== BOOTSTRAP_CONTRACT.confirmation) {
    throw new Error(`--confirm must equal "${BOOTSTRAP_CONTRACT.confirmation}"`);
  }
  const cloudflare = createCloudflareClient({
    token: process.env.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN,
  });
  const github = createGitHubClient({
    tokensByRepository: {
      [BOOTSTRAP_CONTRACT.clawsweeperRepository]: process.env.CLAWSWEEPER_BOOTSTRAP_GH_TOKEN,
      [BOOTSTRAP_CONTRACT.gitcrawlStoreRepository]: process.env.GITCRAWL_STORE_BOOTSTRAP_GH_TOKEN,
    },
  });
  await bootstrapCrawlRemoteAccess(
    {
      publisherEnabled: args["publisher-enabled"] ?? "0",
      rotateServiceToken: Boolean(args["rotate-service-token"]),
      rotationLabel: args["rotation-label"],
      runtimeProvider: args["runtime-provider"] ?? "local",
      workersApiToken: process.env.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN,
    },
    { cloudflare, github },
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
