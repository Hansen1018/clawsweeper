import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { serverStrictBaseBindingBlock } from "../../dist/repair/strict-base-binding.js";

const APP_ID = 3306130;
const APP_SLUG = "openclaw-clawsweeper";
const INSTALLATION_ID = 987654;

test("strict base binding accepts an enforced non-bypass ruleset", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: strictRulesetDetails(),
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
});

test("strict base binding uses documented action outputs without an installation endpoint", () => {
  const requestedEndpoints: string[] = [];
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: strictRulesetDetails(),
    requestedEndpoints,
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
  assert.doesNotMatch(requestedEndpoints.join("\n"), /(?:^|\/)installation(?:\/|$)/m);
});

test("strict base binding rejects a ruleset that exempts the merge app", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: strictRulesetDetails({
      bypassActors: [{ actor_type: "Integration", actor_id: APP_ID, bypass_mode: "always" }],
    }),
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "automerge disabled: merge credential bypasses an applicable strict base-binding ruleset",
  );
});

test("strict base binding evaluates every applicable strict ruleset", () => {
  const requestedEndpoints: string[] = [];
  const github = fakeGithub({
    rules: [
      strictRulesetRule("Repository", 18588237, ["required-ci/first"]),
      strictRulesetRule("Repository", 18588238, ["required-ci/second"]),
    ],
    rulesets: {
      18588237: strictRulesetDetails({ checks: ["required-ci/first"] }),
      18588238: strictRulesetDetails({ checks: ["required-ci/second"] }),
    },
    requestedEndpoints,
  });

  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
  assert.match(requestedEndpoints.join("\n"), /rulesets\/18588237/);
  assert.match(requestedEndpoints.join("\n"), /rulesets\/18588238/);
});

test("strict base binding rejects a later applicable ruleset that bypasses the app", () => {
  const github = fakeGithub({
    rules: [
      strictRulesetRule("Repository", 18588237, ["required-ci/first"]),
      strictRulesetRule("Repository", 18588238, ["required-ci/second"]),
    ],
    rulesets: {
      18588237: strictRulesetDetails({ checks: ["required-ci/first"] }),
      18588238: strictRulesetDetails({
        checks: ["required-ci/second"],
        bypassActors: [{ actor_type: "Integration", actor_id: APP_ID, bypass_mode: "always" }],
      }),
    },
    protection: {
      required_status_checks: { strict: true, contexts: ["classic-ci"] },
    },
  });

  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "automerge disabled: merge credential bypasses an applicable strict base-binding ruleset",
  );
});

test("strict base binding rejects a later ruleset that weakens required checks", () => {
  const requestedEndpoints: string[] = [];
  const github = fakeGithub({
    rules: [
      strictRulesetRule("Repository", 18588237, ["required-ci/first"]),
      strictRulesetRule("Repository", 18588238, ["required-ci/second", "required-ci/security"]),
    ],
    rulesets: {
      18588237: strictRulesetDetails({ checks: ["required-ci/first"] }),
      18588238: strictRulesetDetails({ checks: ["required-ci/second"] }),
    },
    protection: {
      required_status_checks: { strict: true, contexts: ["classic-ci"] },
    },
    requestedEndpoints,
  });

  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "automerge disabled: an applicable ruleset weakens required strict status checks",
  );
  assert.match(requestedEndpoints.join("\n"), /rulesets\/18588237/);
  assert.match(requestedEndpoints.join("\n"), /rulesets\/18588238/);
});

test("strict base binding accepts classic strict branch protection", () => {
  const github = fakeGithub({
    rules: [],
    protection: {
      required_status_checks: {
        strict: true,
        contexts: ["ci"],
      },
    },
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/example",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
});

test("strict base binding fails closed without an installation identity output", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ installationId: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects rulesets whose bypass actors are hidden", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: {},
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "automerge disabled: unable to verify every applicable strict base-binding ruleset",
  );
});

test("strict base binding rejects a missing ruleset verifier credential", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: undefined,
    }),
    "automerge disabled: ruleset verifier credential is unavailable",
  );
});

test("strict base binding rejects a verifier credential from another installation", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyInstallationId: INSTALLATION_ID + 1 }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding rejects a verifier credential from another App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyAppSlug: "other-repair-app" }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding requires the authenticated App identity", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ authenticatedAppId: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding requires the authenticated App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ appSlug: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects a verifier credential from another App id", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyAppId: APP_ID + 1 }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding rejects a mutation credential from another App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ appSlug: "other-repair-app" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects a missing configured App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ configuredAppSlug: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects missing verifier identity outputs", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyInstallationId: "" }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding fails closed for non-repository rulesets without fetching them", () => {
  for (const sourceType of ["Organization", "Enterprise"] as const) {
    const requestedEndpoints: string[] = [];
    assert.equal(
      serverStrictBaseBindingBlock({
        repo: "openclaw/openclaw",
        baseBranch: "main",
        ...appIdentity(),
        policyReadJson: fakeGithub({
          rules: [strictRulesetRule(sourceType)],
          requestedEndpoints,
        }),
      }),
      "automerge disabled: unable to verify every applicable strict base-binding ruleset",
    );
    assert.doesNotMatch(requestedEndpoints.join("\n"), /^(?:orgs|enterprises)\//m);
    assert.doesNotMatch(requestedEndpoints.join("\n"), /rulesets\/18588237/);
  }
});

test("all repair merge owners repeat the shared strict base guard immediately before merge", () => {
  for (const [file, functionName, mergeCall] of [
    ["src/repair/apply-result.ts", "function applyMergeAction(", "ghWithRetry(mergeArgs)"],
    [
      "src/repair/comment-router.ts",
      "function executeAutomerge(",
      "const result = runGitHubSpawnMutation(",
    ],
    ["src/repair/post-flight.ts", "function finalizeFixPr(", "ghWithRetry(mergeArgs)"],
  ] as const) {
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf(functionName);
    const end = source.indexOf("\nfunction ", start + functionName.length);
    const owner = source.slice(start, end < 0 ? undefined : end);
    const guards = [...owner.matchAll(/runtimeStrictBaseBindingBlock\(\{/g)].map(
      (match) => match.index,
    );
    const merge = owner.indexOf(mergeCall);
    assert.equal(guards.length, 2, `${file} must check strict base binding twice`);
    assert.ok(merge > guards[1]!, `${file} does not guard the final merge call`);
    const finalGuard = owner.slice(guards[1]!, merge);
    assert.match(finalGuard, /policyReadJson: rulesetPolicyReader\(\)/);
    assert.doesNotMatch(finalGuard, /gh(?:Json|Text|Spawn|WithRetry)\(/);
  }
});

test("runtime strict base binding binds every configured credential identity", () => {
  const source = fs.readFileSync("src/repair/strict-base-binding.ts", "utf8");
  const start = source.indexOf("export function runtimeStrictBaseBindingBlock");
  const end = source.indexOf("\nexport function serverStrictBaseBindingBlock", start);
  const helper = source.slice(start, end);
  for (const name of [
    "CLAWSWEEPER_APP_SLUG",
    "CLAWSWEEPER_AUTHENTICATED_APP_ID",
    "CLAWSWEEPER_AUTHENTICATED_APP_SLUG",
    "CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID",
    "CLAWSWEEPER_RULESET_APP_ID",
    "CLAWSWEEPER_RULESET_APP_SLUG",
    "CLAWSWEEPER_RULESET_INSTALLATION_ID",
  ]) {
    assert.match(helper, new RegExp(`env\\.${name}`));
  }
});

test("merge-capable workflows isolate verifier credentials in trusted jobs", () => {
  for (const file of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
  ]) {
    const workflow = readWorkflow(file);
    let mergeStepCount = 0;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const mergeSteps = steps.filter((step) =>
        /pnpm run repair:(?:apply-result|post-flight|comment-router)\b/.test(step.run ?? ""),
      );
      if (mergeSteps.length === 0) continue;
      mergeStepCount += mergeSteps.length;

      for (const step of mergeSteps) {
        const tokenProducer = workflowOutputStep(step.env?.GH_TOKEN, "token");
        const slugProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_AUTHENTICATED_APP_SLUG,
          "app-slug",
        );
        const installationProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID,
          "installation-id",
        );
        const verifierProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_RULESET_GH_TOKEN,
          "token",
        );
        const verifierSlugProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_RULESET_APP_SLUG,
          "app-slug",
        );
        const verifierInstallationProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_RULESET_INSTALLATION_ID,
          "installation-id",
        );
        assert.ok(tokenProducer, `${file}:${jobName} merge step is missing an App token output`);
        assert.equal(
          slugProducer,
          tokenProducer,
          `${file}:${jobName} merge step does not bind the authenticated slug to its token`,
        );
        assert.equal(
          installationProducer,
          tokenProducer,
          `${file}:${jobName} merge step does not bind the installation to its token`,
        );
        assert.ok(
          verifierProducer,
          `${file}:${jobName} merge step is missing a ruleset verifier token`,
        );
        assert.equal(
          verifierSlugProducer,
          verifierProducer,
          `${file}:${jobName} verifier slug is not bound to its token`,
        );
        assert.equal(
          verifierInstallationProducer,
          verifierProducer,
          `${file}:${jobName} verifier installation is not bound to its token`,
        );
        assert.notEqual(
          verifierProducer,
          tokenProducer,
          `${file}:${jobName} merge step reuses its mutation credential for ruleset verification`,
        );
        assert.match(
          String(step.env?.CLAWSWEEPER_AUTHENTICATED_APP_ID ?? ""),
          /steps\.[^.]+\.outputs\.app_id/,
          `${file}:${jobName} merge step does not bind the authenticated App id`,
        );
        assert.match(
          String(step.env?.CLAWSWEEPER_RULESET_APP_ID ?? ""),
          /steps\.[^.]+\.outputs\.app_id/,
          `${file}:${jobName} merge step does not bind the verifier App id`,
        );

        const mutationStep = steps.find((candidate) => candidate.id === tokenProducer);
        const verifierStep = steps.find((candidate) => candidate.id === verifierProducer);
        assert.ok(
          mutationStep,
          `${file}:${jobName} mutation token is produced outside the merge job`,
        );
        assert.ok(
          verifierStep,
          `${file}:${jobName} verifier token is produced outside the merge job`,
        );
        assert.equal(
          mutationStep.with?.["permission-administration"],
          undefined,
          `${file}:${jobName} mutation credential still carries administration access`,
        );
        assert.equal(
          verifierStep.with?.["permission-administration"],
          "write",
          `${file}:${jobName} ruleset verifier cannot observe bypass actors`,
        );
        assertRepoScoped(file, jobName, "mutation", mutationStep);
        assertRepoScoped(file, jobName, "verifier", verifierStep);
        assert.equal(
          verifierStep.with?.owner,
          mutationStep.with?.owner,
          `${file}:${jobName} verifier owner scope differs from mutation scope`,
        );
        assert.equal(
          verifierStep.with?.repositories,
          mutationStep.with?.repositories,
          `${file}:${jobName} verifier repository scope differs from mutation scope`,
        );
      }

      const trustedJobCommands = steps
        .map((step) => `${step.uses ?? ""}\n${step.run ?? ""}`)
        .join("\n");
      assert.doesNotMatch(
        trustedJobCommands,
        /(?:^|\/)setup-codex\b/,
        `${file}:${jobName} exposes the verifier to Codex setup`,
      );
      assert.doesNotMatch(
        trustedJobCommands,
        /pnpm run (?:review\b|repair:review-results\b)/,
        `${file}:${jobName} exposes the verifier to review commands`,
      );
      const executeFixCommands = steps
        .map((step) => step.run ?? "")
        .filter((run) => /pnpm run repair:execute-fix\b/.test(run));
      for (const command of executeFixCommands) {
        assert.match(
          command,
          /--publish-report-only\b/,
          `${file}:${jobName} exposes the verifier to non-report repair execution`,
        );
        assert.doesNotMatch(
          command,
          /--defer-publication\b/,
          `${file}:${jobName} exposes the verifier to deferred repair execution`,
        );
      }
    }
    if (file.endsWith("repair-cluster-worker.yml")) {
      const reportCommands = workflow.jobs?.report?.steps
        ?.map((step) => step.run ?? "")
        .filter((run) => /pnpm run repair:execute-fix\b/.test(run));
      assert.equal(reportCommands?.length, 0);
      assert.match(fs.readFileSync(file, "utf8"), /repair:execution-handoff -- publish/);
    }
    assert.ok(mergeStepCount > 0, `${file} has no merge-capable repair steps`);
  }
});

test("repair execution and validation cannot mutate GitHub before trusted publication", () => {
  const file = ".github/workflows/repair-cluster-worker.yml";
  const source = fs.readFileSync(file, "utf8");
  const workflow = readWorkflow(file);
  const execute = workflow.jobs?.execute;
  const authorize = workflow.jobs?.authorize;
  const validate = workflow.jobs?.validate;
  const report = workflow.jobs?.report;
  const mutate = workflow.jobs?.mutate;
  assert.ok(authorize && execute && validate && report && mutate);

  const executeText = JSON.stringify(execute);
  const validateText = JSON.stringify(validate);
  const reportText = JSON.stringify(report);
  const reportOnlyRequeue = report.steps?.find(
    (step: { id?: string }) => step.id === "requeue_report_only",
  );
  const missingHandoffRequeue = report.steps?.find(
    (step: { id?: string }) => step.id === "requeue_missing_execution",
  );
  assert.ok(reportOnlyRequeue);
  assert.ok(missingHandoffRequeue);
  assert.doesNotMatch(executeText, /create-github-app-token|create-state-token|setup-state/);
  assert.doesNotMatch(validateText, /create-github-app-token|create-state-token|setup-state/);
  assert.doesNotMatch(
    `${executeText}\n${validateText}`,
    /\b(?:git push|gh pr create|gh pr merge|gh issue close|gh api .*comments)\b/,
  );
  assert.match(executeText, /"GH_TOKEN":""/);
  assert.match(executeText, /"GITHUB_TOKEN":""/);
  assert.match(validateText, /"GH_TOKEN":""/);
  assert.match(validateText, /"GITHUB_TOKEN":""/);
  assert.match(executeText, /--prepare-publication/);
  assert.match(String(mutate.if ?? ""), /needs\.execute\.result == 'success'/);
  assert.match(
    String(mutate.if ?? ""),
    /needs\.execute\.outputs\.execute_fix_outcome == 'success'/,
  );
  assert.match(String(mutate.if ?? ""), /needs\.validate\.result == 'success'/);
  assert.match(String(report.if ?? ""), /always\(\)/);
  assert.match(reportText, /Verify immutable authorization for fallback reporting/);
  assert.match(reportText, /Requeue execution missing a sealed handoff/);
  assert.match(reportText, /\.clawsweeper-repair\/authorized\/job\.md/);
  assert.match(reportText, /steps\.verify_execution\.outcome != 'success'/);
  assert.match(reportText, /steps\.download_execution\.outcome != 'success'/);
  assert.match(reportText, /fromJSON\(needs\.cluster\.outputs\.requeue_depth \|\| '0'\) < 1/);
  assert.match(reportText, /count-requeue-required/);
  assert.match(reportText, /repair:requeue/);
  assert.match(
    String(authorize.outputs?.allow_execute ?? ""),
    /steps\.restore_authorization\.outputs\.allow_execute.*steps\.authorize\.outputs\.allow_execute/,
  );
  assert.match(
    String(authorize.outputs?.allow_fix_pr ?? ""),
    /steps\.restore_authorization\.outputs\.allow_fix_pr.*steps\.authorize\.outputs\.allow_fix_pr/,
  );
  for (const job of [execute, report, mutate]) {
    assert.match(String(job.env?.CLAWSWEEPER_ALLOW_EXECUTE ?? ""), /needs\.authorize\.outputs/);
  }
  for (const job of [execute, report, mutate]) {
    assert.match(String(job.env?.CLAWSWEEPER_ALLOW_FIX_PR ?? ""), /needs\.authorize\.outputs/);
  }
  assert.match(source, /Authorize exact job and run[\s\S]*--allow-execute[\s\S]*--allow-fix-pr/);
  assert.match(reportText, /repair:requeue[\s\S]*--allow-execute[\s\S]*--allow-fix-pr/);
  assert.match(
    String(reportOnlyRequeue.if ?? ""),
    /fromJSON\(needs\.cluster\.outputs\.requeue_depth \|\| '0'\) < 1/,
  );
  assert.match(
    String(reportOnlyRequeue.run ?? ""),
    /--requeue-depth[\s\S]*--max-requeue-depth 1[\s\S]*--requeue-authority clawsweeper-app/,
  );
  for (const step of [reportOnlyRequeue, missingHandoffRequeue]) {
    assert.match(
      String(step.run ?? ""),
      /repair:requeue -- \.clawsweeper-repair\/authorized\/job\.md[\s\S]*--source-job-path "\$\{\{ needs\.authorize\.outputs\.source_job_path \}\}"/,
    );
    assert.match(
      String(step.run ?? ""),
      /--deadline-at-ms "\$\{\{ steps\.report_deadline\.outputs\.deadline_at_ms \}\}"[\s\S]*--wait-for-capacity/,
    );
    assert.match(String(step.run ?? ""), /--source-run-id "\$\{\{ github\.run_id \}\}"/);
  }
  const reportDeadline = report.steps?.find(
    (step: { id?: string }) => step.id === "report_deadline",
  );
  assert.match(String(reportDeadline?.run ?? ""), /\+ 480000/);
  assert.ok(480_000 < 10 * 60 * 1000);
  assert.match(reportText, /REQUEUE_OUTCOME/);
  assert.match(reportText, /bounded authorized retry could not be queued/);
  assert.match(reportText, /bounded retry, but the retry could not be queued/);
  assert.match(reportText, /failed deterministic verification\. It was not requeued/);
  assert.match(
    String(
      report.steps?.find(
        (step: { name?: string }) => step.name === "Publish terminal report-only status",
      )?.if ?? "",
    ),
    /always\(\)/,
  );
  assert.match(source, /context\.dispatch_key !== dispatchKey/);
  assert.match(source, /context\.job_path !== jobPath/);
  assert.match(source, /liveJobSha256 !== context\.job_sha256/);
  assert.doesNotMatch(
    String(
      report.steps?.find((step: { id?: string }) => step.id === "requeue_missing_execution")?.if ??
        "",
    ),
    /verify_execution/,
  );
  assert.doesNotMatch(reportText, /target_post_flight_token|permission-pull-requests/);
  assert.doesNotMatch(JSON.stringify(mutate), /repair:apply-result|repair:tag-clawsweeper/);
  assert.match(JSON.stringify(mutate), /npm_config_ignore_scripts/);
  assert.match(source, /Publish execution-disabled terminal status/);
  assert.match(source, /--dashboard-only/);
});

test("exact router lanes are item-specific and durable dispatch is globally serialized", () => {
  const source = fs.readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
  const workflow = readWorkflow(".github/workflows/repair-comment-router.yml");
  const normalize = workflow.jobs?.["normalize-lane"];
  const route = workflow.jobs?.["route-comments"];
  const dispatch = workflow.jobs?.["dispatch-waiting-commands"];
  const group = String(route?.concurrency?.group ?? "");
  const dispatchGroup = String(dispatch?.concurrency?.group ?? "");

  assert.ok(normalize);
  assert.ok(dispatch);
  assert.equal(workflow.concurrency, undefined);
  assert.equal(route?.needs, "normalize-lane");
  assert.match(group, /needs\.normalize-lane\.outputs\.concurrency_group/);
  assert.doesNotMatch(group, /comment_id|items-\{1\}/);
  assert.equal(route?.concurrency?.["cancel-in-progress"], false);
  assert.match(dispatchGroup, /needs\.normalize-lane\.outputs\.dispatch_concurrency_group/);
  assert.equal(dispatch?.concurrency?.["cancel-in-progress"], false);
  assert.match(
    source,
    /REPOSITORY_DISPATCH_ITEM_NUMBER:.*github\.event\.client_payload\.item_number/,
  );
  assert.match(
    source,
    /WORKFLOW_DISPATCH_ITEM_NUMBERS:.*inputs\.item_numbers[\s\S]*EVENT_NAME" = "repository_dispatch"[\s\S]*EVENT_NAME" = "workflow_dispatch"/,
  );
  assert.match(
    source,
    /grep -Eq '\^\[1-9\]\[0-9\]\*\$'[\s\S]*Number\.isSafeInteger\(n\)[\s\S]*String\(n\) === process\.argv\[1\]/,
  );
  assert.match(
    source,
    /concurrency_group="repair-comment-router-\$target_repo-item-\$item_number"/,
  );
  assert.match(source, /concurrency_group="repair-comment-router-\$target_repo-scan"/);
  assert.match(
    source,
    /concurrency_group="repair-comment-router-\$target_repo-scan-continuation-\$ROUTER_FANOUT_AFTER"/,
  );
  assert.match(source, /group: \$\{\{ needs\.normalize-lane\.outputs\.concurrency_group \}\}/);
  const laneStep = normalize.steps?.find((step: { id?: string }) => step.id === "lane");
  const laneScript = String(laneStep?.run ?? "");
  const scanLane = runRouterLaneScript(laneScript, {
    EVENT_NAME: "schedule",
    TARGET_REPO: "openclaw/openclaw",
  });
  const continuation42 = runRouterLaneScript(laneScript, {
    EVENT_NAME: "workflow_dispatch",
    TARGET_REPO: "openclaw/openclaw",
    ROUTER_FANOUT_AFTER: "42",
  });
  const continuation43 = runRouterLaneScript(laneScript, {
    EVENT_NAME: "workflow_dispatch",
    TARGET_REPO: "openclaw/openclaw",
    ROUTER_FANOUT_AFTER: "43",
  });
  const item42 = runRouterLaneScript(laneScript, {
    EVENT_NAME: "repository_dispatch",
    TARGET_REPO: "openclaw/openclaw",
    REPOSITORY_DISPATCH_ITEM_NUMBER: "42",
  });
  const item43 = runRouterLaneScript(laneScript, {
    EVENT_NAME: "repository_dispatch",
    TARGET_REPO: "openclaw/openclaw",
    REPOSITORY_DISPATCH_ITEM_NUMBER: "43",
  });
  assert.equal(scanLane.concurrency_group, "repair-comment-router-openclaw/openclaw-scan");
  assert.equal(
    continuation42.concurrency_group,
    "repair-comment-router-openclaw/openclaw-scan-continuation-42",
  );
  assert.notEqual(continuation42.concurrency_group, scanLane.concurrency_group);
  assert.notEqual(continuation42.concurrency_group, continuation43.concurrency_group);
  assert.notEqual(item42.concurrency_group, item43.concurrency_group);
  assert.equal(item42.exact_item, "true");
  assert.equal(item43.exact_item, "true");
  assert.equal(
    item42.dispatch_concurrency_group,
    "repair-comment-router-openclaw/openclaw-worker-dispatch",
  );
  assert.equal(
    item43.dispatch_concurrency_group,
    "repair-comment-router-openclaw/openclaw-worker-dispatch",
  );
  assert.equal(item43.dispatch_concurrency_group, item42.dispatch_concurrency_group);
  const routerSource = fs.readFileSync("src/repair/comment-router.ts", "utf8");
  const candidateSelection = routerSource.slice(
    routerSource.indexOf("function listCandidateComments()"),
    routerSource.indexOf("function extractMarkdownSection"),
  );
  assert.ok(candidateSelection.indexOf("forceReprocess && itemNumbers.size > 0") >= 0);
  assert.match(
    candidateSelection,
    /itemNumbers[\s\S]*recentComments: \[\.\.\.itemNumbers\][\s\S]*\.flatMap[\s\S]*isSuppressedStaleDurableComment[\s\S]*priorityComments: \[\.\.\.forwardedExactComments\(\), \.\.\.durable\.pendingComments\]/,
  );
  assert.ok(
    candidateSelection.indexOf("selectRouterItemFanoutPage({") <
      candidateSelection.indexOf("listDurableRouterComments(broadPage.itemNumbers)"),
  );
  assert.match(
    candidateSelection,
    /routerPendingItemNumbers\(ledger\.commands \?\? \[\], targetRepo\)/,
  );
  assert.match(
    source,
    /Dispatch discovered items through exact router lanes[\s\S]*-f item_numbers="\$item_number"/,
  );
  const fanoutStart = source.indexOf(
    "- name: Dispatch discovered items through exact router lanes",
  );
  const fanoutEnd = source.indexOf("\n  dispatch-waiting-commands:", fanoutStart);
  const fanout = source.slice(fanoutStart, fanoutEnd);
  assert.match(
    fanout,
    /repository_dispatch.*!github\.event\.client_payload\.item_number.*github\.event\.client_payload\.comment_id/,
  );
  for (const input of ["force_reprocess", "lookback_minutes", "since", "max_comments"]) {
    assert.match(fanout, new RegExp(`-f ${input}="\\$${input}"`));
  }
  assert.match(
    fanout,
    /since="\$\([\s\S]*jq -er '\.since \| strings \| select\(length > 0\)'[\s\S]*results\/comment-router-latest\.json[\s\S]*\)"/,
  );
  assert.doesNotMatch(fanout, /since="\$\{\{ github\.event\.(?:inputs|client_payload)/);
  assert.match(fanout, /router_item_fanout\.selected_item_numbers/);
  assert.match(fanout, /group_by\(\.issue_number\)/);
  assert.match(fanout, /\.\[\]\.comment_id.*test\("\^\[0-9\]\+\$"\)/s);
  assert.match(
    fanout,
    /test\("\^repair-loop-label-sweep:\(autofix\|automerge\):\[1-9\]\[0-9\]\*\$"\)/,
  );
  assert.match(fanout, /read -r item_number item_comment_ids/);
  assert.match(
    fanout,
    /router_item_fanout\.next_after_item_number[\s\S]*-f router_fanout_after="\$router_fanout_after"/,
  );
  assert.match(fanout, /-f item_numbers="\$item_numbers"[\s\S]*-f comment_ids="\$comment_ids"/);
  assert.match(fanout, /if \[ -n "\$item_comment_ids" \][\s\S]*comment_ids=\$item_comment_ids/);
  assert.doesNotMatch(
    fanout.slice(0, fanout.indexOf('router_fanout_after="$(')),
    /-f comment_ids="\$comment_ids"/,
  );
  assert.doesNotMatch(
    fanout,
    /-f force_reprocess=false|-f lookback_minutes=180|-f max_comments=100/,
  );
  assert.match(source, /Route ClawSweeper comments[\s\S]*args\+=\(--stage-selected-commands\)/);
  const routeStep = route?.steps?.find(
    (step: { name?: string }) => step.name === "Route ClawSweeper comments",
  );
  const dispatchStep = dispatch.steps?.find(
    (step: { name?: string }) =>
      step.name === "Drain durable waiting commands under the serialized capacity gate",
  );
  assert.doesNotMatch(String(routeStep?.run ?? ""), /--execute/);
  assert.match(String(dispatchStep?.run ?? ""), /--wait-for-capacity/);
  assert.match(String(dispatchStep?.run ?? ""), /--execute/);
  assert.match(String(dispatchStep?.run ?? ""), /results\/comment-router\.json/);
  assert.match(String(dispatchStep?.run ?? ""), /\.status == "waiting" or \.status == "claimed"/);
  assert.match(
    String(dispatchStep?.run ?? ""),
    /group_by\(\[\s*\.issue_number,\s*\(\.comment_version_key \/\/ \.idempotency_key \/\/ \.comment_id\),\s*\(\.attempt_id \/\/ ""\)\s*\]\)/,
  );
  assert.match(String(dispatchStep?.run ?? ""), /dispatch_context\.since/);
  assert.match(String(dispatchStep?.run ?? ""), /status_comment_id/);
  assert.match(String(dispatchStep?.run ?? ""), /--attempt-id "\$attempt_id"/);
  assert.doesNotMatch(String(dispatchStep?.run ?? ""), /inputs\.item_numbers/);
  assert.equal(dispatch["timeout-minutes"], 40);
  assert.match(
    source,
    /Route ClawSweeper comments[\s\S]*repository_dispatch[\s\S]*workflow_dispatch[\s\S]*schedule[\s\S]*args\+=\(--stage-selected-commands\)/,
  );
  assert.ok(dispatch);
  assert.deepEqual(dispatch.needs, ["normalize-lane", "route-comments"]);
  assert.match(
    String(dispatch.if ?? ""),
    /exact_item == 'true'[\s\S]*repository_dispatch[\s\S]*workflow_dispatch[\s\S]*inputs\.execute/,
  );
  assert.match(
    String(dispatch.concurrency?.group ?? ""),
    /needs\.normalize-lane\.outputs\.dispatch_concurrency_group/,
  );
  assert.equal(dispatch.concurrency?.["cancel-in-progress"], false);
  assert.match(
    source,
    /Drain durable waiting commands under the serialized capacity gate[\s\S]*--wait-for-capacity[\s\S]*--execute/,
  );
  assert.doesNotMatch(source, /Retry waiting repair dispatches/);
  for (const stepName of [
    "Commit comment router ledger",
    "Commit comment router dispatch ledger",
  ]) {
    const start = source.indexOf(`- name: ${stepName}`);
    const nextStep = source.indexOf("\n      - name:", start + 1);
    const block = source.slice(start, nextStep === -1 ? undefined : nextStep);
    assert.match(block, /--path results\/comment-router\.json/);
    assert.match(block, /--rebase-strategy merge-comment-router/);
    assert.doesNotMatch(block, /--rebase-strategy theirs/);
  }
});

test("repair requeues require one authenticated bounded context and stable key", () => {
  const workflow = readWorkflow(".github/workflows/repair-cluster-worker.yml");
  const step = workflow.jobs?.cluster?.steps?.find(
    (candidate: { id?: string }) => candidate.id === "requeue_context",
  );
  const script = String(step?.run ?? "");
  const missing = runRequeueContextScript(script, {
    REQUEUE_REQUESTED: "true",
    REQUEUE_ACTOR: "openclaw-clawsweeper[bot]",
  });
  assert.notEqual(missing.status, 0);
  assert.match(
    missing.stderr,
    /requeue=true requires captured context, authenticated authority, and dispatch key/,
  );

  const dispatchKey = "requeue-1-0123456789abcdef01234567";
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-requeue-job-"));
  const jobPath = path.join(jobRoot, "job.md");
  const jobBody = "---\nrepo: openclaw/openclaw\n---\n\n# repair\n";
  fs.writeFileSync(jobPath, jobBody);
  const jobSha256 = createHash("sha256").update(jobBody).digest("hex");
  const context = Buffer.from(
    JSON.stringify({
      schema_version: 2,
      authority: "clawsweeper-app",
      depth: 1,
      allow_execute: "1",
      allow_fix_pr: "1",
      dispatch_key: dispatchKey,
      job_path: jobPath,
      job_sha256: jobSha256,
    }),
  ).toString("base64url");
  const valid = runRequeueContextScript(script, {
    REQUEUE_REQUESTED: "true",
    REQUEUE_CONTEXT: context,
    REQUEUE_AUTHORITY: "clawsweeper-app",
    REQUEUE_DISPATCH_KEY: dispatchKey,
    REQUEUE_ACTOR: "openclaw-clawsweeper[bot]",
    REQUEUE_EVENT_NAME: "workflow_dispatch",
    REQUEUE_JOB_PATH: jobPath,
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.outputs.depth, "1");
  assert.match(valid.environment, /CLAWSWEEPER_ALLOW_EXECUTE=1/);
  assert.match(valid.environment, /CLAWSWEEPER_ALLOW_FIX_PR=1/);

  const unstable = runRequeueContextScript(script, {
    REQUEUE_REQUESTED: "true",
    REQUEUE_CONTEXT: context,
    REQUEUE_AUTHORITY: "clawsweeper-app",
    REQUEUE_DISPATCH_KEY: "manual-retry",
    REQUEUE_ACTOR: "openclaw-clawsweeper[bot]",
    REQUEUE_EVENT_NAME: "workflow_dispatch",
    REQUEUE_JOB_PATH: jobPath,
  });
  assert.notEqual(unstable.status, 0);
  assert.match(unstable.stderr, /captured requeue context is invalid/);

  fs.appendFileSync(jobPath, "\nchanged\n");
  const changed = runRequeueContextScript(script, {
    REQUEUE_REQUESTED: "true",
    REQUEUE_CONTEXT: context,
    REQUEUE_AUTHORITY: "clawsweeper-app",
    REQUEUE_DISPATCH_KEY: dispatchKey,
    REQUEUE_ACTOR: "openclaw-clawsweeper[bot]",
    REQUEUE_EVENT_NAME: "workflow_dispatch",
    REQUEUE_JOB_PATH: jobPath,
  });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /captured requeue job content changed before execution/);
});

function runRouterLaneScript(script: string, overrides: NodeJS.ProcessEnv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-router-lane-"));
  const output = path.join(root, "output");
  execFileSync("bash", ["-c", script], {
    env: {
      ...process.env,
      EVENT_NAME: "",
      REPOSITORY_DISPATCH_ITEM_NUMBER: "",
      WORKFLOW_DISPATCH_ITEM_NUMBERS: "",
      ROUTER_FANOUT_AFTER: "",
      TARGET_REPO: "openclaw/openclaw",
      ...overrides,
      GITHUB_OUTPUT: output,
    },
  });
  return Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

function runRequeueContextScript(script: string, overrides: NodeJS.ProcessEnv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-requeue-context-"));
  const output = path.join(root, "output");
  const environment = path.join(root, "environment");
  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      REQUEUE_CONTEXT: "",
      REQUEUE_REQUESTED: "false",
      REQUEUE_AUTHORITY: "",
      REQUEUE_DISPATCH_KEY: "",
      REQUEUE_ACTOR: "",
      REQUEUE_EVENT_NAME: "workflow_dispatch",
      REQUEUE_JOB_PATH: "",
      ...overrides,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: environment,
    },
    encoding: "utf8",
  });
  const readKeyValues = (file: string) =>
    fs.existsSync(file)
      ? Object.fromEntries(
          fs
            .readFileSync(file, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((entry) => {
              const separator = entry.indexOf("=");
              return [entry.slice(0, separator), entry.slice(separator + 1)];
            }),
        )
      : {};
  return {
    status: result.status,
    stderr: result.stderr,
    outputs: readKeyValues(output),
    environment: fs.existsSync(environment) ? fs.readFileSync(environment, "utf8") : "",
  };
}

test("workflow App identity is derived from authenticated tokens, never a configured numeric id", () => {
  for (const file of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /CLAWSWEEPER_APP_ID/);
    assert.match(source, /gh api "apps\/\$APP_SLUG" --jq '\.id'/);
    assert.doesNotMatch(source, new RegExp(`gh api (?:["'])?installation(?:["'/\\s]|$)`));
  }
});

test("merge-disabled workflows skip merge App identity lookup without blocking publication", () => {
  for (const [file, jobName, identityStepId, mergeFlag] of [
    [
      ".github/workflows/repair-cluster-worker.yml",
      "mutate",
      "mutation_app",
      "env.CLAWSWEEPER_ALLOW_MERGE",
    ],
    [
      ".github/workflows/repair-comment-router.yml",
      "route-comments",
      "mutation-app",
      "vars.CLAWSWEEPER_ALLOW_MERGE",
    ],
  ] as const) {
    const workflow = readWorkflow(file);
    const steps = workflow.jobs?.[jobName]?.steps ?? [];
    const identityStep = steps.find((step) => step.id === identityStepId);
    assert.ok(identityStep, `${file} is missing its mutation App identity step`);
    assert.match(String(identityStep.if ?? ""), new RegExp(`${escapeRegex(mergeFlag)} == '1'`));

    const mutationToken = steps.find((step) =>
      ["app_token", "target_post_flight_token"].includes(String(step.id ?? "")),
    );
    assert.ok(mutationToken, `${file} is missing its ordinary publication token`);
    assert.doesNotMatch(String(mutationToken.if ?? ""), /ALLOW_MERGE/);
  }
});

test("event review delegates routing without verifier or local router access", () => {
  const workflow = fs.readFileSync(".github/workflows/sweep.yml", "utf8");
  const eventStart = workflow.indexOf("\n  event-review-apply:");
  const eventEnd = workflow.indexOf("\n  target-fanout:", eventStart);
  const eventJob = workflow.slice(eventStart, eventEnd);

  assert.ok(eventStart > 0 && eventEnd > eventStart);
  assert.doesNotMatch(eventJob, /ruleset-verifier-token/);
  assert.doesNotMatch(eventJob, /CLAWSWEEPER_RULESET_GH_TOKEN/);
  assert.doesNotMatch(eventJob, /permission-administration/);
  assert.doesNotMatch(eventJob, /pnpm run repair:comment-router\b/);
  assert.match(eventJob, /gh workflow run repair-comment-router\.yml/);
  assert.match(eventJob, /-f item_numbers="\$ITEM_NUMBER"/);
});

test("commit finding intake is merge-disabled and carries no verifier credential", () => {
  const file = ".github/workflows/repair-commit-finding-intake.yml";
  const source = fs.readFileSync(file, "utf8");
  const workflow = readWorkflow(file);

  assert.equal(workflow.env?.CLAWSWEEPER_ALLOW_MERGE, "0");
  assert.match(source, /Create read-only intake token[\s\S]*permission-contents: read/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("- name: Create read-only intake token"),
      source.indexOf("- name: Create central dispatch token"),
    ),
    /permission-(?:contents|issues|pull-requests|workflows): write/,
  );
  assert.match(
    source,
    /Create central dispatch token[\s\S]*repositories: clawsweeper[\s\S]*permission-actions: write/,
  );
  const dispatchToken = source.slice(
    source.indexOf("- name: Create central dispatch token"),
    source.indexOf("- name: Create state token"),
  );
  assert.match(dispatchToken, /permission-contents: read/);
  assert.doesNotMatch(dispatchToken, /permission-contents: write/);
  assert.match(source, /pnpm run repair:dispatch --/);
  assert.match(source, /--mode autonomous[\s\S]*--execution-runner "\$EXECUTION_RUNNER"/);
  assert.doesNotMatch(source, /repair:execute-fix|repair:post-flight|setup-codex/);
  assert.doesNotMatch(source, /ruleset-verifier-token/);
  assert.doesNotMatch(source, /CLAWSWEEPER_RULESET_GH_TOKEN/);
  assert.doesNotMatch(source, /permission-administration/);
});

function strictRulesetRule(
  sourceType: "Repository" | "Organization" | "Enterprise" = "Repository",
  rulesetId = 18588237,
  checks = ["required-ci/exact-merge"],
) {
  return {
    type: "required_status_checks",
    ruleset_id: rulesetId,
    ruleset_source: sourceType === "Repository" ? "openclaw/openclaw" : "openclaw",
    ruleset_source_type: sourceType,
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: checks.map((context) => ({ context })),
    },
  };
}

function strictRulesetDetails({
  checks = ["required-ci/exact-merge"],
  bypassActors = [],
  enforcement = "active",
  strict = true,
}: {
  checks?: string[];
  bypassActors?: unknown[];
  enforcement?: string;
  strict?: boolean;
} = {}) {
  return {
    enforcement,
    bypass_actors: bypassActors,
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: strict,
          required_status_checks: checks.map((context) => ({ context })),
        },
      },
    ],
  };
}

function appIdentity(
  overrides: Partial<{
    configuredAppSlug: string;
    authenticatedAppId: string | number;
    appSlug: string;
    installationId: string | number;
    policyAppId: string | number;
    policyAppSlug: string;
    policyInstallationId: string | number;
  }> = {},
) {
  return {
    configuredAppSlug: APP_SLUG,
    authenticatedAppId: APP_ID,
    appSlug: APP_SLUG,
    installationId: INSTALLATION_ID,
    policyAppId: APP_ID,
    policyAppSlug: APP_SLUG,
    policyInstallationId: INSTALLATION_ID,
    ...overrides,
  };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type WorkflowStep = {
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
};

type Workflow = {
  env?: Record<string, string>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs?: Record<
    string,
    {
      if?: string;
      needs?: string;
      "timeout-minutes"?: number;
      concurrency?: {
        group?: string;
        "cancel-in-progress"?: boolean;
      };
      steps?: WorkflowStep[];
    }
  >;
};

function readWorkflow(file: string): Workflow {
  return parse(fs.readFileSync(file, "utf8")) as Workflow;
}

function assertRepoScoped(
  file: string,
  jobName: string,
  credential: string,
  step: WorkflowStep,
): void {
  assert.ok(step.with?.owner, `${file}:${jobName} ${credential} token has no owner scope`);
  assert.ok(
    step.with?.repositories,
    `${file}:${jobName} ${credential} token has no repository scope`,
  );
}

function workflowOutputStep(value: string | undefined, output: string): string | null {
  return (
    value?.match(new RegExp(`steps\\.([^.]+)\\.outputs\\.${output.replace("-", "\\-")}`))?.[1] ??
    null
  );
}

function fakeGithub({
  rules,
  ruleset = null,
  rulesets = {},
  protection = { required_status_checks: null },
  requestedEndpoints,
}: {
  rules: unknown[];
  ruleset?: unknown;
  rulesets?: Record<number, unknown>;
  protection?: unknown;
  requestedEndpoints?: string[];
}) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (endpoint) requestedEndpoints?.push(endpoint);
    if (endpoint === "repos/openclaw/openclaw/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/example/rules/branches/main") return rules;
    const rulesetId = Number(endpoint?.match(/\/rulesets\/(\d+)$/)?.[1]);
    if (Number.isSafeInteger(rulesetId) && rulesetId in rulesets) return rulesets[rulesetId];
    if (endpoint === "repos/openclaw/openclaw/rulesets/18588237" && ruleset) return ruleset;
    if (endpoint?.endsWith("/branches/main/protection")) return protection;
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}
