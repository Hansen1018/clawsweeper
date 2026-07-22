import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function candidateRevision(candidateRoot) {
  return execFileSync("/usr/bin/git", ["-C", path.resolve(candidateRoot), "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: gitProofEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function assertCandidateRevision(candidateRoot, expectedRevision) {
  const actual = candidateRevision(candidateRoot);
  if (expectedRevision && actual !== expectedRevision) {
    throw new Error(
      `ClawSweeper candidate revision mismatch: expected ${expectedRevision}, got ${actual}`,
    );
  }
  return actual;
}

export function candidateIdentity(
  candidateRoot,
  expectedRevision,
  expectedExecutableDigest,
  expectedDependencyDigest,
) {
  const clawsweeperSha = assertCandidateRevision(candidateRoot, expectedRevision);
  const candidateExecutableDigest = candidateExecutableDigestForRoot(candidateRoot);
  if (expectedExecutableDigest && candidateExecutableDigest !== expectedExecutableDigest) {
    throw new Error(
      `ClawSweeper candidate executable digest mismatch: expected ${expectedExecutableDigest}, got ${candidateExecutableDigest}`,
    );
  }
  const candidateDependencyDigest = candidateDependencyDigestForRoot(candidateRoot);
  if (expectedDependencyDigest && candidateDependencyDigest !== expectedDependencyDigest) {
    throw new Error(
      `ClawSweeper candidate dependency digest mismatch: expected ${expectedDependencyDigest}, got ${candidateDependencyDigest}`,
    );
  }
  return {
    clawsweeperSha,
    candidateDependencyDigest,
    candidateExecutableDigest,
  };
}

export function assertCandidateIdentityUnchanged(candidateRoot, before) {
  const after = candidateIdentity(candidateRoot);
  if (after.clawsweeperSha !== before.clawsweeperSha) {
    throw new Error(
      `ClawSweeper candidate revision changed during scenario: expected ${before.clawsweeperSha}, got ${after.clawsweeperSha}`,
    );
  }
  if (after.candidateExecutableDigest !== before.candidateExecutableDigest) {
    throw new Error(
      `ClawSweeper candidate executable digest changed during scenario: expected ${before.candidateExecutableDigest}, got ${after.candidateExecutableDigest}`,
    );
  }
  if (after.candidateDependencyDigest !== before.candidateDependencyDigest) {
    throw new Error(
      `ClawSweeper candidate dependency digest changed during scenario: expected ${before.candidateDependencyDigest}, got ${after.candidateDependencyDigest}`,
    );
  }
  return after;
}

export function candidateExecutableDigest(candidateRoot) {
  return candidateExecutableDigestForRoot(candidateRoot);
}

export function candidateDependencyDigest(candidateRoot) {
  return candidateDependencyDigestForRoot(candidateRoot);
}

function candidateExecutableDigestForRoot(candidateRoot) {
  const dist = path.join(path.resolve(candidateRoot), "dist");
  if (!fs.existsSync(dist)) throw new Error(`candidate executable directory is missing: ${dist}`);
  const files = listFiles(dist);
  if (files.length === 0) throw new Error(`candidate executable directory is empty: ${dist}`);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const relative = path.relative(dist, file).split(path.sep).join("/");
    const stat = fs.statSync(file);
    hash.update(relative).update("\0");
    hash.update(String(stat.mode & 0o777)).update("\0");
    hash.update(fs.readFileSync(file)).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function listFiles(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const resolved = path.join(root, entry.name);
      if (entry.isDirectory()) return listFiles(resolved);
      if (entry.isFile()) return [resolved];
      throw new Error(`candidate executable tree contains unsupported entry: ${resolved}`);
    })
    .sort();
}

function candidateDependencyDigestForRoot(candidateRoot) {
  const root = path.resolve(candidateRoot);
  const modules = path.join(root, "node_modules");
  if (!fs.existsSync(modules)) {
    throw new Error(`candidate dependency directory is missing: ${modules}`);
  }
  const hash = crypto.createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const resolved = path.join(root, file);
    if (!fs.existsSync(resolved)) continue;
    hash.update(file).update("\0").update(fs.readFileSync(resolved)).update("\0");
  }
  hash
    .update("node_modules")
    .update("\0")
    .update(treeDigest(fs.realpathSync(modules), "candidate dependency tree"))
    .update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function gitProofEnvironment() {
  return {
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  };
}

function treeDigest(root, label) {
  const files = listDependencyEntries(root);
  if (files.length === 0) throw new Error(`${label} is empty: ${root}`);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const stat = fs.lstatSync(file);
    hash.update(relative).update("\0");
    hash.update(String(stat.mode & 0o777)).update("\0");
    if (stat.isSymbolicLink()) {
      hash.update("symlink").update("\0").update(fs.readlinkSync(file)).update("\0");
    } else if (stat.isFile()) {
      hash.update("file").update("\0").update(fs.readFileSync(file)).update("\0");
    } else if (stat.isDirectory()) {
      hash.update("directory").update("\0");
    } else {
      throw new Error(`${label} contains unsupported entry: ${file}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function listDependencyEntries(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const resolved = path.join(root, entry.name);
      if (entry.isDirectory()) return [resolved, ...listDependencyEntries(resolved)];
      return [resolved];
    })
    .sort();
}
