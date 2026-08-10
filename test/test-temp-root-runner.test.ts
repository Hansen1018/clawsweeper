import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";

import { useAutoCleanupTempDirTracker } from "./temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test(
  "test runner removes FIFO fixtures after a successful run",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture("fifo");
    const result = runFixture(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fs.readFileSync(fixture.markerPath, "utf8")), false);
  },
);

test("test runner removes its temporary root after an assertion failure", () => {
  const fixture = createFixture("fail");
  const result = runFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(fs.readFileSync(fixture.markerPath, "utf8")), false);
});

test("test runner removes expired run roots without inspecting their fixtures", () => {
  const fixture = createFixture("pass");
  const staleRoot = path.join(fixture.baseTempDir, "clawsweeper-test-run-stale-fixture");
  fs.mkdirSync(staleRoot);
  fs.writeFileSync(path.join(staleRoot, "unreadable"), "fixture");
  fs.chmodSync(path.join(staleRoot, "unreadable"), 0o000);
  const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  fs.utimesSync(staleRoot, staleAt, staleAt);

  const result = runFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(staleRoot), false);
});

test("test runner removes its temporary root after SIGTERM", async () => {
  const fixture = createFixture("wait");
  const child = spawn(process.execPath, [runnerPath, "unit", "--test-concurrency=1"], {
    cwd: fixture.workspaceDir,
    env: fixture.env,
    stdio: "ignore",
  });
  await waitForFile(fixture.markerPath);
  const runRoot = fs.readFileSync(fixture.markerPath, "utf8");

  child.kill("SIGTERM");
  const outcome = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );

  assert.deepEqual(outcome, { code: null, signal: "SIGTERM" });
  assert.equal(fs.existsSync(runRoot), false);
});

const fixturePath = "test/fixtures/temp-root-runner.test.mjs";
const runnerPath = path.join(process.cwd(), "scripts/run-node-tests.mjs");

function createFixture(mode) {
  const fixtureRoot = tempDirs.make("clawsweeper-test-runner-fixture-");
  const baseTempDir = path.join(fixtureRoot, "tmp");
  const markerPath = path.join(fixtureRoot, "run-root.txt");
  const workspaceDir = path.join(fixtureRoot, "workspace");
  const workspaceFixturePath = path.join(workspaceDir, "test", "fixture.test.ts");
  fs.mkdirSync(baseTempDir);
  fs.mkdirSync(path.dirname(workspaceFixturePath), { recursive: true });
  fs.copyFileSync(fixturePath, workspaceFixturePath);
  return {
    baseTempDir,
    markerPath,
    workspaceDir,
    env: {
      ...process.env,
      CLAWSWEEPER_TEST_RUN_ROOT_MARKER: markerPath,
      CLAWSWEEPER_TEST_RUNNER_MODE: mode,
      TEMP: baseTempDir,
      TMP: baseTempDir,
      TMPDIR: baseTempDir,
    },
  };
}

function runFixture(fixture) {
  return spawnSync(process.execPath, [runnerPath, "unit", "--test-concurrency=1"], {
    cwd: fixture.workspaceDir,
    encoding: "utf8",
    env: fixture.env,
  });
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
