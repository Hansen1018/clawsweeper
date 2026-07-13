import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workerWorkflowPath = ".github/workflows/repair-cluster-worker.yml";
const intakeWorkflowPath = ".github/workflows/repair-commit-finding-intake.yml";

test("immutable worker handoff overwrites mutable state and is rerun-stable", () => {
  const workflow = parse(fs.readFileSync(workerWorkflowPath, "utf8"));
  const checkStep = workflow.jobs.cluster.steps.find(
    (step: { name?: string }) => step.name === "Check job file",
  );
  assert.equal(typeof checkStep?.run, "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-immutable-job-"));
  const jobPath = "jobs/openclaw/inbox/clawsweeper-commit-openclaw-openclaw-abc.md";
  const mutablePath = path.join(root, jobPath);
  const immutablePath = path.join(root, ".clawsweeper-repair", "immutable-state", jobPath);
  const outputPath = path.join(root, "output.txt");
  const immutableBytes = Buffer.from("immutable job bytes\n", "utf8");
  const digest = createHash("sha256").update(immutableBytes).digest("hex");
  fs.mkdirSync(path.dirname(mutablePath), { recursive: true });
  fs.mkdirSync(path.dirname(immutablePath), { recursive: true });
  fs.writeFileSync(mutablePath, "later mutable overwrite\n");
  fs.writeFileSync(immutablePath, immutableBytes);

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fs.writeFileSync(mutablePath, `later mutable overwrite ${attempt}\n`);
      const child = spawnSync("bash", ["-c", checkStep.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          JOB_PATH: jobPath,
          IMMUTABLE_JOB: "true",
          JOB_SHA256: digest,
          GITHUB_OUTPUT: outputPath,
        },
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(fs.readFileSync(mutablePath), immutableBytes);
    }
    assert.equal(
      fs
        .readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line === "job_exists=1").length,
      2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable worker handoff fails closed on a digest mismatch", () => {
  const workflow = parse(fs.readFileSync(workerWorkflowPath, "utf8"));
  const checkStep = workflow.jobs.cluster.steps.find(
    (step: { name?: string }) => step.name === "Check job file",
  );
  assert.equal(typeof checkStep?.run, "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-immutable-mismatch-"));
  const jobPath = "jobs/openclaw/inbox/clawsweeper-commit-openclaw-openclaw-def.md";
  const mutablePath = path.join(root, jobPath);
  const immutablePath = path.join(root, ".clawsweeper-repair", "immutable-state", jobPath);
  fs.mkdirSync(path.dirname(mutablePath), { recursive: true });
  fs.mkdirSync(path.dirname(immutablePath), { recursive: true });
  fs.writeFileSync(mutablePath, "mutable job\n");
  fs.writeFileSync(immutablePath, "immutable job\n");

  try {
    const child = spawnSync("bash", ["-c", checkStep.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        JOB_PATH: jobPath,
        IMMUTABLE_JOB: "true",
        JOB_SHA256: "0".repeat(64),
        GITHUB_OUTPUT: path.join(root, "output.txt"),
      },
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Immutable job SHA-256 mismatch/);
    assert.equal(fs.readFileSync(mutablePath, "utf8"), "mutable job\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commit finding dispatch carries the immutable state receipt on rerun", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-dispatch-receipt-"));
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const jobPath = path.join(
    process.cwd(),
    "jobs",
    `fixture-${unique}`,
    "inbox",
    `clawsweeper-commit-fixture-${unique}-repo-${"a".repeat(12)}.md`,
  );
  const relativeJobPath = path.relative(process.cwd(), jobPath);
  const binDir = path.join(root, "bin");
  const ghPath = path.join(binDir, "gh");
  const ghLog = path.join(root, "gh.log");
  const stateRevision = "b".repeat(40);
  const jobSha256 = "c".repeat(64);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    jobPath,
    `---
repo: fixture-${unique}/repo
cluster_id: clawsweeper-commit-fixture-${unique}-repo-${"a".repeat(12)}
mode: autonomous
job_intent: commit_finding
allowed_actions:
  - fix
source: clawsweeper_commit
commit_sha: ${"a".repeat(40)}
---

# immutable dispatch fixture
`,
  );
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "api") {
  process.stdout.write("[]");
  process.exit(0);
}
fs.appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify(args) + "\\n");
`,
    { mode: 0o755 },
  );

  try {
    const dispatch = (includeImmutableReceipt = true) =>
      spawnSync(
        process.execPath,
        [
          path.resolve("dist/repair/dispatch-jobs.js"),
          relativeJobPath,
          "--mode",
          "autonomous",
          "--dispatch-key",
          `commit-${unique}`,
          ...(includeImmutableReceipt
            ? ["--state-revision", stateRevision, "--job-sha256", jobSha256]
            : []),
          "--max-live-workers",
          "1",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            MOCK_GH_LOG: ghLog,
            CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: path.join(root, "ledger"),
            CLAWSWEEPER_REPO: "openclaw/clawsweeper",
          },
        },
      );
    const first = dispatch();
    const second = dispatch();
    const missingReceipt = dispatch(false);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(missingReceipt.status, 1);
    assert.match(missingReceipt.stderr, /commit finding job requires immutable state handoff/);
    const calls = fs
      .readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.ok(calls[0]?.includes(`state_revision=${stateRevision}`));
    assert.ok(calls[0]?.includes(`job_sha256=${jobSha256}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), "jobs", `fixture-${unique}`), {
      recursive: true,
      force: true,
    });
  }
});

test("commit finding workflows bind terminal receipts and ignore ledger-only artifacts", () => {
  const intake = fs.readFileSync(intakeWorkflowPath, "utf8");
  const worker = fs.readFileSync(workerWorkflowPath, "utf8");

  assert.match(intake, /"Intake commit finding" "Complete durable intake handoff"/);
  assert.match(
    intake,
    /Complete durable intake handoff[\s\S]*PREPARE_OUTCOME[\s\S]*PUBLISH_OUTCOME[\s\S]*DISPATCH_OUTCOME/,
  );
  assert.match(
    intake,
    /SHOULD_REPAIR[\s\S]*"\$PREPARE_OUTCOME" != "success"[\s\S]*"\$PUBLISH_OUTCOME" != "success"[\s\S]*"\$SHOULD_REPAIR" = "true"[\s\S]*"\$DISPATCH_OUTCOME" != "success"/,
  );
  assert.match(
    intake,
    /--state-revision "\$\{\{ steps\.published-job\.outputs\.state_revision \}\}"/,
  );
  assert.match(intake, /--job-sha256 "\$\{\{ steps\.published-job\.outputs\.job_sha256 \}\}"/);
  assert.match(worker, /ref: \$\{\{ inputs\.state_revision \}\}/);
  assert.match(worker, /Immutable job SHA-256 mismatch/);
  assert.match(worker, /Immutable authorization job SHA-256 mismatch/);
  assert.match(worker, /name: clawsweeper-repair-worker-action-ledger-cluster-/);
  assert.match(worker, /name: clawsweeper-repair-worker-action-ledger-execute-/);
  assert.match(worker, /name: clawsweeper-repair-worker-action-ledger-mutate-/);
  assert.doesNotMatch(worker, /name: clawsweeper-repair-action-ledger-(?:cluster|execute|mutate)-/);
});
