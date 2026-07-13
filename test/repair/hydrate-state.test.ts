import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const hydrateScript = path.resolve("scripts/hydrate-state.ts");

test("hydrate-state preserves default hydration without copying the action ledger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-state-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(state, "notifications"), { recursive: true });
  fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "ledger"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "notifications", "clawsweeper-event-ledger.json"),
    '{"version":1,"notifications":[]}\n',
  );
  fs.writeFileSync(path.join(state, "ledger", "state.json"), '{"source":"state"}\n');
  fs.writeFileSync(path.join(worktree, "ledger", "state.json"), '{"source":"worktree"}\n');

  try {
    const result = runHydrate(state, worktree);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(worktree, "notifications", "clawsweeper-event-ledger.json"),
        "utf8",
      ),
      '{"version":1,"notifications":[]}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, "ledger", "state.json"), "utf8"),
      '{"source":"worktree"}\n',
    );
    const report = JSON.parse(result.stdout) as { hydrated: string[] };
    assert.deepEqual(report.hydrated, [
      "records",
      "jobs",
      "results",
      "assets",
      "notifications",
      "apply-report.json",
      "repair-apply-report.json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hydrate-state hydrates only explicitly selected approved roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-ledger-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(state, "records"), { recursive: true });
  fs.mkdirSync(path.join(state, "notifications"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "notifications"), { recursive: true });
  fs.writeFileSync(path.join(state, "ledger", "events.jsonl"), '{"event":"complete"}\n');
  fs.writeFileSync(path.join(state, "records", "index.json"), '{"records":1}\n');
  fs.writeFileSync(path.join(state, "notifications", "state.json"), '{"source":"state"}\n');
  fs.writeFileSync(path.join(worktree, "notifications", "state.json"), '{"source":"worktree"}\n');

  try {
    const result = runHydrate(state, worktree, {}, ["--hydrate-paths", "ledger\nrecords\nledger"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(worktree, "ledger", "events.jsonl"), "utf8"),
      '{"event":"complete"}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, "records", "index.json"), "utf8"),
      '{"records":1}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, "notifications", "state.json"), "utf8"),
      '{"source":"worktree"}\n',
    );
    assert.deepEqual((JSON.parse(result.stdout) as { hydrated: string[] }).hydrated, [
      "ledger",
      "records",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const unsafePath of [
  "/tmp/ledger",
  String.raw`C:\ledger`,
  "../ledger",
  "records/../ledger",
  ".ledger",
  "ledger/.private",
  "ledger/private",
  String.raw`ledger\private`,
  "unknown",
]) {
  test(`hydrate-state rejects unsafe or unknown root ${JSON.stringify(unsafePath)}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-reject-"));
    const state = path.join(root, "state");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
    fs.mkdirSync(worktree);

    try {
      const result = runHydrate(state, worktree, {
        CLAWSWEEPER_HYDRATE_PATHS: unsafePath,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(?:Unsafe|Unknown) generated hydration (?:path|root)/);
      assert.deepEqual(fs.readdirSync(worktree), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("setup-state exposes ledger hydration as an explicit opt-in", () => {
  const action = parse(fs.readFileSync(".github/actions/setup-state/action.yml", "utf8")) as {
    inputs?: Record<string, { default?: string }>;
    runs?: { steps?: Array<{ env?: Record<string, string>; run?: string }> };
  };

  assert.equal(action.inputs?.["hydrate-paths"]?.default, "");
  const hydrateStep = action.runs?.steps?.find((step) => step.run?.includes("hydrate-state.ts"));
  assert.equal(hydrateStep?.env?.CLAWSWEEPER_HYDRATE_PATHS, "${{ inputs.hydrate-paths }}");
});

function runHydrate(
  state: string,
  worktree: string,
  env: NodeJS.ProcessEnv = {},
  args: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [hydrateScript, "--state-dir", state, "--worktree", worktree, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, CLAWSWEEPER_HYDRATE_PATHS: "", ...env },
    },
  );
}
