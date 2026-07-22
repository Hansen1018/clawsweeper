#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [mode, remote, workspace] = process.argv.slice(2);
if (!mode || !remote || !workspace) {
  throw new Error("usage: publication-writer.mjs <sibling|merge> <remote> <workspace>");
}

if (mode === "sibling") publishSibling(remote, workspace);
else if (mode === "merge") publishMerge(remote, workspace);
else throw new Error(`unsupported publication writer mode: ${mode}`);

function publishSibling(remote, workspace) {
  clone(remote, workspace);
  write(path.join(workspace, "results/concurrent-sibling.json"), '{"publisher":2}\n');
  git(["add", "results/concurrent-sibling.json"], workspace);
  git(["commit", "-m", "chore: concurrent sibling publication"], workspace);
  git(["push", "origin", "HEAD:main"], workspace);
}

function publishMerge(remote, workspace) {
  const left = path.join(workspace, "left");
  const right = path.join(workspace, "right");
  clone(remote, left);
  clone(remote, right);

  write(path.join(left, "results/merge-left.json"), '{"parent":"left"}\n');
  git(["add", "results/merge-left.json"], left);
  git(["commit", "-m", "chore: left publication"], left);

  write(path.join(right, "results/merge-right.json"), '{"parent":"right"}\n');
  git(["add", "results/merge-right.json"], right);
  git(["commit", "-m", "chore: right publication"], right);
  const rightCommit = git(["rev-parse", "HEAD"], right).trim();

  git(["fetch", path.join(right, ".git"), rightCommit], left);
  git(["merge", "--no-ff", "FETCH_HEAD", "-m", "chore: server-side publication merge"], left);
  git(["push", "origin", "HEAD:main"], left);
}

function clone(remote, workspace) {
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  git(["clone", remote, workspace]);
  git(["config", "user.name", "Concurrent Publisher"], workspace);
  git(["config", "user.email", "publisher@example.invalid"], workspace);
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function git(args, cwd = process.cwd()) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-20T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-20T00:00:00Z",
      TZ: "UTC",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
