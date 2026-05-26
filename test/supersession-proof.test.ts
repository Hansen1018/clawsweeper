import assert from "node:assert/strict";
import test from "node:test";

import {
  compactSupersessionProofView,
  supersessionProofCloseDecision,
  supersessionProofViewContextTruncated,
} from "../dist/supersession-proof.js";

test("supersession proof rejects blank covered work before closing", () => {
  const decision = supersessionProofCloseDecision({
    sourceSummary: "PR A fixes the activity route.",
    replacementSummary: "PR B fixes the activity route.",
    coveredWork: ["  "],
    uniqueSourceWork: [],
    securityBlocked: false,
    decision: "superseded",
    reason: "PR B covers PR A.",
  });

  assert.equal(decision.close, false);
  assert.equal(decision.proof.decision, "keep_open");
  assert.match(decision.reason, /incomplete/);
});

test("supersession proof can close security-sensitive work when coverage is concrete", () => {
  const decision = supersessionProofCloseDecision({
    sourceSummary: "PR A fixes the auth route.",
    replacementSummary: "PR B fixes the same auth route.",
    coveredWork: ["PR B includes the auth route fix that PR A proposed."],
    uniqueSourceWork: [],
    securityBlocked: true,
    decision: "superseded",
    reason: "PR B covers PR A's auth behavior and PR A has no unique remaining work.",
  });

  assert.equal(decision.close, true);
  assert.equal(decision.proof.decision, "superseded");
});

test("supersession proof view includes bounded file and discussion context", () => {
  const view = compactSupersessionProofView({
    title: "Fix activity",
    body: "Adds the activity fix.",
    changedFiles: 1,
    filePaths: ["src/activity.ts"],
    files: [
      {
        filename: "src/activity.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch: "@@\n+fixActivity();",
      },
    ],
    comments: [{ user: { login: "maintainer" }, body: "This still needs fixActivity." }],
    reviews: [
      {
        user: { login: "reviewer" },
        author_association: "MEMBER",
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-05-01T00:00:00Z",
        body: "Changes requested: keep the route fix.",
      },
    ],
    reviewComments: [{ author: "reviewer", body: "Please preserve the activity route." }],
  });

  assert.match(JSON.stringify(view), /fixActivity/);
  assert.match(JSON.stringify(view), /This still needs fixActivity/);
  assert.match(JSON.stringify(view), /CHANGES_REQUESTED/);
  assert.match(JSON.stringify(view), /2026-05-01T00:00:00Z/);
  assert.match(JSON.stringify(view), /Changes requested: keep the route fix/);
  assert.match(JSON.stringify(view), /preserve the activity route/);
});

test("supersession proof view reports truncated proof context", () => {
  assert.equal(
    supersessionProofViewContextTruncated({
      files: [{ filename: "src/activity.ts", patch: `@@\n+${"x".repeat(1700)}` }],
    }),
    true,
  );
  assert.equal(
    supersessionProofViewContextTruncated({
      files: Array.from({ length: 81 }, (_, index) => ({ filename: `src/${index}.ts` })),
    }),
    true,
  );
  assert.equal(
    supersessionProofViewContextTruncated({
      comments: [{ body: "Visible comment." }],
      commentsTruncated: true,
    }),
    true,
  );
  assert.equal(
    supersessionProofViewContextTruncated({
      reviews: [{ body: "Visible review." }],
      reviewsTruncated: true,
    }),
    true,
  );
  assert.equal(
    supersessionProofViewContextTruncated({
      reviewComments: [{ body: "Visible review comment." }],
      reviewCommentsTruncated: true,
    }),
    true,
  );
  assert.equal(
    supersessionProofViewContextTruncated({
      comments: [{ body: "Looks covered." }],
      files: [{ filename: "src/activity.ts", patch: "@@\n+fixActivity();" }],
    }),
    false,
  );
});
