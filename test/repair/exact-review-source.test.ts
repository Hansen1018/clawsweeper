import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeExactReviewSource } from "../../dist/repair/exact-review-source.js";

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createPullFixture() {
  const root = mkdtempSync(join(tmpdir(), "exact-review-source-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const target = join(root, "target");

  git(["init", "--bare", origin]);
  git(["init", source]);
  git(["config", "user.email", "clawsweeper@example.com"], source);
  git(["config", "user.name", "ClawSweeper Test"], source);
  writeFileSync(join(source, "README.md"), "base\n");
  git(["add", "README.md"], source);
  git(["commit", "-m", "base"], source);
  git(["branch", "-M", "main"], source);
  git(["remote", "add", "origin", origin], source);
  git(["push", "origin", "main"], source);

  writeFileSync(join(source, "feature.txt"), "first\n");
  git(["add", "feature.txt"], source);
  git(["commit", "-m", "feature"], source);
  const leasedHeadSha = git(["rev-parse", "HEAD"], source);
  git(["push", "origin", "HEAD:refs/pull/357/head"], source);
  git(["clone", "--branch", "main", origin, target]);

  return { root, origin, source, target, leasedHeadSha };
}

test("materializes the immutable leased pull request head", () => {
  const fixture = createPullFixture();
  try {
    assert.deepEqual(
      materializeExactReviewSource({
        targetDir: fixture.target,
        itemKind: "pull_request",
        itemNumber: 357,
        sourceHeadSha: fixture.leasedHeadSha,
      }),
      { status: "ready", headSha: fixture.leasedHeadSha },
    );
    assert.equal(git(["rev-parse", "HEAD"], fixture.target), fixture.leasedHeadSha);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], fixture.target), "HEAD");
    assert.equal(readFileSync(join(fixture.target, "feature.txt"), "utf8"), "first\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reports source drift without checking out the moved pull request head", () => {
  const fixture = createPullFixture();
  try {
    const originalCheckoutHead = git(["rev-parse", "HEAD"], fixture.target);
    writeFileSync(join(fixture.source, "feature.txt"), "second\n");
    git(["add", "feature.txt"], fixture.source);
    git(["commit", "-m", "move head"], fixture.source);
    const fetchedHeadSha = git(["rev-parse", "HEAD"], fixture.source);
    git(["push", "--force", "origin", "HEAD:refs/pull/357/head"], fixture.source);

    assert.deepEqual(
      materializeExactReviewSource({
        targetDir: fixture.target,
        itemKind: "pull_request",
        itemNumber: 357,
        sourceHeadSha: fixture.leasedHeadSha,
      }),
      {
        status: "source_drift",
        leasedHeadSha: fixture.leasedHeadSha,
        fetchedHeadSha,
      },
    );
    assert.equal(git(["rev-parse", "HEAD"], fixture.target), originalCheckoutHead);
    assert.equal(existsSync(join(fixture.target, "feature.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when the pull request ref cannot be fetched", () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-source-missing-"));
  const origin = join(root, "origin.git");
  const target = join(root, "target");
  try {
    git(["init", "--bare", origin]);
    git(["clone", origin, target]);
    assert.throws(
      () =>
        materializeExactReviewSource({
          targetDir: target,
          itemKind: "pull_request",
          itemNumber: 357,
          sourceHeadSha: "a".repeat(40),
        }),
      /couldn't find remote ref|could not read from remote repository|fatal:/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
