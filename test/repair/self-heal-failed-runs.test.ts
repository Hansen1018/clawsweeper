import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  activeRepairJobGenerations,
  fetchRecentWorkflowRuns,
} from "../../dist/repair/live-worker-capacity.js";

const JOB = "jobs/openclaw/inbox/cluster-self-heal.md";

test("self-heal indexes active immutable generations beyond 200 workflow runs", () => {
  const digest = "a".repeat(64);
  const calls = [];
  const active = activeRepairJobGenerations({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster-worker.yml",
    fetchWorkflowRuns: (options) =>
      fetchRecentWorkflowRuns({
        ...options,
        fetchPage: (args) => {
          const query = new URL(`https://github.test/${args[3]}`).searchParams;
          const status = query.get("status");
          const page = Number(query.get("page"));
          calls.push({ status, page });
          if (status !== "in_progress") return [];
          if (page <= 2) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: (page - 1) * 100 + index + 1,
              status,
              display_title: `repair cluster jobs/openclaw/inbox/other-${page}-${index}.md (${digest})`,
            }));
          }
          return [
            {
              id: 201,
              status,
              display_title: `repair cluster ${JOB} (${digest})`,
            },
          ];
        },
      }),
  });

  assert.deepEqual(active.get(`${JOB}:${digest}`), ["201"]);
  assert.deepEqual(
    calls.filter((call) => call.status === "in_progress"),
    [
      { status: "in_progress", page: 1 },
      { status: "in_progress", page: 2 },
      { status: "in_progress", page: 3 },
    ],
  );
});

test("self-heal excludes stale queued immutable generations", () => {
  const digest = "b".repeat(64);
  const active = activeRepairJobGenerations({
    nowMs: Date.parse("2026-07-13T12:00:00.000Z"),
    staleQueuedMs: 60 * 60 * 1000,
    fetchWorkflowRuns: () => [
      {
        id: 1,
        status: "queued",
        display_title: `repair cluster ${JOB} (${digest})`,
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:00:00.000Z",
      },
    ],
  });

  assert.equal(active.has(`${JOB}:${digest}`), false);
});

test("self-heal matches active immutable generations by exact job digest", () => {
  const oldDigest = "c".repeat(64);
  const newDigest = "d".repeat(64);
  const active = activeRepairJobGenerations({
    fetchWorkflowRuns: () => [
      {
        id: 7,
        status: "in_progress",
        display_title: `repair cluster ${JOB} (${oldDigest})`,
      },
    ],
  });

  assert.deepEqual(active.get(`${JOB}:${oldDigest}`), ["7"]);
  assert.equal(active.has(`${JOB}:${newDigest}`), false);
});

test("execute-mode self-heal fails closed when active generation discovery fails", () => {
  assert.throws(
    () =>
      activeRepairJobGenerations({
        fetchWorkflowRuns: () => {
          throw new Error("GitHub unavailable");
        },
      }),
    /GitHub unavailable/,
  );

  const source = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");
  const discovery = source.slice(
    source.indexOf("function activeRepairJobGenerations()"),
    source.indexOf("function dispatchCandidate"),
  );
  assert.match(discovery, /cannot verify active repair generations; refusing dispatch/);
  assert.doesNotMatch(discovery, /return new Map/);
});
