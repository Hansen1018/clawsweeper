#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const [candidateRoot, worktree, pathsJson] = process.argv.slice(2);
if (!candidateRoot || !worktree || !pathsJson) {
  throw new Error("usage: publication-worker.mjs <candidate-root> <worktree> <paths-json>");
}

const moduleUrl = pathToFileURL(path.join(candidateRoot, "dist/repair/git-publish.js"));
const { publishMainCommit } = await import(moduleUrl.href);
process.chdir(worktree);
const result = publishMainCommit({
  message: "chore: publish deterministic E2E state",
  paths: JSON.parse(pathsJson),
  maxAttempts: 1,
  pushAttempts: 1,
  rebaseStrategy: "theirs",
  remote: "origin",
  branch: "main",
});
process.stdout.write(`${JSON.stringify({ result })}\n`);
