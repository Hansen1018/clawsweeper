import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactDirectory, digestStrings, writeProofSummary } from "./proof-bundle.mjs";
import {
  assertCandidateIdentityUnchanged,
  candidateDependencyDigest,
  candidateExecutableDigest,
  candidateIdentity,
} from "./candidate-revision.mjs";
import { scenarioManifest } from "./scenarios.mjs";

const helperRoot = path.dirname(fileURLToPath(import.meta.url));

export function runRuntimeScenario({
  candidateRoot,
  openclawMirror,
  outputRoot,
  scenario,
  mode = "candidate",
  keep = false,
}) {
  const manifest = scenarioManifest(scenario);
  if (manifest.kind !== "runtime") throw new Error(`${scenario} is not a runtime scenario`);
  const startedAtMs = Date.now();
  const artifacts = artifactDirectory(outputRoot, scenario);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-openclaw-e2e-"));
  try {
    const candidate = candidateIdentity(
      candidateRoot,
      mode === "reproducer" ? manifest.candidateRevision : null,
      mode === "reproducer" ? manifest.candidateExecutableDigest : null,
      mode === "reproducer" ? manifest.candidateDependencyDigest : null,
    );
    verifyObject(openclawMirror, manifest.openclawBaseRevision, "OpenClaw base");
    verifyObject(openclawMirror, manifest.openclawHeadRevision, "OpenClaw head");
    const workerMode = scenario.endsWith("git-hooks-path") ? "git-hooks" : "process-leak";
    let warmupObservation = null;
    if (workerMode === "process-leak") {
      const warmupAttempt = prepareRuntimeAttempt({
        artifacts,
        manifest,
        openclawMirror,
        root: path.join(root, "warmup"),
        setupLogName: "openclaw-setup-warmup",
        workerMode,
      });
      const warmup = spawnRuntimeWorker({
        baseRevision: manifest.openclawBaseRevision,
        candidateRoot,
        fixture: warmupAttempt.fixture,
        pnpmCli: warmupAttempt.dependencies.pnpmCli,
        workerMode,
      });
      writeChildLog(artifacts, "runtime-worker-warmup", warmup);
      assert.equal(warmup.status, 0, `${warmup.stderr}\n${warmup.stdout}`);
      assertCandidateIdentityUnchanged(candidateRoot, candidate);
      assertFixtureDigestUnchanged(
        warmupAttempt.fixtureDigest,
        openClawFixtureDigest({
          configuredHooksPath: warmupAttempt.configuredHooksPath,
          dependencyCacheDigest: warmupAttempt.dependencies.dependencyCacheDigest,
          manifest,
          worktree: warmupAttempt.fixture.work,
        }),
      );
      warmupObservation = parseLastJsonLine(warmup.stdout);
    }
    const finalAttempt = prepareRuntimeAttempt({
      artifacts,
      manifest,
      openclawMirror,
      root: path.join(root, "final"),
      setupLogName: "openclaw-setup",
      workerMode,
    });
    const worker = spawnRuntimeWorker({
      baseRevision: manifest.openclawBaseRevision,
      candidateRoot,
      fixture: finalAttempt.fixture,
      pnpmCli: finalAttempt.dependencies.pnpmCli,
      workerMode,
    });
    writeChildLog(artifacts, "runtime-worker", worker);
    assert.equal(worker.status, 0, `${worker.stderr}\n${worker.stdout}`);
    assertCandidateIdentityUnchanged(candidateRoot, candidate);
    assertFixtureDigestUnchanged(
      finalAttempt.fixtureDigest,
      openClawFixtureDigest({
        configuredHooksPath: finalAttempt.configuredHooksPath,
        dependencyCacheDigest: finalAttempt.dependencies.dependencyCacheDigest,
        manifest,
        worktree: finalAttempt.fixture.work,
      }),
    );
    const observation = parseLastJsonLine(worker.stdout);
    const observed = runtimeObservation({
      manifest,
      workerMode,
      observation,
      warmupObservation,
      configuredHooksPath: finalAttempt.configuredHooksPath,
    });
    const summary = writeProofSummary({
      artifacts,
      manifest,
      mode,
      startedAtMs,
      observed: {
        ...observed,
        clawsweeperSha: candidate.clawsweeperSha,
        candidateDependencyDigest: candidate.candidateDependencyDigest,
        candidateExecutableDigest: candidate.candidateExecutableDigest,
        openclawBaseSha: manifest.openclawBaseRevision,
        openclawHeadSha: manifest.openclawHeadRevision,
        fixtureDigest: finalAttempt.fixtureDigest,
        eventSequence: [
          "openclaw-real-clone",
          "openclaw-prepare-git-hooks",
          workerMode === "git-hooks"
            ? "production-git-safety-check"
            : "repair-worker-contained-check-changed-warmup",
          ...(workerMode === "process-leak" ? ["production-contained-check-changed-final"] : []),
          "product-terminal-state-oracle",
        ],
        childProcessSnapshot: observed.childProcessSnapshot ?? [],
        invariant:
          workerMode === "git-hooks"
            ? "real setup callback configuration must hit the exact production safety phase"
            : "workflow success cannot override a blocked product state or leaked child processes",
      },
    });
    return { summary, artifacts };
  } catch (error) {
    const summary = writeProofSummary({
      artifacts,
      manifest,
      mode,
      startedAtMs,
      observed: {
        harnessError: true,
        actualOutcome: "harness-error",
        terminalProductState: "unknown",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    });
    return { summary, artifacts };
  } finally {
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

function runtimeObservation({
  manifest,
  workerMode,
  observation,
  warmupObservation,
  configuredHooksPath,
}) {
  if (workerMode === "git-hooks") {
    const exactError = "unsafe target Git callback configuration: core.hookspath";
    const reproduced = configuredHooksPath === "git-hooks" && observation.error === exactError;
    const accepted = observation.status === "accepted";
    return {
      harnessError: !accepted && !reproduced,
      productViolation: reproduced,
      failureFingerprint: reproduced ? manifest.expectedFingerprint : null,
      phase: "target-setup-git-safety",
      actualOutcome: accepted ? "accepted" : "blocked",
      terminalProductState: reproduced ? "blocked" : accepted ? "passed" : "unknown",
      error: observation.error ?? null,
      childProcessSnapshot: [],
    };
  }
  const backgroundProcesses = processCount(observation);
  const warmupBackgroundProcesses =
    warmupObservation === null || warmupObservation === undefined
      ? null
      : processCount(warmupObservation);
  const cleanupCount = cleanupKilledCount(observation);
  const warmupCleanupCount =
    warmupObservation === null || warmupObservation === undefined
      ? null
      : cleanupKilledCount(warmupObservation);
  const reproduced =
    observation.result?.status === 0 &&
    backgroundProcesses === 4 &&
    (warmupObservation === null ||
      (warmupObservation.result?.status === 0 && warmupBackgroundProcesses === 4));
  const independentlyLeaked = (cleanupCount ?? 0) > 0 || (warmupCleanupCount ?? 0) > 0;
  const green =
    observation.result?.status === 0 &&
    backgroundProcesses === 0 &&
    cleanupCount === 0 &&
    (warmupObservation === null ||
      (warmupObservation.result?.status === 0 &&
        warmupBackgroundProcesses === 0 &&
        warmupCleanupCount === 0));
  return {
    harnessError: !reproduced && !independentlyLeaked && !green,
    productViolation: reproduced || independentlyLeaked,
    failureFingerprint: reproduced
      ? manifest.expectedFingerprint
      : independentlyLeaked
        ? "openclaw.runtime-descendant-leak"
        : null,
    phase: "target-validation-process-drain",
    actualOutcome: reproduced
      ? "workflow-success-product-blocked"
      : independentlyLeaked
        ? "validation-left-runtime-descendants"
        : green
          ? "validation-clean"
          : "unexpected-runtime-result",
    terminalProductState:
      reproduced || independentlyLeaked ? "blocked" : green ? "passed" : "unknown",
    error: observation.result?.error?.message ?? null,
    childProcessSnapshot: [
      ...(warmupBackgroundProcesses === null
        ? []
        : [
            {
              name: "pnpm check:changed warmup descendants",
              count_after_exit: warmupBackgroundProcesses,
              command_exit_code: warmupObservation.result?.status ?? null,
              cleanup_killed: warmupCleanupCount,
            },
          ]),
      {
        name: "pnpm check:changed final descendants",
        count_after_exit: backgroundProcesses,
        command_exit_code: observation.result?.status ?? null,
        cleanup_killed: cleanupCount,
      },
    ],
  };
}

function cleanupKilledCount(observation) {
  return Array.isArray(observation.cleanup?.killed) ? observation.cleanup.killed.length : null;
}

function processCount(observation) {
  return Number.isInteger(observation.result?.backgroundProcesses)
    ? observation.result.backgroundProcesses
    : null;
}

function prepareRuntimeAttempt({
  artifacts,
  manifest,
  openclawMirror,
  root,
  setupLogName,
  workerMode,
}) {
  fs.mkdirSync(root, { recursive: true });
  const fixture = createOpenClawFixture({ root, mirror: openclawMirror, manifest });
  const setup = spawnSync(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--net",
      process.execPath,
      path.join(fixture.work, "scripts/prepare-git-hooks.mjs"),
    ],
    {
      cwd: fixture.work,
      encoding: "utf8",
      env: offlineEnvironment(root),
      timeout: 5 * 60 * 1000,
    },
  );
  writeChildLog(artifacts, setupLogName, setup);
  assert.equal(setup.status, 0, `${setup.stderr}\n${setup.stdout}`);
  const configuredHooksPath = git(
    ["config", "--local", "--get", "core.hooksPath"],
    fixture.work,
  ).trim();
  const dependencies =
    workerMode === "process-leak"
      ? prepareDependencies({
          expectedDependencyCacheDigest: manifest.expectedDependencyCacheDigest,
          mirror: openclawMirror,
          revision: manifest.openclawHeadRevision,
          worktree: fixture.work,
        })
      : { dependencyCacheDigest: null, pnpmCli: "" };
  const fixtureDigest = openClawFixtureDigest({
    configuredHooksPath,
    dependencyCacheDigest: dependencies.dependencyCacheDigest,
    manifest,
    worktree: fixture.work,
  });
  return { configuredHooksPath, dependencies, fixture, fixtureDigest };
}

function spawnRuntimeWorker({ baseRevision, candidateRoot, fixture, pnpmCli, workerMode }) {
  const workerProfileRoot = fs.mkdtempSync(
    path.join(path.dirname(fixture.work), "runtime-profile-"),
  );
  const workerScript = path.join(workerProfileRoot, "runtime-worker.mjs");
  fs.copyFileSync(path.join(helperRoot, "runtime-worker.mjs"), workerScript);
  const containedCandidateRoot = materializeContainedCandidate(candidateRoot, workerProfileRoot);
  const containedPnpmCli =
    workerMode === "process-leak" ? materializeContainedPnpm(pnpmCli, workerProfileRoot) : "";
  const containedCandidateDigest = candidateExecutableDigest(containedCandidateRoot);
  const containedCandidateDependencyDigest = candidateDependencyDigest(containedCandidateRoot);
  if (containedCandidateDigest !== candidateExecutableDigest(candidateRoot)) {
    throw new Error(
      "contained runtime candidate executable digest does not match source candidate",
    );
  }
  if (containedCandidateDependencyDigest !== candidateDependencyDigest(candidateRoot)) {
    throw new Error(
      "contained runtime candidate dependency digest does not match source candidate",
    );
  }
  const input = {
    command: process.execPath,
    args: [
      workerScript,
      workerMode,
      containedCandidateRoot,
      fixture.work,
      baseRevision,
      containedPnpmCli,
      workerProfileRoot,
    ],
    cwd: fixture.work,
    isolateNetwork: true,
    maxBuffer: 64 * 1024 * 1024,
    timeoutMs: 35 * 60 * 1000,
    windowsVerbatimArguments: false,
    writableRoots: [fixture.work, workerProfileRoot],
  };
  const supervisor =
    workerMode === "process-leak"
      ? spawnEgressIsolatedWorker(input, fixture.work)
      : spawnFilesystemContainedWorker(input, fixture.work);
  if (workerMode === "process-leak") {
    return verifyDirectRuntimeWorker(supervisor, {
      containedCandidateDependencyDigest,
      containedCandidateDigest,
      containedCandidateRoot,
    });
  }
  return unwrapContainedRuntimeWorker(supervisor, {
    containedCandidateDependencyDigest,
    containedCandidateDigest,
    containedCandidateRoot,
  });
}

function verifyDirectRuntimeWorker(
  worker,
  { containedCandidateDependencyDigest, containedCandidateDigest, containedCandidateRoot },
) {
  const finalContainedCandidateDigest = candidateExecutableDigest(containedCandidateRoot);
  if (finalContainedCandidateDigest !== containedCandidateDigest) {
    return {
      ...worker,
      status: 1,
      stderr: `contained candidate executable changed during scenario: expected ${containedCandidateDigest}, got ${finalContainedCandidateDigest}`,
    };
  }
  const finalContainedCandidateDependencyDigest = candidateDependencyDigest(containedCandidateRoot);
  if (finalContainedCandidateDependencyDigest !== containedCandidateDependencyDigest) {
    return {
      ...worker,
      status: 1,
      stderr: `contained candidate dependency tree changed during scenario: expected ${containedCandidateDependencyDigest}, got ${finalContainedCandidateDependencyDigest}`,
    };
  }
  return worker;
}

function spawnEgressIsolatedWorker(input, cwd) {
  // This historical candidate creates its own production filesystem sandbox for
  // check:changed. Nesting a second chroot changes that candidate's namespace
  // setup before its oracle runs, so only the independent network boundary sits
  // outside it; its production containment remains the filesystem authority.
  return spawnSync(
    "/usr/bin/unshare",
    ["--user", "--map-root-user", "--net", input.command, ...input.args],
    {
      cwd,
      encoding: "utf8",
      env: offlineEnvironment(path.dirname(cwd)),
      maxBuffer: 768 * 1024 * 1024,
      timeout: 36 * 60 * 1000,
    },
  );
}

function spawnFilesystemContainedWorker(input, cwd) {
  return spawnSync(
    process.execPath,
    [path.resolve(helperRoot, "../../../dist/repair/contained-command-worker.js")],
    {
      cwd,
      encoding: "utf8",
      env: offlineEnvironment(path.dirname(cwd)),
      input: JSON.stringify(input),
      maxBuffer: 768 * 1024 * 1024,
      timeout: 36 * 60 * 1000,
    },
  );
}

function materializeContainedPnpm(pnpmCli, workerProfileRoot) {
  const sourceCli = path.resolve(pnpmCli);
  const sourceRoot = path.dirname(path.dirname(sourceCli));
  if (path.basename(path.dirname(sourceCli)) !== "bin" || !fs.existsSync(sourceCli)) {
    throw new Error(`pinned pnpm CLI is not a readable package runtime: ${sourceCli}`);
  }
  const containedRoot = path.join(
    workerProfileRoot,
    "corepack",
    "v1",
    "pnpm",
    path.basename(sourceRoot),
  );
  fs.mkdirSync(path.dirname(containedRoot), { recursive: true });
  // The containment worker cannot read the host Corepack cache. Materializing
  // this fixed runtime before entering the boundary preserves offline execution.
  fs.cpSync(sourceRoot, containedRoot, { recursive: true });
  return path.join(containedRoot, "bin", path.basename(sourceCli));
}

function materializeContainedCandidate(candidateRoot, workerProfileRoot) {
  const containedCandidateRoot = path.join(workerProfileRoot, "candidate");
  fs.mkdirSync(containedCandidateRoot, { recursive: true });
  fs.cpSync(
    path.join(path.resolve(candidateRoot), "dist"),
    path.join(containedCandidateRoot, "dist"),
    { recursive: true },
  );
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const source = path.join(path.resolve(candidateRoot), file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(containedCandidateRoot, file));
  }
  const nodeModules = fs.realpathSync(path.join(path.resolve(candidateRoot), "node_modules"));
  const containedNodeModules = path.join(containedCandidateRoot, "node_modules");
  fs.mkdirSync(containedNodeModules, { recursive: true });
  execFileSync("/usr/bin/cp", ["-a", "--reflink=auto", `${nodeModules}/.`, containedNodeModules], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return containedCandidateRoot;
}

function unwrapContainedRuntimeWorker(
  supervisor,
  { containedCandidateDependencyDigest, containedCandidateDigest, containedCandidateRoot },
) {
  if (supervisor.status !== 0 || supervisor.error) return supervisor;
  const finalContainedCandidateDigest = candidateExecutableDigest(containedCandidateRoot);
  if (finalContainedCandidateDigest !== containedCandidateDigest) {
    return {
      ...supervisor,
      status: 1,
      stderr: `contained candidate executable changed during scenario: expected ${containedCandidateDigest}, got ${finalContainedCandidateDigest}`,
      stdout: supervisor.stdout,
    };
  }
  const finalContainedCandidateDependencyDigest = candidateDependencyDigest(containedCandidateRoot);
  if (finalContainedCandidateDependencyDigest !== containedCandidateDependencyDigest) {
    return {
      ...supervisor,
      status: 1,
      stderr: `contained candidate dependency tree changed during scenario: expected ${containedCandidateDependencyDigest}, got ${finalContainedCandidateDependencyDigest}`,
      stdout: supervisor.stdout,
    };
  }
  let contained;
  try {
    contained = JSON.parse(supervisor.stdout);
  } catch (error) {
    return {
      ...supervisor,
      status: 1,
      stderr: `outer runtime worker returned invalid containment output: ${
        error instanceof Error ? error.message : String(error)
      }`,
      stdout: supervisor.stdout,
    };
  }
  const stderr = [
    contained.stderr ?? "",
    contained.error?.message ?? "",
    contained.backgroundProcesses > 0
      ? `outer runtime worker left ${contained.backgroundProcesses} background process(es)`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ...supervisor,
    signal: contained.signal ?? supervisor.signal,
    status: contained.error || contained.backgroundProcesses > 0 ? 1 : contained.status,
    stderr,
    stdout: contained.stdout ?? "",
  };
}

function createOpenClawFixture({ root, mirror, manifest }) {
  const remote = path.join(root, "target.git");
  const work = path.join(root, "target");
  // The OpenClaw mirror is the immutable cache; fixture remotes must not share
  // object inodes with it because candidate code runs against the fixture.
  git(["clone", "--bare", "--no-hardlinks", path.resolve(mirror), remote]);
  git(["--git-dir", remote, "update-ref", "refs/heads/main", manifest.openclawBaseRevision]);
  git([
    "--git-dir",
    remote,
    "update-ref",
    "refs/heads/contributor/110725",
    manifest.openclawHeadRevision,
  ]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["clone", remote, work]);
  configureUser(work);
  git(["checkout", "-B", "incident-repair", manifest.openclawHeadRevision], work);
  applyIncidentRepairEdit(work);
  return { remote, work };
}

function openClawFixtureDigest({ configuredHooksPath, dependencyCacheDigest, manifest, worktree }) {
  const targetModules = path.join(worktree, "node_modules");
  return digestStrings([
    manifest.openclawBaseRevision,
    manifest.openclawHeadRevision,
    configuredHooksPath,
    dependencyCacheDigest ?? "no-dependency-cache",
    git(["rev-parse", "HEAD^{tree}"], worktree).trim(),
    git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ":!node_modules"],
      worktree,
    ),
    git(["diff", "--binary"], worktree),
    git(["diff", "--cached", "--binary"], worktree),
    fs.existsSync(targetModules)
      ? treeContentDigest(targetModules, "OpenClaw target dependency tree")
      : "no-target-dependency-tree",
  ]);
}

function assertFixtureDigestUnchanged(expected, actual) {
  if (actual !== expected) {
    throw new Error(
      `OpenClaw runtime fixture changed during scenario: expected ${expected}, got ${actual}`,
    );
  }
}

function applyIncidentRepairEdit(worktree) {
  const file = path.join(worktree, "src/plugins/contracts/tts-contract-suites.ts");
  const source = fs.readFileSync(file, "utf8");
  // Decision: these API-key-shaped fixture strings are the exact historical
  // OpenClaw delta. They are not credentials and are hashed into the proof
  // digest so the process-leak reproducer fails closed if the input drifts.
  const keyField = "api" + "Key";
  const repairedValue = "test-" + "api-key";
  const original = `                    ${keyField}: "test-key",\n                    baseUrl,`;
  const repaired = `                    ${keyField}: "${repairedValue}",\n                    baseUrl,`;
  if (!source.includes(original) || source.indexOf(original) !== source.lastIndexOf(original)) {
    throw new Error("pinned OpenClaw incident repair edit no longer has one exact target");
  }
  fs.writeFileSync(file, source.replace(original, repaired));
}

function prepareDependencies({ expectedDependencyCacheDigest, mirror, revision, worktree }) {
  const modules = path.join(path.resolve(mirror), "node_modules");
  if (!fs.existsSync(modules)) {
    throw new Error(`OpenClaw dependency cache is missing: ${modules}`);
  }
  const packageJson = JSON.parse(git(["-C", mirror, "show", `${revision}:package.json`]));
  const packageManager = String(packageJson.packageManager ?? "");
  const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/.exec(packageManager);
  if (!match)
    throw new Error(`OpenClaw packageManager is not an exact pnpm selector: ${packageManager}`);
  const corepackHome = process.env.COREPACK_HOME ?? path.join(os.homedir(), ".cache/node/corepack");
  const pinnedPnpmRoot = path.join(corepackHome, "v1", "pnpm", match[1]);
  const pnpmCli = path.join(pinnedPnpmRoot, "bin", "pnpm.cjs");
  if (!fs.existsSync(pnpmCli)) {
    throw new Error(`pinned OpenClaw pnpm runtime is missing: ${pnpmCli}`);
  }
  const dependencyCacheDigest = digestStrings([
    packageManager,
    git(["-C", mirror, "show", `${revision}:pnpm-lock.yaml`]),
    dependencyTreeDigest(modules),
    treeContentDigest(pinnedPnpmRoot, "pinned pnpm runtime"),
  ]);
  if (expectedDependencyCacheDigest && dependencyCacheDigest !== expectedDependencyCacheDigest) {
    throw new Error(
      `OpenClaw dependency cache digest mismatch: expected ${expectedDependencyCacheDigest}, got ${dependencyCacheDigest}`,
    );
  }
  // A contained command cannot follow a symlink back to an unmounted host
  // checkout. Reflink/hardlink-capable local copies keep the fixture isolated
  // without turning the dependency cache into a writable sandbox root.
  execFileSync(
    "/usr/bin/cp",
    ["-a", "--reflink=auto", modules, path.join(worktree, "node_modules")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return { dependencyCacheDigest, pnpmCli };
}

function dependencyTreeDigest(modules) {
  const metadata = path.join(modules, ".modules.yaml");
  if (!fs.existsSync(metadata)) {
    throw new Error(`OpenClaw dependency metadata is missing: ${metadata}`);
  }
  return treeContentDigest(modules, "OpenClaw dependency tree");
}

function treeContentDigest(root, label) {
  const hash = crypto.createHash("sha256");
  for (const entry of dependencyEntries(root)) {
    const relative = path.relative(root, entry).split(path.sep).join("/");
    const stat = fs.lstatSync(entry);
    hash.update(relative).update("\0");
    hash.update(String(stat.mode & 0o777)).update("\0");
    if (stat.isSymbolicLink()) {
      hash.update("symlink").update("\0").update(fs.readlinkSync(entry)).update("\0");
    } else if (stat.isFile()) {
      hash.update("file").update("\0").update(fs.readFileSync(entry)).update("\0");
    } else if (stat.isDirectory()) {
      hash.update("directory").update("\0");
    } else {
      throw new Error(`${label} contains unsupported entry: ${entry}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function dependencyEntries(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const resolved = path.join(root, entry.name);
      if (entry.isDirectory()) return [resolved, ...dependencyEntries(resolved)];
      return [resolved];
    })
    .sort();
}

function verifyObject(repository, revision, label) {
  const result = spawnSync("/usr/bin/git", [
    "-C",
    repository,
    "cat-file",
    "-e",
    `${revision}^{commit}`,
  ]);
  if (result.status !== 0) throw new Error(`${label} object is missing: ${revision}`);
}

function configureUser(worktree) {
  git(["config", "user.name", "ClawSweeper E2E"], worktree);
  git(["config", "user.email", "e2e@example.invalid"], worktree);
}

function parseLastJsonLine(stdout) {
  const line = String(stdout).trim().split("\n").at(-1);
  if (!line) throw new Error("runtime worker produced no observation");
  return JSON.parse(line);
}

function offlineEnvironment(isolationRoot) {
  const home = path.join(isolationRoot, "home");
  const config = path.join(isolationRoot, "config");
  const fakeBin = path.join(isolationRoot, "fake-bin");
  for (const directory of [home, config, fakeBin]) fs.mkdirSync(directory, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  if (!fs.existsSync(fakeGh)) {
    fs.writeFileSync(
      fakeGh,
      "#!/usr/bin/env sh\necho 'real gh disabled in local E2E' >&2\nexit 127\n",
    );
    fs.chmodSync(fakeGh, 0o755);
  }
  const env = {
    CI: "true",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    npm_config_offline: "true",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: config,
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function writeChildLog(artifacts, name, child) {
  fs.writeFileSync(path.join(artifacts, `${name}.stdout.log`), child.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, `${name}.stderr.log`), child.stderr ?? "");
}

function git(args, cwd = process.cwd()) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitEnvironment() {
  const root = path.join(os.tmpdir(), "clawsweeper-runtime-git-env");
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env = {
    ...inheritedToolEnvironment(),
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    XDG_CONFIG_HOME: config,
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function inheritedToolEnvironment() {
  // Fixture Git commands must not inherit caller GIT_* context; that would make
  // the supposedly isolated bare remotes depend on whichever repository invoked
  // the harness.
  const names = ["LANG", "LC_ALL", "PATH", "TERM", "TMPDIR", "TZ"];
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
