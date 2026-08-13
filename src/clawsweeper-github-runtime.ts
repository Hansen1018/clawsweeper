import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubRuntimeBudget } from "./clawsweeper-types.js";
import { codexEnv } from "./codex-env.js";
import { resolveCommand } from "./command.js";
import {
  exactPublicationPublicReadToken,
  isPublicOpenClawReadOnlyRequest,
} from "./github-public-read.js";
import { GitHubRateLimitError, ghRetryKind, type GitHubCredentialScope } from "./github-retry.js";

interface CreateGitHubRuntimeDependencies {
  ROOT: string;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number | undefined },
  ) => string;
  targetRepo: () => string;
}

const claimedPublicReadFallbackTokens = new Set<string>();
const RATE_LIMIT_LOOKUP_TIMEOUT_MS = 20_000;

export function createGitHubRuntime(dependencies: CreateGitHubRuntimeDependencies) {
  const { ROOT, run, targetRepo } = dependencies;
  const inspectedRateLimitScopes = new Set<GitHubCredentialScope>();

  const GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS = 1_000;

  class GitHubRuntimeBudgetError extends Error {
    constructor(readonly reason: string) {
      super(reason);
      this.name = "GitHubRuntimeBudgetError";
    }
  }

  let activeGitHubRuntimeBudget: GitHubRuntimeBudget | null = null;

  function withGitHubRuntimeBudget<T>(runtimeBudget: GitHubRuntimeBudget, operation: () => T): T {
    const previousRuntimeBudget = activeGitHubRuntimeBudget;
    activeGitHubRuntimeBudget = runtimeBudget;
    try {
      return operation();
    } finally {
      activeGitHubRuntimeBudget = previousRuntimeBudget;
    }
  }

  function githubRuntimeRemainingMs(nowMs = Date.now()): number | null {
    const budget = activeGitHubRuntimeBudget;
    if (!budget || budget.maxRuntimeMs <= 0) return null;
    return (
      budget.maxRuntimeMs - (nowMs - budget.startedAtMs) - GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS
    );
  }

  function githubRuntimeBudgetError(phase: string): GitHubRuntimeBudgetError {
    const budget = activeGitHubRuntimeBudget;
    const reason =
      budget?.yieldReason ??
      budget?.limitReason ??
      `max runtime ${budget?.maxRuntimeMs ?? 0}ms reached ${phase}`;
    if (budget) budget.yieldReason = reason;
    return new GitHubRuntimeBudgetError(reason);
  }

  function pendingGitHubRuntimeBudgetError(): GitHubRuntimeBudgetError | null {
    const reason = activeGitHubRuntimeBudget?.yieldReason;
    return reason ? new GitHubRuntimeBudgetError(reason) : null;
  }

  function githubCommandTimeoutMs(requestedTimeoutMs?: number): number | undefined {
    const pendingError = pendingGitHubRuntimeBudgetError();
    if (pendingError) throw pendingError;
    const remainingMs = githubRuntimeRemainingMs();
    if (remainingMs === null) return requestedTimeoutMs;
    if (remainingMs <= 0) throw githubRuntimeBudgetError("before GitHub operation");
    return Math.max(
      1,
      requestedTimeoutMs === undefined ? remainingMs : Math.min(requestedTimeoutMs, remainingMs),
    );
  }

  function ensureGitHubRuntimeAvailable(phase: string): void {
    const pendingError = pendingGitHubRuntimeBudgetError();
    if (pendingError) throw pendingError;
    const remainingMs = githubRuntimeRemainingMs();
    if (remainingMs !== null && remainingMs <= 0) throw githubRuntimeBudgetError(phase);
  }

  function ensureRuntimeDelayFits(waitMs: number, phase: string): void {
    const pendingError = pendingGitHubRuntimeBudgetError();
    if (pendingError) throw pendingError;
    const remainingMs = githubRuntimeRemainingMs();
    if (remainingMs !== null && remainingMs <= waitMs) {
      throw githubRuntimeBudgetError(phase);
    }
  }

  function ensureGitHubRetryFits(waitMs: number): void {
    ensureRuntimeDelayFits(waitMs, "before GitHub retry");
  }

  function sleepBeforeGitHubRetry(waitMs: number): void {
    ensureGitHubRetryFits(waitMs);
    sleepMs(waitMs);
  }

  function publicReadToken(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): string | null {
    const publicToken = process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN?.trim();
    const env = { ...process.env, ...overrides };
    if (
      !publicToken ||
      Object.hasOwn(overrides, "GH_TOKEN") ||
      Object.hasOwn(overrides, "GITHUB_TOKEN") ||
      (env.GH_HOST && env.GH_HOST.toLowerCase() !== "github.com") ||
      !isPublicOpenClawReadOnlyRequest(args)
    ) {
      return null;
    }
    return publicToken;
  }

  function preparedGitHubEnv(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv | undefined {
    const hasExplicitToken =
      Object.hasOwn(overrides, "GH_TOKEN") || Object.hasOwn(overrides, "GITHUB_TOKEN");
    const token =
      publicReadToken(args, overrides) ??
      (hasExplicitToken
        ? null
        : exactPublicationPublicReadToken(args, targetRepo(), {
            ...process.env,
            ...overrides,
          }));
    const selected = token ? { ...overrides, GH_TOKEN: token } : overrides;
    const telemetryEnv = githubEgressEnvironment(
      args,
      selected,
      token ? "public_read_fallback" : undefined,
    );
    if (token) return { ...selected, ...telemetryEnv };
    return Object.keys(selected).length > 0 || telemetryEnv
      ? { ...selected, ...telemetryEnv }
      : undefined;
  }

  function githubEgressEnvironment(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
    selectedPoolClass?: "public_read_fallback",
  ): NodeJS.ProcessEnv | undefined {
    if (!process.env.CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH?.trim()) return undefined;
    const scope = githubRequestScope(args, overrides);
    return {
      CLAWSWEEPER_GITHUB_POOL_CLASS:
        selectedPoolClass ?? (scope === "repository_actions" ? "repository_actions" : "target_app"),
      CLAWSWEEPER_GITHUB_STAGE:
        process.env.CLAWSWEEPER_GITHUB_STAGE ||
        (process.env.EXACT_EVENT_PUBLICATION === "true"
          ? "publication_apply"
          : "publication_recovery"),
      CLAWSWEEPER_GITHUB_SOURCE_ACTION: process.env.CLAWSWEEPER_GITHUB_SOURCE_ACTION || "",
      CLAWSWEEPER_GITHUB_CLAIM_GENERATION:
        process.env.CLAWSWEEPER_GITHUB_CLAIM_GENERATION ||
        process.env.EXACT_REVIEW_BATCH_CLAIM_GENERATION ||
        process.env.EXACT_REVIEW_CLAIM_GENERATION ||
        "",
      CLAWSWEEPER_GITHUB_REQUEST_REPEAT: process.env.CLAWSWEEPER_GITHUB_REQUEST_REPEAT || "",
    };
  }

  function githubRequestScope(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): GitHubCredentialScope {
    const publicToken =
      publicReadToken(args, overrides) ??
      exactPublicationPublicReadToken(args, targetRepo(), {
        ...process.env,
        ...overrides,
      });
    const selectedToken =
      overrides.GH_TOKEN?.trim() ||
      overrides.GITHUB_TOKEN?.trim() ||
      publicToken ||
      process.env.GH_TOKEN?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      "";
    const repositoryTokens = [
      process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN?.trim(),
      process.env.REPO_TOKEN?.trim(),
      process.env.GITHUB_TOKEN?.trim(),
    ].filter((token): token is string => Boolean(token));
    return repositoryTokens.includes(selectedToken) ? "repository_actions" : "target_app";
  }

  function rateLimitObservationPath(): string | null {
    return process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH?.trim() || null;
  }

  function githubRequestMetricsPath(): string | null {
    return process.env.CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH?.trim() || null;
  }

  function repositoryPoolCoordinatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const effective = env === process.env ? env : { ...process.env, ...env };
    return ["1", "true"].includes(
      String(effective.CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED || "").toLowerCase(),
    );
  }

  function coordinatedRepositoryPoolEnv(
    scope: GitHubCredentialScope,
    preparedEnv: NodeJS.ProcessEnv | undefined,
  ): NodeJS.ProcessEnv | undefined {
    const env = { ...process.env, ...preparedEnv };
    if (scope !== "repository_actions" || !repositoryPoolCoordinatorEnabled(env)) {
      return preparedEnv;
    }
    return {
      ...preparedEnv,
      CLAWSWEEPER_GITHUB_COORDINATOR_POOL_CLASS: "repository_actions",
    };
  }

  function coordinatedRepositoryPoolCommand(
    args: readonly string[],
    scope: GitHubCredentialScope,
    preparedEnv: NodeJS.ProcessEnv | undefined,
  ): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
    coordinated: boolean;
    outcomePath: string | null;
    cleanup: () => void;
  } {
    const env = coordinatedRepositoryPoolEnv(scope, preparedEnv);
    const coordinated = env?.CLAWSWEEPER_GITHUB_COORDINATOR_POOL_CLASS === "repository_actions";
    if (!coordinated) {
      return {
        command: "gh",
        args: [...args],
        env,
        coordinated,
        outcomePath: null,
        cleanup: () => {},
      };
    }
    let root: string;
    try {
      root = mkdtempSync(join(tmpdir(), "clawsweeper-github-runtime-coordinator-"));
    } catch (error) {
      // Without an invocation-private outcome, the parent cannot distinguish a
      // header-classified throttle from an ordinary 403. Fail before egress so
      // durable publication accounting remains unattempted.
      throw repositoryPoolDeferredError(error);
    }
    const outcomePath = join(root, "outcome.json");
    return {
      command: process.execPath,
      args: [join(ROOT, "dist/repair/github-egress-pool-runner.js"), "--", "gh", ...args],
      env: {
        ...env,
        CLAWSWEEPER_GITHUB_COORDINATOR_OUTCOME_PATH: outcomePath,
      },
      coordinated,
      outcomePath,
      cleanup: () => {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // Never replace the GitHub command result with temp cleanup failure.
          // The bounded sidecar contains only attempted/rateLimited booleans.
        }
      },
    };
  }

  function coordinatorClassifiedThrottle(path: string | null): boolean {
    if (!path) return false;
    try {
      const outcome = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return outcome.attempted === true && outcome.rateLimited === true;
    } catch {
      return false;
    }
  }

  function coordinatorObservation(): {
    retryAt: string;
    provenance: "retry_after" | "rate_limit_reset" | "rate_limit_status" | "fallback";
    authoritative: boolean;
  } | null {
    const path = rateLimitObservationPath();
    if (!path) return null;
    try {
      const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        const item = JSON.parse(line) as Record<string, unknown>;
        if (item.scope !== "repository_actions" || typeof item.coordinator_deferred !== "boolean") {
          continue;
        }
        if (typeof item.retry_at !== "string") continue;
        const retryAt = item.retry_at;
        if (!Number.isFinite(Date.parse(retryAt)) || Date.parse(retryAt) <= Date.now()) continue;
        const rawProvenance = typeof item.provenance === "string" ? item.provenance : "fallback";
        const provenance = [
          "retry_after",
          "rate_limit_reset",
          "rate_limit_status",
          "fallback",
        ].includes(rawProvenance)
          ? (rawProvenance as "retry_after" | "rate_limit_reset" | "rate_limit_status" | "fallback")
          : "fallback";
        return { retryAt, provenance, authoritative: item.authoritative === true };
      }
    } catch {
      // The coordinator remains authoritative when the compatibility record is unavailable.
    }
    return null;
  }

  function commandExitStatus(error: unknown): number | null {
    if (!error || typeof error !== "object" || !("status" in error)) return null;
    const status = Number((error as Record<string, unknown>).status);
    return Number.isSafeInteger(status) ? status : null;
  }

  function repositoryPoolDeferredError(error: unknown): GitHubRateLimitError {
    const observed = coordinatorObservation();
    return new GitHubRateLimitError(error, Date.now(), {
      scope: "repository_actions",
      retryAt: observed?.retryAt ?? Date.now() + 5 * 60_000,
      provenance: observed?.provenance ?? "fallback",
      authoritative: observed?.authoritative ?? false,
      attempted: false,
    });
  }

  function appendJsonLine(path: string | null, value: Record<string, unknown>): void {
    if (!path) return;
    appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  }

  function githubEndpointCategory(args: readonly string[]): string {
    const text = args.join(" ").toLowerCase();
    if (/\brate_limit\b/.test(text)) return "rate_status";
    if (/\brun download\b/.test(text)) return "artifact_download";
    if (/\/comments(?:\?|\s|$)/.test(text)) return "comments";
    if (/\/labels(?:\?|\s|$)/.test(text)) return "labels";
    if (/\/reviews(?:\?|\s|$)/.test(text)) return "reviews";
    if (/\bworkflow run\b/.test(text)) return "workflow_dispatch";
    if (/\/issues\/\d+|\/pulls\/\d+/.test(text)) return "item_metadata";
    return "other";
  }

  function recordGitHubRequest(
    args: readonly string[],
    scope: GitHubCredentialScope,
    outcome: "success" | "throttle" | "transient" | "error",
  ): void {
    appendJsonLine(githubRequestMetricsPath(), {
      scope,
      category: githubEndpointCategory(args),
      mode: isPublicOpenClawReadOnlyRequest(args) ? "read" : "mutation_or_private_read",
      outcome,
      repeat_revision: process.env.CLAWSWEEPER_GITHUB_REQUEST_REPEAT === "true",
      count: 1,
    });
  }

  function rateLimitStatusRetryAt(scope: GitHubCredentialScope, token: string): number | null {
    if (!rateLimitObservationPath() || inspectedRateLimitScopes.has(scope) || !token) return null;
    inspectedRateLimitScopes.add(scope);
    try {
      closeSync(openSync(`${rateLimitObservationPath()}.lookup-${scope}.lock`, "wx"));
    } catch {
      return null;
    }
    try {
      const raw = run(
        "gh",
        [
          "api",
          "rate_limit",
          "--jq",
          "{remaining:.resources.core.remaining,reset:.resources.core.reset}",
        ],
        {
          timeoutMs: RATE_LIMIT_LOOKUP_TIMEOUT_MS,
          env: {
            ...process.env,
            GH_TOKEN: token,
            ...githubEgressEnvironment(["api", "rate_limit"], { GH_TOKEN: token }),
          },
        },
      );
      recordGitHubRequest(["api", "rate_limit"], scope, "success");
      const status = JSON.parse(raw) as { remaining?: unknown; reset?: unknown };
      const remaining = Number(status.remaining);
      const reset = Number(status.reset);
      return remaining <= 0 && Number.isSafeInteger(reset) && reset > 0 ? reset * 1_000 : null;
    } catch (error) {
      const kind = ghRetryKind(error);
      recordGitHubRequest(
        ["api", "rate_limit"],
        scope,
        kind === "throttle" ? "throttle" : kind === "transient" ? "transient" : "error",
      );
      return null;
    }
  }

  function githubRateLimitError(
    cause: unknown,
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): GitHubRateLimitError {
    const scope = githubRequestScope(args, overrides);
    const prepared = preparedGitHubEnv(args, overrides) ?? overrides;
    const token =
      prepared.GH_TOKEN?.trim() ||
      prepared.GITHUB_TOKEN?.trim() ||
      process.env.GH_TOKEN?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      "";
    const hinted = new GitHubRateLimitError(cause, Date.now(), { scope });
    const coordinatedObservation =
      scope === "repository_actions" && repositoryPoolCoordinatorEnabled(prepared)
        ? coordinatorObservation()
        : null;
    const statusRetryAt =
      hinted.authoritative ||
      coordinatedObservation ||
      (scope === "repository_actions" && repositoryPoolCoordinatorEnabled(prepared))
        ? null
        : rateLimitStatusRetryAt(scope, token);
    const error = coordinatedObservation
      ? new GitHubRateLimitError(cause, Date.now(), {
          scope,
          retryAt: coordinatedObservation.retryAt,
          provenance: coordinatedObservation.provenance,
          authoritative: coordinatedObservation.authoritative,
        })
      : statusRetryAt
        ? new GitHubRateLimitError(cause, Date.now(), {
            scope,
            retryAt: statusRetryAt,
            provenance: "rate_limit_status",
            authoritative: true,
          })
        : hinted;
    appendJsonLine(rateLimitObservationPath(), {
      scope: error.scope,
      ...(error.scope === "target_app"
        ? { target_owner: targetRepo().split("/", 1)[0]?.toLowerCase() }
        : {}),
      observed_at: new Date().toISOString(),
      retry_at: error.retryAt,
      provenance: error.provenance,
      authoritative: error.authoritative,
    });
    recordGitHubRequest(args, scope, "throttle");
    return error;
  }

  function claimPublicReadFallback(args: readonly string[]): NodeJS.ProcessEnv | null {
    const publicToken =
      publicReadToken(args) ?? exactPublicationPublicReadToken(args, targetRepo(), process.env);
    const appToken = process.env.GH_TOKEN?.trim();
    if (
      !publicToken ||
      repositoryPoolCoordinatorEnabled() ||
      !appToken ||
      publicToken === appToken ||
      claimedPublicReadFallbackTokens.has(appToken)
    ) {
      return null;
    }
    const observationPath = rateLimitObservationPath();
    if (observationPath) {
      try {
        closeSync(openSync(`${observationPath}.fallback-target_app.lock`, "wx"));
      } catch {
        return null;
      }
    }
    claimedPublicReadFallbackTokens.add(appToken);
    return { GH_TOKEN: appToken };
  }

  function ghWithPreparedTimeout(
    args: string[],
    timeoutMs: number | undefined,
    env: NodeJS.ProcessEnv = {},
  ): string {
    const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
    const preparedEnv = preparedGitHubEnv(resolvedArgs, env);
    const scope = githubRequestScope(resolvedArgs, env);
    const invocation = coordinatedRepositoryPoolCommand(resolvedArgs, scope, preparedEnv);
    try {
      const result = run(invocation.command, invocation.args, {
        timeoutMs,
        ...(invocation.env ? { env: invocation.env } : {}),
      });
      recordGitHubRequest(resolvedArgs, scope, "success");
      return result;
    } catch (error) {
      if (invocation.coordinated && commandExitStatus(error) === 75) {
        throw repositoryPoolDeferredError(error);
      }
      if (invocation.coordinated && coordinatorClassifiedThrottle(invocation.outcomePath)) {
        throw githubRateLimitError(error, resolvedArgs, env);
      }
      const retryKind = ghRetryKind(error);
      if (retryKind !== "throttle") {
        recordGitHubRequest(resolvedArgs, scope, retryKind === "transient" ? "transient" : "error");
      }
      throw error;
    } finally {
      invocation.cleanup();
    }
  }

  function gh(args: string[]): string {
    return ghWithPreparedTimeout(args, githubCommandTimeoutMs());
  }

  function ghOnce(args: string[], timeoutMs: number): string {
    const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
    const preparedEnv = preparedGitHubEnv(resolvedArgs);
    const scope = githubRequestScope(resolvedArgs);
    const invocation = coordinatedRepositoryPoolCommand(resolvedArgs, scope, preparedEnv);
    try {
      const commandEnv = {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        ...invocation.env,
      };
      const command = resolveCommand(invocation.command, invocation.args, commandEnv);
      const commandTimeoutMs = githubCommandTimeoutMs(timeoutMs) ?? timeoutMs;
      const runtimeLimitedTimeout = commandTimeoutMs < timeoutMs;
      const result = spawnSync(command.command, command.args, {
        cwd: ROOT,
        encoding: "utf8",
        env: commandEnv,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: commandTimeoutMs,
      });
      if (result.error) {
        if (invocation.coordinated && coordinatorClassifiedThrottle(invocation.outcomePath)) {
          throw githubRateLimitError(result.error, resolvedArgs);
        }
        if (runtimeLimitedTimeout && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          throw githubRuntimeBudgetError("during GitHub operation");
        }
        throw result.error;
      }
      if (result.status !== 0) {
        const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
        const error = new Error(
          [`Command failed: gh ${resolvedArgs.join(" ")}`, stderr].filter(Boolean).join("\n"),
        );
        const commandError = Object.assign(error, { status: result.status, stderr });
        if (invocation.coordinated && result.status === 75) {
          throw repositoryPoolDeferredError(commandError);
        }
        if (invocation.coordinated && coordinatorClassifiedThrottle(invocation.outcomePath)) {
          throw githubRateLimitError(commandError, resolvedArgs);
        }
        throw error;
      }
      return (result.stdout ?? "").trim();
    } finally {
      invocation.cleanup();
    }
  }

  function sleepMs(milliseconds: number): void {
    if (milliseconds <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }

  function untrustedCodexEnv(
    options: {
      ghToken?: string | undefined;
      preserveCodexAuth?: boolean | undefined;
    } = {},
  ): NodeJS.ProcessEnv {
    const env = codexEnv(options);
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAWSWEEPER_ACTION_LEDGER_")) delete env[key];
    }
    return env;
  }

  function untrustedCodexEnvForTest(
    env: NodeJS.ProcessEnv,
    options: {
      ghToken?: string | undefined;
      preserveCodexAuth?: boolean | undefined;
    } = {},
  ): NodeJS.ProcessEnv {
    const previousEnv = process.env;
    try {
      process.env = { ...env };
      return untrustedCodexEnv(options);
    } finally {
      process.env = previousEnv;
    }
  }

  return {
    GitHubRuntimeBudgetError,
    claimPublicReadFallback,
    ensureGitHubRetryFits,
    ensureGitHubRuntimeAvailable,
    ensureRuntimeDelayFits,
    gh,
    ghOnce,
    ghWithPreparedTimeout,
    githubRateLimitError,
    githubCommandTimeoutMs,
    githubRuntimeBudgetError,
    sleepBeforeGitHubRetry,
    sleepMs,
    untrustedCodexEnv,
    untrustedCodexEnvForTest,
    withGitHubRuntimeBudget,
  };
}
