import assert from "node:assert/strict";
import test from "node:test";

import { CLAWSWEEPER_CO_AUTHOR_TRAILER } from "../../dist/repair/co-author-credit.js";
import {
  coAuthorTrailers,
  sourcePullRequestSecurityBlockReason,
} from "../../dist/repair/execute-fix-github.js";

test("replacement co-author trailers include contributor and ClawSweeper credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "Mona Octocat",
        email: "1+octocat@users.noreply.github.com",
      },
    ]),
    [
      "Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>",
      CLAWSWEEPER_CO_AUTHOR_TRAILER,
    ],
  );
});

test("replacement co-author trailers dedupe ClawSweeper credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "clawsweeper[bot]",
        email: "274271284+clawsweeper[bot]@users.noreply.github.com",
      },
    ]),
    [CLAWSWEEPER_CO_AUTHOR_TRAILER],
  );
});

test("replacement source PR security gate allows ordinary source PRs", () => {
  assert.equal(
    sourcePullRequestSecurityBlockReason({
      title: "Fix stale activity test",
      body: "Regular bug fix.",
      labels: [{ name: "bug" }],
      comments: [{ body: "Looks good." }],
    }),
    "",
  );
});

test("replacement source PR security gate blocks labels and comments", () => {
  assert.match(
    sourcePullRequestSecurityBlockReason({
      title: "Fix auth bypass",
      body: "Regular body.",
      labels: [{ name: "security" }],
      comments: [],
    }),
    /security-sensitive source PR/,
  );
  assert.match(
    sourcePullRequestSecurityBlockReason({
      title: "Fix auth bypass",
      body: "Regular body.",
      labels: [],
      comments: [{ body: "clawsweeper-security:security" }],
    }),
    /security-sensitive source PR/,
  );
});
