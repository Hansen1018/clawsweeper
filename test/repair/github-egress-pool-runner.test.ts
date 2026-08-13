import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { GithubEgressPoolCoordinator } from "../../dashboard/github-egress-pool-coordinator.ts";
import {
  GITHUB_EGRESS_POOL_DEFERRED_EXIT,
  runGithubEgressPoolCommand,
} from "../../dist/repair/github-egress-pool-runner.js";
import { MemoryDurableStorage } from "../dashboard-worker-harness.ts";

test("disabled and non-repository pool paths preserve command bytes without coordinator traffic", async (t) => {
  const disabledOutcomePath = join(
    tmpdir(),
    `clawsweeper-disabled-pool-attempt-${process.pid}-${Date.now()}.json`,
  );
  writeFileSync(disabledOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  t.after(() => rmSync(disabledOutcomePath, { force: true }));
  const expected = {
    code: 17,
    signal: null,
    stdout: Buffer.from([0, 1, 2, 255]),
    stderr: Buffer.from("ordinary stderr\n"),
  };
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return expected;
  };
  const disabled = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env: {
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
      CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: disabledOutcomePath,
    },
    fetch: async () => {
      throw new Error("coordinator must not be called");
    },
    execute,
  });
  assert.equal(disabled.deferred, false);
  assert.equal(disabled.code, expected.code);
  assert.deepEqual(disabled.stdout, expected.stdout);
  assert.deepEqual(disabled.stderr, expected.stderr);
  assert.equal(
    JSON.parse(readFileSync(disabledOutcomePath, "utf8")).postEffectsGithubAttempted,
    true,
  );

  const targetApp = await runGithubEgressPoolCommand("gh", ["api", "user"], {
    env: {
      CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
      CLAWSWEEPER_GITHUB_POOL_CLASS: "target_app",
    },
    fetch: async () => {
      throw new Error("target App must not share the repository pool");
    },
    execute,
  });
  assert.equal(targetApp.deferred, false);
  assert.equal(executions, 2);
});

test("disabled repository execution fails closed before wire when its attempt receipt is unavailable", async () => {
  const unavailablePath = join(
    tmpdir(),
    `clawsweeper-missing-attempt-parent-${process.pid}-${Date.now()}`,
    "outcome.json",
  );
  let executions = 0;
  const result = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env: {
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
      CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: unavailablePath,
    },
    execute: async () => {
      executions += 1;
      throw new Error("unreceipted command reached the wire");
    },
  });
  assert.equal(result.deferred, false);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(
    result.stderr.toString(),
    "ClawSweeper GitHub attempt receipt unavailable before egress\n",
  );
  assert.doesNotMatch(result.stderr.toString(), /clawsweeper-missing-attempt-parent|outcome\.json/);
  assert.equal(executions, 0);
});

test("enabled repository execution defers before wire when throttle-detail isolation is unavailable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-detail-unavailable-"));
  const attemptedOutcomePath = join(root, "attempted-outcome.json");
  const observationPath = join(root, "rate-observations.jsonl");
  writeFileSync(attemptedOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "detail-unavailable-secret";
  const now = Date.parse("2026-08-13T03:15:00Z");
  const operations: string[] = [];
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {},
    { now: () => now, random: () => 0, permitId: () => "detail-unavailable-permit" },
  );
  let wireCalls = 0;
  const result = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env: {
      CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
      CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: attemptedOutcomePath,
      CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationPath,
      EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.text();
      const operation = new URL(request.url).pathname.split("/").at(-1) ?? "";
      operations.push(operation);
      return coordinator.fetch(
        new Request(`https://pool.test/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    },
    now: () => now,
    isolateRateLimitDetails: () => null,
    execute: async () => {
      wireCalls += 1;
      throw new Error("detail-sink failure reached GitHub");
    },
  });
  assert.equal(result.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
  assert.equal(result.deferred, true);
  assert.equal(wireCalls, 0);
  assert.deepEqual(operations, ["acquire", "start", "finish"]);
  assert.equal(
    JSON.parse(readFileSync(attemptedOutcomePath, "utf8")).postEffectsGithubAttempted,
    undefined,
  );
  const observation = JSON.parse(readFileSync(observationPath, "utf8").trim());
  assert.equal(observation.coordinator_deferred, true);
  assert.equal(observation.retry_at, new Date(now + 5 * 60_000).toISOString());
  const state = await (
    await coordinator.fetch(new Request("https://pool.test/observability"))
  ).json();
  assert.equal(state.permits_in_flight, 0);
});

test(
  "wrapper termination reaches the on-wire GitHub CLI child",
  { skip: process.platform === "win32" ? "POSIX workflow signal boundary" : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-runner-signal-"));
    const fakeGh = join(root, "gh");
    const startedPath = join(root, "started");
    const terminatedPath = join(root, "terminated");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.once("SIGTERM", () => {
  writeFileSync(process.env.CLAWSWEEPER_TEST_TERMINATED_PATH, "SIGTERM\\n");
  process.exit(0);
});
writeFileSync(process.env.CLAWSWEEPER_TEST_STARTED_PATH, String(process.pid));
setInterval(() => {}, 1_000);
`,
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
    const runner = spawn(
      process.execPath,
      [join(process.cwd(), "dist", "repair", "github-egress-pool-runner.js"), "--", fakeGh],
      {
        env: {
          ...process.env,
          CLAWSWEEPER_TEST_STARTED_PATH: startedPath,
          CLAWSWEEPER_TEST_TERMINATED_PATH: terminatedPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    runner.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        runner.once("error", reject);
        runner.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      await waitForFile(startedPath);
      assert.equal(runner.kill("SIGTERM"), true);
      const outcome = await Promise.race([
        closed,
        delay(5_000).then(() => {
          throw new Error("coordinator wrapper did not exit after SIGTERM");
        }),
      ]);
      await waitForFile(terminatedPath);
      assert.deepEqual(outcome, { code: 1, signal: null }, stderr);
      assert.equal(readFileSync(terminatedPath, "utf8"), "SIGTERM\n");
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "wrapper termination does not wait on descendant-held child pipes",
  { skip: process.platform === "win32" ? "POSIX workflow signal boundary" : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-runner-descendant-"));
    const fakeGh = join(root, "gh");
    const childExitedPath = join(root, "child-exited");
    const descendantPidPath = join(root, "descendant-pid");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.env.CLAWSWEEPER_TEST_DESCENDANT_PID_PATH, String(descendant.pid));
writeFileSync(process.env.CLAWSWEEPER_TEST_CHILD_EXITED_PATH, "exiting\\n");
process.exit(0);
`,
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
    const runner = spawn(
      process.execPath,
      [join(process.cwd(), "dist", "repair", "github-egress-pool-runner.js"), "--", fakeGh],
      {
        env: {
          ...process.env,
          CLAWSWEEPER_TEST_CHILD_EXITED_PATH: childExitedPath,
          CLAWSWEEPER_TEST_DESCENDANT_PID_PATH: descendantPidPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        runner.once("error", reject);
        runner.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    let descendantPid = 0;
    try {
      await waitForFile(childExitedPath);
      await waitForFile(descendantPidPath);
      descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
      await delay(50);
      assert.equal(runner.kill("SIGTERM"), true);
      const outcome = await Promise.race([
        closed,
        delay(2_000).then(() => {
          throw new Error("wrapper waited on descendant-held stdio after SIGTERM");
        }),
      ]);
      assert.deepEqual(outcome, { code: 1, signal: null });
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
      if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("signaled coordinated commands skip post-termination acknowledgement", async () => {
  const secret = "signaled-command-secret";
  const now = Date.parse("2026-08-12T21:00:00Z");
  const operations: string[] = [];
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
    },
    { now: () => now, random: () => 0, permitId: () => "signaled-permit" },
  );
  const result = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env: {
      CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
      EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.text();
      const operation = new URL(request.url).pathname.split("/").at(-1) ?? "";
      operations.push(operation);
      return coordinator.fetch(
        new Request(`https://pool.test/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    },
    now: () => now,
    execute: async () => ({
      code: 0,
      signal: "SIGTERM",
      wrapperTerminated: true,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }),
  });

  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.deferred, false);
  assert.deepEqual(operations, ["acquire", "start"]);
  const state = await (
    await coordinator.fetch(new Request("https://pool.test/observability"))
  ).json();
  assert.equal(state.permits_in_flight, 1);
});

test("independently signaled GitHub CLI commands still acknowledge failure", async () => {
  const secret = "child-signal-secret";
  const now = Date.parse("2026-08-12T21:05:00Z");
  const operations: string[] = [];
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
    },
    { now: () => now, random: () => 0, permitId: () => "child-signal-permit" },
  );
  const result = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env: {
      CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
      EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.text();
      const operation = new URL(request.url).pathname.split("/").at(-1) ?? "";
      operations.push(operation);
      return coordinator.fetch(
        new Request(`https://pool.test/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    },
    now: () => now,
    execute: async () => ({
      code: 1,
      signal: "SIGKILL",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }),
  });

  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.wrapperTerminated, undefined);
  assert.deepEqual(operations, ["acquire", "start", "finish"]);
  const state = await (
    await coordinator.fetch(new Request("https://pool.test/observability"))
  ).json();
  assert.equal(state.permits_in_flight, 0);
});

test("over-horizon wire throttle falls back and prevents the next command", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-runner-"));
  const detailPath = join(root, "rate-details.jsonl");
  const legacyPath = join(root, "rate-observations.jsonl");
  const attemptedOutcomePath = join(root, "attempted-outcome.json");
  const deferredOutcomePath = join(root, "deferred-outcome.json");
  const rollbackOutcomePath = join(root, "rollback-outcome.json");
  const coordinatorOutcomePath = join(root, "coordinator-outcome.json");
  writeFileSync(attemptedOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  writeFileSync(deferredOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  writeFileSync(rollbackOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  const secret = "coordinator-test-secret";
  let now = Date.parse("2026-08-12T15:00:00Z");
  let permitSequence = 0;
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
      GITHUB_EGRESS_POOL_FALLBACK_BASE_MS: "60000",
      GITHUB_EGRESS_POOL_FALLBACK_MAX_MS: "600000",
      GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO: "0",
    },
    { now: () => now, random: () => 0, permitId: () => `permit-${++permitSequence}` },
  );
  const coordinatorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.text();
    const signature = request.headers.get("x-clawsweeper-exact-review-signature");
    assert.equal(signature, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
    const operation = new URL(request.url).pathname.split("/").at(-1);
    return coordinator.fetch(
      new Request(`https://pool.test/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  };
  const env = {
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_router",
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "2",
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: detailPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: legacyPath,
    CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: attemptedOutcomePath,
    CLAWSWEEPER_GITHUB_COORDINATOR_OUTCOME_PATH: coordinatorOutcomePath,
    EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
  };
  let wireCalls = 0;
  try {
    const throttled = await runGithubEgressPoolCommand(
      "gh",
      ["workflow", "run", "repair-comment-router.yml"],
      {
        env,
        fetch: coordinatorFetch,
        now: () => now,
        execute: async (_command, _args, commandEnv) => {
          wireCalls += 1;
          const isolatedPath = commandEnv.CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH;
          assert.ok(isolatedPath);
          assert.notEqual(isolatedPath, detailPath);
          appendFileSync(
            isolatedPath,
            `${JSON.stringify({
              observedAt: new Date(now).toISOString(),
              poolClass: "repository_actions",
              status: 403,
              headers: {
                retryAfterPresent: true,
                retryAfterSeconds: 7_201,
                remainingPresent: true,
                remaining: 0,
                resetPresent: true,
                resetEpochSeconds: Math.floor((now + 7_201_000) / 1000),
              },
            })}\n`,
          );
          return {
            code: 1,
            signal: null,
            stdout: Buffer.from("original stdout\n"),
            stderr: Buffer.from("gh: request failed (HTTP 403)\n"),
          };
        },
      },
    );
    assert.equal(throttled.deferred, false);
    assert.equal(throttled.code, 1);
    assert.equal(throttled.stdout.toString(), "original stdout\n");
    assert.equal(throttled.stderr.toString(), "gh: request failed (HTTP 403)\n");
    assert.deepEqual(JSON.parse(readFileSync(coordinatorOutcomePath, "utf8")), {
      attempted: true,
      rateLimited: true,
    });
    assert.equal(
      JSON.parse(readFileSync(attemptedOutcomePath, "utf8")).postEffectsGithubAttempted,
      true,
    );
    const state = await (
      await coordinator.fetch(new Request("https://pool.test/observability"))
    ).json();
    assert.equal(state.state, "open");
    assert.equal(state.epoch, 2);
    assert.equal(state.reset_provenance, "fallback");
    assert.equal(state.reset_authoritative, false);
    assert.equal(state.blocked_until, new Date(now + 60_000).toISOString());

    const deferred = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
      env: {
        ...env,
        CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: deferredOutcomePath,
      },
      fetch: coordinatorFetch,
      now: () => now,
      execute: async () => {
        wireCalls += 1;
        throw new Error("deferred command reached the wire");
      },
    });
    assert.equal(deferred.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.stdout.length, 0);
    assert.match(deferred.stderr.toString(), /deferred before GitHub egress/);
    assert.equal(wireCalls, 1);
    assert.equal(
      JSON.parse(readFileSync(deferredOutcomePath, "utf8")).postEffectsGithubAttempted,
      undefined,
    );

    const legacy = readFileSync(legacyPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(legacy.length, 2);
    assert.equal(legacy[0].provenance, "fallback");
    assert.equal(legacy[0].authoritative, false);
    assert.equal(legacy[1].coordinator_deferred, true);
    assert.equal(legacy[1].retry_at, new Date(now + 60_000).toISOString());
    assert.doesNotMatch(JSON.stringify(state), /1234|repair-comment-router|clawsweeper\.test/);
    assert.equal(readFileSync(detailPath, "utf8").trim().split(/\r?\n/).length, 1);

    const rollbackBypass = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
      env: {
        ...env,
        CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "false",
        CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: rollbackOutcomePath,
      },
      fetch: async () => {
        throw new Error("disabled rollback must bypass coordinator state");
      },
      now: () => now,
      execute: async () => {
        wireCalls += 1;
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from("rollback bypass\n"),
          stderr: Buffer.alloc(0),
        };
      },
    });
    assert.equal(rollbackBypass.deferred, false);
    assert.equal(rollbackBypass.stdout.toString(), "rollback bypass\n");
    assert.equal(
      JSON.parse(readFileSync(rollbackOutcomePath, "utf8")).postEffectsGithubAttempted,
      true,
    );
    assert.equal(wireCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed throttle acknowledgement records a bounded local fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-runner-ack-fallback-"));
  const legacyPath = join(root, "rate-observations.jsonl");
  const attemptedOutcomePath = join(root, "attempted-outcome.json");
  writeFileSync(attemptedOutcomePath, `${JSON.stringify({ kind: "eligible" })}\n`);
  const secret = "coordinator-test-secret";
  const now = Date.parse("2026-08-12T16:00:00Z");
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {},
    { now: () => now, random: () => 0, permitId: () => "permit-ack-fallback" },
  );
  let throttleAcknowledgements = 0;
  const coordinatorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.text();
    const signature = request.headers.get("x-clawsweeper-exact-review-signature");
    assert.equal(signature, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
    const operation = new URL(request.url).pathname.split("/").at(-1);
    if (operation === "throttle") {
      throttleAcknowledgements += 1;
      return new Response("coordinator unavailable", { status: 503 });
    }
    return coordinator.fetch(
      new Request(`https://pool.test/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  };
  let wireCalls = 0;
  try {
    const result = await runGithubEgressPoolCommand(
      "gh",
      ["workflow", "run", "repair-comment-router.yml"],
      {
        env: {
          CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
          CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
          CLAWSWEEPER_GITHUB_STAGE: "publication_router",
          CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: legacyPath,
          CLAWSWEEPER_GITHUB_POST_EFFECT_OUTCOME_PATH: attemptedOutcomePath,
          EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
        },
        fetch: coordinatorFetch,
        now: () => now,
        execute: async () => {
          wireCalls += 1;
          return {
            code: 1,
            signal: null,
            stdout: Buffer.from("original stdout\n"),
            stderr: Buffer.from("gh: API rate limit exceeded (HTTP 403)\n"),
          };
        },
      },
    );

    assert.equal(result.deferred, false);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.toString(), "original stdout\n");
    assert.equal(result.stderr.toString(), "gh: API rate limit exceeded (HTTP 403)\n");
    assert.equal(wireCalls, 1);
    assert.equal(throttleAcknowledgements, 2);
    assert.equal(
      JSON.parse(readFileSync(attemptedOutcomePath, "utf8")).postEffectsGithubAttempted,
      true,
    );
    const observations = readFileSync(legacyPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(observations, [
      {
        scope: "repository_actions",
        observed_at: new Date(now).toISOString(),
        retry_at: new Date(now + 5 * 60_000).toISOString(),
        provenance: "fallback",
        authoritative: false,
        coordinator_deferred: false,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel commands consume only their isolated throttle observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-isolated-details-"));
  const sharedDetailPath = join(root, "rate-details.jsonl");
  const secret = "isolated-details-secret";
  const now = Date.parse("2026-08-12T15:30:00Z");
  let permitSequence = 0;
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
      GITHUB_EGRESS_POOL_FALLBACK_BASE_MS: "60000",
      GITHUB_EGRESS_POOL_FALLBACK_MAX_MS: "600000",
      GITHUB_EGRESS_POOL_FALLBACK_JITTER_RATIO: "0",
    },
    { now: () => now, random: () => 0, permitId: () => `permit-${++permitSequence}` },
  );
  let poolOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    poolOpened = resolve;
  });
  const coordinatorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.text();
    const operation = new URL(request.url).pathname.split("/").at(-1);
    const response = await coordinator.fetch(
      new Request(`https://pool.test/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    if (operation === "throttle") poolOpened();
    return response;
  };
  const env = {
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_router",
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: sharedDetailPath,
    EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    GITHUB_RUN_ID: "parallel-details-run",
    GITHUB_RUN_ATTEMPT: "1",
  };
  let entered = 0;
  let bothEntered!: () => void;
  const commandsEntered = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  const isolatedPaths = new Set<string>();
  const execute = async (
    _command: string,
    args: readonly string[],
    commandEnv: NodeJS.ProcessEnv,
  ) => {
    const isolatedPath = commandEnv.CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH;
    assert.ok(isolatedPath);
    isolatedPaths.add(isolatedPath);
    entered += 1;
    if (entered === 2) bothEntered();
    await commandsEntered;
    if (args.includes("throttle")) {
      appendFileSync(
        isolatedPath,
        `${JSON.stringify({
          observedAt: new Date(now).toISOString(),
          poolClass: "repository_actions",
          status: 403,
          headers: {
            retryAfterPresent: true,
            retryAfterSeconds: 120,
            remainingPresent: true,
            remaining: 0,
            resetPresent: true,
            resetEpochSeconds: Math.floor((now + 120_000) / 1000),
          },
        })}\n`,
      );
      return {
        code: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("gh: API rate limit exceeded (HTTP 403)\n"),
      };
    }
    await opened;
    return {
      code: 0,
      signal: null,
      stdout: Buffer.from("sibling success\n"),
      stderr: Buffer.alloc(0),
    };
  };

  try {
    const [throttled, successful] = await Promise.all([
      runGithubEgressPoolCommand("gh", ["api", "throttle"], {
        env,
        fetch: coordinatorFetch,
        now: () => now,
        execute,
      }),
      runGithubEgressPoolCommand("gh", ["api", "success"], {
        env,
        fetch: coordinatorFetch,
        now: () => now,
        execute,
      }),
    ]);
    assert.equal(throttled.deferred, false);
    assert.equal(throttled.code, 1);
    assert.equal(successful.deferred, false);
    assert.equal(successful.code, 0);
    assert.equal(isolatedPaths.size, 2);
    for (const path of isolatedPaths) assert.equal(existsSync(path), false);
    const sharedDetails = readFileSync(sharedDetailPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(sharedDetails.length, 1);
    assert.equal(sharedDetails[0].status, 403);

    const state = await (
      await coordinator.fetch(new Request("https://pool.test/observability"))
    ).json();
    assert.equal(state.state, "open");
    assert.equal(state.epoch, 2);
    assert.equal(state.throttle_observations, 1);
    assert.equal(state.already_on_wire_completions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity deferral gets a short durable retry boundary without executing", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-pool-capacity-"));
  const legacyPath = join(root, "rate-observations.jsonl");
  const now = Date.parse("2026-08-12T16:00:00Z");
  let executions = 0;
  try {
    const result = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
      env: {
        CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
        CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
        CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: legacyPath,
        EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "capacity-secret",
      },
      now: () => now,
      fetch: async () =>
        new Response(
          JSON.stringify({
            granted: false,
            reason: "capacity_deferred",
            epoch: 4,
            blocked_until: null,
            reset_provenance: "none",
            reset_authoritative: false,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      execute: async () => {
        executions += 1;
        throw new Error("capacity-deferred command reached the wire");
      },
    });
    assert.equal(result.code, GITHUB_EGRESS_POOL_DEFERRED_EXIT);
    assert.equal(executions, 0);
    assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), {
      scope: "repository_actions",
      observed_at: new Date(now).toISOString(),
      retry_at: new Date(now + 5_000).toISOString(),
      provenance: "fallback",
      authoritative: false,
      coordinator_deferred: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command launch failure releases the started permit and preserves the exception", async () => {
  const secret = "command-launch-failure-secret";
  const now = Date.parse("2026-08-12T16:15:00Z");
  let permitSequence = 0;
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
    },
    { now: () => now, random: () => 0, permitId: () => `permit-${++permitSequence}` },
  );
  let finishOutcome: unknown;
  const coordinatorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.text();
    const operation = new URL(request.url).pathname.split("/").at(-1);
    if (operation === "finish") finishOutcome = JSON.parse(body).outcome;
    return coordinator.fetch(
      new Request(`https://pool.test/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  };
  const launchError = new Error("spawn gh ENOENT");
  await assert.rejects(
    runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
      env: {
        CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
        CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
        EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
      },
      fetch: coordinatorFetch,
      now: () => now,
      execute: async () => {
        throw launchError;
      },
    }),
    (error) => error === launchError,
  );
  const state = await (
    await coordinator.fetch(new Request("https://pool.test/observability"))
  ).json();
  assert.equal(state.state, "closed");
  assert.equal(state.permits_in_flight, 0);
  assert.equal(finishOutcome, "unexecuted_failure");
});

test("lost post-commit acquire and start responses retry without duplicate wire work", async () => {
  const secret = "ambiguous-start-secret";
  const now = Date.parse("2026-08-12T16:20:00Z");
  let permitSequence = 0;
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
    },
    { now: () => now, random: () => 0, permitId: () => `permit-${++permitSequence}` },
  );
  let acquireAttempts = 0;
  let startAttempts = 0;
  const coordinatorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.text();
    const operation = new URL(request.url).pathname.split("/").at(-1);
    const response = await coordinator.fetch(
      new Request(`https://pool.test/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    if (operation === "acquire") {
      acquireAttempts += 1;
      if (acquireAttempts === 1) throw new Error("acquire response lost after commit");
    }
    if (operation === "start") {
      startAttempts += 1;
      if (startAttempts === 1) throw new Error("start response lost after commit");
    }
    return response;
  };
  let wireCalls = 0;
  const result = await runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env: {
      CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
      EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
    },
    fetch: coordinatorFetch,
    now: () => now,
    execute: async () => {
      wireCalls += 1;
      return {
        code: 0,
        signal: null,
        stdout: Buffer.from("success after retry\n"),
        stderr: Buffer.alloc(0),
      };
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.deferred, false);
  assert.equal(acquireAttempts, 2);
  assert.equal(startAttempts, 2);
  assert.equal(wireCalls, 1);
  const state = await (
    await coordinator.fetch(new Request("https://pool.test/observability"))
  ).json();
  assert.equal(state.state, "closed");
  assert.equal(state.permits_in_flight, 0);
});

test("parallel commands in one workflow run hold distinct active permits", async () => {
  const secret = "parallel-permit-secret";
  const now = Date.parse("2026-08-12T16:30:00Z");
  let permitSequence = 0;
  const coordinator = new GithubEgressPoolCoordinator(
    { storage: new MemoryDurableStorage() },
    {
      GITHUB_EGRESS_POOL_MAX_PERMITS: "8",
      GITHUB_EGRESS_POOL_ACQUIRED_PERMIT_TTL_MS: "5000",
      GITHUB_EGRESS_POOL_STARTED_PERMIT_TTL_MS: "60000",
    },
    { now: () => now, random: () => 0, permitId: () => `permit-${++permitSequence}` },
  );
  const coordinatorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.text();
    const operation = new URL(request.url).pathname.split("/").at(-1);
    return coordinator.fetch(
      new Request(`https://pool.test/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  };
  const env = {
    CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED: "true",
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_prepare",
    EXACT_REVIEW_QUEUE_URL: "https://clawsweeper.test",
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    GITHUB_RUN_ID: "shared-run",
    GITHUB_RUN_ATTEMPT: "1",
  };
  let entered = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let bothEntered!: () => void;
  const commandsEntered = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  const execute = async () => {
    entered += 1;
    if (entered === 2) bothEntered();
    await released;
    return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  const first = runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env,
    fetch: coordinatorFetch,
    now: () => now,
    execute,
  });
  const second = runGithubEgressPoolCommand("gh", ["api", "rate_limit"], {
    env,
    fetch: coordinatorFetch,
    now: () => now,
    execute,
  });
  await commandsEntered;
  const state = await (
    await coordinator.fetch(new Request("https://pool.test/observability"))
  ).json();
  assert.equal(state.permits_in_flight, 2);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => result.deferred),
    [false, false],
  );
});

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path}`);
}
