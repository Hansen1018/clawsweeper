import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDeadlineBoundRequeueDispatch } from "../../dist/repair/requeue-dispatch.js";

test("requeue workflow dispatch is killed at the absolute deadline and classified indeterminate", () => {
  const fixture = fakeGhFixture(
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);\n",
  );
  const startedAt = Date.now();
  try {
    assert.throws(
      () =>
        runDeadlineBoundRequeueDispatch({
          args: ["workflow", "run", "repair-cluster-worker.yml"],
          cwd: fixture.root,
          deadlineAtMs: Date.now() + 100,
          env: fixture.env,
        }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "REQUEUE_DISPATCH_INDETERMINATE");
        assert.match(error.message, /workflow may have been accepted, so refusing a blind retry/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    fixture.cleanup();
  }
});

test("expired requeue deadlines fail before starting gh", () => {
  const markerPath = path.join(os.tmpdir(), `clawsweeper-requeue-marker-${process.pid}`);
  const fixture = fakeGhFixture(
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");\n`,
  );
  fs.rmSync(markerPath, { force: true });
  try {
    assert.throws(
      () =>
        runDeadlineBoundRequeueDispatch({
          args: ["workflow", "run", "repair-cluster-worker.yml"],
          cwd: fixture.root,
          deadlineAtMs: Date.now() - 1,
          env: fixture.env,
        }),
      /requeue dispatch deadline expired/,
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fixture.cleanup();
    fs.rmSync(markerPath, { force: true });
  }
});

test("successful requeue dispatch remains one exact gh invocation", () => {
  const fixture = fakeGhFixture(
    `require("node:fs").writeFileSync(${JSON.stringify("ARGS_PATH")}, JSON.stringify(process.argv.slice(2)));\n`,
    true,
  );
  try {
    runDeadlineBoundRequeueDispatch({
      args: ["workflow", "run", "repair-cluster-worker.yml", "--repo", "openclaw/clawsweeper"],
      cwd: fixture.root,
      deadlineAtMs: Date.now() + 5_000,
      env: fixture.env,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.argsPath, "utf8")), [
      "workflow",
      "run",
      "repair-cluster-worker.yml",
      "--repo",
      "openclaw/clawsweeper",
    ]);
  } finally {
    fixture.cleanup();
  }
});

function fakeGhFixture(body: string, replaceArgsPath = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-requeue-dispatch-"));
  const scriptPath = path.join(root, "fake-gh.cjs");
  const argsPath = path.join(root, "args.json");
  fs.writeFileSync(
    scriptPath,
    replaceArgsPath ? body.replace("ARGS_PATH", argsPath.replaceAll("\\", "\\\\")) : body,
  );
  return {
    argsPath,
    root,
    env: {
      ...process.env,
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([scriptPath]),
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
