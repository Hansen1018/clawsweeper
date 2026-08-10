#!/usr/bin/env node

/**
 * Definition: expand one named ClawSweeper test target and run it with Node's
 * built-in test runner. The script does not build sources or mutate fixtures.
 *
 * Parameters: a required target, an optional positive --test-concurrency, and
 * optional Node test-runner arguments after `--`.
 *
 * Outputs: the selected target/concurrency/file count on stderr, inherited TAP
 * output, and the child runner's exit code or terminating signal.
 *
 * Examples:
 *   node scripts/run-node-tests.mjs unit
 *   node scripts/run-node-tests.mjs all --test-concurrency 4 -- --experimental-test-coverage
 */

import { spawn } from "node:child_process";
import fs, { globSync } from "node:fs";
import os, { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_TEST_CONCURRENCY = 16;
const RUN_PREFIX = "clawsweeper-test-run-";
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const HEARTBEAT_MS = 60_000;
const SIGNAL_GRACE_MS = 5_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"];
const TARGET_PATTERNS = Object.freeze({
  unit: ["test/*.test.ts"],
  repair: ["test/repair/*.test.ts", "dist/repair/*.test.js"],
  all: ["test/*.test.ts", "test/repair/*.test.ts", "dist/repair/*.test.js"],
  "codex-process": ["test/codex-process.test.ts"],
  "fix-prompt-builder": ["dist/repair/fix-prompt-builder.test.js"],
  "workflow-sparse-checkout": ["test/repair/workflow-sparse-checkout.smoke.ts"],
});

const HELP = `Usage:
  node scripts/run-node-tests.mjs <target> [--test-concurrency <count>] [-- <node-options...>]

Description:
  Expand a named ClawSweeper test target with node:fs globSync, sort the files,
  and invoke the Node test runner without building the repository.

Targets:
  unit                test/*.test.ts
  repair              test/repair/*.test.ts and dist/repair/*.test.js
  all                 all unit and repair targets
  codex-process       test/codex-process.test.ts
  fix-prompt-builder  dist/repair/fix-prompt-builder.test.js
  workflow-sparse-checkout  test/repair/workflow-sparse-checkout.smoke.ts

Options:
  --test-concurrency <count>  Positive integer overriding the adaptive default
  -h, --help                  Show this help
  --                          Forward remaining arguments to node --test

Outputs:
  Writes the selected target, concurrency, and file count to stderr. Test output
  uses inherited stdio. The process preserves the child exit code or signal.

Examples:
  node scripts/run-node-tests.mjs unit
  node scripts/run-node-tests.mjs all --test-concurrency 4
  node scripts/run-node-tests.mjs all -- --experimental-test-coverage
`;

export function calculateTestConcurrency(parallelism = availableParallelism()) {
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new Error(`Available parallelism must be a positive integer, received ${parallelism}.`);
  }

  // Measurements on this suite show that higher fan-out increases Git fixture,
  // subprocess, and filesystem contention even on large hosts. Sixteen retains
  // useful parallelism without making that host-specific result a fixed demand.
  return Math.min(parallelism, MAX_TEST_CONCURRENCY);
}

export function parseArguments(argv) {
  const separatorIndex = argv.indexOf("--");
  const wrapperArguments = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  if (wrapperArguments.includes("--help") || wrapperArguments.includes("-h")) {
    return { help: true };
  }

  const [target, ...rest] = argv;
  if (!Object.hasOwn(TARGET_PATTERNS, target)) {
    throw new Error(
      `Target must be one of ${Object.keys(TARGET_PATTERNS).join(", ")}; received ${target ?? "nothing"}.`,
    );
  }

  let concurrency;
  const nodeArguments = [];
  let forwarding = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (forwarding) {
      if (argument === "--test" || argument.startsWith("--test-concurrency")) {
        throw new Error(
          "Do not forward --test or --test-concurrency; the runner owns those options.",
        );
      }
      nodeArguments.push(argument);
      continue;
    }
    if (argument === "--") {
      forwarding = true;
      continue;
    }
    if (argument === "--test-concurrency") {
      concurrency = parsePositiveInteger(rest[index + 1], "--test-concurrency");
      index += 1;
      continue;
    }
    if (argument.startsWith("--test-concurrency=")) {
      concurrency = parsePositiveInteger(
        argument.slice(argument.indexOf("=") + 1),
        "--test-concurrency",
      );
      continue;
    }
    throw new Error(`Unknown option ${argument}. Put Node test-runner options after --.`);
  }

  return { help: false, target, concurrency, nodeArguments };
}

export function resolveTestFiles(target, cwd = process.cwd()) {
  const patterns = TARGET_PATTERNS[target];
  if (!patterns) throw new Error(`Unknown test target: ${target}.`);

  return [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd })))].sort();
}

export async function runNodeTests({
  target,
  concurrency = calculateTestConcurrency(),
  nodeArguments = [],
  cwd = process.cwd(),
  spawnProcess = spawn,
  signalSource = process,
  baseTempDir = os.tmpdir(),
} = {}) {
  const files = resolveTestFiles(target, cwd);
  if (files.length === 0) {
    throw new Error(`Test target ${target} did not match any files in ${cwd}.`);
  }

  console.error(
    `[run-node-tests] target=${target} concurrency=${concurrency} files=${files.length}`,
  );
  removeStaleRunRoots(baseTempDir);
  const runRoot = fs.mkdtempSync(path.join(baseTempDir, RUN_PREFIX));
  const childEnv = { ...process.env, TMPDIR: runRoot, TEMP: runRoot, TMP: runRoot };
  delete childEnv.NODE_TEST_CONTEXT;
  const heartbeat = setInterval(() => touchRunRoot(runRoot), HEARTBEAT_MS);
  heartbeat.unref();
  let child;
  let forceTimer;
  let receivedSignal;
  let settled = false;
  const signalHandlers = new Map(
    FORWARDED_SIGNALS.map((signal) => [
      signal,
      () => {
        if (!child || settled) return;
        receivedSignal ??= signal;
        child.kill(signal);
        forceTimer ??= setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, SIGNAL_GRACE_MS);
        forceTimer.unref();
      },
    ]),
  );

  try {
    child = spawnProcess(
      process.execPath,
      ["--test", `--test-concurrency=${concurrency}`, ...nodeArguments, ...files],
      {
        cwd,
        env: childEnv,
        stdio: "inherit",
      },
    );
    for (const [signal, handler] of signalHandlers) signalSource.on(signal, handler);

    return await new Promise((resolve, reject) => {
      child.once("error", (error) => {
        settled = true;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        settled = true;
        resolve(receivedSignal ? { code: null, signal: receivedSignal } : { code, signal });
      });
    });
  } finally {
    clearInterval(heartbeat);
    if (forceTimer) clearTimeout(forceTimer);
    for (const [signal, handler] of signalHandlers) signalSource.removeListener(signal, handler);
    removeRunRoot(runRoot);
  }
}

export function applyProcessOutcome(
  outcome,
  { setExitCode = (code) => (process.exitCode = code), signalProcess = process.kill } = {},
) {
  if (outcome.signal) {
    signalProcess(process.pid, outcome.signal);
    return;
  }
  setExitCode(outcome.code ?? 1);
}

function parsePositiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    throw new Error(`${option} must be a positive integer; received ${value ?? "nothing"}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} must be a safe positive integer; received ${value}.`);
  }
  return parsed;
}

function removeStaleRunRoots(tempDir) {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue;
    const candidate = path.join(tempDir, entry.name);
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stats.mtimeMs < cutoff) removeRunRoot(candidate);
  }
}

function touchRunRoot(root) {
  try {
    const now = new Date();
    fs.utimesSync(root, now, now);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function removeRunRoot(root) {
  // Recursive removal unlinks FIFO, socket, and symlink fixtures without opening their contents.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    applyProcessOutcome(await runNodeTests(options));
  } catch (error) {
    console.error(`run-node-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
