import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLimitedPages,
  collectLimitedPagesAsync,
  githubLimitedPagePath,
  githubPaginatedPath,
} from "../../dist/repair/github-cli.js";

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("githubLimitedPagePath caps one REST page and preserves existing filters", () => {
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 80),
    "repos/openclaw/openclaw/pulls/123/files?per_page=80&page=1",
  );
  assert.equal(
    githubLimitedPagePath(
      "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100",
      250,
      3,
    ),
    "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100&page=3",
  );
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 0, 0),
    "repos/openclaw/openclaw/pulls/123/files?per_page=1&page=1",
  );
});

test("bounded pagination stops after the requested comment budget", () => {
  const calls: Array<{ perPage: number; page: number }> = [];
  const comments = collectLimitedPages(150, (perPage, page) => {
    calls.push({ perPage, page });
    return Array.from({ length: perPage }, (_, index) => ({
      id: (page - 1) * perPage + index + 1,
    }));
  });

  assert.equal(comments.length, 150);
  assert.deepEqual(calls, [
    { perPage: 100, page: 1 },
    { perPage: 100, page: 2 },
  ]);
});

test("async bounded pagination does not hydrate a huge comment history", async () => {
  const calls: Array<{ perPage: number; page: number }> = [];
  const comments = await collectLimitedPagesAsync(1, async (perPage, page) => {
    calls.push({ perPage, page });
    return Array.from({ length: 10_000 }, (_, index) => ({
      id: (page - 1) * 10_000 + index + 1,
    }));
  });

  assert.equal(comments.length, 1);
  assert.deepEqual(calls, [{ perPage: 1, page: 1 }]);
});
