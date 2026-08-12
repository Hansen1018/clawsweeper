import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import {
  adaptiveCodexTimeoutMsForTest,
  classifyItemWebhook,
  classifyIssueCommentWebhook,
  classifyWebhook,
  handleGitHubWebhook,
  startServer,
  verifyGitHubSignature,
} from "../../dist/repair/comment-webhook.js";
import {
  coordinateDirectReReview,
  directReReviewIntake,
  planClawSweeperAcknowledgementConvergence,
  validateDirectReReviewIntake,
} from "../../dist/repair/direct-re-review-admission.js";

test("comment webhook accepts maintainer ClawSweeper commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "trunk" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        author_association: "MEMBER",
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "trunk",
    itemNumber: 71898,
    itemKind: "issue",
    itemState: "",
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
    commentBody: "@clawsweeper automerge",
    commentAuthor: "",
    commentUrl: "",
    maintainerAuthorized: true,
  });
});

test("comment webhook ignores ClawSweeper proof-nudge comments", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "main" },
      issue: { number: 86422 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: [
          "@contributor thanks for the PR. ClawSweeper is still waiting on real behavior proof.",
          "",
          "Once proof is added, @clawsweeper re-review can check it.",
          "",
          '<!-- clawsweeper-proof-nudge item="86422" sha="abc123" at="2026-06-02T00:00:00.000Z" v="1" -->',
        ].join("\n"),
        author_association: "MEMBER",
        user: { login: "clawsweeper[bot]" },
      },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "proof nudge comment" });
});

test("comment webhook ignores command-bearing assist and visual publications before ack or dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("generated publications must not reach GitHub");
  };

  try {
    for (const body of [
      "@clawsweeper automerge\n<!-- clawsweeper-assist:stable-request -->",
      "/autoclose\n<!-- clawsweeper-visual -->",
    ]) {
      const result = await handleGitHubWebhook({
        event: "issue_comment",
        payload: {
          action: "created",
          repository: { full_name: "openclaw/openclaw", default_branch: "main" },
          issue: { number: 86422 },
          installation: { id: 123 },
          comment: {
            id: 456,
            body,
            author_association: "MEMBER",
            user: { login: "clawsweeper[bot]" },
          },
        },
      });

      assert.deepEqual(result, {
        statusCode: 202,
        body: { accepted: false, reason: "assist publication comment" },
      });
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("comment webhook rejects inline ClawSweeper mentions before visible ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "main" },
      issue: { number: 87801 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "the closed PR 87835 was closed as already implemented by PR 87890 @clawsweeper re-review and if necessary close this issue",
        author_association: "MEMBER",
      },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "no routable ClawSweeper command" });
});

test("comment webhook accepts ClawSweeper mention commands on their own line", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "main" },
      issue: { number: 87801 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "The issue may already be fixed.\n@clawsweeper re-review based on the latest comments\nThanks.",
        author_association: "MEMBER",
      },
    },
  });

  assert.equal(result.accepted, true);
});

test("comment webhook rejects contributor commands before visible ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        author_association: "CONTRIBUTOR",
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /not allowed/);
});

test("comment webhook accepts author read-only re-review commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76991, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper Re-run",
        author_association: "CONTRIBUTOR",
        user: { login: "NickMOpen" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 76991,
    itemKind: "issue",
    itemState: "",
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
    commentBody: "@clawsweeper Re-run",
    commentAuthor: "NickMOpen",
    commentUrl: "",
    maintainerAuthorized: false,
  });
});

test("comment webhook rejects stale re-review commands on closed PRs before fast ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "edited",
      repository: { full_name: "openclaw/openclaw" },
      issue: {
        number: 76991,
        state: "closed",
        closed_at: "2026-05-19T05:02:03Z",
        pull_request: {},
      },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-review",
        created_at: "2026-05-18T19:30:48Z",
        updated_at: "2026-05-23T18:14:04Z",
        author_association: "MEMBER",
        user: { login: "user" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: "PR closed after this re_review command",
  });
});

test("comment webhook still accepts post-close re-review commands for router response", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: {
        number: 76991,
        state: "closed",
        closed_at: "2026-05-19T05:02:03Z",
        pull_request: {},
      },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-review",
        created_at: "2026-05-19T05:03:00Z",
        updated_at: "2026-05-19T05:03:00Z",
        author_association: "MEMBER",
        user: { login: "user" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 76991,
    itemKind: "pull_request",
    itemState: "closed",
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
    commentBody: "@clawsweeper re-review",
    commentAuthor: "user",
    commentUrl: "",
    maintainerAuthorized: true,
    commentUpdatedAt: "2026-05-19T05:03:00Z",
    commentBodySha256: crypto.createHash("sha256").update("@clawsweeper re-review").digest("hex"),
  });
});

test("comment webhook rejects commands from ineligible repositories", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: {
        full_name: "openclaw/clawsweeper-state",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 123 },
      comment: { body: "/clawsweeper status", author_association: "MEMBER" },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "repository not eligible" });
});

test("comment webhook rejects non-author read-only re-review commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76991, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-run",
        author_association: "CONTRIBUTOR",
        user: { login: "somebody-else" },
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /not allowed/);
});

test("webhook accepts eligible issue events for generic OpenClaw repositories", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber: 597,
    itemKind: "issue",
    installationId: 123,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  });
});

test("webhook accepts eligible pull request events for generic steipete repositories", () => {
  const result = classifyWebhook({
    event: "pull_request",
    payload: {
      action: "synchronize",
      repository: {
        full_name: "steipete/summarize",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: { number: 42, head: { sha: "a".repeat(40) } },
      installation: { id: 456 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "steipete/summarize",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    installationId: 456,
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    sourceHeadSha: "a".repeat(40),
    supersedesInProgress: true,
    codexTimeoutMs: 600_000,
    mediaProofTimeoutMs: 0,
  });
});

test("webhook carries the semantic tuple through edited pull request fallback intake", () => {
  const title = "Clarify the review request";
  const body = "The revised context is ready for review.";
  const result = classifyWebhook({
    event: "pull_request",
    payload: {
      action: "edited",
      repository: {
        full_name: "openclaw/openclaw",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: {
        number: 857,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
        draft: false,
        title,
        body,
        updated_at: "2026-07-26T09:00:00Z",
      },
      installation: { id: 456 },
    },
  });

  assert.equal(result.accepted, true);
  if (!result.accepted || result.type !== "item") return;
  assert.equal(result.sourceBaseSha, "b".repeat(40));
  assert.equal(result.sourceIsDraft, false);
  assert.equal(result.sourceUpdatedAt, "2026-07-26T09:00:00Z");
  assert.equal(
    result.sourceContentRevision,
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ version: 1, title, body }))
      .digest("hex"),
  );
});

test("adaptive Codex timeout preserves the default for small non-media PRs", () => {
  assert.equal(
    adaptiveCodexTimeoutMsForTest({
      changed_files: 4,
      additions: 120,
      deletions: 30,
      body: "Small cleanup without proof assets.",
    }),
    600_000,
  );
});

test("adaptive Codex timeout scales for large PRs", () => {
  assert.equal(
    adaptiveCodexTimeoutMsForTest({
      changed_files: 71,
      additions: 4176,
      deletions: 0,
      body: [
        "Proof:",
        "https://uploads.example.invalid/proof-a.mov",
        "https://uploads.example.invalid/proof-b.mp4.",
      ].join("\n"),
    }),
    1_268_800,
  );
});

test("adaptive Codex timeout stays capped separately from media preprocessing", () => {
  assert.equal(
    adaptiveCodexTimeoutMsForTest({
      changed_files: 1000,
      additions: 50_000,
      deletions: 10_000,
      body: [
        "https://uploads.example.invalid/one.mov",
        "https://uploads.example.invalid/two.mp4",
        "https://uploads.example.invalid/three.webm",
        "https://uploads.example.invalid/four.mkv",
        "https://uploads.example.invalid/five.avi",
      ].join("\n"),
    }),
    1_500_000,
  );
});

test("pull request webhooks dispatch adaptive Codex timeout payload", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousClientId = process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let dispatchedBody: Record<string, unknown> | undefined;
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    if (path === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
      return jsonResponse({ id: 999 });
    }
    if (path === "/app/installations/999/access_tokens" && method === "POST") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (path === "/repos/openclaw/clawsweeper/dispatches" && method === "POST") {
      dispatchedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  }) as typeof fetch;

  try {
    const result = await handleGitHubWebhook({
      event: "pull_request",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          default_branch: "main",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        pull_request: {
          number: 91093,
          head: { sha: "b".repeat(40) },
          base: { sha: "c".repeat(40) },
          draft: false,
          title: "Add direct fallback semantic ingress coverage",
          changed_files: 71,
          additions: 4176,
          deletions: 0,
          body: [
            "Proof:",
            "https://uploads.example.invalid/proof-a.mov",
            "https://uploads.example.invalid/proof-b.mp4",
          ].join("\n"),
          updated_at: "2026-07-26T09:00:00Z",
        },
        installation: { id: 123 },
      },
    });

    assert.deepEqual(result, {
      statusCode: 202,
      body: { ok: true, dispatched: "clawsweeper_item" },
    });
    assert.equal(dispatchedBody?.event_type, "clawsweeper_item");
    const clientPayload = dispatchedBody?.client_payload as Record<string, unknown>;
    const queueClaim = clientPayload.queue_claim as Record<string, unknown>;
    assert.ok(Object.keys(clientPayload).length <= 10, JSON.stringify(clientPayload));
    assert.equal(queueClaim.codex_timeout_ms, 1_268_800);
    assert.equal(queueClaim.media_proof_timeout_ms, 240_000);
    assert.equal(clientPayload.source_head_sha, undefined);
    assert.equal(queueClaim.source_head_sha, "b".repeat(40));
    assert.equal(queueClaim.source_base_sha, "c".repeat(40));
    assert.equal(queueClaim.source_is_draft, false);
    assert.equal(
      queueClaim.source_content_revision,
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            title: "Add direct fallback semantic ingress coverage",
            body: [
              "Proof:",
              "https://uploads.example.invalid/proof-a.mov",
              "https://uploads.example.invalid/proof-b.mp4",
            ].join("\n"),
          }),
        )
        .digest("hex"),
    );
    assert.equal(queueClaim.source_updated_at, "2026-07-26T09:00:00Z");
    assert.equal(queueClaim.installation_id, 123);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("webhook preserves valid repository default branch for item dispatch", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
        default_branch: "trunk",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetBranch, "trunk");
});

test("webhook falls back to main for invalid repository default branch", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
        default_branch: "bad branch",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetBranch, "main");
});

test("webhook rejects private and denied target repositories", () => {
  const privateResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "steipete/private-tool",
        private: true,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.deepEqual(privateResult, { accepted: false, reason: "repository not eligible" });

  const deniedResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/clawsweeper-state",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.deepEqual(deniedResult, { accepted: false, reason: "repository not eligible" });
});

test("webhook requeues unlocked and close-guard removal events", () => {
  const closeGuardLabels = [
    "security",
    "beta-blocker",
    "release-blocker",
    "maintainer",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:automerge",
    "clawsweeper:autofix",
  ];
  const cases = [
    { event: "issues", action: "unlocked" },
    { event: "pull_request", action: "unlocked" },
    ...closeGuardLabels.flatMap((name) => [
      { event: "issues", action: "unlabeled", label: { name } },
      { event: "pull_request", action: "unlabeled", label: { name } },
    ]),
  ];
  for (const [index, { event, action, label }] of cases.entries()) {
    const itemNumber = 76990 + index;
    const result = classifyItemWebhook({
      event,
      payload: {
        action,
        repository: {
          full_name: "openclaw/gogcli",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        ...(event === "issues"
          ? { issue: { number: itemNumber } }
          : { pull_request: { number: itemNumber } }),
        ...(label ? { label } : {}),
        installation: { id: 123 },
      },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.sourceAction, action);
    assert.equal(result.supersedesInProgress, true);
  }
});

test("webhook rejects label additions and unrelated removals from exact-review intake", () => {
  for (const [event, payload] of [
    [
      "pull_request",
      {
        action: "labeled",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        pull_request: { number: 76992 },
        installation: { id: 123 },
        sender: { login: "openclaw-clawsweeper[bot]" },
      },
    ],
    [
      "issues",
      {
        action: "unlabeled",
        repository: {
          full_name: "openclaw/gogcli",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 597 },
        label: { name: "clawsweeper:queueable-fix" },
        installation: { id: 123 },
        sender: { login: "steipete" },
      },
    ],
  ] as const) {
    assert.deepEqual(classifyItemWebhook({ event, payload }), {
      accepted: false,
      reason: "unsupported action",
    });
  }
});

test("direct re-review performs one signed durable intake without GitHub work", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const previousSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CLAWSWEEPER_APP_ID = "12345";
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = "queue-secret";
  const requests: string[] = [];
  const intakes: Array<Record<string, any>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/internal/exact-review/command-intake") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      intakes.push(body);
      assert.match(
        String(new Headers(init?.headers).get("x-clawsweeper-internal-signature")),
        /^sha256=[0-9a-f]{64}$/,
      );
      return jsonResponse({
        ok: true,
        accepted: true,
        deduped: false,
        command_version_id: body.commandVersionId,
      });
    }
    throw new Error(`unexpected fetch ${method} ${url.pathname}`);
  }) as typeof fetch;

  try {
    for (const scenario of [
      {
        number: 8101,
        association: "MEMBER",
        author: "maintainer",
        issueAuthor: "reporter",
        body: "@clawsweeper\nre-review: focus on the retry\nEvidence: injected 429 after PATCH",
      },
      {
        number: 8102,
        association: "CONTRIBUTOR",
        author: "reporter",
        issueAuthor: "reporter",
        body: "@clawsweeper\nre-review this path",
      },
    ]) {
      const result = await handleGitHubWebhook({
        event: "issue_comment",
        payload: {
          action: "created",
          repository: { full_name: "openclaw/openclaw" },
          issue: {
            number: scenario.number,
            state: "open",
            user: { login: scenario.issueAuthor },
          },
          installation: { id: 123 },
          comment: {
            id: scenario.number + 100,
            body: scenario.body,
            updated_at: `2026-08-08T20:00:${scenario.number === 8101 ? "01" : "02"}Z`,
            html_url: `https://github.com/openclaw/openclaw/issues/${scenario.number}#comment`,
            author_association: scenario.association,
            user: { login: scenario.author },
          },
        },
      });
      assert.equal(result.statusCode, 202);
      const decision = intakes.at(-1)!.decision;
      assert.match(
        String(decision.sourceDeliveryId),
        new RegExp(`^command-${scenario.number + 100}-`),
      );
      assert.match(String(decision.commandStatusMarker), /:re_review:command-/);
      assert.equal(
        String(decision.additionalPrompt).includes("Evidence: injected 429 after PATCH"),
        scenario.association === "MEMBER",
      );
    }
    assert.deepEqual(requests, [
      "POST /internal/exact-review/command-intake",
      "POST /internal/exact-review/command-intake",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
    restoreEnv("CLAWSWEEPER_WEBHOOK_SECRET", previousSecret);
  }
});

test("acknowledgement convergence prunes only duplicate copies of the same command revision", () => {
  const marker = "<!-- clawsweeper-command-status:8101:re_review:command-8201 -->";
  const otherMarker = "<!-- clawsweeper-command-status:8101:re_review:command-8201-edit -->";
  const comments = [
    {
      id: 10,
      body: `<!-- clawsweeper-command-ack:8201 -->\n${marker}`,
      created_at: "2026-08-08T20:00:00Z",
    },
    {
      id: 11,
      body: `<!-- clawsweeper-command-ack:8201 -->\n${marker}`,
      created_at: "2026-08-08T20:00:01Z",
    },
    {
      id: 12,
      body: `<!-- clawsweeper-command-ack:8201 -->\n${otherMarker}`,
      created_at: "2026-08-08T20:00:02Z",
    },
    {
      id: 13,
      body: "<!-- clawsweeper-command-ack:8201 -->\nCommand router queued.",
      created_at: "2026-08-08T20:00:03Z",
    },
  ];

  assert.deepEqual(planClawSweeperAcknowledgementConvergence(comments, marker), {
    keepId: 10,
    prunableIds: [11, 13],
  });
});

test("direct PR coordinator retries rejection only after observing a changed head", async () => {
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 8203,
    itemKind: "pull_request",
    installationId: 123,
    sourceCommentId: 8303,
    sourceCommentUpdatedAt: "2026-08-08T20:00:00Z",
    commandBodyDigest: "c".repeat(64),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
  const heads = ["a".repeat(40), "b".repeat(40)];
  const completions: Array<[number, "enqueued" | "mismatch"]> = [];
  const result = await coordinateDirectReReview(intake, {
    readPullRequest: async () => ({ headSha: heads.shift()! }),
    reserveAuthority: async () => ({ kind: "reserved", sourceAuthoritySeq: 1 }),
    completeAuthority: async (sequence, disposition) => {
      completions.push([sequence, disposition]);
      return { kind: "completed" };
    },
    enqueue: async () => ({ kind: "rejected", reason: "stale head" }),
    convergeAcknowledgement: async () => 1,
    addReaction: async () => undefined,
  });

  assert.deepEqual(result, { kind: "retry", reason: "head_changed" });
  assert.deepEqual(completions, [[1, "mismatch"]]);
});

test("direct PR coordinator terminalizes rejection when head and command version are unchanged", async () => {
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 8204,
    itemKind: "pull_request",
    installationId: 123,
    sourceCommentId: 8304,
    sourceCommentUpdatedAt: "2026-08-08T20:00:00Z",
    commandBodyDigest: "d".repeat(64),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
  const head = "a".repeat(40);
  const result = await coordinateDirectReReview(intake, {
    readPullRequest: async () => ({ headSha: head }),
    reserveAuthority: async () => ({ kind: "reserved", sourceAuthoritySeq: 1 }),
    completeAuthority: async () => ({ kind: "completed" }),
    enqueue: async () => ({ kind: "rejected", reason: "stale head" }),
    convergeAcknowledgement: async () => assert.fail("acknowledgement must not run"),
    addReaction: async () => assert.fail("reaction must not run"),
  });
  assert.deepEqual(result, { kind: "rejected", reason: "stale head" });
});

test("direct PR coordinator retries when rejection freshness cannot be verified", async () => {
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 8_205,
    itemKind: "pull_request",
    installationId: 123,
    sourceCommentId: 8_305,
    sourceCommentUpdatedAt: "2026-08-08T20:00:00Z",
    commandBodyDigest: "d".repeat(64),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
  let reads = 0;
  const completions: string[] = [];
  const result = await coordinateDirectReReview(intake, {
    readPullRequest: async () => {
      reads += 1;
      if (reads === 1) return { headSha: "a".repeat(40) };
      throw new Error("GitHub unavailable");
    },
    reserveAuthority: async () => ({ kind: "reserved", sourceAuthoritySeq: 1 }),
    completeAuthority: async (_sequence, disposition) => {
      completions.push(disposition);
      return { kind: "completed" };
    },
    enqueue: async () => ({ kind: "rejected", reason: "stale head" }),
    convergeAcknowledgement: async () => assert.fail("acknowledgement must not run"),
    addReaction: async () => assert.fail("reaction must not run"),
  });
  assert.deepEqual(result, { kind: "retry", reason: "dependency_unavailable" });
  assert.deepEqual(completions, []);
});

test("direct intake validation rejects a mismatched acknowledgement marker", () => {
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 8_206,
    itemKind: "issue",
    installationId: 123,
    sourceCommentId: 8_306,
    sourceCommentUpdatedAt: "2026-08-08T20:00:00Z",
    commandBodyDigest: "e".repeat(64),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
  assert.equal(
    validateDirectReReviewIntake({
      ...intake,
      decision: { ...intake.decision, commandStatusMarker: "<!-- wrong-command -->" },
    }),
    null,
  );
});

test("direct intake construction caps maintainer context to its validated bound", () => {
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 8_207,
    itemKind: "issue",
    installationId: 123,
    sourceCommentId: 8_307,
    sourceCommentUpdatedAt: "2026-08-08T20:00:00Z",
    commandBodyDigest: "f".repeat(64),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "x".repeat(6_000),
  });
  assert.equal(intake.decision.additionalPrompt.length, 5_000);
  assert.ok(validateDirectReReviewIntake(intake));
});

test("local direct PR webhook returns after intake without waiting for slow GitHub", async () => {
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = "queue-secret";
  let githubCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/internal/exact-review/command-intake") {
      const intake = JSON.parse(String(init?.body || "{}"));
      return jsonResponse({
        ok: true,
        accepted: true,
        deduped: false,
        command_version_id: intake.commandVersionId,
      });
    }
    githubCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    throw new Error(`unexpected slow GitHub call ${url}`);
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    const result = await handleGitHubWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "openclaw/openclaw" },
        issue: {
          number: 8201,
          state: "open",
          pull_request: {},
          user: { login: "maintainer" },
        },
        installation: { id: 123 },
        comment: {
          id: 8301,
          body: "@clawsweeper re-review",
          updated_at: "2026-08-08T20:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer" },
        },
      },
    });
    assert.equal(result.statusCode, 202);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(githubCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_WEBHOOK_SECRET", previousSecret);
  }
});

test("local webhook fails closed before ten seconds when durable remote intake hangs", async () => {
  const previousSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
  const previousInternalSecret = process.env.CLAWSWEEPER_INTERNAL_QUEUE_SECRET;
  const previousQueueUrl = process.env.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL;
  const secret = "hung-intake-secret";
  let intakeCalls = 0;
  const hungIntake = http.createServer((_request, _response) => {
    intakeCalls += 1;
  });
  await new Promise<void>((resolve) => hungIntake.listen(0, "127.0.0.1", resolve));
  const intakeAddress = hungIntake.address();
  assert.ok(intakeAddress && typeof intakeAddress === "object");
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = secret;
  process.env.CLAWSWEEPER_INTERNAL_QUEUE_SECRET = secret;
  process.env.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL = `http://127.0.0.1:${intakeAddress.port}`;

  const webhook = startServer(0);
  await new Promise<void>((resolve) => webhook.once("listening", resolve));
  const webhookAddress = webhook.address();
  assert.ok(webhookAddress && typeof webhookAddress === "object");
  const payload = JSON.stringify({
    action: "created",
    repository: { full_name: "openclaw/openclaw" },
    issue: { number: 8_205, state: "open", pull_request: {}, user: { login: "maintainer" } },
    installation: { id: 123 },
    comment: {
      id: 8_305,
      body: "@clawsweeper re-review",
      updated_at: "2026-08-08T20:00:00Z",
      author_association: "MEMBER",
      user: { login: "maintainer" },
    },
  });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${webhookAddress.port}/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 503);
    assert.ok(elapsed < 10_000, `webhook response took ${elapsed}ms`);
    assert.deepEqual(await response.json(), {
      ok: false,
      retryable: true,
      error: "durable_intake_unavailable",
    });
    assert.equal(intakeCalls, 1);
  } finally {
    webhook.closeAllConnections();
    hungIntake.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => webhook.close(() => resolve())),
      new Promise<void>((resolve) => hungIntake.close(() => resolve())),
    ]);
    restoreEnv("CLAWSWEEPER_WEBHOOK_SECRET", previousSecret);
    restoreEnv("CLAWSWEEPER_INTERNAL_QUEUE_SECRET", previousInternalSecret);
    restoreEnv("CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL", previousQueueUrl);
  }
});

test("local closed post-close re-review stays on the visible comment-router path", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CLAWSWEEPER_APP_ID = "12345";
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  let exactQueueCalls = 0;
  let dispatchPayload: Record<string, unknown> | undefined;
  let statusBody = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/8202/comments") {
      if (init?.method === "GET") return jsonResponse([]);
      statusBody = String(JSON.parse(String(init?.body ?? "{}")).body || "");
      return jsonResponse({ id: 18_202, body: statusBody });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/comments/8302/reactions") {
      return jsonResponse({ id: 1 });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchPayload = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({});
    }
    if (url.pathname.startsWith("/internal/exact-review/")) {
      exactQueueCalls += 1;
      return jsonResponse({ ok: true, queued: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const result = await handleGitHubWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "openclaw/openclaw" },
        issue: {
          number: 8202,
          state: "closed",
          closed_at: "2026-08-08T20:00:00Z",
          pull_request: {},
          user: { login: "maintainer" },
        },
        installation: { id: 123 },
        comment: {
          id: 8302,
          body: "@clawsweeper re-review",
          created_at: "2026-08-08T20:01:00Z",
          updated_at: "2026-08-08T20:01:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer" },
        },
      },
    });
    assert.deepEqual(result, {
      statusCode: 202,
      body: { ok: true, status_comment_id: 18_202 },
    });
    assert.equal(exactQueueCalls, 0);
    assert.match(statusBody, /Command router queued/);
    assert.equal(
      (dispatchPayload as { client_payload?: { status_comment_id?: number } })?.client_payload
        ?.status_comment_id,
      18_202,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("concurrent non-review commands share an immediate status comment with the router", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousClientId = process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const previousSettleDelays = process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const comments: Array<{ id: number; body: string; created_at: string; user: { login: string } }> =
    [];
  let nextCommentId = 9001;
  let fastAckPosts = 0;
  let reactions = 0;
  let dispatches = 0;
  const dispatchBodies: Array<Record<string, unknown>> = [];
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS = "0,0,0";
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    if (path === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
      return jsonResponse({ id: 999 });
    }
    if (path === "/app/installations/999/access_tokens" && method === "POST") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (path === "/app/installations/123/access_tokens" && method === "POST") {
      return jsonResponse({ token: "target-token" });
    }
    if (path.startsWith("/repos/openclaw/openclaw/issues/71898/comments?") && method === "GET") {
      return jsonResponse([...comments]);
    }
    if (path === "/repos/openclaw/openclaw/issues/71898/comments" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      fastAckPosts += 1;
      const comment = {
        id: nextCommentId++,
        body: String(body.body ?? ""),
        created_at: `2026-05-28T13:00:0${fastAckPosts}Z`,
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return jsonResponse(comment);
    }
    if (path === "/repos/openclaw/openclaw/issues/comments/456/reactions" && method === "POST") {
      reactions += 1;
      return jsonResponse({ id: 1 });
    }
    if (path === "/repos/openclaw/clawsweeper/dispatches" && method === "POST") {
      dispatches += 1;
      dispatchBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({});
    }
    if (path.startsWith("/repos/openclaw/openclaw/issues/comments/") && method === "DELETE") {
      const id = Number(path.split("/").pop());
      const index = comments.findIndex((comment) => comment.id === id);
      if (index >= 0) comments.splice(index, 1);
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  }) as typeof fetch;

  try {
    const payload = {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        updated_at: "2026-07-12T20:00:00Z",
        author_association: "MEMBER",
        user: { login: "user" },
      },
    };
    const [left, right] = await Promise.all([
      handleGitHubWebhook({ event: "issue_comment", payload }),
      handleGitHubWebhook({ event: "issue_comment", payload }),
    ]);

    assert.deepEqual(left, {
      statusCode: 202,
      body: { ok: true, status_comment_id: 9001 },
    });
    assert.deepEqual(right, {
      statusCode: 202,
      body: { ok: true, status_comment_id: 9001 },
    });
    assert.equal(fastAckPosts, 1);
    assert.equal(reactions, 2);
    assert.equal(dispatches, 2);
    assert.deepEqual(
      dispatchBodies.map((body) => body.client_payload),
      Array.from({ length: 2 }, () => ({
        target_repo: "openclaw/openclaw",
        target_branch: "main",
        item_number: 71898,
        comment_id: 456,
        status_comment_id: 9001,
        source_event: "issue_comment",
        source_action: "created",
        comment_event_auth: "github_webhook_v1",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: crypto
          .createHash("sha256")
          .update("@clawsweeper automerge")
          .digest("hex"),
      })),
    );
    assert.ok(
      dispatchBodies.every(
        (body) => Object.keys(body.client_payload as Record<string, unknown>).length <= 10,
      ),
    );
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Command router queued/);
    assert.doesNotMatch(comments[0]!.body, /clawsweeper-command-status/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
    restoreEnv("CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS", previousSettleDelays);
  }
});

test("webhook signature verification uses sha256 body hmac", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ ok: true });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.doesNotThrow(() => verifyGitHubSignature({ secret, signature, body }));
  assert.throws(
    () => verifyGitHubSignature({ secret, signature: "sha256=bad", body }),
    /invalid GitHub webhook signature/,
  );
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
