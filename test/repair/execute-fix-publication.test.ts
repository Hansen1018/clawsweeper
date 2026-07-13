import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const executor = path.join(process.cwd(), "dist/repair/execute-fix-artifact.js");

test("execute-fix CLI defers outcome publication until fresh-token invocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publication-cli-"));
  const binDir = path.join(root, "bin");
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(root, "result.json");
  const reportPath = path.join(root, "fix-execution-report.json");
  const tokenLog = path.join(root, "outcome-tokens.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    jobPath,
    `---\nrepo: openclaw/clawsweeper\ncluster_id: automerge-openclaw-clawsweeper-494\nmode: autonomous\nsource: pr_automerge\nallowed_actions: [comment]\ncandidates: [#494]\ncanonical: [#494]\n---\nfixture\n`,
  );
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      repo: "openclaw/clawsweeper",
      cluster_id: "automerge-openclaw-clawsweeper-494",
      mode: "autonomous",
      canonical_pr: "https://github.com/openclaw/clawsweeper/pull/494",
      reviewed_sha: "a".repeat(40),
      fix_artifact: {
        source_prs: ["https://github.com/openclaw/clawsweeper/pull/494"],
      },
      actions: [],
    })}\n`,
  );
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/bin/sh\nset -eu\ncase "$*" in\n  *"issues/494/comments?per_page=100"*) printf '[]\\n' ;;\n  "pr view 494 "*) printf '{"state":"CLOSED","headRefOid":"%s","statusCheckRollup":[]}\\n' "${"a".repeat(40)}" ;;\n  *"issues/494/comments --method POST"*) printf '%s\\n' "\${GH_TOKEN:-}" >> "$TOKEN_LOG" ;;\n  *) printf 'unexpected gh args: %s\\n' "$*" >&2; exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
    CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
    CLAWSWEEPER_MODEL: "fixture-model",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "123",
    TOKEN_LOG: tokenLog,
  };

  runExecutor([jobPath, resultPath, "--defer-publication"], {
    ...baseEnv,
    GH_TOKEN: "expired-token",
  });
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal(fs.existsSync(tokenLog), false);

  runExecutor([jobPath, resultPath, "--publish-report-only"], {
    ...baseEnv,
    GH_TOKEN: "fresh-token",
  });
  assert.equal(fs.readFileSync(tokenLog, "utf8"), "fresh-token\n");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.actions.at(-1)?.action, "automerge_repair_outcome_comment");
  assert.equal(report.actions.at(-1)?.status, "executed");
});

test("execute-fix receipts preserve the canonical job revision", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-execute-revision-")),
  );
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(root, "result.json");
  const ledgerOutputRoot = path.join(root, "ledger-output");
  const sourceRevision = "b".repeat(64);
  fs.mkdirSync(ledgerOutputRoot);
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/clawsweeper",
      "cluster_id: issue-openclaw-clawsweeper-521",
      "mode: autonomous",
      "allowed_actions: [comment]",
      "candidates: ['#521']",
      `source_issue_revision_sha256: "${sourceRevision}"`,
      "---",
      "fixture",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      repo: "openclaw/clawsweeper",
      cluster_id: "issue-openclaw-clawsweeper-521",
      mode: "autonomous",
      reviewed_sha: "c".repeat(40),
      actions: [],
    })}\n`,
  );
  const env = actionLedgerEnv(root, ledgerOutputRoot, "execute-fix");

  try {
    runExecutor([jobPath, resultPath], env);
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), "dist/repair/action-ledger-cli.js"), "finalize"],
      { env, stdio: "pipe" },
    );

    const events = readActionEvents(ledgerOutputRoot);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.subject?.source_revision === sourceRevision));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runExecutor(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawnSync(process.execPath, [executor, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
}

function actionLedgerEnv(
  root: string,
  ledgerOutputRoot: string,
  invocation: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: ledgerOutputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
    CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
    GITHUB_ACTION: "execute_fix",
    GITHUB_JOB: "execute",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "521",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };
}

function readActionEvents(root: string): Record<string, any>[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return readActionEvents(target);
    if (!target.endsWith(".jsonl")) return [];
    return fs
      .readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  });
}
