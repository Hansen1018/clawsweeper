#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, candidateRoot, targetRoot, baseSha, pnpmCli, providedProfileRoot] =
  process.argv.slice(2);
if (!mode || !candidateRoot || !targetRoot || !baseSha) {
  throw new Error("usage: runtime-worker.mjs <git-hooks|process-leak> <candidate> <target> <base>");
}

if (mode === "git-hooks") {
  const targetValidation = await importCandidate("target-validation.js");
  try {
    targetValidation.assertTargetPublicationGitConfiguration(targetRoot);
    emit({ status: "accepted" });
  } catch (error) {
    emit({ status: "blocked", error: error instanceof Error ? error.message : String(error) });
  }
} else if (mode === "process-leak") {
  const commandRunner = await importCandidate("command-runner.js");
  if (!pnpmCli) throw new Error("process-leak mode requires the pinned pnpm CLI path");
  const profileRoot = providedProfileRoot
    ? path.resolve(providedProfileRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-runtime-profile-"));
  const ownsProfileRoot = !providedProfileRoot;
  fs.mkdirSync(profileRoot, { recursive: true });
  try {
    const containedCorepackHome = path.join(profileRoot, "corepack");
    const containedPnpmRoot = path.resolve(path.dirname(pnpmCli), "..");
    if (
      !containedPnpmRoot.startsWith(`${containedCorepackHome}${path.sep}`) ||
      !fs.existsSync(pnpmCli)
    ) {
      throw new Error("process-leak worker requires a materialized profile-local pnpm runtime");
    }
    const corepackBin = path.join(containedCorepackHome, "bin");
    fs.mkdirSync(corepackBin, { recursive: true });
    execFileSync("corepack", ["enable", "--install-directory", corepackBin, "pnpm"], {
      env: { ...process.env, COREPACK_HOME: containedCorepackHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const home = path.join(profileRoot, "home");
    const cache = path.join(profileRoot, "cache");
    const config = path.join(profileRoot, "config");
    const state = path.join(profileRoot, "state");
    const temporary = path.join(profileRoot, "tmp");
    for (const directory of [home, cache, config, state, temporary]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    // CWD is not a reliable ownership signal for leaked descendants; the marker
    // lets the independent oracle find children that chdir before the parent exits.
    const runtimeScope = { marker: profileRoot, profileRoot, targetRoot };
    let result;
    try {
      result = commandRunner.runContainedCommandResult("pnpm", ["check:changed"], {
        cwd: targetRoot,
        env: {
          ...process.env,
          CI: "true",
          CLAWSWEEPER_TARGET_BASE_SHA: baseSha,
          CLAWSWEEPER_TARGET_HEAD_SHA: "HEAD",
          CLAWSWEEPER_RUNTIME_E2E_MARKER: runtimeScope.marker,
          COREPACK_HOME: containedCorepackHome,
          HOME: home,
          OPENCLAW_LOCAL_CHECK: "0",
          NPM_CONFIG_USERCONFIG: path.join(config, "npmrc"),
          PATH: `${corepackBin}${path.delimiter}${process.env.PATH ?? ""}`,
          PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
          TMPDIR: temporary,
          XDG_CACHE_HOME: cache,
          XDG_CONFIG_HOME: config,
          XDG_STATE_HOME: state,
        },
        isolateNetwork: true,
        timeoutMs: 30 * 60 * 1000,
        writableRoots: [targetRoot, profileRoot],
      });
      emit({ cleanup: reapRuntimeProcesses(runtimeScope), status: "completed", result });
    } catch (error) {
      emit({
        cleanup: reapRuntimeProcesses(runtimeScope),
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        status: "failed",
      });
    }
  } finally {
    reapRuntimeProcesses({ marker: profileRoot, profileRoot, targetRoot });
    if (ownsProfileRoot) fs.rmSync(profileRoot, { recursive: true, force: true });
  }
} else {
  throw new Error(`unsupported runtime worker mode: ${mode}`);
}

async function importCandidate(file) {
  return import(pathToFileURL(path.join(candidateRoot, "dist/repair", file)).href);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reapRuntimeProcesses(scope) {
  const killed = [];
  if (process.platform !== "linux") return { killed };
  const descendants = descendantProcessIds(process.pid);
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    if (!belongsToRuntimeScope(pid, scope, descendants)) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
      killed.push(Number(pid));
    } catch {
      // The process may exit between snapshot and kill; the oracle only needs
      // cleanup to be best-effort after production containment has reaped.
    }
  }
  return { killed };
}

function belongsToRuntimeScope(pid, { marker, profileRoot, targetRoot }, descendants) {
  if (processHasMarkedEnvironment(pid, marker)) return true;
  if (!descendants.has(Number(pid))) return false;
  return (
    processPathInScope(`/proc/${pid}/cwd`, targetRoot) ||
    processPathInScope(`/proc/${pid}/cwd`, profileRoot) ||
    processPathInScope(`/proc/${pid}/root`, targetRoot) ||
    processPathInScope(`/proc/${pid}/root`, profileRoot)
  );
}

function descendantProcessIds(rootPid) {
  const parentByPid = new Map();
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const parent = parentProcessId(pid);
    if (parent !== null) parentByPid.set(Number(pid), parent);
  }
  const descendants = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parentByPid) {
      if (descendants.has(pid)) continue;
      if (parent === rootPid || descendants.has(parent)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

function parentProcessId(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return Number.parseInt(fields[1], 10);
  } catch {
    return null;
  }
}

function processHasMarkedEnvironment(pid, marker) {
  try {
    const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(`CLAWSWEEPER_RUNTIME_E2E_MARKER=${marker}`);
  } catch {
    return false;
  }
}

function processPathInScope(link, root) {
  let resolved;
  try {
    resolved = fs.realpathSync(link);
  } catch {
    return false;
  }
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
