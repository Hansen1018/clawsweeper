import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySpamCommentActivity,
  runSpamCommentIntake,
} from "../../dist/repair/spam-comment-intake.js";

function spamActivity() {
  return {
    action: "github_activity",
    client_payload: {
      event_name: "issue_comment",
      activity: {
        type: "issue_comment",
        action: "created",
        repo: "openclaw/openclaw",
        actor: "IgorGanapolsky",
        subject: {
          kind: "issue",
          number: 81908,
          title: "Telegram hangs",
          url: "https://github.com/openclaw/openclaw/issues/81908",
          state: "open",
        },
        comment: {
          id: 4454649536,
          html_url: "https://github.com/openclaw/openclaw/issues/81908#issuecomment-4454649536",
          body: "We build Managed Revenue Engines for $1,500. Demo: https://igorganapolsky.github.io/openclaw-mac-ai-workstation-setup/agent-app-catalog.html",
          user: { login: "IgorGanapolsky" },
          author_association: "NONE",
          created_at: "2026-05-14T20:54:28Z",
          updated_at: "2026-05-14T20:54:28Z",
        },
      },
    },
  };
}

test("spam comment intake dispatches exact scans for deterministic candidates", () => {
  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload: spamActivity(),
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
  assert.equal(decision.dispatch_payload.client_payload.comment_id, "4454649536");
  assert.equal(decision.dispatch_payload.client_payload.max_comments, "1");
  assert.match(decision.reason, /outside_author_with_external_link/);
  assert.match(decision.reason, /priced_service_pitch/);
});

test("spam comment intake accepts compact repository dispatch activity payloads", () => {
  const payload = spamActivity();
  delete payload.client_payload.activity.type;

  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
});

test("spam comment intake honors target repo on compact dispatch payloads", () => {
  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload: {
      action: "github_activity",
      repository: { full_name: "openclaw/clawsweeper" },
      client_payload: {
        event_name: "issue_comment",
        action: "created",
        target_repo: "openclaw/openclaw",
        comment_id: 4454649536,
        body: "We build Managed Revenue Engines for $1,500. Demo: https://igorganapolsky.github.io/openclaw-mac-ai-workstation-setup/agent-app-catalog.html",
        actor: "IgorGanapolsky",
      },
    },
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
  assert.equal(decision.dispatch_payload.client_payload.target_repo, "openclaw/openclaw");
});

test("spam comment intake honors top-level target repo on nested dispatch payloads", () => {
  const payload = spamActivity();
  payload.repository = { full_name: "openclaw/clawsweeper" };
  payload.client_payload.target_repo = "openclaw/openclaw";
  delete payload.client_payload.activity.repo;

  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
  assert.equal(decision.dispatch_payload.client_payload.target_repo, "openclaw/openclaw");
});

test("spam comment intake dispatches exact scans for pull request review comments", () => {
  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload: {
      action: "github_activity",
      client_payload: {
        event_name: "pull_request_review_comment",
        activity: {
          type: "pull_request_review_comment",
          action: "created",
          repo: "openclaw/openclaw",
          actor: "IgorGanapolsky",
          subject: {
            kind: "pull_request",
            number: 81908,
            url: "https://github.com/openclaw/openclaw/pull/81908",
          },
          comment: {
            id: 4454649536,
            url: "https://github.com/openclaw/openclaw/pull/81908#discussion_r4454649536",
            body_excerpt:
              "We build Managed Revenue Engines for $1,500. Demo: https://igorganapolsky.github.io/openclaw-mac-ai-workstation-setup/agent-app-catalog.html",
          },
        },
      },
    },
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.comment.kind, "pull_request_review_comment");
  assert.equal(decision.dispatch_payload.client_payload.review_comment_id, "4454649536");
  assert.equal(decision.dispatch_payload.client_payload.comment_id, undefined);
});

test("spam comment intake skips protected authors before dispatch", () => {
  const payload = spamActivity();
  payload.client_payload.activity.comment.author_association = "CONTRIBUTOR";

  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload,
  });

  assert.equal(decision.accepted, false);
  assert.match(decision.reason, /protected/);
});

test("runSpamCommentIntake posts repository dispatch for accepted comments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-spam-intake-"));
  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(eventPath, `${JSON.stringify(spamActivity())}\n`);
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  const summary = await runSpamCommentIntake(["--write-report"], {
    root,
    log: () => undefined,
    env: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GH_TOKEN: "token",
    },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(summary.status, "ok");
  assert.equal(summary.dispatched, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.github.com/repos/openclaw/clawsweeper/dispatches");
  assert.deepEqual(requests[0]?.body, {
    event_type: "clawsweeper_spam_comment",
    client_payload: {
      target_repo: "openclaw/openclaw",
      comment_id: "4454649536",
      max_comments: "1",
    },
  });
  assert.ok(fs.existsSync(path.join(root, "notifications/spam-comment-intake-report.json")));
});

test("spam comment intake records privacy-safe classification and exact dispatch receipts", async () => {
  const first = await runLedgerIntake({
    runId: "8101",
    fetch: async () => new Response(null, { status: 204 }),
  });
  const second = await runLedgerIntake({
    runId: "8102",
    fetch: async () => new Response(null, { status: 204 }),
  });

  try {
    const classification = first.events.find((event) => event.event_type === "review.item");
    assert.equal(classification?.action.status, "classified");
    assert.equal(classification?.action.reason_code, "accepted");
    assert.equal(classification?.attributes?.completion_reason, "candidate_accepted");

    const dispatches = first.events.filter((event) => event.event_type === "dispatch.lifecycle");
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[0]?.action.status, "started");
    assert.equal(dispatches[1]?.action.status, "dispatched");
    assert.equal(dispatches[1]?.action.mutation, true);
    assert.equal(dispatches[1]?.attributes?.completion_reason, "mutation_accepted");
    assert.equal(dispatches[1]?.parent_event_id, dispatches[0]?.event_id);
    assert.equal(dispatches[1]?.idempotency_key_sha256, dispatches[0]?.idempotency_key_sha256);
    assert.equal(dispatches[1]?.evidence?.[0]?.sha256, dispatches[0]?.evidence?.[0]?.sha256);

    const secondAttempt = second.events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "started",
    );
    assert.equal(secondAttempt?.idempotency_key_sha256, dispatches[0]?.idempotency_key_sha256);

    const terminal = first.events.at(-1);
    assert.equal(terminal?.event_type, "review.batch");
    assert.equal(terminal?.action.status, "completed");
    assert.equal(terminal?.action.mutation, true);
    assert.equal(terminal?.attributes?.processed_count, 1);
    assert.equal(terminal?.evidence?.[0]?.kind, "spam_comment_intake_report");

    const reportPath = path.join(first.root, "notifications", "spam-comment-intake-report.json");
    const reportBytes = fs.readFileSync(reportPath);
    assert.ok(reportBytes.byteLength < 64 * 1024);
    assert.equal(terminal?.evidence?.[0]?.sha256, sha256(reportBytes));
    assert.equal(
      terminal?.evidence?.[0]?.report_path,
      "notifications/spam-comment-intake-report.json",
    );

    const serialized = `${ledgerContents(first.outputRoot)}\n${reportBytes.toString("utf8")}`;
    assert.doesNotMatch(serialized, /Managed Revenue Engines/);
    assert.doesNotMatch(serialized, /igorganapolsky\.github\.io/);
    assert.doesNotMatch(serialized, /intake-token-marker/);
    assert.doesNotMatch(serialized, /"body"\s*:/);
    assert.doesNotMatch(serialized, /"html_url"\s*:/);
  } finally {
    fs.rmSync(first.root, { force: true, recursive: true });
    fs.rmSync(second.root, { force: true, recursive: true });
  }
});

test("spam comment intake records explicit dispatch rejection without claiming mutation", async () => {
  const result = await runLedgerIntake({
    runId: "8103",
    fetch: async () => new Response(null, { status: 422 }),
    expectError: /spam scanner dispatch rejected: 422/,
  });

  try {
    const outcome = result.events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "skipped",
    );
    assert.ok(outcome);
    assert.equal(outcome.action.mutation, false);
    assert.equal(outcome.action.retryable, false);
    assert.equal(outcome.attributes?.completion_reason, "mutation_rejected");

    const terminal = result.events.at(-1);
    assert.equal(terminal?.event_type, "review.batch");
    assert.equal(terminal?.action.status, "failed");
    assert.equal(terminal?.action.mutation, false);
    assert.equal(terminal?.attributes?.partial, false);
  } finally {
    fs.rmSync(result.root, { force: true, recursive: true });
  }
});

test("spam comment intake records unknown transport outcomes without masking the failure", async () => {
  const primary = new Error("network failed after request start");
  const result = await runLedgerIntake({
    runId: "8104",
    fetch: async () => {
      throw primary;
    },
    expectError: (error) => error === primary,
  });

  try {
    const outcome = result.events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "failed",
    );
    assert.ok(outcome);
    assert.equal(outcome.action.mutation, true);
    assert.equal(outcome.action.retryable, false);
    assert.equal(outcome.attributes?.completion_reason, "mutation_outcome_unknown");

    const terminal = result.events.at(-1);
    assert.equal(terminal?.event_type, "review.batch");
    assert.equal(terminal?.action.status, "failed");
    assert.equal(terminal?.action.mutation, true);
    assert.equal(terminal?.attributes?.partial, true);
    assert.equal(terminal?.attributes?.completion_reason, "dispatch_outcome_unknown");
  } finally {
    fs.rmSync(result.root, { force: true, recursive: true });
  }
});

test("spam comment intake preserves dispatch failures when receipt finalization also fails", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-spam-intake-")));
  const eventPath = path.join(root, "event.json");
  const outputRoot = path.join(root, "action-ledger-output");
  const primary = new Error("primary dispatch failure");
  const logs: string[] = [];
  fs.writeFileSync(eventPath, `${JSON.stringify(spamActivity())}\n`);
  fs.writeFileSync(outputRoot, "not a directory\n");

  try {
    await assert.rejects(
      runSpamCommentIntake(["--write-report"], {
        root,
        log: (message) => logs.push(message),
        env: actionLedgerEnv(eventPath, outputRoot, "8104"),
        fetch: async () => {
          throw primary;
        },
      }),
      (error) => error === primary,
    );
    assert.ok(
      logs.some((message) =>
        message.includes("failed to finalize action receipts after the primary failure"),
      ),
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("spam comment intake workflow publishes only exact current-attempt shards", () => {
  const workflow = fs.readFileSync(".github/workflows/spam-comment-intake.yml", "utf8");

  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /hydrate-paths: ledger/);
  assert.match(
    workflow,
    /repair:action-ledger -- publish-workflow \\\n\s+--expected-producer-job intake/,
  );
  assert.match(workflow, /jq -r '\.paths\[\]\?'/);
  assert.match(workflow, /cp "\$durable_event_path" "\$event_path"/);
  assert.match(workflow, /chore: append spam comment intake action ledger/);
  for (const requiredPath of [
    "scripts/hydrate-state.ts",
    "src/action-ledger-files.ts",
    "src/action-ledger-runtime.ts",
    "src/action-ledger.ts",
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${requiredPath.replaceAll(".", "\\.")}$`, "m"));
  }
  assert.ok(
    workflow.indexOf("Dispatch exact spam scan") <
      workflow.indexOf("Finalize spam comment intake action ledger"),
  );
  assert.ok(
    workflow.indexOf("Finalize spam comment intake action ledger") <
      workflow.indexOf("Import immutable spam comment intake action ledger"),
  );
  assert.ok(
    workflow.indexOf("Import immutable spam comment intake action ledger") <
      workflow.indexOf("Publish immutable spam comment intake action ledger"),
  );
});

type LedgerEvent = {
  event_type: string;
  event_id: string;
  parent_event_id: string | null;
  idempotency_key_sha256: string;
  action: {
    status: string;
    reason_code?: string;
    retryable: boolean;
    mutation: boolean;
  };
  attributes?: Record<string, unknown>;
  evidence?: Array<{
    kind: string;
    sha256?: string;
    report_path?: string;
  }>;
  phase_seq: number;
};

async function runLedgerIntake(options: {
  runId: string;
  fetch: typeof fetch;
  expectError?: RegExp | ((error: unknown) => boolean);
}): Promise<{
  root: string;
  outputRoot: string;
  events: LedgerEvent[];
}> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-spam-intake-")));
  const eventPath = path.join(root, "event.json");
  const outputRoot = path.join(root, "action-ledger-output");
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(eventPath, `${JSON.stringify(spamActivity())}\n`);

  const invocation = runSpamCommentIntake(["--write-report"], {
    root,
    log: () => undefined,
    env: actionLedgerEnv(eventPath, outputRoot, options.runId),
    fetch: options.fetch,
    now: () => new Date("2026-07-13T12:00:00Z"),
  });
  if (options.expectError) await assert.rejects(invocation, options.expectError);
  else assert.equal((await invocation).status, "ok");

  return {
    root,
    outputRoot,
    events: readLedgerEvents(outputRoot),
  };
}

function actionLedgerEnv(eventPath: string, outputRoot: string, runId: string): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "repository_dispatch",
    GH_TOKEN: "intake-token-marker",
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    GITHUB_ACTION: "dispatch_exact_spam_scan",
    GITHUB_JOB: "intake",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_STARTED_AT: "2026-07-13T12:00:00Z",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "spam comment intake",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/spam-comment-intake.yml@refs/heads/main",
  };
}

function readLedgerEvents(outputRoot: string): LedgerEvent[] {
  return recursiveFiles(outputRoot)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEvent),
    )
    .sort((left, right) => left.phase_seq - right.phase_seq);
}

function ledgerContents(outputRoot: string): string {
  return recursiveFiles(outputRoot)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function recursiveFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(file));
    else files.push(file);
  }
  return files;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
