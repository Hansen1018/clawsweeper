import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCandidateIdentityUnchanged, candidateIdentity } from "./candidate-revision.mjs";
import { artifactDirectory, digestStrings, writeProofSummary } from "./proof-bundle.mjs";
import { scenarioManifest } from "./scenarios.mjs";

const helperRoot = path.dirname(fileURLToPath(import.meta.url));
let publicationEnvironmentRoot = null;

// Publication scenarios intentionally use production publishing code against
// disposable local bare remotes. No GitHub refs, comments, labels, or PR state
// are touched while reproducing the state-tree loss cases.
export function runPublicationScenario({
  candidateRoot,
  outputRoot,
  scenario,
  mode = "candidate",
  keep = false,
}) {
  const manifest = scenarioManifest(scenario);
  if (manifest.kind !== "publication") throw new Error(`${scenario} is not a publication scenario`);
  const startedAtMs = Date.now();
  const artifacts = artifactDirectory(outputRoot, scenario);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publication-e2e-"));
  publicationEnvironmentRoot = root;
  try {
    const candidate = candidateIdentity(
      candidateRoot,
      mode === "reproducer" ? manifest.candidateRevision : null,
      mode === "reproducer" ? manifest.candidateExecutableDigest : null,
      mode === "reproducer" ? manifest.candidateDependencyDigest : null,
    );
    if (scenario === "publisher-canonical-path-conflict") {
      return immutableConflictScenario({
        artifacts,
        candidate,
        candidateRoot,
        manifest,
        mode,
        root,
        startedAtMs,
      });
    }
    const fixture = createShallowPublicationFixture(root);
    const writerMode = scenario === "publisher-two-parent-then-depth1" ? "merge" : "sibling";
    fs.writeFileSync(
      path.join(fixture.work, "results/local-publication.json"),
      '{"publisher":1}\n',
    );
    const barrier = publicationBarrier(root, writerMode, fixture.remote);
    const worker = spawnLocalOnlyNode(
      [
        path.join(helperRoot, "publication-worker.mjs"),
        path.resolve(candidateRoot),
        fixture.work,
        JSON.stringify(["results"]),
      ],
      { encoding: "utf8", env: sanitizedEnvironment(root, barrier), timeout: 120_000 },
    );
    writeChildLog(artifacts, "publisher-one", worker);
    assertCandidateIdentityUnchanged(candidateRoot, candidate);
    const writer = readWriterStatus(barrier.status);
    writeSyntheticChildLog(artifacts, "publisher-two", writer);

    const expectedPath =
      writerMode === "merge" ? "results/merge-right.json" : "results/concurrent-sibling.json";
    const remoteHead = remoteRef(fixture.remote, "main");
    const treePaths = git(["--git-dir", fixture.remote, "ls-tree", "-r", "--name-only", remoteHead])
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    const siblingPreserved = treePaths.includes(expectedPath);
    const localPreserved = treePaths.includes("results/local-publication.json");
    const siblingContentPreserved =
      siblingPreserved &&
      remoteFile(fixture.remote, remoteHead, expectedPath) === expectedContent(writerMode);
    const localContentPreserved =
      localPreserved &&
      remoteFile(fixture.remote, remoteHead, "results/local-publication.json") ===
        '{"publisher":1}\n';
    const baseContentPreserved =
      treePaths.includes("results/base.json") &&
      remoteFile(fixture.remote, remoteHead, "results/base.json") === '{"base":true}\n';
    const harnessError = writer.status !== 0 || timedOut(worker);
    const productViolation =
      worker.status !== 0 ||
      !siblingContentPreserved ||
      !localContentPreserved ||
      !baseContentPreserved;
    const failureFingerprint = productViolation
      ? worker.status !== 0
        ? "state-publication.publisher-did-not-converge"
        : !siblingContentPreserved
          ? writerMode === "merge"
            ? "state-publication.merge-tree-entry-lost"
            : "state-publication.concurrent-sibling-lost"
          : !localContentPreserved
            ? "state-publication.local-entry-lost"
            : "state-publication.base-entry-lost"
      : null;
    const graph = git([
      "--git-dir",
      fixture.remote,
      "log",
      "--graph",
      "--format=%H %P %s",
      "--all",
    ]);
    fs.writeFileSync(path.join(artifacts, "git-graph.txt"), graph);
    fs.writeFileSync(path.join(artifacts, "git-tree.txt"), `${treePaths.join("\n")}\n`);

    const summary = writeProofSummary({
      artifacts,
      manifest,
      mode,
      startedAtMs,
      observed: {
        harnessError,
        productViolation,
        failureFingerprint,
        clawsweeperSha: candidate.clawsweeperSha,
        candidateDependencyDigest: candidate.candidateDependencyDigest,
        candidateExecutableDigest: candidate.candidateExecutableDigest,
        fixtureDigest: digestStrings([fixture.initialHead, ...treePaths]),
        eventSequence: [
          "publisher-one-depth1-clone",
          `publisher-two-${writerMode}-push`,
          "publisher-one-production-publish",
          "remote-tree-oracle",
        ],
        actualOutcome: productViolation ? "remote-tree-incomplete" : "remote-tree-preserved",
        terminalProductState: productViolation ? "blocked" : "published",
        gitRefsAndTreeDigest: digestStrings([remoteHead, ...treePaths]),
        childProcessSnapshot: [
          { name: "publisher-two", exit_code: writer.status },
          { name: "publisher-one", exit_code: worker.status },
        ],
        invariant: `publisher one must preserve ${expectedPath}, its own publication, and the initial state tree`,
        error: worker.status === 0 ? null : normalizeError(`${worker.stderr}\n${worker.stdout}`),
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
        phase: manifest.phase,
        actualOutcome: "harness-error",
        terminalProductState: "unknown",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
    });
    return { summary, artifacts };
  } finally {
    publicationEnvironmentRoot = null;
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

function createShallowPublicationFixture(root) {
  const remote = path.join(root, "state.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "publisher-one");
  git(["init", "--bare", remote]);
  git(["clone", remote, seed]);
  configureUser(seed, "Fixture Seeder");
  write(path.join(seed, "results/base.json"), '{"base":true}\n');
  git(["add", "."], seed);
  git(["commit", "-m", "chore: seed state"], seed);
  git(["push", "origin", "HEAD:main"], seed);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["clone", "--depth", "1", `file://${remote}`, work]);
  configureUser(work, "Publisher One");
  return { remote, seed, work, initialHead: remoteRef(remote, "main") };
}

function immutableConflictScenario({
  artifacts,
  candidate,
  candidateRoot,
  manifest,
  mode,
  root,
  startedAtMs,
}) {
  const fixture = createShallowPublicationFixture(root);
  const ledgerRoot = path.join(fixture.work, "ledger-root");
  fs.mkdirSync(ledgerRoot);
  const immutable = spawnLocalOnlyNode(
    [path.join(helperRoot, "immutable-ledger-worker.mjs"), path.resolve(candidateRoot), ledgerRoot],
    { encoding: "utf8", env: sanitizedEnvironment(root), timeout: 120_000 },
  );
  writeChildLog(artifacts, "immutable-ledger", immutable);
  const observation = immutable.status === 0 ? parseLastJsonLine(immutable.stdout) : {};
  const publisher = spawnLocalOnlyNode(
    [
      path.join(helperRoot, "publication-worker.mjs"),
      path.resolve(candidateRoot),
      fixture.work,
      JSON.stringify(["ledger-root"]),
    ],
    { encoding: "utf8", env: sanitizedEnvironment(root), timeout: 120_000 },
  );
  writeChildLog(artifacts, "immutable-publisher", publisher);
  assertCandidateIdentityUnchanged(candidateRoot, candidate);
  const remoteHead = remoteRef(fixture.remote, "main");
  const treePaths = git(["--git-dir", fixture.remote, "ls-tree", "-r", "--name-only", remoteHead])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  const immutablePath = observation.relative_path
    ? path.posix.join("ledger-root", String(observation.relative_path).replaceAll(path.sep, "/"))
    : null;
  const immutablePathExists = Boolean(immutablePath && treePaths.includes(immutablePath));
  const conflictBlocked =
    immutable.status === 0 &&
    publisher.status === 0 &&
    observation.original_preserved === true &&
    immutablePathExists &&
    remoteFile(fixture.remote, remoteHead, immutablePath) === observation.original_text &&
    observation.conflict_detected === true;
  const productViolation = !conflictBlocked;
  const harnessError =
    immutable.status !== 0 || publisher.status !== 0 || timedOut(immutable) || timedOut(publisher);
  const summary = writeProofSummary({
    artifacts,
    manifest,
    mode,
    startedAtMs,
    observed: {
      harnessError,
      productViolation,
      failureFingerprint: productViolation
        ? "state-publication.immutable-path-not-preserved"
        : null,
      clawsweeperSha: candidate.clawsweeperSha,
      candidateDependencyDigest: candidate.candidateDependencyDigest,
      candidateExecutableDigest: candidate.candidateExecutableDigest,
      fixtureDigest: digestStrings([fixture.initialHead, immutablePath, ...treePaths]),
      eventSequence: [
        "production-canonical-path-create",
        "production-conflicting-replay",
        "production-state-publish",
        "remote-tree-oracle",
      ],
      actualOutcome: conflictBlocked ? "blocked" : "immutable-path-not-preserved",
      terminalProductState: conflictBlocked ? "blocked" : "unsafe",
      gitRefsAndTreeDigest: digestStrings([remoteHead, ...treePaths]),
      childProcessSnapshot: [
        { name: "immutable-ledger", exit_code: immutable.status },
        { name: "immutable-publisher", exit_code: publisher.status },
      ],
      invariant: "an immutable canonical path cannot be overwritten with different bytes",
      error:
        immutable.status === 0 && publisher.status === 0
          ? null
          : normalizeError(`${immutable.stderr}\n${publisher.stderr}`),
    },
  });
  return { summary, artifacts };
}

function spawnLocalOnlyNode(args, options) {
  // PATH shims prove command routing, but the phase boundary also requires an
  // outer egress-deny layer that candidate code cannot bypass with absolute tools.
  return spawnSync(
    "/usr/bin/unshare",
    ["--user", "--map-root-user", "--net", process.execPath, ...args],
    options,
  );
}

function parseLastJsonLine(stdout) {
  const line = String(stdout).trim().split("\n").at(-1);
  if (!line) throw new Error("publication worker produced no observation");
  return JSON.parse(line);
}

function writeChildLog(artifacts, name, child) {
  fs.writeFileSync(path.join(artifacts, `${name}.stdout.log`), child.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, `${name}.stderr.log`), child.stderr ?? "");
}

function publicationBarrier(root, writerMode, remote) {
  return {
    fired: path.join(root, "publication-barrier-fired"),
    mode: writerMode,
    remote,
    script: path.join(helperRoot, "publication-writer.mjs"),
    status: path.join(root, "publication-writer-status.json"),
    workspace: path.join(root, "publisher-two"),
  };
}

function readWriterStatus(file) {
  if (!fs.existsSync(file))
    return { status: 1, stderr: "publication writer barrier did not fire\n", stdout: "" };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeSyntheticChildLog(artifacts, name, child) {
  fs.writeFileSync(path.join(artifacts, `${name}.stdout.log`), child.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, `${name}.stderr.log`), child.stderr ?? "");
}

function sanitizedEnvironment(isolationRoot = null, barrier = null) {
  const root = isolationRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-e2e-env-"));
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const fakeBin = path.join(root, "fake-bin");
  for (const directory of [home, config, fakeBin]) fs.mkdirSync(directory, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  if (!fs.existsSync(fakeGh)) {
    fs.writeFileSync(
      fakeGh,
      "#!/usr/bin/env sh\necho 'real gh disabled in local E2E' >&2\nexit 127\n",
    );
    fs.chmodSync(fakeGh, 0o755);
  }
  const fakeGit = path.join(fakeBin, "git");
  if (!fs.existsSync(fakeGit)) {
    fs.symlinkSync(path.join(helperRoot, "git-proxy.mjs"), fakeGit);
  }
  const env = {
    GIT_AUTHOR_DATE: "2026-07-20T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-07-20T00:00:00Z",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: root,
    TZ: "UTC",
    XDG_CONFIG_HOME: config,
  };
  if (barrier) {
    env.CLAWSWEEPER_E2E_PUBLICATION_BARRIER_FIRED = barrier.fired;
    env.CLAWSWEEPER_E2E_PUBLICATION_WRITER_MODE = barrier.mode;
    env.CLAWSWEEPER_E2E_PUBLICATION_WRITER_REMOTE = barrier.remote;
    env.CLAWSWEEPER_E2E_PUBLICATION_WRITER_SCRIPT = barrier.script;
    env.CLAWSWEEPER_E2E_PUBLICATION_WRITER_STATUS = barrier.status;
    env.CLAWSWEEPER_E2E_PUBLICATION_WRITER_WORKSPACE = barrier.workspace;
  }
  return env;
}

function configureUser(worktree, name) {
  git(["config", "user.name", name], worktree);
  git(["config", "user.email", "e2e@example.invalid"], worktree);
}

function remoteRef(remote, branch) {
  return git(["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]).trim();
}

function remoteFile(remote, revision, file) {
  return git(["--git-dir", remote, "show", `${revision}:${file}`]);
}

function expectedContent(writerMode) {
  return writerMode === "merge" ? '{"parent":"right"}\n' : '{"publisher":2}\n';
}

function timedOut(child) {
  return child.error?.code === "ETIMEDOUT";
}

function normalizeError(value) {
  return value
    .replaceAll(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replaceAll(/\/tmp\/[^\s]+/g, "<tmp>")
    .trim();
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function git(args, cwd = process.cwd()) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedEnvironment(publicationEnvironmentRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
