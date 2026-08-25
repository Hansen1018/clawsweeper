import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = fs.readFileSync(".github/workflows/sweep.yml", "utf8");
const publishStart = workflow.indexOf("\n  event-review-publish:");
const publishEnd = workflow.indexOf("\n  event-review-terminal-finalization:", publishStart);
const publication = workflow.slice(publishStart, publishEnd);

test("exact-review publication finalization fences Endor convergence and notification durability", () => {
  assert.ok(publishStart > 0);
  assert.ok(publishEnd > publishStart);
  assert.match(publication, /name: Prepare Endor exact-head review/);
  assert.match(
    publication,
    /--review-generation "\$PUBLISHER_LEASE_ID:\$PUBLISHER_LEASE_REVISION"/,
  );
  assert.match(publication, /name: Advance Endor review-until-clean state/);
  assert.match(publication, /name: Queue next Endor exact-head review/);
  assert.match(publication, /name: Deliver Endor remediation notification/);
  assert.match(
    publication,
    /name: Deliver Endor remediation notification[\s\S]*?GH_TOKEN: \$\{\{ steps\.target-write-token\.outputs\.token \}\}/,
  );
  assert.match(publication, /name: Queue current Endor head after delivery drift/);
  assert.match(publication, /CLAWSWEEPER_HERMIT_URL/);
  assert.match(publication, /CLAWSWEEPER_HERMIT_TOKEN/);
  assert.match(publication, /name: Publish Endor terminal review state/);
  assert.match(publication, /name: Publish Endor notification receipt/);
  assert.match(publication, /id: endor-finalization-readiness/);
  assert.match(publication, /steps\.advance-endor-review\.outputs\.state_path/);
  assert.match(publication, /steps\.deliver-endor-notification\.outputs\.ledger_path/);
  assert.match(publication, /steps\.deliver-endor-notification\.outputs\.report_path/);
  assert.doesNotMatch(publication, /endor-remediation-(?:review-state|ledger|report)\.json/);
  assert.match(publication, /steps\.prepare-endor-review\.outputs\.failure_kind/);
  assert.match(publication, /steps\.prepare-endor-review\.outputs\.retry_at/);
  assert.match(publication, /steps\.deliver-endor-notification\.outputs\.failure_kind/);
  assert.match(publication, /steps\.queue-current-endor-head\.outcome/);
  assert.doesNotMatch(publication, /ENDOR_ACTION/);
  assert.doesNotMatch(
    publication,
    /\[ "\$outcome" = "success" \] && \[ "\$ENDOR_ACTION" = "requeue" \]/,
  );

  const prepare = publication.indexOf("name: Prepare Endor exact-head review");
  const publishTerminal = publication.indexOf("name: Publish Endor terminal review state");
  const deliver = publication.indexOf("name: Deliver Endor remediation notification");
  const publishReceipt = publication.indexOf("name: Publish Endor notification receipt");
  const readiness = publication.indexOf("name: Resolve Endor finalization readiness");
  const acknowledgement = publication.indexOf("name: Complete durable exact review publication");
  assert.ok(prepare > 0);
  assert.ok(publishTerminal > prepare);
  assert.ok(deliver > publishTerminal);
  assert.ok(publishReceipt > deliver);
  assert.ok(readiness > publishReceipt);
  assert.ok(acknowledgement > readiness);
  assert.match(publication, /ENDOR_FINALIZATION_READY/);
});

test("Endor publication completion retires queued successors and retries transient preparation", () => {
  const document = parse(workflow) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; env?: Record<string, unknown> }> }
    >;
  };
  const exportStep = document.jobs["event-review-publish"]?.steps.find(
    (step) => step.name === "Export exact review publication result",
  );
  assert.ok(exportStep?.run);
  const baseEnv = Object.fromEntries(Object.keys(exportStep.env ?? {}).map((name) => [name, ""]));
  const run = (overrides: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "endor-publication-result-"));
    const output = path.join(root, "github-output");
    try {
      execFileSync("bash", ["-c", exportStep.run!], {
        env: { ...process.env, ...baseEnv, ...overrides, GITHUB_OUTPUT: output },
      });
      return Object.fromEntries(
        fs
          .readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  assert.deepEqual(
    run({
      ENDOR_FINALIZATION_READY: "false",
      ENDOR_PREPARE_OUTCOME: "failure",
      ENDOR_PREPARE_FAILURE_KIND: "github_transient",
      REQUEUE_LATEST: "false",
    }),
    {
      outcome: "failure",
      completion_kind: "retryable_failure",
      reason_code: "github_transient",
      requeue_latest: "false",
      direct_requeue: "false",
      failure_kind: "github_transient",
    },
  );

  const successor = run({
    ENDOR_FINALIZATION_READY: "true",
    ENDOR_PREPARE_OUTCOME: "success",
    PRIOR_JOB_STATUS: "success",
    PUBLISH_OUTCOME: "success",
    PUBLISH_COMPLETION_KIND: "published",
    PUBLISH_REASON_CODE: "publication_applied",
    GUARDED_OPEN: "true",
    REQUEUE_LATEST: "false",
  });
  assert.equal(successor.outcome, "success");
  assert.equal(successor.completion_kind, "published");
  assert.equal(successor.reason_code, "publication_applied");
  assert.equal(successor.requeue_latest, "false");

  const deliveryRetry = run({
    ENDOR_FINALIZATION_READY: "false",
    ENDOR_DELIVERY_OUTCOME: "failure",
    ENDOR_DELIVERY_FAILURE_KIND: "github_transient",
    REQUEUE_LATEST: "false",
  });
  assert.equal(deliveryRetry.completion_kind, "retryable_failure");
  assert.equal(deliveryRetry.reason_code, "github_transient");
  assert.equal(deliveryRetry.failure_kind, "github_transient");

  const hermitRetry = run({
    ENDOR_FINALIZATION_READY: "false",
    ENDOR_DELIVERY_OUTCOME: "failure",
    ENDOR_DELIVERY_FAILURE_KIND: "hermit_transient",
    REQUEUE_LATEST: "false",
  });
  assert.equal(hermitRetry.completion_kind, "retryable_failure");
  assert.equal(hermitRetry.reason_code, "hermit_transient");
  assert.equal(hermitRetry.failure_kind, undefined);
});

test("delivery terminal races finalize without a receipt or another review", () => {
  const document = parse(workflow) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; env?: Record<string, unknown> }> }
    >;
  };
  const readinessStep = document.jobs["event-review-publish"]?.steps.find(
    (step) => step.name === "Resolve Endor finalization readiness",
  );
  assert.ok(readinessStep?.run);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "endor-terminal-readiness-"));
  const output = path.join(root, "github-output");
  try {
    execFileSync("bash", ["-c", readinessStep.run], {
      env: {
        ...process.env,
        ...Object.fromEntries(Object.keys(readinessStep.env ?? {}).map((name) => [name, ""])),
        PREPARE_OUTCOME: "success",
        ELIGIBLE: "true",
        ADVANCE_OUTCOME: "success",
        ACTION: "notify",
        DELIVERY_OUTCOME: "success",
        DELIVERY_ACTION: "complete",
        TERMINAL_STATE_PUBLICATION_OUTCOME: "success",
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(fs.readFileSync(output, "utf8"), "ready=true\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the default direct path diverts eligible Endor reviews to durable publication", () => {
  const document = parse(workflow) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; env?: Record<string, unknown>; if?: string }> }
    >;
  };
  const steps = document.jobs["event-review-apply"]?.steps ?? [];
  const prepareIndex = steps.findIndex(
    (step) => step.name === "Deliver GitHub effects and prepare direct state mutation",
  );
  const detectIndex = steps.findIndex(
    (step) => step.name === "Detect Endor review for durable publication",
  );
  const routeIndex = steps.findIndex(
    (step) => step.name === "Resolve direct exact review publication route",
  );
  const directIndex = steps.findIndex(
    (step) => step.name === "Post direct exact review publication result",
  );
  assert.ok(prepareIndex >= 0 && detectIndex > prepareIndex);
  assert.ok(routeIndex > detectIndex && directIndex > routeIndex);
  assert.match(
    steps[directIndex]?.if ?? "",
    /direct-publication-route\.outputs\.route == 'direct'/,
  );

  const routeStep = steps[routeIndex];
  assert.ok(routeStep?.run);
  const run = (overrides: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "endor-direct-route-"));
    const output = path.join(root, "github-output");
    try {
      execFileSync("bash", ["-c", routeStep.run!], {
        env: {
          ...process.env,
          ITEM_KIND: "",
          DETECTION_OUTCOME: "",
          ENDOR_ELIGIBLE: "",
          ...overrides,
          GITHUB_OUTPUT: output,
        },
      });
      return fs.readFileSync(output, "utf8").trim();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  assert.equal(run({ ITEM_KIND: "issue" }), "route=direct");
  assert.equal(
    run({ ITEM_KIND: "pull_request", DETECTION_OUTCOME: "success", ENDOR_ELIGIBLE: "false" }),
    "route=direct",
  );
  assert.equal(
    run({ ITEM_KIND: "pull_request", DETECTION_OUTCOME: "success", ENDOR_ELIGIBLE: "true" }),
    "route=durable_publication",
  );
  assert.equal(
    run({ ITEM_KIND: "pull_request", DETECTION_OUTCOME: "failure" }),
    "route=durable_publication",
  );
});
