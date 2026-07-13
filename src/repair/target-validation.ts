import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { resolveSpawnCommand } from "../command.js";
import { runCommand as run, type CommandRunOptions } from "./command-runner.js";
import {
  ensureMergeBaseAvailable,
  gitChangedFiles,
  gitLsFiles,
  isAncestor,
} from "./git-repo-utils.js";
import { parsePullRequestUrl } from "./github-ref.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  resolveTargetRepoToolchain,
  type TargetChangedGate,
  type TargetRepoToolchain,
} from "./target-toolchain-config.js";
import { compactText } from "./text-utils.js";
import {
  buildStagedProofPlan,
  executeStagedProofPlan,
  stagedProofPlanFromArtifact,
  stagedProofPlanArtifact,
  type StagedProofCommandInput,
  type StagedProofExecutionResult,
  type StagedProofPlan,
  type StagedProofPlanArtifact,
  type StagedProofSubsumptionContract,
} from "./staged-proof-gates.js";
import {
  isTestFile,
  looksLikePathArgument,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  requireWorkspaceMatchFailure,
  resolveValidationCommandEnvironment,
  stripEnvPrefix,
  uniqueStrings,
  validateAllowedValidationCommandParts,
  validationCommandForExecution,
  vitestPathFilterIndexes,
} from "./validation-command-utils.js";

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TARGET_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TARGET_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_VALIDATION_TIMEOUT_MS = 12 * 60 * 1000;
export const DEFAULT_PROOF_INPUT_MAX_ENTRIES = 250_000;
const DEFAULT_PROOF_INPUT_MAX_DEPTH = 64;
const DEFAULT_PROOF_INPUT_MAX_BYTES = 512 * 1024 * 1024;
const MIN_TRACKED_INDEX_OUTPUT_BYTES = 4 * 1024;
const MAX_TRACKED_INDEX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MIN_VALIDATION_RETRY_BUDGET_MS = 1_000;
const ABSENT_PROOF_INPUT = "<absent>";
const TARGET_VALIDATION_ROOT_PREFIXES = [
  "clawsweeper-base-validation-",
  "clawsweeper-repair-target-",
];
const PROTECTED_PROOF_INPUT_DIRECTORIES = new Set([
  ".venv",
  ".yarn",
  "node_modules",
  "venv",
  "vendor",
]);
const ROOT_PROOF_INPUT_CANDIDATES = [
  ".env",
  ".env.ci",
  ".env.development",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.test",
  ".npmrc",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  ".venv",
  ".yarn",
  ".yarnrc",
  ".yarnrc.yml",
  "node_modules",
  "venv",
];

export type TargetValidationOptions = {
  additionalValidationCommands?: string[];
  allowExpensiveValidation: boolean;
  installTimeoutMs?: number;
  installTargetDeps: boolean;
  skipOpenClawChangedGate?: boolean;
  strictTargetValidation: boolean;
  targetRepo: string;
  setupTimeoutMs?: number;
  validationTimeoutMs?: number;
  proofBudgetMs?: number;
  proofInputMaxBytes?: number;
  proofInputMaxEntries?: number;
  proofInputMaxDepth?: number;
  proofSurfacePaths?: string[];
  pinnedBaseRef?: string;
  /**
   * Optional override of the per-repo toolchain (package manager, base validation
   * commands, changed gate). If omitted, it is resolved from
   * config/target-repositories.json via `resolveTargetRepoToolchain(targetRepo)`.
   * Tests inject this directly to avoid touching the config file.
   */
  toolchain?: TargetRepoToolchain;
};

export type RepairDeltaValidationPlan = {
  commands: string[];
  options: TargetValidationOptions;
  scope: "changed-surface" | "repair-delta-docs";
  changed_files: string[];
  reason: string;
};

export type ExternalBaseValidationBlocker = {
  paths: string[];
  reason: string;
};

export type TargetValidationProofResult = StagedProofExecutionResult & {
  plan: StagedProofPlan;
};

type LinuxTargetValidationIsolation = {
  kind: "linux-user";
  gid: number;
  home: string;
  uid: number;
  user: string;
};

type MacosTargetValidationIsolation = {
  kind: "macos-sandbox";
  home: string;
  user: string;
};

type LinuxTestTargetValidationIsolation = {
  kind: "linux-test";
  home: string;
  user: string;
};

type TargetValidationIsolation =
  | LinuxTargetValidationIsolation
  | MacosTargetValidationIsolation
  | LinuxTestTargetValidationIsolation;

type TargetControlledCommandOptions = CommandRunOptions & {
  cwd: string;
  isolateNetwork?: boolean;
};

type RequiredValidationCommand = {
  command: LooseRecord;
  source: StagedProofCommandInput["source"];
  canonical: boolean;
  required: boolean;
};

export function classifyExternalBaseValidationFailure({
  targetDir,
  pinnedBaseRef,
  repairBaseRef,
  repairDeltaPaths,
  error,
  baseError,
}: {
  targetDir: string;
  pinnedBaseRef: string;
  repairBaseRef: string | null;
  repairDeltaPaths?: string[];
  error: unknown;
  baseError: unknown;
}): ExternalBaseValidationBlocker | null {
  if (!repairBaseRef || !baseError) return null;
  const trackedAtBase = new Set(
    splitGitLines(run("git", ["ls-tree", "-r", "--name-only", pinnedBaseRef], { cwd: targetDir })),
  );
  const referencedPaths = referencedTrackedPaths(String((error as Error)?.message ?? error), {
    targetDir,
    trackedAtBase,
  });
  if (referencedPaths.length === 0) return null;
  const baseReferencedPaths = referencedTrackedPaths(
    String((baseError as Error)?.message ?? baseError),
    { targetDir, trackedAtBase },
  );
  if (
    baseReferencedPaths.length !== referencedPaths.length ||
    referencedPaths.some((file) => !baseReferencedPaths.includes(file))
  ) {
    return null;
  }
  if (
    normalizedValidationFailure(String((error as Error)?.message ?? error), trackedAtBase) !==
    normalizedValidationFailure(String((baseError as Error)?.message ?? baseError), trackedAtBase)
  ) {
    return null;
  }

  const changedFromBase = new Set(
    splitGitLines(
      run("git", ["diff", "--name-only", `${pinnedBaseRef}..HEAD`], { cwd: targetDir }),
    ),
  );
  const repairDelta = new Set(
    repairDeltaPaths ??
      splitGitLines(
        run("git", ["diff", "--name-only", `${repairBaseRef}..HEAD`], { cwd: targetDir }),
      ),
  );
  if (referencedPaths.some((file) => changedFromBase.has(file) || repairDelta.has(file))) {
    return null;
  }

  return {
    paths: referencedPaths,
    reason: "validation failed only in base-identical files outside the repair delta",
  };
}

export function reproduceValidationFailureAtPinnedBase({
  commands,
  targetDir,
  options,
  baseBranch = DEFAULT_BASE_BRANCH,
}: {
  commands: LooseRecord[];
  targetDir: string;
  options: TargetValidationOptions;
  baseBranch?: string;
}): unknown | null {
  if (!options.pinnedBaseRef) return null;
  let changedFromPinnedBase: string[];
  try {
    changedFromPinnedBase = gitChangedFilesFromRef(targetDir, options.pinnedBaseRef);
  } catch {
    return null;
  }
  if (changedFromPinnedBase.some(isDependencyOrToolchainInputPath)) return null;
  if (fs.existsSync(path.join(targetDir, "node_modules")) && !options.installTargetDeps)
    return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-base-validation-"));
  const checkout = path.join(root, "target");
  try {
    run("git", ["clone", "--shared", "--no-checkout", targetDir, checkout]);
    run("git", ["checkout", "--detach", options.pinnedBaseRef], { cwd: checkout });
    try {
      prepareTargetToolchain(checkout, options);
    } catch {
      return null;
    }
    try {
      runAllowedValidationCommands(
        commands,
        checkout,
        { ...options, installTargetDeps: false },
        baseBranch,
      );
      return null;
    } catch (error) {
      return error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isDependencyOrToolchainInputPath(filePath: string) {
  const name = path.posix.basename(filePath);
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|composer\.(?:json|lock)|requirements(?:-[^.]+)?\.txt)$/i.test(
      name,
    ) || /^(?:\.nvmrc|\.node-version|\.tool-versions|mise\.toml)$/i.test(name)
  );
}

export function prepareTargetToolchain(cwd: string, options: TargetValidationOptions) {
  if (!options.installTargetDeps) return;
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return;
  const setupTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_SETUP_TIMEOUT_MS",
    options.setupTimeoutMs ?? DEFAULT_TARGET_SETUP_TIMEOUT_MS,
    options.setupTimeoutMs,
  );
  const installTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_INSTALL_TIMEOUT_MS",
    options.installTimeoutMs ?? DEFAULT_TARGET_INSTALL_TIMEOUT_MS,
    options.installTimeoutMs,
  );
  const remainingBudgetMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_PROOF_BUDGET_MS",
    options.proofBudgetMs ?? Math.max(setupTimeoutMs, installTimeoutMs),
    options.proofBudgetMs,
  );
  const toolchainBudgetMs = Math.min(remainingBudgetMs, Math.max(setupTimeoutMs, installTimeoutMs));
  const identityLimits = proofInputLimits(options, Date.now() + toolchainBudgetMs);
  const sourceIdentity = validationSourceIdentity(cwd, identityLimits);
  if (sourceIdentity.status) {
    throw new Error("target dependency setup requires a clean source checkout");
  }

  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const toolchain = getToolchain(options);
  const validationEnv = targetValidationEnv();
  runTargetControlledCommand(
    "node",
    [
      "-e",
      "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error(`Node ${process.version} is too old for target validation`); process.exit(1); }",
    ],
    {
      cwd,
      env: validationEnv,
      timeoutMs: targetToolchainCommandTimeout(identityLimits, setupTimeoutMs, "node setup probe"),
    },
  );

  if (toolchain.packageManager === "bun") {
    prepareBunToolchain({
      cwd,
      validationEnv,
      setupTimeoutMs,
      installTimeoutMs,
      identityLimits,
    });
    assertValidationSourceIdentity(cwd, sourceIdentity, identityLimits);
    return;
  }
  if (toolchain.packageManager === "npm") {
    prepareNpmToolchain({ cwd, validationEnv, installTimeoutMs, identityLimits });
    assertValidationSourceIdentity(cwd, sourceIdentity, identityLimits);
    return;
  }
  preparePnpmToolchain({
    cwd,
    packageJson,
    validationEnv,
    setupTimeoutMs,
    installTimeoutMs,
    identityLimits,
  });
  assertValidationSourceIdentity(cwd, sourceIdentity, identityLimits);
}

function preparePnpmToolchain({
  cwd,
  packageJson,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
  identityLimits,
}: {
  cwd: string;
  packageJson: LooseRecord;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
  identityLimits: ProofInputLimits;
}) {
  const packageManager = String(packageJson.packageManager ?? "pnpm@10.33.0");
  if (!packageManager.startsWith("pnpm@")) {
    throw new Error(`unsupported target package manager: ${packageManager}`);
  }
  const isolation = targetValidationIsolationFromEnv();
  const enableArgs = isolation
    ? ["enable", "--install-directory", path.join(isolation.home, ".local", "bin")]
    : ["enable"];
  runTargetControlledCommand("corepack", enableArgs, {
    cwd,
    env: validationEnv,
    timeoutMs: targetToolchainCommandTimeout(identityLimits, setupTimeoutMs, "corepack enable"),
  });
  runTargetControlledCommand("corepack", ["prepare", packageManager, "--activate"], {
    cwd,
    env: validationEnv,
    timeoutMs: targetToolchainCommandTimeout(identityLimits, setupTimeoutMs, "corepack prepare"),
  });
  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--ignore-scripts",
    "--config.engine-strict=false",
    "--config.enable-pre-post-scripts=false",
  ];
  try {
    runTargetControlledCommand("pnpm", installArgs, {
      cwd,
      env: validationEnv,
      timeoutMs: targetToolchainCommandTimeout(identityLimits, installTimeoutMs, "pnpm install"),
    });
  } catch (error) {
    if (!/ERR_PNPM_OUTDATED_LOCKFILE/i.test(String(error.message))) throw error;
    runTargetControlledCommand(
      "pnpm",
      installArgs.map((arg) => (arg === "--frozen-lockfile" ? "--no-frozen-lockfile" : arg)),
      {
        cwd,
        env: validationEnv,
        timeoutMs: targetToolchainCommandTimeout(
          identityLimits,
          installTimeoutMs,
          "pnpm install fallback",
        ),
      },
    );
    restoreTargetLockfile(
      cwd,
      "pnpm-lock.yaml",
      targetToolchainCommandTimeout(identityLimits, installTimeoutMs, "pnpm lockfile restoration"),
    );
    runTargetControlledCommand("pnpm", installArgs, {
      cwd,
      env: validationEnv,
      timeoutMs: targetToolchainCommandTimeout(
        identityLimits,
        installTimeoutMs,
        "pnpm frozen reinstall",
      ),
    });
  }
}

function prepareBunToolchain({
  cwd,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
  identityLimits,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
  identityLimits: ProofInputLimits;
}) {
  // The repair execution workflow provisions pinned Bun before this path runs.
  // Keep a clear fail-fast probe so local/manual runners surface setup gaps early.
  // ClawSweeper runs under pnpm, so strip caller lifecycle identity before Bun
  // while preserving target registry, auth, proxy, userconfig, and cache settings.
  const bunEnv = sanitizeEnvForBun(validationEnv);
  runTargetControlledCommand("bun", ["--version"], {
    cwd,
    env: bunEnv,
    timeoutMs: targetToolchainCommandTimeout(identityLimits, setupTimeoutMs, "bun setup probe"),
  });
  const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts"];
  try {
    runTargetControlledCommand("bun", installArgs, {
      cwd,
      env: bunEnv,
      timeoutMs: targetToolchainCommandTimeout(identityLimits, installTimeoutMs, "bun install"),
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (!/lockfile|frozen|out of date|out-of-date/i.test(message)) throw error;
    runTargetControlledCommand("bun", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
      cwd,
      env: bunEnv,
      timeoutMs: targetToolchainCommandTimeout(
        identityLimits,
        installTimeoutMs,
        "bun install fallback",
      ),
    });
    for (const lockfile of ["bun.lock", "bun.lockb"]) {
      restoreTargetLockfile(
        cwd,
        lockfile,
        targetToolchainCommandTimeout(identityLimits, installTimeoutMs, `${lockfile} restoration`),
      );
    }
    runTargetControlledCommand("bun", installArgs, {
      cwd,
      env: bunEnv,
      timeoutMs: targetToolchainCommandTimeout(
        identityLimits,
        installTimeoutMs,
        "bun frozen reinstall",
      ),
    });
  }
}

function sanitizeEnvForBun(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldStripBunInstallEnv(key)) continue;
    out[key] = value;
  }
  // Declare bun as the active package manager so target preinstall hooks
  // such as `bunx only-allow bun` recognise the caller.
  out.npm_config_user_agent = `bun/unknown npm/? node/${process.versions.node} ${process.platform} ${process.arch}`;
  return out;
}

function shouldStripBunInstallEnv(key: string): boolean {
  return (
    /^PNPM_/i.test(key) ||
    /^npm_config_user_agent$/i.test(key) ||
    /^npm_execpath$/i.test(key) ||
    /^npm_node_execpath$/i.test(key) ||
    /^npm_lifecycle_/i.test(key) ||
    /^npm_package_/i.test(key)
  );
}

function prepareNpmToolchain({
  cwd,
  validationEnv,
  installTimeoutMs,
  identityLimits,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  installTimeoutMs: number;
  identityLimits: ProofInputLimits;
}) {
  const installArgs = fs.existsSync(path.join(cwd, "package-lock.json"))
    ? ["ci", "--ignore-scripts"]
    : ["install", "--no-package-lock", "--ignore-scripts"];
  runTargetControlledCommand("npm", installArgs, {
    cwd,
    env: validationEnv,
    timeoutMs: targetToolchainCommandTimeout(identityLimits, installTimeoutMs, "npm install"),
  });
}

export function runAllowedValidationCommands(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  return runStagedValidationProof(commands, cwd, options, baseBranch).commands;
}

export function buildTargetValidationProofPlan(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  const validationEnv = targetValidationEnv();
  return stagedProofPlanArtifact(
    createTargetValidationProofPlan(commands, cwd, options, baseBranch, validationEnv).plan,
  );
}

export function runStagedValidationProof(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
): TargetValidationProofResult {
  const validationEnv = targetValidationEnv();
  const { baseRef, plan } = createTargetValidationProofPlan(
    commands,
    cwd,
    options,
    baseBranch,
    validationEnv,
  );
  const validationTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
    options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
    options.validationTimeoutMs,
  );
  const defaultProofBudgetMs = Math.max(
    validationTimeoutMs,
    validationTimeoutMs * plan.commands.length,
  );
  const proofBudgetMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_PROOF_BUDGET_MS",
    options.proofBudgetMs ?? defaultProofBudgetMs,
    options.proofBudgetMs,
  );
  const proofStartedAt = Date.now();
  const proofLimits = proofInputLimits(options, proofStartedAt + proofBudgetMs);
  const checkoutIdentity = validationCheckoutIdentity(cwd, baseRef, proofLimits);
  if (checkoutIdentity.status) {
    throw new Error("staged proof requires a clean validation checkout");
  }
  const proofInputSnapshot = validationProofInputSnapshot(cwd, plan.commands, proofLimits);
  const executed = new Set<string>();
  const attempts = new Map<string, number>();
  const result = executeStagedProofPlan(plan, {
    commandTimeoutMs: validationTimeoutMs,
    budgetMs: remainingProofBudgetMs(proofBudgetMs, proofStartedAt),
    validatedHeadSha: checkoutIdentity.headSha,
    validatedBaseSha: checkoutIdentity.baseSha,
    runCommand: (command, timeoutMs) =>
      runValidationPlanCommand({
        parts: command.parts,
        displayParts: command.display_parts,
        timeoutMs,
        cwd,
        validationEnv,
        options,
        attempts,
        executed,
        baseRef,
        checkoutIdentity,
        proofInputSnapshot,
        proofLimits,
      }),
  });
  return { ...result, plan };
}

export function replayStagedValidationProof(
  planArtifact: StagedProofPlanArtifact,
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
): TargetValidationProofResult {
  const validationEnv = targetValidationEnv();
  const plan = stagedProofPlanFromArtifact(planArtifact);
  const baseRef = validationBaseRef(cwd, baseBranch, options);
  const validationTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
    options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
    options.validationTimeoutMs,
  );
  const defaultProofBudgetMs = Math.max(
    validationTimeoutMs,
    validationTimeoutMs * plan.commands.length,
  );
  const proofBudgetMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_PROOF_BUDGET_MS",
    options.proofBudgetMs ?? defaultProofBudgetMs,
    options.proofBudgetMs,
  );
  const proofStartedAt = Date.now();
  const proofLimits = proofInputLimits(options, proofStartedAt + proofBudgetMs);
  const checkoutIdentity = validationCheckoutIdentity(cwd, baseRef, proofLimits);
  if (checkoutIdentity.status) {
    throw new Error("staged proof replay requires a clean validation checkout");
  }
  const proofInputSnapshot = validationProofInputSnapshot(cwd, plan.commands, proofLimits);
  const executed = new Set<string>();
  const attempts = new Map<string, number>();
  const result = executeStagedProofPlan(plan, {
    commandTimeoutMs: validationTimeoutMs,
    budgetMs: remainingProofBudgetMs(proofBudgetMs, proofStartedAt),
    validatedHeadSha: checkoutIdentity.headSha,
    validatedBaseSha: checkoutIdentity.baseSha,
    runCommand: (command, timeoutMs) => {
      const validatedParts = requireWorkspaceMatchFailure(
        validateAllowedValidationCommandParts(command.parts, command.display_parts.join(" ")),
      );
      if (JSON.stringify(validatedParts) !== JSON.stringify(command.parts)) {
        throw new Error("staged proof replay command differs from current validation policy");
      }
      return runValidationPlanCommand({
        parts: validatedParts,
        displayParts: command.display_parts,
        timeoutMs,
        cwd,
        validationEnv,
        options,
        attempts,
        executed,
        baseRef,
        checkoutIdentity,
        proofInputSnapshot,
        proofLimits,
      });
    },
  });
  return { ...result, plan };
}

function createTargetValidationProofPlan(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string,
  validationEnv: NodeJS.ProcessEnv,
) {
  const baseRef = validationBaseRef(cwd, baseBranch, options);
  const changedFiles = gitChangedFilesFromRef(cwd, baseRef);
  const surfaceHints = options.proofSurfacePaths ?? [];
  const toolchain = getToolchain(options);
  const requiredCommands = resolvedRequiredValidationCommandEntries(
    commands,
    cwd,
    baseBranch,
    options,
    validationEnv,
  );
  if (requiredCommands.length === 0) {
    throw new Error(
      "validation_command_missing: no configured or artifact validation command is available",
    );
  }
  const missingScript = missingRequiredPackageScript(
    requiredCommands,
    readPackageScriptInventory(cwd),
  );
  if (missingScript) {
    throw new Error(
      `validation_script_missing: required ${missingScript.command} is unavailable in target checkout`,
    );
  }
  const resolved: StagedProofCommandInput[] = [
    {
      parts: ["git", "diff", "--check", `${baseRef}...HEAD`],
      source: "configured",
      canonical: false,
      required: true,
      originalIndex: -2,
    },
    {
      parts: ["git", "diff", "--check"],
      source: "configured",
      canonical: false,
      required: true,
      originalIndex: -1,
    },
    ...requiredCommands,
  ];

  return {
    baseRef,
    plan: buildStagedProofPlan({
      commands: resolved,
      changedFiles,
      surfaceHints,
      subsumptionContracts: proofSubsumptionContracts(toolchain, validationEnv),
    }),
  };
}

function runValidationPlanCommand({
  parts,
  displayParts,
  timeoutMs,
  cwd,
  validationEnv,
  options,
  attempts,
  executed,
  baseRef,
  checkoutIdentity,
  proofInputSnapshot,
  proofLimits,
}: {
  parts: string[];
  displayParts: string[];
  timeoutMs: number;
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  options: TargetValidationOptions;
  attempts: Map<string, number>;
  executed: Set<string>;
  baseRef: string;
  checkoutIdentity: ValidationCheckoutIdentity;
  proofInputSnapshot: ValidationProofInputSnapshot;
  proofLimits: ProofInputLimits;
}) {
  const rendered = displayParts.join(" ");
  const commandIdentity = JSON.stringify(parts);
  if (executed.has(commandIdentity)) {
    return { executedCommands: [], reason: "exact command already passed" };
  }
  const startedAt = Date.now();
  assertValidationProofInputSnapshot(cwd, proofInputSnapshot, proofLimits);
  while (true) {
    const remainingBudgetMs = remainingCommandBudget(timeoutMs, startedAt);
    if (remainingBudgetMs <= 0) {
      throw validationCommandBudgetError(rendered);
    }
    let executionError: Error | null = null;
    try {
      const executionParts = validationCommandForExecution(parts);
      runTargetControlledCommand(executionParts[0]!, executionParts.slice(1), {
        cwd,
        env: validationEnv,
        isolateNetwork: true,
        timeoutMs: remainingBudgetMs,
      });
    } catch (error) {
      executionError = error as Error;
    }
    assertValidationCheckoutIdentity(cwd, baseRef, checkoutIdentity, proofLimits);
    assertValidationProofInputSnapshot(cwd, proofInputSnapshot, proofLimits);
    const postVerificationBudgetMs = remainingCommandBudget(timeoutMs, startedAt);
    if (postVerificationBudgetMs <= 0) {
      throw validationCommandBudgetError(rendered, executionError ?? undefined);
    }
    if (!executionError) {
      executed.add(commandIdentity);
      return {
        executedCommands: [rendered],
        reason:
          (attempts.get(commandIdentity) ?? 0) > 0
            ? `passed after ${(attempts.get(commandIdentity) ?? 0) + 1} attempts`
            : "passed",
      };
    }
    if (
      postVerificationBudgetMs >= MIN_VALIDATION_RETRY_BUDGET_MS &&
      shouldRetryValidationCommand({
        parts,
        error: executionError,
        attempts,
        options,
        attemptKey: commandIdentity,
      })
    ) {
      continue;
    }
    throw new Error(
      `validation command failed (${rendered}): ${compactText(executionError.message, 12000)}`,
      { cause: executionError },
    );
  }
}

type ValidationCheckoutIdentity = {
  headSha: string;
  baseSha: string;
  status: string;
  trackedWorktreeSha256: string;
};

type ValidationProofInputSnapshot = {
  entries: Map<string, string>;
};

type ProofInputLimits = {
  deadlineAt: number;
  maxBytes: number;
  maxDepth: number;
  maxEntries: number;
};

type ProofTraversalState = {
  bytes: number;
  entries: number;
};

type ValidationSourceIdentity = {
  headSha: string;
  treeSha: string;
  status: string;
  trackedWorktreeSha256: string;
};

function proofInputLimits(options: TargetValidationOptions, deadlineAt: number): ProofInputLimits {
  const limits = {
    deadlineAt,
    maxBytes: options.proofInputMaxBytes ?? DEFAULT_PROOF_INPUT_MAX_BYTES,
    maxDepth: options.proofInputMaxDepth ?? DEFAULT_PROOF_INPUT_MAX_DEPTH,
    maxEntries: options.proofInputMaxEntries ?? DEFAULT_PROOF_INPUT_MAX_ENTRIES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`proof input ${name} must be a positive integer`);
    }
  }
  return limits;
}

function validationSourceIdentity(cwd: string, limits: ProofInputLimits): ValidationSourceIdentity {
  return {
    headSha: run("git", ["rev-parse", "HEAD"], {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, "source head"),
    }).trim(),
    treeSha: run("git", ["rev-parse", "HEAD^{tree}"], {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, "source tree"),
    }).trim(),
    status: run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, "source status"),
    }),
    trackedWorktreeSha256: trackedWorktreeSha256(cwd, limits),
  };
}

function assertValidationSourceIdentity(
  cwd: string,
  expected: ValidationSourceIdentity,
  limits: ProofInputLimits,
) {
  const actual = validationSourceIdentity(cwd, limits);
  if (
    actual.headSha !== expected.headSha ||
    actual.treeSha !== expected.treeSha ||
    actual.status !== expected.status ||
    actual.trackedWorktreeSha256 !== expected.trackedWorktreeSha256
  ) {
    throw new Error("target dependency setup mutated source or proof identity");
  }
}

function validationCheckoutIdentity(
  cwd: string,
  baseRef: string,
  limits: ProofInputLimits,
): ValidationCheckoutIdentity {
  return {
    headSha: run("git", ["rev-parse", "HEAD"], {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, "checkout head"),
    }).trim(),
    baseSha: run("git", ["rev-parse", baseRef], {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, "checkout base"),
    }).trim(),
    status: run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, "checkout status"),
    }),
    trackedWorktreeSha256: trackedWorktreeSha256(cwd, limits),
  };
}

function assertValidationCheckoutIdentity(
  cwd: string,
  baseRef: string,
  expected: ValidationCheckoutIdentity,
  limits: ProofInputLimits,
) {
  const actual = validationCheckoutIdentity(cwd, baseRef, limits);
  if (
    actual.headSha !== expected.headSha ||
    actual.baseSha !== expected.baseSha ||
    actual.status !== expected.status ||
    actual.trackedWorktreeSha256 !== expected.trackedWorktreeSha256
  ) {
    throw new Error("unsafe validation command mutated checkout or proof identity");
  }
}

function validationProofInputSnapshot(
  cwd: string,
  commands: readonly { parts: readonly string[] }[],
  limits: ProofInputLimits,
): ValidationProofInputSnapshot {
  const root = fs.realpathSync(cwd);
  const entries = new Map<string, string>();
  const visitedPaths = new Set<string>();
  const state: ProofTraversalState = { bytes: 0, entries: 0 };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`proof input ${name} must be a positive integer`);
    }
  }

  const visit = (relativePath: string) => {
    if (visitedPaths.has(relativePath)) return;
    consumeProofInputTraversalEntry(relativePath, state, limits);
    visitedPaths.add(relativePath);
    const entryPath = proofInputPath(root, relativePath);
    const stat = fs.lstatSync(entryPath, { bigint: true });
    entries.set(relativePath, validationProofInputSignature(stat));

    if (stat.isSymbolicLink()) {
      entries.set(`${relativePath}\0link`, fs.readlinkSync(entryPath));
      const targetPath = proofInputSymlinkTarget(root, entryPath, relativePath);
      const targetStat = fs.statSync(targetPath, { bigint: true });
      const targetRelativePath = proofInputRelativePath(root, targetPath);
      entries.set(
        `${relativePath}\0target`,
        `${targetRelativePath}\0${validationProofInputSignature(targetStat)}`,
      );
      visit(targetRelativePath);
      return;
    }
    if (!stat.isDirectory()) {
      if (!stat.isFile()) {
        throw new Error(`unsupported proof input entry: ${relativePath}`);
      }
      return;
    }
    assertProofInputTraversalBudget(relativePath, visitedPaths.size - 1, limits);
    const children = readProofInputSnapshotDirectory(
      entryPath,
      relativePath,
      state.entries,
      limits,
    );
    entries.set(`${relativePath}\0children`, children.join("\0"));
    for (const name of children) {
      visit(path.posix.join(relativePath, name));
    }
  };

  for (const relativePath of validationProofInputCandidates(cwd, commands, limits)) {
    if (proofInputLstat(root, relativePath)) visit(relativePath);
    else {
      consumeProofInputTraversalEntry(relativePath, state, limits);
      visitedPaths.add(relativePath);
      entries.set(relativePath, ABSENT_PROOF_INPUT);
    }
  }
  return { entries };
}

function readProofInputSnapshotDirectory(
  directoryPath: string,
  relativePath: string,
  visitedEntries: number,
  limits: ProofInputLimits,
) {
  assertProofInputTraversalDeadline(relativePath, limits);
  const directory = fs.opendirSync(directoryPath);
  const children: string[] = [];
  try {
    for (;;) {
      assertProofInputTraversalDeadline(relativePath, limits);
      const entry = directory.readSync();
      assertProofInputTraversalDeadline(relativePath, limits);
      if (!entry) break;
      const childPath = path.posix.join(relativePath, entry.name);
      assertProofInputTraversalBudget(childPath, visitedEntries + children.length, limits);
      children.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return children.sort();
}

function assertProofInputTraversalBudget(
  relativePath: string,
  visitedEntries: number,
  limits: ProofInputLimits,
) {
  assertProofInputTraversalDeadline(relativePath, limits);
  if (visitedEntries >= limits.maxEntries) {
    throw new Error(`proof input traversal exceeded the supported entry budget at ${relativePath}`);
  }
  const depth = relativePath.split("/").filter(Boolean).length;
  if (depth > limits.maxDepth) {
    throw new Error(`proof input traversal exceeded the supported depth budget at ${relativePath}`);
  }
}

function consumeProofInputTraversalEntry(
  relativePath: string,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  assertProofInputTraversalBudget(relativePath, state.entries, limits);
  const bytes = Buffer.byteLength(relativePath);
  if (state.bytes + bytes > limits.maxBytes) {
    throw new Error(`proof input traversal exceeded the supported byte budget at ${relativePath}`);
  }
  state.bytes += bytes;
  state.entries += 1;
}

function assertProofInputTraversalDeadline(relativePath: string, limits: ProofInputLimits) {
  if (Date.now() >= limits.deadlineAt) {
    throw new Error(
      `staged proof runtime budget exhausted before proof input snapshot completed: ${relativePath}`,
    );
  }
}

function validationProofInputSignature(stat: fs.BigIntStats) {
  return [
    stat.mode,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
  ].join(":");
}

function assertValidationProofInputSnapshot(
  cwd: string,
  expected: ValidationProofInputSnapshot,
  limits: ProofInputLimits,
) {
  const root = fs.realpathSync(cwd);
  const state: ProofTraversalState = { bytes: 0, entries: 0 };
  for (const [entryPath, signature] of expected.entries) {
    const relativePath = entryPath.split("\0", 1)[0]!;
    assertProofInputVerificationDeadline(limits, relativePath);
    assertProofInputVerificationDepth(limits, relativePath);
    if (currentProofInputSignature(root, entryPath, limits, state) === signature) continue;
    if (!entryPath.includes("\0") && expected.entries.has(`${relativePath}\0children`)) {
      currentProofInputSignature(root, `${relativePath}\0children`, limits, state);
    }
    throw new Error(
      `unsafe validation command mutated ignored proof input surface: ${relativePath || "unknown"}`,
    );
  }
}

function validationProofInputCandidates(
  cwd: string,
  commands: readonly { parts: readonly string[] }[],
  limits: ProofInputLimits,
): string[] {
  const candidates = new Set(ROOT_PROOF_INPUT_CANDIDATES);
  const discoveryState: ProofTraversalState = { bytes: 0, entries: 0 };
  for (const candidate of trackedManifestProofInputCandidates(cwd, limits, discoveryState)) {
    candidates.add(candidate);
  }
  const ignoredPaths = boundedGitProofInputPaths(
    cwd,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    limits,
    discoveryState,
    "ignored proof inputs",
  );
  const ignoredPathSet = new Set(ignoredPaths);
  for (const ignoredPath of ignoredPaths) {
    const parts = ignoredPath.split("/");
    const protectedIndex = parts.findIndex((part) => PROTECTED_PROOF_INPUT_DIRECTORIES.has(part));
    if (protectedIndex >= 0) {
      addDiscoveredProofInputCandidate(
        candidates,
        parts.slice(0, protectedIndex + 1).join("/"),
        discoveryState,
        limits,
      );
    } else if (isProtectedProofInputFile(ignoredPath)) {
      addDiscoveredProofInputCandidate(candidates, ignoredPath, discoveryState, limits);
    }
  }

  for (const command of commands) {
    for (const argument of stripEnvPrefix(command.parts).slice(1)) {
      if (!looksLikePathArgument(argument) || argument.startsWith("-")) continue;
      const absolute = path.resolve(cwd, argument);
      if (!isPathWithin(path.resolve(cwd), absolute) || !fs.existsSync(absolute)) continue;
      const relative = proofInputRelativePath(path.resolve(cwd), absolute);
      if (pathIsWithinCandidateSet(relative, ignoredPathSet)) {
        addDiscoveredProofInputCandidate(candidates, relative, discoveryState, limits);
      }
    }
  }

  return reduceProofInputCandidatePrefixes(candidates);
}

function trackedManifestProofInputCandidates(
  cwd: string,
  limits: ProofInputLimits,
  state: ProofTraversalState,
): string[] {
  const manifests = boundedGitProofInputPaths(
    cwd,
    [
      "ls-files",
      "-z",
      "--",
      ":(glob)**/Cargo.toml",
      ":(glob)**/Gemfile",
      ":(glob)**/Pipfile",
      ":(glob)**/composer.json",
      ":(glob)**/go.mod",
      ":(glob)**/package.json",
      ":(glob)**/poetry.lock",
      ":(glob)**/pyproject.toml",
      ":(glob)**/requirements*.txt",
    ],
    limits,
    state,
    "tracked manifest proof inputs",
  );
  const candidates = new Set<string>();
  for (const manifest of manifests) {
    const directory = path.posix.dirname(manifest);
    for (const name of ROOT_PROOF_INPUT_CANDIDATES) {
      addDiscoveredProofInputCandidate(
        candidates,
        directory === "." ? name : path.posix.join(directory, name),
        state,
        limits,
      );
    }
    if (
      path.posix.basename(manifest) === "Cargo.toml" ||
      path.posix.basename(manifest) === "go.mod"
    ) {
      addDiscoveredProofInputCandidate(
        candidates,
        directory === "." ? "vendor" : path.posix.join(directory, "vendor"),
        state,
        limits,
      );
    }
  }
  return [...candidates];
}

export function reduceProofInputCandidatePrefixes(values: Iterable<string>): string[] {
  type TrieNode = { terminal: boolean; children: Map<string, TrieNode> };
  const root: TrieNode = { terminal: false, children: new Map() };
  const selected: string[] = [];
  const candidates = [
    ...new Set([...values].map(normalizeProofInputCandidate).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
  for (const candidate of candidates) {
    const parts = candidate.split("/");
    let node = root;
    let covered = false;
    for (const part of parts) {
      if (node.terminal) {
        covered = true;
        break;
      }
      let child = node.children.get(part);
      if (!child) {
        child = { terminal: false, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    if (covered || node.terminal) continue;
    node.terminal = true;
    node.children.clear();
    selected.push(candidate);
  }
  return selected;
}

function boundedGitProofInputPaths(
  cwd: string,
  args: string[],
  limits: ProofInputLimits,
  state: ProofTraversalState,
  label: string,
) {
  let output: string;
  try {
    output = run("git", args, {
      cwd,
      timeoutMs: proofInputDiscoveryTimeoutMs(limits, label),
      maxBuffer: Math.max(1, limits.maxBytes),
    });
  } catch (error) {
    if (/ENOBUFS|maxBuffer/i.test(String((error as Error).message))) {
      throw new Error(
        `proof input candidate discovery exceeded the supported byte budget at ${label}`,
        { cause: error },
      );
    }
    throw error;
  }
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== "\0") continue;
    const entry = normalizeProofInputCandidate(output.slice(start, index).replace(/\/+$/, ""));
    start = index + 1;
    if (!entry) continue;
    consumeProofInputCandidateDiscoveryEntry(entry, state, limits);
    entries.push(entry);
  }
  return entries;
}

function addDiscoveredProofInputCandidate(
  candidates: Set<string>,
  candidate: string,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  const normalized = normalizeProofInputCandidate(candidate);
  if (!normalized || candidates.has(normalized)) return;
  consumeProofInputCandidateDiscoveryEntry(normalized, state, limits);
  candidates.add(normalized);
}

function normalizeProofInputCandidate(candidate: string) {
  const normalized = candidate
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized === ".git" || normalized.startsWith(".git/")) return "";
  return normalized;
}

function consumeProofInputCandidateDiscoveryEntry(
  relativePath: string,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  assertProofInputCandidateDiscoveryDeadline(limits, relativePath);
  if (state.entries >= limits.maxEntries) {
    throw new Error(
      `proof input candidate discovery exceeded the supported entry budget at ${relativePath}`,
    );
  }
  const depth = relativePath.split("/").filter(Boolean).length;
  if (depth > limits.maxDepth) {
    throw new Error(
      `proof input candidate discovery exceeded the supported depth budget at ${relativePath}`,
    );
  }
  const bytes = Buffer.byteLength(relativePath) + 1;
  if (state.bytes + bytes > limits.maxBytes) {
    throw new Error(
      `proof input candidate discovery exceeded the supported byte budget at ${relativePath}`,
    );
  }
  state.entries += 1;
  state.bytes += bytes;
}

function proofInputDiscoveryTimeoutMs(limits: ProofInputLimits, label: string) {
  assertProofInputCandidateDiscoveryDeadline(limits, label);
  return Math.max(1, limits.deadlineAt - Date.now());
}

function assertProofInputCandidateDiscoveryDeadline(limits: ProofInputLimits, label: string) {
  if (Date.now() >= limits.deadlineAt) {
    throw new Error(
      `staged proof runtime budget exhausted during proof input candidate discovery: ${label}`,
    );
  }
}

function pathIsWithinCandidateSet(relativePath: string, candidates: Set<string>) {
  let candidate = relativePath;
  for (;;) {
    if (candidates.has(candidate)) return true;
    const parent = path.posix.dirname(candidate);
    if (parent === "." || parent === candidate) return false;
    candidate = parent;
  }
}

function isProtectedProofInputFile(filePath: string) {
  const name = path.posix.basename(filePath);
  return (
    /^\.env(?:\..+)?$/.test(name) ||
    /^(?:\.npmrc|\.pnp\.(?:cjs|loader\.mjs)|\.pnpmfile\.cjs|\.yarnrc(?:\.yml)?)$/.test(name)
  );
}

function currentProofInputSignature(
  root: string,
  entryPath: string,
  limits: ProofInputLimits,
  state: ProofTraversalState,
): string {
  const [relativePath, kind = "stat"] = entryPath.split("\0");
  assertProofInputVerificationDeadline(limits, relativePath!);
  const absolute = proofInputPath(root, relativePath!);
  const stat = proofInputLstat(root, relativePath!);
  if (!stat) return ABSENT_PROOF_INPUT;
  if (kind === "stat") return validationProofInputSignature(stat);
  if (kind === "children") {
    return stat.isDirectory()
      ? readProofInputVerificationDirectory(absolute, relativePath!, state, limits).join("\0")
      : "<not-directory>";
  }
  if (kind === "link") {
    if (!stat.isSymbolicLink()) return "<not-symlink>";
    const target = fs.readlinkSync(absolute);
    consumeProofInputVerificationBytes(relativePath!, Buffer.byteLength(target), state, limits);
    return target;
  }
  if (kind === "target") {
    if (!stat.isSymbolicLink()) return "<not-symlink>";
    const targetPath = proofInputSymlinkTarget(root, absolute, relativePath!);
    const targetRelativePath = proofInputRelativePath(root, targetPath);
    consumeProofInputVerificationBytes(
      relativePath!,
      Buffer.byteLength(targetRelativePath),
      state,
      limits,
    );
    return `${targetRelativePath}\0${validationProofInputSignature(
      fs.statSync(targetPath, { bigint: true }),
    )}`;
  }
  return "<unknown-proof-input>";
}

function readProofInputVerificationDirectory(
  directoryPath: string,
  relativePath: string,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  const directory = fs.opendirSync(directoryPath);
  const children: string[] = [];
  try {
    for (;;) {
      assertProofInputVerificationDeadline(limits, relativePath);
      const entry = directory.readSync();
      if (!entry) break;
      const childPath = path.posix.join(relativePath, entry.name);
      if (state.entries >= limits.maxEntries) {
        throw new Error(
          `proof input snapshot verification exceeded the supported entry budget at ${childPath}`,
        );
      }
      const depth = childPath.split("/").filter(Boolean).length;
      if (depth > limits.maxDepth) {
        throw new Error(
          `proof input snapshot verification exceeded the supported depth budget at ${childPath}`,
        );
      }
      consumeProofInputVerificationBytes(childPath, Buffer.byteLength(entry.name), state, limits);
      state.entries += 1;
      children.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return children.sort();
}

function consumeProofInputVerificationBytes(
  relativePath: string,
  bytes: number,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  assertProofInputVerificationDeadline(limits, relativePath);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes + bytes > limits.maxBytes) {
    throw new Error(
      `proof input snapshot verification exceeded the supported byte budget at ${relativePath}`,
    );
  }
  state.bytes += bytes;
}

function assertProofInputVerificationDeadline(limits: ProofInputLimits, relativePath: string) {
  if (Date.now() >= limits.deadlineAt) {
    throw new Error(
      `staged proof runtime budget exhausted during proof input snapshot verification: ${relativePath}`,
    );
  }
}

function assertProofInputVerificationDepth(limits: ProofInputLimits, relativePath: string) {
  const depth = relativePath.split("/").filter(Boolean).length;
  if (depth > limits.maxDepth) {
    throw new Error(
      `proof input snapshot verification exceeded the supported depth budget at ${relativePath}`,
    );
  }
}

function proofInputLstat(root: string, relativePath: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(proofInputPath(root, relativePath), { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function proofInputPath(root: string, relativePath: string) {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!isPathWithin(root, absolute)) {
    throw new Error(`proof input path escapes validation checkout: ${relativePath}`);
  }
  return absolute;
}

function proofInputSymlinkTarget(root: string, entryPath: string, relativePath: string) {
  let targetPath: string;
  try {
    targetPath = fs.realpathSync(entryPath);
  } catch {
    throw new Error(`proof input symlink is broken or cyclic: ${relativePath}`);
  }
  if (!isPathWithin(root, targetPath)) {
    throw new Error(`proof input symlink escapes validation checkout: ${relativePath}`);
  }
  return targetPath;
}

function proofInputRelativePath(root: string, absolute: string) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function remainingCommandBudget(timeoutMs: number, startedAt: number) {
  return Math.max(0, timeoutMs - Math.max(0, Date.now() - startedAt));
}

function remainingProofBudgetMs(budgetMs: number, startedAt: number) {
  return Math.max(0, budgetMs - Math.max(0, Date.now() - startedAt));
}

function trackedWorktreeSha256(cwd: string, limits: ProofInputLimits): string {
  assertNoHiddenTrackedIndexFlags(cwd, limits);
  const root = fs.realpathSync(cwd);
  const digest = crypto.createHash("sha256");
  const state: ProofTraversalState = { bytes: 0, entries: 0 };
  const output = boundedTrackedIndexOutput(
    cwd,
    ["ls-files", "--stage", "-z"],
    limits,
    "tracked index",
  );
  for (const entry of nullDelimitedEntries(output)) {
    const match = entry.match(/^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/);
    if (!match || match[3] !== "0") {
      throw new Error("staged proof requires an unambiguous tracked index");
    }
    const [, mode, indexObject, , relativePath] = match;
    const depth = relativePath!.split("/").filter(Boolean).length;
    consumeProofHashingEntry(relativePath!, depth, state, limits);
    consumeProofHashingBytes(relativePath!, Buffer.byteLength(relativePath!), state, limits);
    const absolutePath = path.resolve(root, ...relativePath!.split("/"));
    if (!isPathWithin(root, absolutePath)) {
      throw new Error(`tracked proof input escapes validation checkout: ${relativePath}`);
    }
    updateProofDigest(digest, "path", relativePath!);
    updateProofDigest(digest, "mode", mode!);
    updateProofDigest(digest, "index", indexObject!);
    if (mode === "160000") {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        updateProofDigest(digest, "gitlink-worktree", "uninitialized");
        continue;
      }
      if (!stat.isDirectory()) {
        throw new Error(`tracked gitlink worktree is not a directory: ${relativePath}`);
      }
      if (
        trackedGitlinkWorktreeState(absolutePath, relativePath!, depth, state, limits) ===
        "uninitialized"
      ) {
        updateProofDigest(digest, "gitlink-worktree", "uninitialized");
        continue;
      }
      const head = run("git", ["-C", absolutePath, "rev-parse", "HEAD"], {
        cwd,
        timeoutMs: proofHashingTimeoutMs(limits, `gitlink head ${relativePath}`),
      }).trim();
      if (head !== indexObject) {
        throw new Error(`tracked gitlink worktree head differs from index: ${relativePath}`);
      }
      updateProofDigest(digest, "gitlink-worktree", head);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      updateProofDigest(digest, "working-tree", ABSENT_PROOF_INPUT);
      continue;
    }
    if (stat.isSymbolicLink()) {
      assertProofHashingDeadline(limits, relativePath!);
      updateProofDigest(digest, "symlink", fs.readlinkSync(absolutePath));
      const targetPath = trackedProofInputSymlinkTarget(root, absolutePath, relativePath!);
      updateProofDigest(digest, "symlink-target", proofInputRelativePath(root, targetPath));
      updateTrackedSymlinkTargetDigest(
        digest,
        root,
        targetPath,
        `${relativePath!}\0target`,
        depth + 1,
        new Set(),
        state,
        limits,
      );
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`tracked proof input is not a regular file: ${relativePath}`);
    }
    hashTrackedFile(digest, absolutePath, relativePath!, "working-tree", stat, state, limits);
  }
  return digest.digest("hex");
}

function trackedGitlinkWorktreeState(
  absolutePath: string,
  relativePath: string,
  depth: number,
  state: ProofTraversalState,
  limits: ProofInputLimits,
): "initialized" | "uninitialized" {
  const gitMarkerPath = path.join(absolutePath, ".git");
  assertProofHashingDeadline(limits, `${relativePath}/.git`);
  try {
    fs.lstatSync(gitMarkerPath);
    consumeProofHashingEntry(`${relativePath}/.git`, depth + 1, state, limits);
    return "initialized";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const directory = fs.opendirSync(absolutePath);
  try {
    assertProofHashingDeadline(limits, relativePath);
    const child = directory.readSync();
    assertProofHashingDeadline(limits, relativePath);
    if (!child) return "uninitialized";
    consumeProofHashingEntry(`${relativePath}/${child.name}`, depth + 1, state, limits);
    throw new Error(`tracked gitlink worktree is not initialized: ${relativePath}`);
  } finally {
    directory.closeSync();
  }
}

function trackedProofInputSymlinkTarget(root: string, entryPath: string, relativePath: string) {
  let targetPath: string;
  try {
    targetPath = fs.realpathSync(entryPath);
  } catch {
    throw new Error(`tracked proof input symlink is broken or cyclic: ${relativePath}`);
  }
  if (!isPathWithin(root, targetPath)) {
    throw new Error(`tracked proof input symlink escapes validation checkout: ${relativePath}`);
  }
  return targetPath;
}

function updateTrackedSymlinkTargetDigest(
  digest: crypto.Hash,
  root: string,
  entryPath: string,
  logicalPath: string,
  depth: number,
  activeDirectories: Set<string>,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  consumeProofHashingEntry(logicalPath, depth, state, limits);
  const stat = fs.lstatSync(entryPath);
  updateProofDigest(digest, "symlink-target-entry", logicalPath);
  updateProofDigest(digest, "symlink-target-mode", stat.mode.toString(8));
  if (stat.isSymbolicLink()) {
    updateProofDigest(digest, "symlink-target-link", fs.readlinkSync(entryPath));
    const targetPath = trackedProofInputSymlinkTarget(root, entryPath, logicalPath);
    updateProofDigest(digest, "symlink-target-resolved", proofInputRelativePath(root, targetPath));
    if (activeDirectories.has(targetPath)) {
      throw new Error(`tracked proof input symlink is broken or cyclic: ${logicalPath}`);
    }
    updateTrackedSymlinkTargetDigest(
      digest,
      root,
      targetPath,
      `${logicalPath}\0target`,
      depth + 1,
      activeDirectories,
      state,
      limits,
    );
    return;
  }
  if (stat.isFile()) {
    hashTrackedFile(digest, entryPath, logicalPath, "symlink-target-bytes", stat, state, limits);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`tracked proof input symlink target is unsupported: ${logicalPath}`);
  }

  const realDirectory = fs.realpathSync(entryPath);
  if (activeDirectories.has(realDirectory)) {
    throw new Error(`tracked proof input symlink is broken or cyclic: ${logicalPath}`);
  }
  activeDirectories.add(realDirectory);
  try {
    const children = readProofHashingDirectory(entryPath, logicalPath, state, limits);
    updateProofDigest(digest, "symlink-target-children", children.join("\0"));
    for (const child of children) {
      updateTrackedSymlinkTargetDigest(
        digest,
        root,
        path.join(entryPath, child),
        `${logicalPath}/${child}`,
        depth + 1,
        activeDirectories,
        state,
        limits,
      );
    }
  } finally {
    activeDirectories.delete(realDirectory);
  }
}

function readProofHashingDirectory(
  directoryPath: string,
  logicalPath: string,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  assertProofHashingDeadline(limits, logicalPath);
  const directory = fs.opendirSync(directoryPath);
  const children: string[] = [];
  try {
    for (;;) {
      assertProofHashingDeadline(limits, logicalPath);
      const entry = directory.readSync();
      if (!entry) break;
      if (state.entries + children.length >= limits.maxEntries) {
        throw new Error(
          `tracked checkout hashing exceeded the supported entry budget at ${logicalPath}/${entry.name}`,
        );
      }
      consumeProofHashingBytes(
        `${logicalPath}/${entry.name}`,
        Buffer.byteLength(entry.name),
        state,
        limits,
      );
      children.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return children.sort();
}

function hashTrackedFile(
  digest: crypto.Hash,
  filePath: string,
  logicalPath: string,
  label: string,
  stat: fs.Stats,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  consumeProofHashingBytes(logicalPath, stat.size, state, limits);
  const fileDigest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  let remaining = stat.size;
  try {
    while (remaining > 0) {
      assertProofHashingDeadline(limits, logicalPath);
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (read <= 0) {
        throw new Error(`tracked proof input changed during hashing: ${logicalPath}`);
      }
      fileDigest.update(buffer.subarray(0, read));
      remaining -= read;
    }
    if (fs.fstatSync(descriptor).size !== stat.size) {
      throw new Error(`tracked proof input changed during hashing: ${logicalPath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  updateProofDigest(digest, `${label}-length`, String(stat.size));
  updateProofDigest(digest, `${label}-sha256`, fileDigest.digest("hex"));
}

function consumeProofHashingEntry(
  logicalPath: string,
  depth: number,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  assertProofHashingDeadline(limits, logicalPath);
  if (state.entries >= limits.maxEntries) {
    throw new Error(
      `tracked checkout hashing exceeded the supported entry budget at ${logicalPath}`,
    );
  }
  if (depth > limits.maxDepth) {
    throw new Error(
      `tracked checkout hashing exceeded the supported depth budget at ${logicalPath}`,
    );
  }
  state.entries += 1;
}

function consumeProofHashingBytes(
  logicalPath: string,
  bytes: number,
  state: ProofTraversalState,
  limits: ProofInputLimits,
) {
  assertProofHashingDeadline(limits, logicalPath);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes + bytes > limits.maxBytes) {
    throw new Error(
      `tracked checkout hashing exceeded the supported byte budget at ${logicalPath}`,
    );
  }
  state.bytes += bytes;
}

function proofHashingTimeoutMs(limits: ProofInputLimits, logicalPath: string) {
  assertProofHashingDeadline(limits, logicalPath);
  return Math.max(1, limits.deadlineAt - Date.now());
}

function targetToolchainCommandTimeout(
  limits: ProofInputLimits,
  configuredTimeoutMs: number,
  logicalPath: string,
) {
  return Math.min(configuredTimeoutMs, proofHashingTimeoutMs(limits, logicalPath));
}

function assertProofHashingDeadline(limits: ProofInputLimits, logicalPath: string) {
  if (Date.now() >= limits.deadlineAt) {
    throw new Error(
      `staged proof runtime budget exhausted during tracked checkout hashing: ${logicalPath}`,
    );
  }
}

function assertNoHiddenTrackedIndexFlags(cwd: string, limits: ProofInputLimits) {
  const output = boundedTrackedIndexOutput(
    cwd,
    ["ls-files", "-v", "-z"],
    limits,
    "tracked index flags",
  );
  let entryCount = 0;
  assertProofHashingDeadline(limits, "tracked index flags");
  for (const entry of nullDelimitedEntries(output)) {
    if (entryCount >= limits.maxEntries) {
      throw new Error("tracked checkout hashing exceeded the supported entry budget");
    }
    entryCount += 1;
    assertProofHashingDeadline(limits, "tracked index flags");
    const tag = entry[0] ?? "";
    if (tag === "S" || (/[A-Za-z]/.test(tag) && tag === tag.toLowerCase())) {
      throw new Error(
        `staged proof rejects hidden tracked index flags: ${entry.slice(2) || "unknown"}`,
      );
    }
  }
}

function boundedTrackedIndexOutput(
  cwd: string,
  args: string[],
  limits: ProofInputLimits,
  logicalPath: string,
) {
  const configuredBytes =
    Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0 ? limits.maxBytes : 1;
  const maxBuffer = Math.min(
    MAX_TRACKED_INDEX_OUTPUT_BYTES,
    Math.max(MIN_TRACKED_INDEX_OUTPUT_BYTES, configuredBytes),
  );
  try {
    return run("git", args, {
      cwd,
      timeoutMs: proofHashingTimeoutMs(limits, logicalPath),
      maxBuffer,
    });
  } catch (error) {
    if (/ENOBUFS|maxBuffer/i.test(String((error as Error).message))) {
      throw new Error(
        `tracked checkout hashing exceeded the supported byte budget at ${logicalPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function* nullDelimitedEntries(output: string) {
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== "\0") continue;
    if (index > start) yield output.slice(start, index);
    start = index + 1;
  }
}

function updateProofDigest(digest: crypto.Hash, label: string, value: string) {
  digest.update(`${label}:${Buffer.byteLength(value)}:${value}\0`);
}

function validationCommandBudgetError(rendered: string, cause?: unknown) {
  return new Error(
    `validation command failed (${rendered}): validation command runtime budget exhausted`,
    cause === undefined ? undefined : { cause },
  );
}

export function preflightTargetValidationPlan(
  { fixArtifact, targetDir, baseBranch = DEFAULT_BASE_BRANCH }: LooseRecord,
  options: TargetValidationOptions,
) {
  const scriptInventory = readPackageScriptInventory(targetDir);
  const availableScripts = [...scriptInventory.rootScripts].sort();
  const resolved: string[] = [];
  const resolvedEntries: StagedProofCommandInput[] = [];
  const validationEnv = targetValidationEnv();
  for (const command of resolvedRequiredValidationCommandEntries(
    fixArtifact.validation_commands ?? [],
    targetDir,
    baseBranch,
    options,
    validationEnv,
  )) {
    resolvedEntries.push(command);
    const rendered = (command.displayParts ?? command.parts).join(" ");
    if (!resolved.includes(rendered)) resolved.push(rendered);
  }

  if (resolved.length === 0) {
    return {
      status: "blocked",
      code: "validation_command_missing",
      available_scripts: availableScripts,
      resolved_commands: [],
      reason:
        "validation_command_missing: no configured or artifact validation command is available",
    };
  }

  const missing = missingRequiredPackageScript(resolvedEntries, scriptInventory);
  if (!missing) {
    return {
      status: "passed",
      resolved_commands: resolved,
      available_scripts: availableScripts,
    };
  }

  const sourcePr =
    (fixArtifact.source_prs ?? []).find(
      (source: JsonValue) => parsePullRequestUrl(source)?.repo === options.targetRepo,
    ) ?? null;
  return {
    status: "blocked",
    code: "validation_script_missing",
    required: missing.command,
    missing_script: missing.name,
    available_scripts: availableScripts,
    target_branch: fixArtifact.branch ?? fixArtifact.head_branch ?? null,
    source_pr: sourcePr,
    resolved_commands: resolved,
    reason: `validation_script_missing: required ${missing.command} is unavailable in target checkout`,
  };
}

export function requiredValidationCommands(
  commands: LooseRecord[] | undefined,
  cwd: string,
  options: TargetValidationOptions,
) {
  return uniqueStrings(
    requiredValidationCommandEntries(commands ?? [], cwd, options).map((entry) => entry.command),
  );
}

function requiredValidationCommandEntries(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
): RequiredValidationCommand[] {
  const toolchain = getToolchain(options);
  const additionalCommands = options.additionalValidationCommands ?? [];
  const replacementCommands = [...additionalCommands, ...toolchain.baseValidationCommands];
  const sanitized = sanitizeStaleChangedGateCommands(commands, toolchain, replacementCommands);
  const out: RequiredValidationCommand[] = [
    ...sanitized.map((command) => ({
      command,
      source: "artifact" as const,
      canonical: false,
      required: true,
    })),
    ...additionalCommands.map((command) => ({
      command,
      source: "configured" as const,
      canonical: false,
      required: true,
    })),
    ...toolchain.baseValidationCommands.map((command) => ({
      command,
      source: "repository_profile" as const,
      canonical: false,
      required: true,
    })),
  ];
  const gate = toolchain.changedGate;
  if (gate && !options.skipOpenClawChangedGate) {
    out.push({
      command: gate.command,
      source: "changed_gate",
      canonical: true,
      required: true,
    });
  }
  const unique = new Map<string, RequiredValidationCommand>();
  for (const entry of out) {
    const key = String(entry.command);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, entry);
      continue;
    }
    unique.set(key, {
      ...previous,
      source: entry.canonical ? entry.source : previous.source,
      canonical: previous.canonical || entry.canonical,
      required: previous.required || entry.required,
    });
  }
  return [...unique.values()];
}

/**
 * Drop validation commands that look like "some other repo's changed gate"
 * when the current target repo does not have one. This protects against stale
 * fixArtifacts (most notably deterministic automerge artifacts authored before
 * per-repo toolchain config landed) that ship `pnpm check:changed` even when
 * the target is bun-based and has no `check:changed` script. Without this
 * guard preflight terminates with `validation_script_missing` and the
 * executor never tries the project's real validation command.
 *
 * We are deliberately conservative: we only drop commands that match the
 * fingerprint of a known changed-gate command and only when the active
 * toolchain has no gate of its own. If no repository-specific replacement
 * exists, fall back to `git diff --check`; unrelated commands still pass
 * through so genuinely missing scripts remain visible.
 */
function sanitizeStaleChangedGateCommands(
  commands: readonly LooseRecord[],
  toolchain: TargetRepoToolchain,
  replacementCommands: readonly string[],
): LooseRecord[] {
  if (toolchain.changedGate) return [...commands];
  const filtered = commands.filter((command) => !looksLikeStaleChangedGateCommand(command));
  if (
    filtered.length === 0 &&
    commands.some((command) => looksLikeStaleChangedGateCommand(command)) &&
    replacementCommands.length === 0
  ) {
    return ["git diff --check"];
  }
  return filtered;
}

function looksLikeStaleChangedGateCommand(command: LooseRecord): boolean {
  const text = String(command ?? "").trim();
  if (!text) return false;
  // Matches the canonical openclaw/openclaw changed gate verbatim, with or
  // without a leading `env` wrapper. Kept narrow on purpose so we only
  // discard things we are confident are the stale gate.
  return /^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?pnpm\s+(?:-s\s+|--silent\s+)?(?:run\s+)?check:changed$/.test(
    text,
  );
}

export function repairDeltaValidationPlan(
  { fixArtifact, targetDir, sourceHead }: LooseRecord,
  options: TargetValidationOptions,
): RepairDeltaValidationPlan {
  const commands = fixArtifact.validation_commands ?? [];
  const changedSurface = {
    commands,
    options,
    scope: "changed-surface" as const,
    changed_files: [],
    reason: "validate the full changed surface against the target base branch",
  };
  if (options.targetRepo !== "openclaw/openclaw") return changedSurface;
  if (fixArtifact.repair_strategy !== "repair_contributor_branch") return changedSurface;
  const sourceRef = String(sourceHead ?? "");
  if (!/^[0-9a-f]{40}$/i.test(sourceRef)) return changedSurface;
  if (!isAncestor({ targetDir, ancestor: sourceRef, descendant: "HEAD" })) return changedSurface;

  const changedFiles = changedFilesSinceRef(targetDir, sourceRef);
  if (changedFiles.length === 0 || !changedFiles.every(isDocsOnlyRepairDeltaFile)) {
    return { ...changedSurface, changed_files: changedFiles };
  }

  return {
    commands: [`git diff --check ${sourceRef}..HEAD`],
    options: { ...options, skipOpenClawChangedGate: true },
    scope: "repair-delta-docs",
    changed_files: changedFiles,
    reason:
      "adopted PR repair changed only docs/changelog files since the source head; validate the repair delta and let PR checks gate the existing source diff",
  };
}

export function canSkipInternalCodexReviewForRepairDelta(plan: LooseRecord) {
  return String(plan?.scope ?? "") === "repair-delta-docs";
}

function restoreTargetLockfile(cwd: string, lockfile: string, timeoutMs: number) {
  if (!fs.existsSync(path.join(cwd, lockfile))) return;
  run("git", ["checkout", "--", lockfile], { cwd, timeoutMs });
}

function isChangedGateStall(error: JsonValue) {
  return /no output for \d+ms|terminating stalled Vitest|stalled Vitest process/i.test(
    String(error?.message ?? ""),
  );
}

function shouldRetryValidationCommand({
  parts,
  error,
  attempts,
  options,
  attemptKey,
}: LooseRecord) {
  if (options.strictTargetValidation) return false;
  if (!isChangedGateCommand(parts, options)) return false;
  if (isChangedGateStall(error)) return false;

  const configuredRetries = Number.parseInt(process.env.CLAWSWEEPER_VALIDATION_RETRIES ?? "1", 10);
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1;
  const rendered = String(attemptKey ?? parts.join(" "));
  const used = attempts.get(rendered) ?? 0;
  if (used >= maxRetries) return false;
  attempts.set(rendered, used + 1);
  return true;
}

export function targetValidationEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: process.env.CI ?? "true",
    OPENCLAW_LOCAL_CHECK: process.env.OPENCLAW_LOCAL_CHECK ?? "0",
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  delete env.CODEX_HOME;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_RUNTIME_TOKEN;
  delete env.ACTIONS_RUNTIME_URL;
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("OPENAI_") ||
      key.startsWith("CODEX_") ||
      key.startsWith("GITHUB_") ||
      key.startsWith("RUNNER_") ||
      key.startsWith("ACTIONS_") ||
      key.startsWith("CLAWSWEEPER_TARGET_VALIDATION_") ||
      key.startsWith("CLAWSWEEPER_ACTION_LEDGER_") ||
      key.startsWith("CLAWSWEEPER_CRABFLEET_") ||
      /^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY|GLOBAL_AGENT_(?:HTTP|HTTPS)_PROXY)$/i.test(key) ||
      /^npm_config_(?:proxy|https_proxy|noproxy)$/i.test(key) ||
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIALS?)$/i.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

export function targetValidationIsolationFromEnv(): TargetValidationIsolation | null {
  const requiredValue = process.env.CLAWSWEEPER_TARGET_VALIDATION_ISOLATION_REQUIRED ?? "";
  if (requiredValue && !["0", "1"].includes(requiredValue)) {
    throw new Error("invalid CLAWSWEEPER_TARGET_VALIDATION_ISOLATION_REQUIRED value");
  }
  const safeTestModeValue = process.env.CLAWSWEEPER_TARGET_VALIDATION_SAFE_TEST_MODE ?? "";
  if (safeTestModeValue && !["0", "1"].includes(safeTestModeValue)) {
    throw new Error("invalid CLAWSWEEPER_TARGET_VALIDATION_SAFE_TEST_MODE value");
  }
  const required = requiredValue === "1";
  const safeTestMode = safeTestModeValue === "1";
  const user = String(process.env.CLAWSWEEPER_TARGET_VALIDATION_USER ?? "").trim();
  const configuredHome = String(process.env.CLAWSWEEPER_TARGET_VALIDATION_HOME ?? "").trim();
  if (process.platform !== "linux") {
    if (!safeTestMode) {
      if (!required && !user && !configuredHome) return null;
      throw new Error("target validation user isolation is supported only on Linux");
    }
    if (process.platform !== "darwin") {
      throw new Error("safe target validation test mode is supported only on macOS");
    }
    if (required || user) {
      throw new Error("safe macOS target validation test mode cannot use Linux user isolation");
    }
    if (!configuredHome) {
      throw new Error("safe macOS target validation test mode requires an isolated home");
    }
    if (!path.isAbsolute(configuredHome)) {
      throw new Error("safe macOS target validation home must be absolute");
    }
    const home = fs.realpathSync(configuredHome);
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const hostHome = fs.realpathSync(os.homedir());
    if (
      !pathIsWithin(temporaryRoot, home) ||
      pathIsWithin(home, hostHome) ||
      pathIsWithin(hostHome, home)
    ) {
      throw new Error("safe macOS target validation home must be isolated temporary storage");
    }
    const homeStat = fs.lstatSync(configuredHome);
    if (
      !homeStat.isDirectory() ||
      homeStat.isSymbolicLink() ||
      (homeStat.mode & 0o077) !== 0 ||
      homeStat.uid !== process.getuid?.()
    ) {
      throw new Error("safe macOS target validation home must be private and runner-owned");
    }
    return {
      kind: "macos-sandbox",
      home,
      user: os.userInfo().username,
    };
  }
  if (safeTestMode) {
    // Unit tests exercise real toolchain commands. Keep that direct-run escape
    // unreachable outside a Node test worker and private temporary storage.
    if (required || user) {
      throw new Error(
        "safe Linux target validation test mode cannot use production user isolation",
      );
    }
    if (process.env.NODE_TEST_CONTEXT !== "child-v8") {
      throw new Error(
        "safe Linux target validation test mode is restricted to the Node test runner",
      );
    }
    if (!configuredHome) {
      throw new Error("safe Linux target validation test mode requires an isolated home");
    }
    if (!path.isAbsolute(configuredHome)) {
      throw new Error("safe Linux target validation home must be absolute");
    }
    const home = fs.realpathSync(configuredHome);
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const hostHome = fs.realpathSync(os.homedir());
    const homeStat = fs.lstatSync(configuredHome);
    if (
      !pathIsWithin(temporaryRoot, home) ||
      pathIsWithin(home, hostHome) ||
      pathIsWithin(hostHome, home) ||
      !homeStat.isDirectory() ||
      homeStat.isSymbolicLink() ||
      (homeStat.mode & 0o077) !== 0 ||
      homeStat.uid !== process.getuid?.()
    ) {
      throw new Error(
        "safe Linux target validation home must be private runner-owned temporary storage",
      );
    }
    return {
      kind: "linux-test",
      home,
      user: os.userInfo().username,
    };
  }
  if (!required && !user && !configuredHome) {
    throw new Error("Linux target validation requires explicit user isolation metadata");
  }
  if (!user || !configuredHome) {
    throw new Error("target validation isolation requires both a user and isolated home");
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
    throw new Error("invalid target validation isolation user");
  }
  if (!path.isAbsolute(configuredHome)) {
    throw new Error("target validation isolation home must be absolute");
  }

  const homeStat = fs.lstatSync(configuredHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (homeStat.mode & 0o077) !== 0) {
    throw new Error("target validation isolation home must be a private directory");
  }
  const home = fs.realpathSync(configuredHome);
  const uid = parseIsolationIdentity("uid", run("id", ["-u", user]));
  const gid = parseIsolationIdentity("gid", run("id", ["-g", user]));
  if (homeStat.uid !== uid) {
    throw new Error("target validation isolation home is not owned by the validation user");
  }
  const runnerGid = process.getgid?.();
  if (runnerGid === undefined || gid !== runnerGid) {
    throw new Error("target validation isolation user must share only the checkout group");
  }
  return { kind: "linux-user", gid, home, uid, user };
}

export function runTargetControlledCommand(
  command: string,
  commandArgs: string[],
  options: TargetControlledCommandOptions,
): string {
  const isolation = targetValidationIsolationFromEnv();
  if (!isolation) {
    throw new Error(
      "target-controlled commands require Linux user isolation or explicit safe test mode",
    );
  }
  if (isolation.kind === "linux-test") {
    return run(command, commandArgs, options);
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS;
  const cwd = fs.realpathSync(options.cwd);
  if (isolation.kind === "macos-sandbox") {
    if (pathIsWithin(cwd, isolation.home) || pathIsWithin(isolation.home, cwd)) {
      throw new Error("safe macOS target validation checkout and isolated home must be disjoint");
    }
    return runMacosSandboxedTargetCommand(command, commandArgs, {
      ...options,
      cwd,
      env: options.env ?? process.env,
      isolation,
      timeoutMs: remainingIsolationBudget(timeoutMs, startedAt),
    });
  }
  const root = targetValidationIsolationRoot(cwd);
  if (pathIsWithin(root, isolation.home) || pathIsWithin(isolation.home, root)) {
    throw new Error("target validation checkout and isolated home must be disjoint");
  }
  prepareTargetValidationAccess(root, isolation.gid, timeoutMs, startedAt);
  const envArgs = isolatedTargetValidationEnv(options.env ?? process.env, isolation).map(
    ([key, value]) => `${key}=${value}`,
  );
  const isolatedCommand = ["/usr/bin/env", "-i", ...envArgs, command, ...commandArgs];
  const sudoArgs = options.isolateNetwork
    ? [
        "-n",
        "unshare",
        "--net",
        "--",
        "/bin/bash",
        "-c",
        'set -euo pipefail; ip link set lo up; uid="$1"; gid="$2"; shift 2; exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"',
        "clawsweeper-target-validation",
        String(isolation.uid),
        String(isolation.gid),
        ...isolatedCommand,
      ]
    : [
        "-n",
        "-u",
        isolation.user,
        "-H",
        "--",
        "setpriv",
        "--no-new-privs",
        "--",
        ...isolatedCommand,
      ];
  return run("sudo", sudoArgs, {
    cwd,
    timeoutMs: remainingIsolationBudget(timeoutMs, startedAt),
  });
}

function runMacosSandboxedTargetCommand(
  command: string,
  commandArgs: string[],
  options: TargetControlledCommandOptions & {
    env: NodeJS.ProcessEnv;
    isolation: MacosTargetValidationIsolation;
    timeoutMs: number;
  },
) {
  if (!fs.existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("safe macOS target validation requires /usr/bin/sandbox-exec");
  }
  const env = Object.fromEntries(isolatedTargetValidationEnv(options.env, options.isolation));
  const invocation = resolveSpawnCommand(command, commandArgs, {
    cwd: options.cwd,
    env,
  });
  const profile = macosTargetValidationSandboxProfile({
    command: invocation.command,
    cwd: options.cwd,
    env,
    home: options.isolation.home,
  });
  try {
    return run("/usr/bin/sandbox-exec", ["-p", profile, invocation.command, ...invocation.args], {
      cwd: options.cwd,
      env,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (/^command timed out after \d+ms:/i.test(String((error as Error).message))) {
      throw new Error(
        `command timed out after ${options.timeoutMs}ms: ${[command, ...commandArgs].join(" ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function macosTargetValidationSandboxProfile({
  command,
  cwd,
  env,
  home,
}: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
}) {
  const readableRoots = macosTargetValidationReadableRoots({ command, cwd, env, home });
  const writableRoots = macosTargetValidationWritableRoots({ command, cwd, env, home });
  const readRules = readableRoots.map((root) => `(subpath ${JSON.stringify(root)})`).join(" ");
  const writeRules = writableRoots.map((root) => `(subpath ${JSON.stringify(root)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    "(allow file-read-metadata)",
    `(allow file-read* ${readRules})`,
    `(allow file-write* ${writeRules})`,
    "(deny network*)",
  ].join("\n");
}

function macosTargetValidationReadableRoots({
  command,
  cwd,
  env,
  home,
}: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
}) {
  return uniqueExistingRealPaths([
    "/Applications",
    "/Library",
    "/System",
    "/bin",
    "/dev",
    "/opt/homebrew",
    "/private/etc",
    "/sbin",
    "/usr",
    cwd,
    home,
    ...macosTargetValidationGitObjectRoots(cwd),
    ...targetValidationToolRoots(command, env),
  ]);
}

function macosTargetValidationWritableRoots({
  command,
  cwd,
  env,
  home,
}: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  return uniqueExistingRealPaths([
    cwd,
    home,
    ...targetValidationToolRoots(command, env).filter((root) => pathIsWithin(temporaryRoot, root)),
  ]);
}

function targetValidationToolRoots(command: string, env: NodeJS.ProcessEnv) {
  const roots = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  if (path.isAbsolute(command)) roots.push(path.dirname(command));
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith("_BIN") && value && path.isAbsolute(value)) {
      roots.push(path.dirname(value));
      continue;
    }
    if (!key.endsWith("_BIN_ARGS") || !value || !env[key.slice(0, -5)]) continue;
    try {
      const args = JSON.parse(value);
      if (!Array.isArray(args)) continue;
      for (const arg of args) {
        if (typeof arg !== "string" || !path.isAbsolute(arg)) continue;
        try {
          roots.push(fs.statSync(arg).isDirectory() ? arg : path.dirname(arg));
        } catch {
          // Missing override inputs fail when the command is launched.
        }
      }
    } catch {
      // Invalid override JSON fails in command resolution.
    }
  }
  const resolved = uniqueExistingRealPaths(roots);
  const hostHome = fs.realpathSync(os.homedir());
  if (resolved.some((root) => pathIsWithin(root, hostHome) || pathIsWithin(hostHome, root))) {
    throw new Error("safe macOS target validation tool roots must not expose the host home");
  }
  return resolved;
}

function macosTargetValidationGitObjectRoots(cwd: string) {
  const gitDir = path.join(cwd, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(gitDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
  const objectsDir = path.join(gitDir, "objects");
  const alternatesPath = path.join(objectsDir, "info", "alternates");
  let alternates: string;
  try {
    alternates = fs.readFileSync(alternatesPath, "utf8");
  } catch {
    return [];
  }
  return uniqueStrings(
    alternates
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) =>
        validatedMacosTemporaryReadRoot(
          path.isAbsolute(entry) ? entry : path.resolve(objectsDir, entry),
        ),
      ),
  );
}

function validatedMacosTemporaryReadRoot(candidate: string) {
  const resolved = fs.realpathSync(candidate);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const hostHome = fs.realpathSync(os.homedir());
  const stat = fs.lstatSync(resolved);
  if (
    resolved === temporaryRoot ||
    !pathIsWithin(temporaryRoot, resolved) ||
    pathIsWithin(resolved, hostHome) ||
    pathIsWithin(hostHome, resolved) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  ) {
    throw new Error("safe macOS target validation Git objects must be runner-owned temporary data");
  }
  return resolved;
}

function uniqueExistingRealPaths(values: string[]) {
  return [
    ...new Set(
      values.flatMap((value) => {
        try {
          return [fs.realpathSync(value)];
        } catch {
          return [];
        }
      }),
    ),
  ].sort();
}

function parseIsolationIdentity(label: string, value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid target validation isolation ${label}`);
  }
  return parsed;
}

function targetValidationIsolationRoot(cwd: string) {
  let candidate = cwd;
  while (true) {
    if (
      TARGET_VALIDATION_ROOT_PREFIXES.some((prefix) => path.basename(candidate).startsWith(prefix))
    ) {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("target validation isolation root must be a real directory");
      }
      const runnerUid = process.getuid?.();
      if (
        runnerUid === undefined ||
        stat.uid !== runnerUid ||
        !pathIsWithin(fs.realpathSync(os.tmpdir()), candidate)
      ) {
        throw new Error("target validation isolation root must be runner-owned temporary storage");
      }
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("target validation isolation requires a trusted disposable checkout root");
}

function prepareTargetValidationAccess(
  root: string,
  gid: number,
  timeoutMs: number,
  startedAt: number,
) {
  run("sudo", ["-n", "chgrp", "-R", "--no-dereference", "--", String(gid), root], {
    timeoutMs: remainingIsolationBudget(timeoutMs, startedAt),
  });
  run("sudo", ["-n", "chmod", "-R", "g+rwX", "--", root], {
    timeoutMs: remainingIsolationBudget(timeoutMs, startedAt),
  });
}

function isolatedTargetValidationEnv(
  source: NodeJS.ProcessEnv,
  isolation: TargetValidationIsolation,
): [string, string][] {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "HOME" ||
      normalized === "LOGNAME" ||
      normalized === "SUDO_COMMAND" ||
      normalized === "SUDO_GID" ||
      normalized === "SUDO_UID" ||
      normalized === "SUDO_USER" ||
      normalized === "TMPDIR" ||
      normalized === "USER" ||
      normalized === "NPM_CONFIG_CACHE" ||
      normalized === "NPM_CONFIG_USERCONFIG" ||
      normalized === "PNPM_STORE_PATH" ||
      normalized.startsWith("XDG_") ||
      /^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY|GLOBAL_AGENT_(?:HTTP|HTTPS)_PROXY)$/.test(normalized) ||
      /^NPM_CONFIG_(?:PROXY|HTTPS_PROXY|NOPROXY|STORE_DIR)$/.test(normalized)
    ) {
      delete env[key];
    }
  }
  env.HOME = isolation.home;
  env.USER = isolation.user;
  env.LOGNAME = isolation.user;
  env.TMPDIR = path.join(isolation.home, "tmp");
  env.XDG_CACHE_HOME = path.join(isolation.home, ".cache");
  env.XDG_CONFIG_HOME = path.join(isolation.home, ".config");
  env.XDG_DATA_HOME = path.join(isolation.home, ".local", "share");
  env.COREPACK_HOME = path.join(isolation.home, ".cache", "node", "corepack");
  env.PNPM_HOME = path.join(isolation.home, ".local", "share", "pnpm");
  env.npm_config_cache = path.join(isolation.home, ".cache", "npm");
  env.npm_config_userconfig = path.join(isolation.home, ".npmrc");
  env.npm_config_manage_package_manager_versions = "false";
  env.npm_config_pm_on_fail = "ignore";
  env.npm_config_verify_deps_before_run = "false";
  env.PATH = isolatedTargetValidationPath(source.PATH, isolation.home);
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
}

function isolatedTargetValidationPath(sourcePath: string | undefined, isolatedHome: string) {
  const hostHome = fs.realpathSync(os.homedir());
  const entries = [
    path.join(isolatedHome, ".local", "bin"),
    ...(sourcePath ?? "").split(path.delimiter),
  ];
  return uniqueStrings(
    entries.filter((entry) => {
      if (!entry || !path.isAbsolute(entry)) return false;
      if (pathIsWithin(hostHome, entry) || pathIsWithin(entry, hostHome)) return false;
      try {
        const resolved = fs.realpathSync(entry);
        return !pathIsWithin(hostHome, resolved) && !pathIsWithin(resolved, hostHome);
      } catch {
        return pathIsWithin(isolatedHome, entry);
      }
    }),
  ).join(path.delimiter);
}

function remainingIsolationBudget(timeoutMs: number, startedAt: number) {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new Error("target validation isolation setup exhausted the command runtime budget");
  }
  return remaining;
}

function pathIsWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function targetValidationTimeoutMs(name: string, fallback: number, cap?: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return cap ? Math.min(timeout, cap) : timeout;
}

function resolveAllowedValidationCommands(
  command: LooseRecord,
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options: TargetValidationOptions,
) {
  const parts = parseAllowedValidationCommand(command);
  const commandParts = stripEnvPrefix(parts);
  const envPrefix = parts[0] === "env" ? parts.slice(0, parts.length - commandParts.length) : [];
  const toolchain = getToolchain(options);
  if (toolchain.packageManager === "pnpm" && commandParts[0] === "pnpm") {
    const commandStart = commandParts[1] === "-s" || commandParts[1] === "--silent" ? 2 : 1;
    const pnpmScript = commandParts[commandStart];
    const vitestArgsStart =
      pnpmScript === "vitest" && commandParts[commandStart + 1] === "run"
        ? commandStart + 2
        : pnpmScript === "exec" &&
            commandParts[commandStart + 1] === "vitest" &&
            commandParts[commandStart + 2] === "run"
          ? commandStart + 3
          : -1;
    if (vitestArgsStart >= 0) {
      const vitestArgs = commandParts.slice(vitestArgsStart);
      const pathIndexes = vitestPathFilterIndexes(vitestArgs);
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", "exec", "vitest", "run", ...vitestArgs],
          cwd,
          baseBranch,
          4,
          new Set(pathIndexes),
          options,
        ),
      );
    }
    if (pnpmScript === "test" || pnpmScript === "test:serial") {
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", pnpmScript, ...commandParts.slice(commandStart + 1)],
          cwd,
          baseBranch,
          2,
          undefined,
          options,
        ),
      );
    }
  }
  return [parts];
}

function withEnvPrefix(envPrefix: string[], commands: string[][]) {
  if (envPrefix.length === 0) return commands;
  return commands.map((command) => [...envPrefix, ...command]);
}

function normalizePathValidationCommand(
  parts: string[],
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  pathArgStart: number = 2,
  testPathIndexes?: ReadonlySet<number>,
  options?: TargetValidationOptions,
) {
  const args = parts.slice(pathArgStart);
  const shouldNormalize = (arg: string, index: number) =>
    testPathIndexes ? testPathIndexes.has(index) : looksLikePathArgument(arg);
  if (!args.some(shouldNormalize)) return [parts];

  const normalizedArgs: string[] = [];
  const missing: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (!shouldNormalize(arg, index)) {
      normalizedArgs.push(arg);
      continue;
    }
    const mapped = resolveRepoPathArgument(arg, cwd);
    if (mapped) normalizedArgs.push(mapped);
    else missing.push(arg);
  }

  if (missing.length === 0) {
    return [[...parts.slice(0, pathArgStart), ...normalizedArgs]];
  }

  const changedTests = changedTestFiles(cwd, baseBranch, options);
  if (changedTests.length > 0) {
    return [[...parts.slice(0, pathArgStart), ...normalizedArgs, ...changedTests]];
  }

  return [["pnpm", "check:changed"]];
}

function resolveRepoPathArgument(arg: JsonValue, cwd: string): string {
  const clean = String(arg ?? "").trim();
  if (!clean || clean.startsWith("-")) return clean;
  if (fs.existsSync(path.join(cwd, clean))) return clean;

  const candidates = candidateRepoPaths(clean, cwd).filter((candidate) =>
    fs.existsSync(path.join(cwd, candidate)),
  );
  return candidates[0] ?? "";
}

function candidateRepoPaths(filePath: string, cwd: string): string[] {
  const out: string[] = [];
  if (filePath.startsWith("src/web/")) {
    out.push(`extensions/whatsapp/src/${filePath.slice("src/web/".length)}`);
  }
  const basename = path.basename(filePath);
  if (basename) {
    const files = gitLsFiles(cwd);
    out.push(...files.filter((file) => path.basename(file) === basename));
  }
  return uniqueStrings(out);
}

function changedTestFiles(
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options?: TargetValidationOptions,
) {
  const changedFiles = options?.pinnedBaseRef
    ? gitChangedFilesFromRef(cwd, validationBaseRef(cwd, baseBranch, options))
    : gitChangedFiles(cwd, baseBranch);
  return changedFiles.filter((file) => isTestFile(file) && fs.existsSync(path.join(cwd, file)));
}

function validationBaseRef(cwd: string, baseBranch: string, options: TargetValidationOptions) {
  if (!options.pinnedBaseRef) {
    ensureMergeBaseAvailable({ targetDir: cwd, baseBranch });
    return `origin/${baseBranch}`;
  }
  run("git", ["merge-base", options.pinnedBaseRef, "HEAD"], { cwd });
  return options.pinnedBaseRef;
}

function gitChangedFilesFromRef(cwd: string, baseRef: string) {
  const committed = run("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.replace(/\r$/, "").slice(3))
    .map((line) => line.split(" -> ").pop())
    .filter((line): line is string => Boolean(line));
  return uniqueStrings([...committed, ...uncommitted]);
}

function referencedTrackedPaths(
  message: string,
  { targetDir, trackedAtBase }: { targetDir: string; trackedAtBase: ReadonlySet<string> },
) {
  const normalized = message.split(`${path.resolve(targetDir)}${path.sep}`).join("");
  const candidates = normalized.match(/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  const paths: string[] = [];
  for (const rawCandidate of uniqueStrings(candidates)) {
    const candidate = rawCandidate.replace(/^\.\//, "");
    if (trackedAtBase.has(candidate)) {
      paths.push(candidate);
      continue;
    }
    for (const trackedPath of trackedAtBase) {
      if (candidate.endsWith(`/${trackedPath}`)) paths.push(trackedPath);
    }
  }
  return uniqueStrings(paths);
}

function normalizedValidationFailure(message: string, trackedAtBase: ReadonlySet<string>) {
  const ansiCsi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  let normalized = message.replace(ansiCsi, "").replace(/\r\n/g, "\n");
  const candidates = normalized.match(/\/?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  for (const candidate of uniqueStrings(candidates).sort(
    (left, right) => right.length - left.length,
  )) {
    const withoutLeadingSlash = candidate.replace(/^\//, "");
    const trackedPath = trackedAtBase.has(withoutLeadingSlash)
      ? withoutLeadingSlash
      : [...trackedAtBase].find((tracked) => withoutLeadingSlash.endsWith(`/${tracked}`));
    if (trackedPath) normalized = normalized.split(candidate).join(trackedPath);
  }
  return normalized.trim();
}

function splitGitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

type PackageScriptInventory = {
  rootScripts: Set<string>;
  rootPackage: {
    name: string;
    relativePath: ".";
    scripts: Set<string>;
  };
  workspaces: Array<{
    name: string;
    relativePath: string;
    scripts: Set<string>;
  }>;
};

function readPackageScriptInventory(cwd: string): PackageScriptInventory {
  const packagePath = path.join(cwd, "package.json");
  const empty = {
    rootScripts: new Set<string>(),
    rootPackage: { name: "", relativePath: "." as const, scripts: new Set<string>() },
    workspaces: [],
  };
  if (!fs.existsSync(packagePath)) return empty;
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const rootScripts = new Set<string>(Object.keys(pkg.scripts ?? {}));
    const patterns = workspacePackagePatterns(cwd, pkg);
    const workspaces = workspacePackagePaths(cwd, patterns).flatMap((relativePath) => {
      try {
        const workspace = JSON.parse(
          fs.readFileSync(path.join(cwd, relativePath, "package.json"), "utf8"),
        );
        return [
          {
            name: String(workspace.name ?? ""),
            relativePath,
            scripts: new Set<string>(Object.keys(workspace.scripts ?? {})),
          },
        ];
      } catch {
        return [];
      }
    });
    return {
      rootScripts,
      rootPackage: {
        name: String(pkg.name ?? ""),
        relativePath: ".",
        scripts: rootScripts,
      },
      workspaces,
    };
  } catch {
    return empty;
  }
}

function getToolchain(options: TargetValidationOptions): TargetRepoToolchain {
  return options.toolchain ?? resolveTargetRepoToolchain(options.targetRepo);
}

function missingRequiredPackageScript(
  commands: readonly { parts: readonly string[] }[],
  inventory: PackageScriptInventory,
) {
  for (const command of commands) {
    const script = packageScriptRequirement(command.parts);
    if (!script) continue;
    if (!script.workspaceScoped) {
      if (!inventory.rootScripts.has(script.name)) return script;
      continue;
    }
    const selected = selectWorkspacePackages(script, inventory);
    if (selected === null) continue;
    if (
      selected.length === 0 ||
      (script.executable === "pnpm" && script.allWorkspaces
        ? !selected.some((workspace) => workspace.scripts.has(script.name))
        : selected.some((workspace) => !workspace.scripts.has(script.name)))
    ) {
      return script;
    }
  }
  return null;
}

function workspacePackagePatterns(cwd: string, rootPackage: LooseRecord): string[] {
  const packageWorkspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];
  const pnpmWorkspacePath = path.join(cwd, "pnpm-workspace.yaml");
  let pnpmPackages: unknown[] = [];
  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(pnpmWorkspacePath, "utf8"));
      pnpmPackages = Array.isArray(parsed?.packages) ? parsed.packages : [];
    } catch {
      pnpmPackages = [];
    }
  }
  return uniqueStrings([...packageWorkspaces, ...pnpmPackages])
    .map((pattern) =>
      pattern
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, ""),
    )
    .filter(Boolean);
}

const MAX_WORKSPACE_PATTERN_LENGTH = 1_024;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const MAX_WORKSPACE_PATTERNS = 256;
const MAX_WORKSPACE_PATTERN_OPERATORS = 128;

export type WorkspaceScanLimits = {
  maxDirectories: number;
  maxDepth: number;
  maxEntries: number;
  maxMatchOperations: number;
};

const DEFAULT_WORKSPACE_SCAN_LIMITS: WorkspaceScanLimits = {
  maxDirectories: 10_000,
  maxDepth: 64,
  maxEntries: 100_000,
  maxMatchOperations: 100_000,
};

export function workspacePackagePaths(
  cwd: string,
  patterns: readonly string[],
  overrides: Partial<WorkspaceScanLimits> = {},
): string[] {
  if (patterns.length === 0) return [];
  if (patterns.length > MAX_WORKSPACE_PATTERNS) {
    throw new Error("workspace pattern count exceeds the supported budget");
  }
  const limits = workspaceScanLimits(overrides);
  const includedPatterns = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map(validateWorkspacePattern);
  const excludedPatterns = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => validateWorkspacePattern(pattern.slice(1)));
  if (includedPatterns.length === 0) return [];

  const matches: string[] = [];
  const pending = [{ directory: cwd, relativeDirectory: "", depth: 0 }];
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let matchOperations = 0;
  const matchesPattern = (relativePath: string, candidates: readonly string[]) =>
    candidates.some((pattern) => {
      matchOperations += 1;
      if (matchOperations > limits.maxMatchOperations) {
        throw new Error("workspace glob evaluation exceeded the supported work budget");
      }
      return workspacePatternMatches(pattern, relativePath);
    });

  while (pending.length > 0) {
    const { directory, relativeDirectory, depth } = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      visitedEntries += 1;
      if (visitedEntries > limits.maxEntries) {
        throw new Error("workspace discovery exceeded the supported entry budget");
      }
      if (
        !entry.isDirectory() ||
        [".git", ".hg", ".svn", ".venv", "node_modules", "venv"].includes(entry.name)
      ) {
        continue;
      }
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      validateWorkspacePath(relativePath);
      const childDepth = depth + 1;
      if (childDepth > limits.maxDepth) {
        throw new Error("workspace discovery exceeded the supported depth budget");
      }
      visitedDirectories += 1;
      if (visitedDirectories > limits.maxDirectories) {
        throw new Error("workspace discovery exceeded the supported directory budget");
      }
      const absolutePath = path.join(directory, entry.name);
      if (
        fs.existsSync(path.join(absolutePath, "package.json")) &&
        matchesPattern(relativePath, includedPatterns) &&
        !matchesPattern(relativePath, excludedPatterns)
      ) {
        matches.push(relativePath);
      }
      pending.push({
        directory: absolutePath,
        relativeDirectory: relativePath,
        depth: childDepth,
      });
    }
  }
  return [...new Set(matches)].sort();
}

export function workspacePatternMatches(pattern: string, relativePath: string): boolean {
  const boundedPattern = validateWorkspacePattern(pattern);
  validateWorkspacePath(relativePath);
  try {
    return path.posix.matchesGlob(relativePath, boundedPattern);
  } catch {
    throw new Error("workspace pattern is not a valid supported glob");
  }
}

function validateWorkspacePattern(pattern: string): string {
  if (!pattern || pattern.length > MAX_WORKSPACE_PATTERN_LENGTH) {
    throw new Error("workspace pattern exceeds the maximum supported length");
  }
  if (pattern.includes("\0")) {
    throw new Error("workspace pattern contains a null byte");
  }
  const operators = [...pattern].filter((character) => "*?[]{}(),".includes(character)).length;
  if (operators > MAX_WORKSPACE_PATTERN_OPERATORS) {
    throw new Error("workspace pattern exceeds the supported operator budget");
  }
  return pattern;
}

function validateWorkspacePath(relativePath: string) {
  if (relativePath.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new Error("workspace path exceeds the maximum supported length");
  }
}

function workspaceScanLimits(overrides: Partial<WorkspaceScanLimits>): WorkspaceScanLimits {
  const limits = { ...DEFAULT_WORKSPACE_SCAN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`workspace ${name} must be a positive integer`);
    }
  }
  return limits;
}

function selectWorkspacePackages(
  script: NonNullable<ReturnType<typeof packageScriptRequirement>>,
  inventory: PackageScriptInventory,
): PackageScriptInventory["workspaces"] | null {
  if (
    script.executable === "pnpm" &&
    script.workspaceSelectors.some((selector) => !locallyEvaluablePnpmSelector(selector))
  ) {
    return null;
  }
  if (script.workspaceSelectors.length === 0) {
    return script.allWorkspaces ? inventory.workspaces : [];
  }
  return [inventory.rootPackage, ...inventory.workspaces].filter((workspace) =>
    script.workspaceSelectors.some((selector) => workspaceSelectorMatches(selector, workspace)),
  );
}

function locallyEvaluablePnpmSelector(selector: string) {
  return (
    !["!", "[", "]", "{", "}", "^"].some((operator) => selector.includes(operator)) &&
    !selector.includes("...")
  );
}

function workspaceSelectorMatches(
  selector: string,
  workspace: PackageScriptInventory["workspaces"][number],
) {
  const normalized = selector.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (normalized === workspace.name || normalized === workspace.relativePath) return true;
  if (!normalized.includes("*")) return false;
  return (
    workspacePatternMatches(normalized, workspace.name) ||
    workspacePatternMatches(normalized, workspace.relativePath)
  );
}

function proofSubsumptionContracts(
  toolchain: TargetRepoToolchain,
  validationEnv: NodeJS.ProcessEnv,
): StagedProofSubsumptionContract[] {
  const out: StagedProofSubsumptionContract[] = [];
  for (const contract of toolchain.proofSubsumptions ?? []) {
    try {
      const command = parseAllowedValidationCommand(contract.command);
      out.push({
        command: validateAllowedValidationCommandParts(
          resolveValidationCommandEnvironment(command, validationEnv),
          contract.command,
        ),
        subsumes: contract.subsumes.map((subsumedCommand) => {
          const parsed = parseAllowedValidationCommand(subsumedCommand);
          return validateAllowedValidationCommandParts(
            resolveValidationCommandEnvironment(parsed, validationEnv),
            subsumedCommand,
          );
        }),
      });
    } catch {
      // Invalid repository metadata cannot weaken or block proof; ignore the contract.
    }
  }
  return out;
}

function resolvedRequiredValidationCommandEntries(
  commands: LooseRecord[],
  cwd: string,
  baseBranch: string,
  options: TargetValidationOptions,
  validationEnv: NodeJS.ProcessEnv,
): StagedProofCommandInput[] {
  const toolchain = getToolchain(options);
  return requiredValidationCommandEntries(commands, cwd, options).flatMap(
    (command, originalIndex) =>
      resolveAllowedValidationCommands(command.command, cwd, baseBranch, options).map((parts) => {
        const displayParts = requireWorkspaceMatchFailure(parts);
        const concreteParts = requireWorkspaceMatchFailure(
          validateAllowedValidationCommandParts(
            resolveValidationCommandEnvironment(parts, validationEnv),
            command.command,
          ),
        );
        const canonical =
          command.canonical ||
          changedGateCommandParts(toolchain.changedGate, concreteParts) !== null;
        return {
          parts: concreteParts,
          displayParts,
          source:
            canonical && command.source === "artifact" ? ("changed_gate" as const) : command.source,
          canonical,
          required: command.required,
          originalIndex,
        };
      }),
  );
}

function isChangedGateCommand(parts: readonly string[], options: TargetValidationOptions) {
  return changedGateCommandParts(getToolchain(options).changedGate, parts) !== null;
}

function changedGateCommandParts(
  gate: TargetChangedGate | null,
  parts: readonly string[],
): readonly string[] | null {
  if (!gate) return null;
  const gateParts = gate.command.split(/\s+/).filter(Boolean);
  if (gateParts.length !== parts.length) return null;
  for (let i = 0; i < gateParts.length; i += 1) {
    if (gateParts[i] !== parts[i]) return null;
  }
  return gateParts;
}

function changedFilesSinceRef(cwd: string, sourceRef: string) {
  const committed = run("git", ["diff", "--name-only", `${sourceRef}..HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^.. /, ""))
    .map((line) => line.split(" -> ").pop())
    .filter(Boolean);
  return uniqueStrings([...committed, ...uncommitted]);
}

function isDocsOnlyRepairDeltaFile(filePath: string) {
  const file = String(filePath ?? "").trim();
  if (!file) return false;
  if (file === "CHANGELOG.md") return true;
  if (file.startsWith("docs/")) return true;
  if (/^(?:README|CONTRIBUTING|SECURITY|SUPPORT|CODE_OF_CONDUCT)\.md$/i.test(file)) return true;
  return /\.(?:md|mdx|txt)$/i.test(file);
}
