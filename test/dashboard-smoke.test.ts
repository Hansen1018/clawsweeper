import assert from "node:assert/strict";
import test from "node:test";

import { containsDirectGitHubApiUrl } from "../scripts/dashboard-smoke.mjs";

test("dashboard smoke detects only the exact GitHub API hostname", () => {
  assert.equal(containsDirectGitHubApiUrl('fetch("https://api.github.com/repos/openclaw")'), true);
  assert.equal(containsDirectGitHubApiUrl('fetch("https://API.GITHUB.COM./graphql")'), true);
  assert.equal(containsDirectGitHubApiUrl('fetch("//api.github.com/repos/openclaw")'), true);
  assert.equal(
    containsDirectGitHubApiUrl('fetch("https:\\\/\\\/api.github.com/repos/openclaw")'),
    true,
  );
  assert.equal(
    containsDirectGitHubApiUrl('fetch("https://api.github.com.evil.example/repos/openclaw")'),
    false,
  );
  assert.equal(
    containsDirectGitHubApiUrl('fetch("//api.github.com.evil.example/repos/openclaw")'),
    false,
  );
  assert.equal(
    containsDirectGitHubApiUrl('fetch("https://evil-api.github.com/repos/openclaw")'),
    false,
  );
  assert.equal(containsDirectGitHubApiUrl('fetch("https://github.com/openclaw")'), false);
});
