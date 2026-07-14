#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const DEPLOY_CONSUMER_CONTRACT = Object.freeze({
  checkoutStepName: "Checkout crawl-remote Access resolver",
  checkoutUses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  checkoutWith: {
    "fetch-depth": "1",
    "persist-credentials": "false",
    "sparse-checkout": "scripts/resolve-crawl-remote-access-credentials.mjs",
    "sparse-checkout-cone-mode": "false",
  },
  command: "node scripts/resolve-crawl-remote-access-credentials.mjs",
  inheritedEnvironment: {
    BASH_ENV: "",
    ENV: "",
    NODE_OPTIONS: "",
  },
  forbiddenInheritedEnvironment: [
    "BASHOPTS",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_PATH",
    "PATH",
    "SHELLOPTS",
  ],
  job: "deploy",
  jobEnvironment: "crawl-remote-production",
  jobRunsOn: "ubuntu-latest",
  jobShell: "bash --noprofile --norc -euo pipefail {0}",
  consumerEnvironment: {
    CF_ACCESS_CLIENT_ID: "${{ steps.crawl-remote-access-credentials.outputs.client_id }}",
    CF_ACCESS_CLIENT_SECRET: "${{ steps.crawl-remote-access-credentials.outputs.client_secret }}",
  },
  path: ".github/workflows/deploy-crawl-remote.yml",
  stepId: "crawl-remote-access-credentials",
  stepName: "Resolve crawl-remote Access credentials",
  requiredEnvironment: {
    BASH_ENV: "",
    CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION:
      "${{ vars.CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION }}",
    CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID: "${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_ID }}",
    CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET: "${{ secrets.CRAWL_REMOTE_ACCESS_BLUE_CLIENT_SECRET }}",
    CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID: "${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_ID }}",
    CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET:
      "${{ secrets.CRAWL_REMOTE_ACCESS_GREEN_CLIENT_SECRET }}",
    ENV: "",
    NODE_OPTIONS: "",
  },
  forbiddenReferences: ["CRAWL_REMOTE_ACCESS_CLIENT_ID", "CRAWL_REMOTE_ACCESS_CLIENT_SECRET"],
});
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
  assertDormantOptionalConsumers({ runtimeProvider, publisherEnabled });
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
  const markerSelectedTokens = matchingTokens.filter((token) =>
    credentialStates.some((state) => credentialStateBindsToken(state, token)),
  );
  if (matchingTokens.length === 1 && !rotateServiceToken) {
    assertCredentialStatesBoundToToken(credentialStates, matchingTokens[0]);
  }

  const applicationState = await cloudflare.inspectAccessApplication();
  let oldTokens = [];
  let activeToken = null;
  let createdCredentials = null;
  let resumedRotation = false;
  let authorizedOldTokens = [];

  if (rotateServiceToken && matchingTokens.length > 1) {
    const boundTokens = matchingTokens.filter((token) =>
      credentialStates.every((state) => credentialStateBindsToken(state, token)),
    );
    if (boundTokens.length > 1) {
      throw new Error("multiple managed service tokens match the active credential generation");
    }
    if (boundTokens.length === 1) {
      const boundToken = boundTokens[0];
      const remainingTokens = matchingTokens.filter((token) => token.id !== boundToken.id);
      if (isStrictlyNewestManagedServiceToken(boundToken, remainingTokens)) {
        activeToken = boundToken;
        oldTokens = remainingTokens;
        resumedRotation = true;
      }
    }
  }

  if (!activeToken && matchingTokens.length === 1 && !rotateServiceToken) {
    activeToken = matchingTokens[0];
  }

  await github.assertCurrentMain();

  if (!activeToken) {
    oldTokens = matchingTokens;
    authorizedOldTokens = markerSelectedTokens;
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
      ? [...new Set([...authorizedOldTokens.map((token) => token.id), activeToken.id])]
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
    await github.assertCurrentMain();
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

export function assertCrawlRemoteDeployConsumerContract(source) {
  if (typeof source !== "string") {
    throw new Error("crawl-remote deploy consumer source is unavailable");
  }
  const {
    steps: deploySteps,
    jobEnvironment,
    jobDeploymentEnvironment,
    jobRunDefaults,
    jobRunsOn,
    hasJobContainer,
    hasJobServices,
    hasWorkflowDefaults,
    hasWorkflowEnvironment,
  } = parseWorkflowJobSteps(source, DEPLOY_CONSUMER_CONTRACT.job);
  const matchingSteps = deploySteps.filter(
    (step) => step.name === DEPLOY_CONSUMER_CONTRACT.stepName,
  );
  if (matchingSteps.length !== 1) {
    throw new Error(
      `crawl-remote deploy consumer requires exactly one "${DEPLOY_CONSUMER_CONTRACT.stepName}" ` +
        `step in the ${DEPLOY_CONSUMER_CONTRACT.job} job`,
    );
  }
  const resolver = matchingSteps[0];
  if (
    resolver.fields.size !== 1 ||
    resolver.fields.get("id") !== DEPLOY_CONSUMER_CONTRACT.stepId ||
    resolver.configuration.size !== 0 ||
    resolver.environment.size !== Object.keys(DEPLOY_CONSUMER_CONTRACT.requiredEnvironment).length
  ) {
    throw new Error("crawl-remote deploy credential resolver has an unsafe step contract");
  }
  if (
    hasWorkflowDefaults ||
    hasWorkflowEnvironment ||
    hasJobContainer ||
    hasJobServices ||
    jobRunsOn !== DEPLOY_CONSUMER_CONTRACT.jobRunsOn ||
    jobDeploymentEnvironment.get("name") !== DEPLOY_CONSUMER_CONTRACT.jobEnvironment ||
    jobRunDefaults.size !== 1 ||
    jobRunDefaults.get("shell") !== DEPLOY_CONSUMER_CONTRACT.jobShell
  ) {
    throw new Error("crawl-remote deploy credential resolver has unsafe inherited run controls");
  }
  for (const [name, value] of Object.entries(DEPLOY_CONSUMER_CONTRACT.inheritedEnvironment)) {
    if (jobEnvironment.get(name) !== value) {
      throw new Error(
        `crawl-remote deploy credential resolver has unsafe inherited ${name} binding`,
      );
    }
  }
  for (const name of DEPLOY_CONSUMER_CONTRACT.forbiddenInheritedEnvironment) {
    if (jobEnvironment.has(name)) {
      throw new Error(
        `crawl-remote deploy credential resolver has unsafe inherited ${name} binding`,
      );
    }
  }
  const resolverIndex = deploySteps.indexOf(resolver);
  const checkout = deploySteps[resolverIndex - 1];
  if (
    checkout?.name !== DEPLOY_CONSUMER_CONTRACT.checkoutStepName ||
    checkout.fields.size !== 1 ||
    checkout.fields.get("uses") !== DEPLOY_CONSUMER_CONTRACT.checkoutUses ||
    checkout.environment.size !== 0 ||
    checkout.configuration.size !== Object.keys(DEPLOY_CONSUMER_CONTRACT.checkoutWith).length ||
    checkout.run.length !== 0
  ) {
    throw new Error(
      "crawl-remote deploy credential resolver requires its pinned sparse checkout immediately before it",
    );
  }
  for (const [name, value] of Object.entries(DEPLOY_CONSUMER_CONTRACT.checkoutWith)) {
    if (checkout.configuration.get(name) !== value) {
      throw new Error(`crawl-remote deploy resolver checkout has invalid ${name}`);
    }
  }
  for (const [name, value] of Object.entries(DEPLOY_CONSUMER_CONTRACT.requiredEnvironment)) {
    if (resolver.environment.get(name) !== value) {
      throw new Error(`crawl-remote deploy credential resolver has invalid ${name} binding`);
    }
  }
  const protectedBindings = Object.keys(DEPLOY_CONSUMER_CONTRACT.requiredEnvironment).filter(
    (name) => name.startsWith("CRAWL_REMOTE_ACCESS_"),
  );
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  if (!normalizedSource.includes(resolver.source)) {
    throw new Error("crawl-remote deploy credential resolver source cannot be isolated");
  }
  const sourceOutsideResolver = normalizedSource.replace(resolver.source, "").toUpperCase();
  for (const name of protectedBindings) {
    if (sourceOutsideResolver.includes(name)) {
      throw new Error(`crawl-remote deploy consumer must reference ${name} only in the resolver`);
    }
  }
  const executableLines = resolver.run
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (executableLines.length !== 1 || executableLines[0] !== DEPLOY_CONSUMER_CONTRACT.command) {
    throw new Error("crawl-remote deploy credential resolver does not invoke the tested artifact");
  }
  const credentialConsumers = deploySteps
    .map((step, index) => ({
      index,
      step,
      source: step.run
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .join("\n"),
    }))
    .filter(
      ({ source: runSource }) =>
        runSource.includes("$CF_ACCESS_CLIENT_ID") &&
        runSource.includes("$CF_ACCESS_CLIENT_SECRET"),
    );
  if (
    credentialConsumers.length === 0 ||
    credentialConsumers.some(({ index }) => index <= resolverIndex)
  ) {
    throw new Error(
      "crawl-remote deploy credential consumers must run after the generation-slot resolver",
    );
  }
  for (const { step } of credentialConsumers) {
    for (const [name, value] of Object.entries(DEPLOY_CONSUMER_CONTRACT.consumerEnvironment)) {
      if (step.environment.get(name) !== value) {
        throw new Error(
          `crawl-remote deploy credential consumer has invalid ${name} resolver-output binding`,
        );
      }
    }
  }
  for (const value of Object.values(DEPLOY_CONSUMER_CONTRACT.consumerEnvironment)) {
    if (countOccurrences(source, value) !== credentialConsumers.length) {
      throw new Error(
        "crawl-remote deploy resolver outputs must be scoped to credential consumers",
      );
    }
  }
  for (const step of deploySteps) {
    let unapprovedSource = step.source;
    if (credentialConsumers.some((consumer) => consumer.step === step)) {
      for (const value of Object.values(DEPLOY_CONSUMER_CONTRACT.consumerEnvironment)) {
        unapprovedSource = unapprovedSource.replace(value, "");
      }
    }
    if (containsResolverOutputReference(unapprovedSource)) {
      throw new Error(
        "crawl-remote deploy resolver outputs must use only allowlisted consumer bindings",
      );
    }
  }
  const hasAccessOverride =
    jobEnvironment.has("CF_ACCESS_CLIENT_ID") ||
    jobEnvironment.has("CF_ACCESS_CLIENT_SECRET") ||
    deploySteps.some((step) => {
      const hasAccessEnvironment =
        step.environment.has("CF_ACCESS_CLIENT_ID") ||
        step.environment.has("CF_ACCESS_CLIENT_SECRET");
      return (
        hasAccessEnvironment && !credentialConsumers.some((consumer) => consumer.step === step)
      );
    }) ||
    deploySteps.some((step) =>
      step.run
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .some((line) => /(?:^|\s)(?:export\s+)?CF_ACCESS_CLIENT_(?:ID|SECRET)=/.test(line)),
    ) ||
    /^ {6}CF_ACCESS_CLIENT_(?:ID|SECRET):/m.test(source);
  if (hasAccessOverride) {
    throw new Error("crawl-remote deploy consumers must not override resolved Access credentials");
  }
  const legacyReferences = DEPLOY_CONSUMER_CONTRACT.forbiddenReferences.filter((reference) =>
    source.includes(reference),
  );
  if (legacyReferences.length > 0) {
    throw new Error(
      "crawl-remote deploy consumer retains legacy unversioned references: " +
        legacyReferences.join(", "),
    );
  }
}

function countOccurrences(source, value) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(value, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + value.length;
  }
}

function containsResolverOutputReference(source) {
  const normalized = source.replace(/\s+/g, "").toLowerCase();
  return (
    normalized.includes(DEPLOY_CONSUMER_CONTRACT.stepId.toLowerCase()) &&
    normalized.includes("outputs") &&
    (normalized.includes("client_id") || normalized.includes("client_secret"))
  );
}

function parseWorkflowJobSteps(source, expectedJob) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.some((line) => line.includes("\t"))) {
    throw new Error("crawl-remote deploy workflow must not contain tab indentation");
  }
  const jobsIndexes = lines.flatMap((line, index) => (line === "jobs:" ? [index] : []));
  if (jobsIndexes.length !== 1) {
    throw new Error("crawl-remote deploy workflow has no jobs mapping");
  }
  const jobsIndex = jobsIndexes[0];
  const hasWorkflowDefaults = lines.some(
    (line) => matchYamlMappingLine(line, 0, "defaults") !== null,
  );
  const hasWorkflowEnvironment = lines.some(
    (line) => matchYamlMappingLine(line, 0, "env") !== null,
  );
  const jobIndexes = lines.flatMap((line, index) =>
    index > jobsIndex && line === `  ${expectedJob}:` ? [index] : [],
  );
  if (jobIndexes.length !== 1) {
    throw new Error(`crawl-remote deploy workflow must have exactly one ${expectedJob} job`);
  }
  const jobStart = jobIndexes[0];
  let jobEnd = lines.length;
  for (let index = jobStart + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      jobEnd = index;
      break;
    }
  }
  const stepsIndexes = lines.flatMap((line, index) =>
    index > jobStart && index < jobEnd && line === "    steps:" ? [index] : [],
  );
  if (stepsIndexes.length !== 1) {
    throw new Error(`crawl-remote deploy ${expectedJob} job must have exactly one steps sequence`);
  }
  const stepsIndex = stepsIndexes[0];
  const jobEnvironment = parseJobMapping(lines, jobStart, stepsIndex, "env");
  const jobDeploymentEnvironment = parseJobMapping(lines, jobStart, stepsIndex, "environment");
  const jobRunDefaults = parseJobRunDefaults(lines, jobStart, stepsIndex);
  const jobRunsOnEntries = lines
    .slice(jobStart + 1, stepsIndex)
    .map((line) => matchYamlMappingLine(line, 4, "runs-on"))
    .filter((value) => value !== null);
  const jobRunsOn = jobRunsOnEntries.length === 1 ? parseYamlScalar(jobRunsOnEntries[0]) : null;
  const hasJobContainer = lines
    .slice(jobStart + 1, stepsIndex)
    .some((line) => matchYamlMappingLine(line, 4, "container") !== null);
  const hasJobServices = lines
    .slice(jobStart + 1, stepsIndex)
    .some((line) => matchYamlMappingLine(line, 4, "services") !== null);

  const steps = [];
  for (let index = stepsIndex + 1; index < jobEnd; index += 1) {
    const stepMatch = /^      - (.+?)\s*$/.exec(lines[index]);
    if (!stepMatch) {
      if (/^      -(?:\s|$)/.test(lines[index])) {
        throw new Error(`crawl-remote deploy workflow has invalid step syntax: ${lines[index]}`);
      }
      continue;
    }
    let stepEnd = jobEnd;
    for (let cursor = index + 1; cursor < jobEnd; cursor += 1) {
      if (lines[cursor].startsWith("      - ")) {
        stepEnd = cursor;
        break;
      }
    }
    steps.push(parseWorkflowStep(lines.slice(index, stepEnd), stepMatch[1]));
    index = stepEnd - 1;
  }
  return {
    steps,
    jobEnvironment,
    jobDeploymentEnvironment,
    jobRunDefaults,
    jobRunsOn,
    hasJobContainer,
    hasJobServices,
    hasWorkflowDefaults,
    hasWorkflowEnvironment,
  };
}

function parseJobMapping(lines, jobStart, stepsIndex, key) {
  const indexes = lines.flatMap((line, index) => {
    if (index <= jobStart || index >= stepsIndex) return [];
    const value = matchYamlMappingLine(line, 4, key);
    return value === "" ? [index] : [];
  });
  if (indexes.length !== 1) {
    return new Map();
  }
  const values = new Map();
  for (let index = indexes[0] + 1; index < stepsIndex; index += 1) {
    const line = lines[index];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (isYamlMappingAtIndent(line, 4)) break;
    const match = /^      ([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match || values.has(match[1])) {
      throw new Error(`crawl-remote deploy workflow has invalid inherited ${key} syntax`);
    }
    values.set(match[1], parseYamlScalar(match[2]));
  }
  return values;
}

function parseJobRunDefaults(lines, jobStart, stepsIndex) {
  const indexes = lines.flatMap((line, index) => {
    if (index <= jobStart || index >= stepsIndex) return [];
    const value = matchYamlMappingLine(line, 4, "defaults");
    return value === "" ? [index] : [];
  });
  if (indexes.length !== 1) {
    return new Map();
  }
  const values = new Map();
  let foundRun = false;
  for (let index = indexes[0] + 1; index < stepsIndex; index += 1) {
    const line = lines[index];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (isYamlMappingAtIndent(line, 4)) break;
    if (matchYamlMappingLine(line, 6, "run") === "") {
      if (foundRun) {
        throw new Error("crawl-remote deploy workflow has duplicate inherited run defaults");
      }
      foundRun = true;
      continue;
    }
    const match = /^        ([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!foundRun || !match || values.has(match[1])) {
      throw new Error("crawl-remote deploy workflow has invalid inherited run defaults");
    }
    values.set(match[1], parseYamlScalar(match[2]));
  }
  return foundRun ? values : new Map();
}

function matchYamlMappingLine(line, indentation, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^ {${indentation}}(?:"${escapedKey}"|'${escapedKey}'|${escapedKey})\\s*:\\s*(.*?)\\s*$`,
  );
  return pattern.exec(line)?.[1] ?? null;
}

function isYamlMappingAtIndent(line, indentation) {
  const pattern = new RegExp(`^ {${indentation}}(?:"[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\\s*:`);
  return pattern.test(line);
}

function parseWorkflowStep(lines, firstEntry) {
  let name = null;
  const fields = new Map();
  const environment = new Map();
  const configuration = new Map();
  const run = [];
  const stepKeys = new Set();
  let block = null;

  const setField = (key, rawValue) => {
    if (stepKeys.has(key)) {
      throw new Error(`crawl-remote deploy workflow has duplicate step field: ${key}`);
    }
    stepKeys.add(key);
    block = null;
    if (key === "name") {
      name = parseYamlScalar(rawValue);
    } else if (key === "env" && rawValue.length === 0) {
      block = "env";
    } else if (key === "with" && rawValue.length === 0) {
      block = "with";
    } else if (key === "run" && /^[|>][+-]?$/.test(rawValue)) {
      block = "run";
    } else {
      fields.set(key, parseYamlScalar(rawValue));
    }
  };

  const firstField = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(firstEntry);
  if (!firstField) {
    throw new Error(`crawl-remote deploy workflow has invalid step syntax: ${firstEntry}`);
  }
  setField(firstField[1], firstField[2] ?? "");

  for (const line of lines.slice(1)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const fieldMatch = /^        ([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (fieldMatch) {
      const [, key, rawValue = ""] = fieldMatch;
      setField(key, rawValue);
      continue;
    }
    if (block === "env") {
      const environmentMatch = /^          ([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line);
      if (!environmentMatch) {
        throw new Error(`crawl-remote deploy resolver has invalid env syntax: ${line.trim()}`);
      }
      if (environment.has(environmentMatch[1])) {
        throw new Error(
          `crawl-remote deploy workflow has duplicate step env field: ${environmentMatch[1]}`,
        );
      }
      environment.set(environmentMatch[1], parseYamlScalar(environmentMatch[2]));
      continue;
    }
    if (block === "with") {
      const configurationMatch = /^          ([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
      if (!configurationMatch) {
        throw new Error(`crawl-remote deploy resolver has invalid with syntax: ${line.trim()}`);
      }
      if (configuration.has(configurationMatch[1])) {
        throw new Error(
          `crawl-remote deploy workflow has duplicate step with field: ${configurationMatch[1]}`,
        );
      }
      configuration.set(configurationMatch[1], parseYamlScalar(configurationMatch[2]));
      continue;
    }
    if (block === "run" && line.startsWith("          ")) {
      run.push(line.slice(10));
      continue;
    }
    throw new Error(`crawl-remote deploy workflow has invalid step syntax: ${line.trim()}`);
  }
  return { name, fields, environment, configuration, run, source: lines.join("\n") };
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function assertLocalDeployConsumerContract() {
  let source;
  try {
    source = readFileSync(DEPLOY_CONSUMER_CONTRACT.path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${DEPLOY_CONSUMER_CONTRACT.path}: ${detail}`);
  }
  assertCrawlRemoteDeployConsumerContract(source);
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
  mainReadToken,
  expectedMainSha,
  fetchImpl = fetch,
  apiBase = "https://api.github.com",
  runGh = defaultRunGh,
}) {
  assertSecretValue(mainReadToken, "ClawSweeper main-read GitHub token");
  if (typeof expectedMainSha !== "string" || !/^[0-9a-f]{40}$/.test(expectedMainSha)) {
    throw new Error("GITHUB_SHA must be a full lowercase commit SHA");
  }
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
    async assertCurrentMain() {
      const path = `/repos/${BOOTSTRAP_CONTRACT.clawsweeperRepository}/commits/main`;
      const response = await fetchImpl(`${apiBase}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${mainReadToken}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`GitHub GET ${path} failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.sha !== expectedMainSha) {
        throw new Error("ClawSweeper main advanced during crawl-remote Access bootstrap");
      }
    },

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
  delete childEnvironment.CLAWSWEEPER_MAIN_READ_GH_TOKEN;
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

function isStrictlyNewestManagedServiceToken(candidate, otherTokens) {
  const candidateGeneration = managedServiceTokenGeneration(candidate);
  if (candidateGeneration === null) return false;
  return otherTokens.every((token) => {
    const generation = managedServiceTokenGeneration(token);
    return (
      generation !== null && compareServiceTokenGenerations(candidateGeneration, generation) > 0
    );
  });
}

function managedServiceTokenGeneration(token) {
  if (token?.name === BOOTSTRAP_CONTRACT.accessServiceTokenName) {
    return { initial: true, runId: 0n, attempt: 0n };
  }
  const prefix = `${BOOTSTRAP_CONTRACT.accessServiceTokenName} rotation `;
  if (typeof token?.name !== "string" || !token.name.startsWith(prefix)) return null;
  const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(token.name.slice(prefix.length));
  if (!match) return null;
  return {
    initial: false,
    runId: BigInt(match[1]),
    attempt: BigInt(match[2] ?? "0"),
  };
}

function compareServiceTokenGenerations(left, right) {
  if (left.initial !== right.initial) return left.initial ? -1 : 1;
  if (left.runId !== right.runId) return left.runId > right.runId ? 1 : -1;
  if (left.attempt !== right.attempt) return left.attempt > right.attempt ? 1 : -1;
  return 0;
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

function assertDormantOptionalConsumers({ runtimeProvider, publisherEnabled }) {
  if (runtimeProvider !== "local") {
    throw new Error(
      "ClawSweeper Gitcrawl must remain local until its generation-slot consumer contract lands",
    );
  }
  if (publisherEnabled !== "0") {
    throw new Error(
      "gitcrawl-store publication must remain disabled until its generation-slot consumer contract lands",
    );
  }
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
  if (args["check-consumer-contract"]) {
    assertLocalDeployConsumerContract();
    console.log("verified crawl-remote generation-slot deploy consumer contract");
    return;
  }
  if (args.confirm !== BOOTSTRAP_CONTRACT.confirmation) {
    throw new Error(`--confirm must equal "${BOOTSTRAP_CONTRACT.confirmation}"`);
  }
  assertLocalDeployConsumerContract();
  const cloudflare = createCloudflareClient({
    token: process.env.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN,
  });
  const github = createGitHubClient({
    expectedMainSha: process.env.GITHUB_SHA,
    mainReadToken: process.env.CLAWSWEEPER_MAIN_READ_GH_TOKEN,
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
