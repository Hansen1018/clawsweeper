import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("fixture", async () => {
  fs.writeFileSync(process.env.CLAWSWEEPER_TEST_RUN_ROOT_MARKER, process.env.TMPDIR);
  const fixtureDir = path.join(process.env.TMPDIR, "packages", "worker");
  fs.mkdirSync(fixtureDir, { recursive: true });
  if (process.env.CLAWSWEEPER_TEST_RUNNER_MODE === "fifo") {
    execFileSync("mkfifo", [path.join(fixtureDir, "package.json")]);
  }
  if (process.env.CLAWSWEEPER_TEST_RUNNER_MODE === "wait") {
    await new Promise((resolve) => setInterval(resolve, 60_000));
  }
  assert.notEqual(process.env.CLAWSWEEPER_TEST_RUNNER_MODE, "fail");
});
