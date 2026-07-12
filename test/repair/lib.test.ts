import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hasDeterministicSecuritySignal,
  hasSecuritySignalText,
  parseArgs,
  parseSimpleYaml,
  renderPrompt,
  validateJob,
} from "../../dist/repair/lib.js";

test("parseArgs ignores package-manager double dash separators", () => {
  assert.deepEqual(parseArgs(["--", "jobs/openclaw/inbox/example.md"]), {
    _: ["jobs/openclaw/inbox/example.md"],
  });
  assert.deepEqual(parseArgs(["--mode", "autonomous", "--", "job.md", "--latest"]), {
    _: ["job.md"],
    latest: true,
    mode: "autonomous",
  });
});

test("renderPrompt loads tracked repair prompt templates", () => {
  const prompt = renderPrompt(
    {
      raw: "---\nrepo: openclaw/clawsweeper\ncluster_id: smoke\nmode: autonomous\nrefs:\n  - 1\n---\nRepair smoke.",
      frontmatter: {
        repo: "openclaw/clawsweeper",
        cluster_id: "smoke",
        mode: "autonomous",
        refs: [1],
      },
    },
    "autonomous",
  );
  assert.match(prompt, /## Job file/);
  assert.match(prompt, /Repair smoke\./);
});

test("renderPrompt sizes Markdown fences beyond embedded job and artifact backticks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-prompt-fence-"));
  const artifactPath = path.join(directory, "artifact.json");
  const jobBackticks = "``````";
  const artifactBackticks = "````````";
  fs.writeFileSync(artifactPath, JSON.stringify({ payload: artifactBackticks }));
  try {
    const prompt = renderPrompt(
      {
        raw: `---\nrepo: openclaw/clawsweeper\ncluster_id: smoke\nmode: autonomous\nrefs:\n  - 1\n---\n${jobBackticks}\nunsafe`,
        frontmatter: {
          repo: "openclaw/clawsweeper",
          cluster_id: "smoke",
          mode: "autonomous",
          refs: [1],
        },
      },
      "autonomous",
      { clusterPlanPath: artifactPath },
    );
    const jobFence = prompt.slice(prompt.indexOf("## Job file")).match(/^(`+)md$/m)?.[1];
    const artifactFence = prompt
      .slice(prompt.indexOf("## Cluster preflight artifact"))
      .match(/^(`+)json$/m)?.[1];
    assert.ok(jobFence);
    assert.ok(artifactFence);
    assert.ok(jobFence.length > jobBackticks.length);
    assert.ok(artifactFence.length > artifactBackticks.length);
    assert.match(prompt, new RegExp(`${artifactBackticks}`));
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("validateJob rejects unknown canonical job intents", () => {
  const frontmatter = parseSimpleYaml(`repo: openclaw/openclaw
cluster_id: smoke
mode: autonomous
job_intent: surprise
allowed_actions:
  - comment
candidates:
  - "#1"
`);
  assert.deepEqual(validateJob({ frontmatter }), ["unsupported job_intent: surprise"]);
});

test("versioned Gitcrawl jobs bind their worker and policy intent", () => {
  const base = {
    repo: "openclaw/openclaw",
    mode: "plan",
    allowed_actions: ["comment"],
    candidates: ["#1"],
    gitcrawl_evidence_schema: "gitcrawl-evidence-job-v1",
    gitcrawl_evidence_required: true,
  };
  assert.deepEqual(
    validateJob({
      frontmatter: {
        ...base,
        cluster_id: "low-signal-pr-sweep-v1-20260712T1200-01",
      },
    }),
    ["versioned low-signal Gitcrawl job requires job_intent: low_signal_pr_cleanup"],
  );
  assert.deepEqual(
    validateJob({
      frontmatter: {
        ...base,
        cluster_id: "low-signal-pr-sweep-v1-20260712T1200-01",
        job_intent: "low_signal_pr_cleanup",
      },
    }),
    ["versioned low-signal Gitcrawl job requires triage_policy: low_signal_prs"],
  );
  assert.deepEqual(
    validateJob({
      frontmatter: {
        ...base,
        cluster_id: "gitcrawl-evidence-v1-7-current",
        job_intent: "low_signal_pr_cleanup",
      },
    }),
    ["versioned cluster Gitcrawl job requires job_intent: repair_cluster"],
  );
});

test("security signal detection ignores non-security advisory wording", () => {
  assert.equal(
    hasSecuritySignalText(
      "pnpm lint:tmp:dynamic-import-warts (advisory-only; no new run-loop.ts advisory)",
    ),
    false,
  );
});

test("security signal detection keeps explicit security advisory wording", () => {
  assert.equal(hasSecuritySignalText("security advisory triage for GHSA-1234-5678-abcd"), true);
  assert.equal(hasSecuritySignalText("CVE-2026-12345 is routed to the security lane"), true);
  assert.equal(hasSecuritySignalText({ name: "security:sensitive" }), true);
});

test("deterministic security signals ignore prose credential wording", () => {
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: [
        "Current main's Codex credential reader types expose codexHome, platform, and execSync, but no allowKeychainPrompt.",
      ],
    }),
    false,
  );
});

test("deterministic security signals accept labels and structured ClawSweeper markers", () => {
  assert.equal(hasDeterministicSecuritySignal({ labels: ["security:sensitive"] }), true);
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: ["<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->"],
    }),
    true,
  );
});
