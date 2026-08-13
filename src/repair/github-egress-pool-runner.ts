#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  GithubEgressPoolCoordinatorClient,
  type GithubEgressPoolDeferred,
  type GithubEgressPoolState,
} from "./github-egress-pool-client.js";

export const GITHUB_EGRESS_POOL_DEFERRED_EXIT = 75;

type CommandResult = {
  code: number;
  signal: NodeJS.Signals | null;
  wrapperTerminated?: boolean;
  stdout: Buffer;
  stderr: Buffer;
};

type RunnerRuntime = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  execute?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<CommandResult>;
  isolateRateLimitDetails?: typeof isolatedRateLimitDetails;
};

type RunnerResult = CommandResult & { deferred: boolean };

type SanitizedThrottle = {
  status: 403 | 429;
  observedAt: string;
  headers: {
    retryAfterPresent: boolean;
    retryAfterSeconds: number | null;
    resetPresent: boolean;
    resetEpochSeconds: number | null;
  };
};

const DEFERRED_MESSAGE = "ClawSweeper repository Actions pool deferred before GitHub egress\n";
const ATTEMPT_RECEIPT_UNAVAILABLE_MESSAGE =
  "ClawSweeper GitHub attempt receipt unavailable before egress\n";
const OPERATION_INDEX = 1;
const CHILD_TERMINATION_GRACE_MS = 2_000;
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGTERM", "SIGINT", "SIGBREAK"] : ["SIGTERM", "SIGINT"];

export async function runGithubEgressPoolCommand(
  command: string,
  args: readonly string[],
  runtime: RunnerRuntime = {},
): Promise<RunnerResult> {
  const env = runtime.env ?? process.env;
  const execute = runtime.execute ?? executeCommand;
  const now = runtime.now ?? Date.now;
  if (coordinatorPoolClass(env) !== "repository_actions") {
    return { ...(await execute(command, args, env)), deferred: false };
  }
  if (!coordinatorEnabled(env)) {
    try {
      markPostEffectAttempted(env);
    } catch {
      return attemptReceiptUnavailableResult();
    }
    return { ...(await execute(command, args, env)), deferred: false };
  }
  if (!/^gh(?:\.exe)?$/i.test(basename(command))) {
    throw new Error("Repository Actions pool runner accepts only the gh executable");
  }

  let client: GithubEgressPoolCoordinatorClient;
  try {
    client = new GithubEgressPoolCoordinatorClient({
      baseUrl: requiredEnv(env, "EXACT_REVIEW_QUEUE_URL"),
      webhookSecret: requiredEnv(env, "CLAWSWEEPER_WEBHOOK_SECRET"),
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    });
  } catch {
    return deferredResult(env, now(), unavailableDeferral(now()));
  }
  // A workflow run can execute several publication commands concurrently.
  // Keep each runner invocation distinct so an active permit cannot be shared
  // by sibling commands. Coordinator-side caller deduplication still protects
  // retries of one acquire request; it is not an execution-coalescing primitive.
  const invocationId = randomUUID();
  const callerHash = digest(
    [
      "caller:v1",
      env.GITHUB_RUN_ID || "local",
      env.GITHUB_RUN_ATTEMPT || "0",
      env.CLAWSWEEPER_GITHUB_STAGE || "unknown",
      env.CLAWSWEEPER_GITHUB_CLAIM_GENERATION || "unknown",
      invocationId,
    ].join(":"),
    24,
  );

  let acquired: Awaited<ReturnType<GithubEgressPoolCoordinatorClient["acquire"]>>;
  try {
    acquired = await retryCoordinatorCall(() => client.acquire({ callerHash, declaredBudget: 1 }));
  } catch {
    return deferredResult(env, now(), unavailableDeferral(now()));
  }
  if (!acquired.granted) return deferredResult(env, now(), acquired);
  const permit = acquired.permit;
  let started: Awaited<ReturnType<GithubEgressPoolCoordinatorClient["start"]>>;
  try {
    started = await retryCoordinatorCall(() =>
      client.start({ permit, operationIndex: OPERATION_INDEX }),
    );
  } catch {
    return deferredResult(env, now(), unavailableDeferral(now(), permit.epoch));
  }
  if ("granted" in started) return deferredResult(env, now(), started);

  const rateDetails = (runtime.isolateRateLimitDetails ?? isolatedRateLimitDetails)(env);
  if (!rateDetails) {
    const observedAt = now();
    const receiptId = digest(
      [
        "finish:v1",
        permit.permitId,
        permit.epoch,
        OPERATION_INDEX,
        "rate_detail_isolation_unavailable",
        observedAt,
      ].join(":"),
      64,
    );
    try {
      await retryCoordinatorCall(() =>
        client.finish({
          permit,
          operationIndex: OPERATION_INDEX,
          receiptId,
          outcome: "unexecuted_failure",
        }),
      );
    } catch {
      // The started-permit TTL remains the final bound if the conservative
      // release acknowledgement is unavailable.
    }
    return deferredResult(env, observedAt, unavailableDeferral(observedAt, permit.epoch));
  }

  try {
    markPostEffectAttempted(env);
  } catch {
    rateDetails.cleanup();
    const observedAt = now();
    const receiptId = digest(
      [
        "finish:v1",
        permit.permitId,
        permit.epoch,
        OPERATION_INDEX,
        "attempt_receipt_unavailable",
        observedAt,
      ].join(":"),
      64,
    );
    try {
      await retryCoordinatorCall(() =>
        client.finish({
          permit,
          operationIndex: OPERATION_INDEX,
          receiptId,
          outcome: "unexecuted_failure",
        }),
      );
    } catch {
      // The started-permit TTL remains the final bound if its local attempt
      // receipt and both coordinator acknowledgements are unavailable.
    }
    return deferredResult(env, observedAt, unavailableDeferral(observedAt, permit.epoch));
  }

  let result!: CommandResult;
  let executionError: unknown;
  let throttle: SanitizedThrottle | null = null;
  let observedAt = now();
  try {
    result = await execute(command, args, rateDetails.env);
    observedAt = now();
    throttle = readThrottleObservation(
      rateDetails.path,
      0,
      result.stderr,
      observedAt,
      env.CLAWSWEEPER_GITHUB_POOL_CLASS || "repository_actions",
    );
    rateDetails.persist();
  } catch (error) {
    observedAt = now();
    executionError = error;
  } finally {
    rateDetails.cleanup();
  }
  if (executionError) {
    const receiptId = digest(
      [
        "finish:v1",
        permit.permitId,
        permit.epoch,
        OPERATION_INDEX,
        "command_error",
        observedAt,
      ].join(":"),
      64,
    );
    try {
      await retryCoordinatorCall(() =>
        client.finish({
          permit,
          operationIndex: OPERATION_INDEX,
          receiptId,
          outcome: "unexecuted_failure",
        }),
      );
    } catch {
      // Preserve the original command-launch exception. The coordinator's
      // started-permit TTL remains the final bound if both acknowledgements fail.
    }
    throw executionError;
  }
  if (result.wrapperTerminated) {
    // Outer timeout/cancellation owns shutdown. The attempt receipt is already
    // durable, and the persisted started-permit TTL bounds coordinator state.
    // Do not let a slow acknowledgement endpoint keep the wrapper alive after
    // its GitHub CLI child has terminated.
    return { ...result, deferred: false };
  }
  const receiptId = digest(
    [
      throttle ? "throttle:v1" : "finish:v1",
      permit.permitId,
      permit.epoch,
      OPERATION_INDEX,
      result.code,
      throttle?.observedAt || observedAt,
    ].join(":"),
    64,
  );

  try {
    if (throttle) {
      writeCoordinatorThrottleOutcome(env);
      const state = await retryCoordinatorCall(() =>
        client.throttle({
          permit,
          operationIndex: OPERATION_INDEX,
          receiptId,
          ...throttle,
        }),
      );
      appendLegacyCircuitObservation(env, observedAt, state, false);
    } else {
      const state = await retryCoordinatorCall(() =>
        client.finish({
          permit,
          operationIndex: OPERATION_INDEX,
          receiptId,
          outcome: result.code === 0 ? "success" : "failure",
        }),
      );
      if (state.state === "open") appendLegacyCircuitObservation(env, observedAt, state, false);
    }
  } catch {
    // The already-on-wire command result remains authoritative. A failed
    // coordinator acknowledgement cannot be retried by issuing GitHub work again.
    // Preserve a bounded local circuit observation for a classified throttle so
    // this claimed batch still releases untouched siblings as unattempted quota
    // deferrals even while the shared coordinator is unavailable.
    if (throttle) {
      appendLegacyCircuitObservation(
        env,
        observedAt,
        unavailableDeferral(observedAt, permit.epoch),
        false,
      );
    }
  }
  return { ...result, deferred: false };
}

async function retryCoordinatorCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

function deferredResult(
  env: NodeJS.ProcessEnv,
  now: number,
  deferred: GithubEgressPoolDeferred,
): RunnerResult {
  // Capacity, probe, and stale-epoch rejections can occur without an open
  // circuit boundary. Give the durable queue a short retry boundary so the
  // unattempted member is released without consuming its failure budget.
  const retryableDeferred = deferred.blockedUntil
    ? deferred
    : {
        ...deferred,
        blockedUntil: new Date(now + 5_000).toISOString(),
        resetProvenance: "fallback" as const,
        resetAuthoritative: false,
      };
  appendLegacyCircuitObservation(env, now, retryableDeferred, true);
  return {
    code: GITHUB_EGRESS_POOL_DEFERRED_EXIT,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(DEFERRED_MESSAGE),
    deferred: true,
  };
}

function appendLegacyCircuitObservation(
  env: NodeJS.ProcessEnv,
  observedAt: number,
  state: GithubEgressPoolDeferred | GithubEgressPoolState,
  deferred: boolean,
) {
  const path = env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH?.trim();
  if (!path || !state.blockedUntil) return;
  const provenance = state.resetProvenance === "none" ? "fallback" : state.resetProvenance;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        scope: "repository_actions",
        observed_at: new Date(observedAt).toISOString(),
        retry_at: state.blockedUntil,
        provenance,
        authoritative: state.resetAuthoritative,
        coordinator_deferred: deferred,
      })}\n`,
      "utf8",
    );
  } catch {
    // Coordinator enforcement remains authoritative when legacy telemetry is unavailable.
  }
}

function writeCoordinatorThrottleOutcome(env: NodeJS.ProcessEnv): void {
  const path = env.CLAWSWEEPER_GITHUB_COORDINATOR_OUTCOME_PATH?.trim();
  if (!path) return;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ attempted: true, rateLimited: true })}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch {
    // The durable coordinator and legacy observation remain authoritative.
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readThrottleObservation(
  path: string | undefined,
  start: number,
  stderr: Buffer,
  fallbackObservedAt: number,
  expectedPoolClass: string,
): SanitizedThrottle | null {
  const observations = readJsonLines(path, start);
  for (const raw of observations.reverse()) {
    const item = objectValue(raw);
    const status = Number(item.status);
    const poolClass = String(item.poolClass || "");
    const headers = objectValue(item.headers);
    const remaining = nullableInteger(headers.remaining);
    const retryAfterPresent = headers.retryAfterPresent === true;
    const resetPresent = headers.resetPresent === true;
    const rateSignal =
      status === 429 ||
      retryAfterPresent ||
      remaining === 0 ||
      githubThrottleText(stderr.toString("utf8"));
    if ((status !== 403 && status !== 429) || poolClass !== expectedPoolClass || !rateSignal) {
      continue;
    }
    const observedAt = String(item.observedAt || "");
    return {
      status,
      observedAt: Number.isFinite(Date.parse(observedAt))
        ? new Date(Date.parse(observedAt)).toISOString()
        : new Date(fallbackObservedAt).toISOString(),
      headers: {
        retryAfterPresent,
        retryAfterSeconds: nullableInteger(headers.retryAfterSeconds),
        resetPresent,
        resetEpochSeconds: nullableInteger(headers.resetEpochSeconds),
      },
    };
  }
  if (!githubThrottleText(stderr.toString("utf8"))) return null;
  return {
    status: /(?:HTTP\s*)?429/i.test(stderr.toString("utf8")) ? 429 : 403,
    observedAt: new Date(fallbackObservedAt).toISOString(),
    headers: {
      retryAfterPresent: false,
      retryAfterSeconds: null,
      resetPresent: false,
      resetEpochSeconds: null,
    },
  };
}

function readJsonLines(path: string | undefined, start: number): unknown[] {
  if (!path || !existsSync(path)) return [];
  try {
    const contents = readFileSync(path);
    return contents
      .subarray(Math.min(start, contents.byteLength))
      .toString("utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function isolatedRateLimitDetails(env: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  path: string | undefined;
  persist: () => void;
  cleanup: () => void;
} | null {
  const sharedPath = env.CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH?.trim();
  try {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-github-egress-pool-"));
    const path = join(root, "rate-limit-details.jsonl");
    return {
      env: { ...env, CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: path },
      path,
      persist: () => {
        if (!sharedPath || !existsSync(path)) return;
        try {
          const details = readFileSync(path);
          if (!details.length) return;
          mkdirSync(dirname(sharedPath), { recursive: true });
          appendFileSync(sharedPath, details);
        } catch {
          // Enforcement already consumed the isolated observation. Phase 0
          // conservation reports an unavailable shared telemetry append.
        }
      },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch {
    return null;
  }
}

function unavailableDeferral(now: number, epoch = 1): GithubEgressPoolDeferred {
  return {
    granted: false,
    reason: "coordinator_unavailable",
    epoch,
    blockedUntil: new Date(now + 5 * 60_000).toISOString(),
    resetProvenance: "fallback",
    resetAuthoritative: false,
  };
}

function attemptReceiptUnavailableResult(): RunnerResult {
  return {
    code: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(ATTEMPT_RECEIPT_UNAVAILABLE_MESSAGE),
    deferred: false,
  };
}

function coordinatorEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true"].includes(
    String(env.CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED || "").toLowerCase(),
  );
}

function coordinatorPoolClass(env: NodeJS.ProcessEnv): string {
  return env.CLAWSWEEPER_GITHUB_COORDINATOR_POOL_CLASS || env.CLAWSWEEPER_GITHUB_POOL_CLASS || "";
}

function githubThrottleText(value: string): boolean {
  return /api rate limit exceeded|secondary rate limit|abuse detection|http\s*429|rate limited|was submitted too quickly/i.test(
    value,
  );
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function markPostEffectAttempted(env: NodeJS.ProcessEnv): void {
  const path = env.CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH?.trim();
  if (!path) return;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Publication post-effect outcome must be an object");
  }
  const temporary = `${path}.github-egress-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...(parsed as Record<string, unknown>), postEffectsGithubAttempted: true })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when repository pool coordination is enabled`);
  return value;
}

function digest(value: string, length: 24 | 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function executeCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let forwardedSignal: NodeJS.Signals | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? 1,
        signal: forwardedSignal ?? signal,
        wrapperTerminated: forwardedSignal !== null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (forwardedSignal) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited between the state check and escalation.
        }
        return;
      }
      forwardedSignal = signal;
      if (child.exitCode !== null || child.signalCode !== null) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveOnce(child.exitCode, child.signalCode);
        return;
      }
      try {
        child.kill(signal);
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The outer timeout still owns the wrapper. Preserve its termination
          // while avoiding an uncaught signal-handler exception.
        }
      }
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited before the grace timer fired.
        }
      }, CHILD_TERMINATION_GRACE_MS);
      killTimer.unref();
    };
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => forwardSignal(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectOnce);
    child.once("close", (code, signal) => {
      resolveOnce(code, signal);
    });
  });
}

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const command = separator >= 0 ? process.argv[separator + 1] : undefined;
  const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
  if (!command) throw new Error("usage: github-egress-pool-runner -- gh <arguments>");
  const result = await runGithubEgressPoolCommand(command, args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.signal ? 1 : result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
