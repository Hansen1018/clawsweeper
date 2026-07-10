import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  implementedCloseReport,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

test("apply-decisions preserves auto-selected order and traces only examined records", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const tracePath = join(root, "apply-cursor-trace.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    for (const number of [10, 20]) {
      writeFileSync(
        join(itemsDir, `${number}.md`),
        workPlanCandidateReport({
          repository: "openclaw/openclaw",
          number,
          local_checkout_access: "unverified",
          decision: "keep_open",
          action_taken: "kept_open",
        }),
        "utf8",
      );
    }

    runApplyDecisionsForTest({
      itemsDir,
      closedDir,
      plansDir,
      reportPath,
      extraArgs: [
        "--target-repo",
        "openclaw/openclaw",
        "--item-numbers",
        "20,10",
        "--processed-limit",
        "1",
        "--cursor-trace",
        tracePath,
      ],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(report[0]?.number, 20);
    assert.deepEqual(trace, { schema_version: 1, examined_item_numbers: [20] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps close-limit candidates out of the cursor trace", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const tracePath = join(root, "apply-cursor-trace.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const comments: Record<number, string> = {};
    for (const number of [10, 20]) {
      const synced = reportWithSyncedReviewComment(
        implementedCloseReport({ number }),
        number,
        "implemented_on_main",
      );
      writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
      comments[number] = synced.comment;
    }

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
const comments = ${JSON.stringify(comments)};
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(10|20)\\/timeline(?:\\?|$)/.test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(10|20)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(path.match(/\\/issues\\/(\\d+)\\/comments/)[1]);
  console.log(JSON.stringify([[
    {
      id: 9000 + number,
      html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
      body: comments[number],
      user: { login: "github-actions[bot]" },
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/(10|20)$/.test(path)) {
  const number = Number(path.match(/\\/issues\\/(\\d+)$/)[1]);
  console.log(JSON.stringify({
    number,
    title: "Close limit trace " + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--dry-run",
          "--limit",
          "1",
          "--processed-limit",
          "10",
          "--cursor-trace",
          tracePath,
        ],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.deepEqual(
      report
        .filter((entry: { action: string }) => entry.action === "closed")
        .map((entry: { number: number }) => entry.number),
      [10],
    );
    assert.deepEqual(trace, { schema_version: 1, examined_item_numbers: [10] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serial checkpoints skip archived tuples and advance only their examined trace", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const cursorPath = join(root, "apply-cursor.json");
    const itemNumbers = [10, 20, 30, 40];
    const comments: Record<number, string> = {};
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    for (const number of itemNumbers) {
      const synced = reportWithSyncedReviewComment(
        implementedCloseReport({ number }),
        number,
        "implemented_on_main",
      );
      writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
      comments[number] = synced.comment;
    }

    const ghMock = `
const { readFileSync } = require("fs");
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
const comments = ${JSON.stringify(comments)};
const issueMatch = path.match(/\\/issues\\/(10|20|30|40)(?:$|\\/)/);
const commentIdMatch = path.match(/\\/issues\\/comments\\/(90(?:10|20|30|40))$/);
const number = issueMatch
  ? Number(issueMatch[1])
  : commentIdMatch
    ? Number(commentIdMatch[1]) - 9000
    : Number(args[2]);
if (args[0] === "api" && args[1] === "-i" && /\\/timeline(?:\\?|$)/.test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) {
    const input = args[args.indexOf("--input") + 1];
    const body = JSON.parse(readFileSync(input, "utf8")).body;
    console.log(JSON.stringify({
      id: 9000 + number,
      html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
      body,
      user: { login: "github-actions[bot]" },
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z"
    }));
  } else {
    console.log(JSON.stringify([[
      {
        id: 9000 + number,
        html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
        body: comments[number],
        user: { login: "github-actions[bot]" },
        created_at: "2026-05-01T01:00:00Z",
        updated_at: "2026-05-01T01:00:00Z"
      }
    ]]));
  }
} else if (args[0] === "api" && /\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "api" && issueMatch) {
  console.log(JSON.stringify({
    number,
    title: "Serial checkpoint " + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "issue" && args[1] === "close") {
  console.log("");
} else if (args[0] === "issue" || args[0] === "label") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;

    withMockGh(root, ghMock, () => {
      for (const [checkpoint, expected] of [
        [1, [10, 20]],
        [2, [30, 40]],
      ] as const) {
        const tracePath = join(root, `apply-cursor-trace-${checkpoint}.json`);
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--item-numbers",
            itemNumbers.join(","),
            "--limit",
            "2",
            "--processed-limit",
            "10",
            "--cursor-trace",
            tracePath,
          ],
        });
        execFileSync(process.execPath, [
          "dist/repair/workflow-utils.js",
          "write-apply-cursor",
          "--cursor-path",
          cursorPath,
          "--report",
          reportPath,
          "--target-repo",
          "openclaw/clawsweeper",
          "--item-numbers",
          itemNumbers.join(","),
          "--cursor-trace",
          tracePath,
        ]);

        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        const trace = JSON.parse(readFileSync(tracePath, "utf8"));
        const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
        assert.deepEqual(
          report
            .filter((entry: { action: string }) => entry.action === "closed")
            .map((entry: { number: number }) => entry.number),
          expected,
        );
        assert.deepEqual(trace.examined_item_numbers, expected);
        assert.equal(cursor.next_after_number, expected.at(-1));
      }
    });

    for (const number of itemNumbers) {
      assert.equal(existsSync(join(itemsDir, `${number}.md`)), false);
      assert.equal(existsSync(join(closedDir, `${number}.md`)), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
