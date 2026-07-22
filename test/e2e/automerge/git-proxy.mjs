#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const rawArgs = process.argv.slice(2);
const publicationBarrier = publicationBarrierConfig();
if (publicationBarrier && isPublicationBarrierCommand(rawArgs)) {
  const child = spawnSync("/usr/bin/git", rawArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.error) fail(child.error.message);
  if ((child.status ?? 1) === 0 && claimPublicationBarrier(publicationBarrier.fired)) {
    triggerPublicationWriter(publicationBarrier);
  }
  process.exit(child.status ?? 1);
}

const needsNetworkRewrite = rawArgs.some((arg) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(arg),
);
const statePath = process.env.CLAWSWEEPER_E2E_GITHUB_STATE;
if (needsNetworkRewrite && !statePath) fail("CLAWSWEEPER_E2E_GITHUB_STATE is required");
// Contained validation intentionally cannot see the simulator state outside
// its writable roots. Local Git commands need no simulation, so delegate them
// without opening that external file; network commands still fail closed.
const state = needsNetworkRewrite ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
const githubUrl = state ? `https://github.com/${state.repo}.git` : "";
const args = rawArgs.map((arg) => (state && arg === githubUrl ? state.remote : arg));

const child = spawnSync("/usr/bin/git", args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (child.error) fail(child.error.message);
process.exit(child.status ?? 1);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function publicationBarrierConfig() {
  const {
    CLAWSWEEPER_E2E_PUBLICATION_BARRIER_FIRED: fired,
    CLAWSWEEPER_E2E_PUBLICATION_WRITER_MODE: mode,
    CLAWSWEEPER_E2E_PUBLICATION_WRITER_REMOTE: remote,
    CLAWSWEEPER_E2E_PUBLICATION_WRITER_SCRIPT: script,
    CLAWSWEEPER_E2E_PUBLICATION_WRITER_STATUS: status,
    CLAWSWEEPER_E2E_PUBLICATION_WRITER_WORKSPACE: workspace,
  } = process.env;
  if (!fired || !mode || !remote || !script || !status || !workspace) return null;
  return { fired, mode, remote, script, status, workspace };
}

function isPublicationBarrierCommand(args) {
  return args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD";
}

function claimPublicationBarrier(fired) {
  let fd;
  try {
    fd = fs.openSync(fired, "wx");
    fs.writeFileSync(fd, `${process.pid}\n`);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function triggerPublicationWriter(config) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAWSWEEPER_E2E_PUBLICATION_")) delete env[key];
  }
  const child = spawnSync(
    process.execPath,
    [config.script, config.mode, config.remote, config.workspace],
    {
      encoding: "utf8",
      env,
    },
  );
  fs.writeFileSync(
    config.status,
    `${JSON.stringify({
      error: child.error?.message ?? null,
      status: child.status,
      stderr: child.stderr,
      stdout: child.stdout,
    })}\n`,
  );
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
}
