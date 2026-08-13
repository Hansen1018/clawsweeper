import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runBoundedPool,
  recordPreparedGithubEgressMember,
  coordinatorClassifiedThrottle,
  selectThrottleObservation,
} from "../../scripts/prepare-exact-review-batch.mjs";

test("bounded preparation pool respects the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await runBoundedPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.equal(result.peak, 2);
  assert.deepEqual(result.results, [2, 4, 6, 8, 10]);
});

test("batch preparation copies canonical records without cloning git state", () => {
  const source = readFileSync("scripts/prepare-exact-review-batch.mjs", "utf8");
  assert.match(source, /cpSync\(recordsSource, join\(root, "records"\)/);
  assert.doesNotMatch(source, /CLAWSWEEPER_STATE_DIR|stateClone|git["'], \["clone"/);
  assert.doesNotMatch(source, /pack-objects|unpack-objects|targetOid|expectedOid/);
});

test("coordinated throttles never issue an unpermitted rate-limit lookup", async () => {
  const now = Date.parse("2026-08-12T16:30:00Z");
  let lookups = 0;
  const fallback = await selectThrottleObservation({
    coordinated: true,
    existing: null,
    now,
    resolveUncoordinated: async () => {
      lookups += 1;
      throw new Error("coordinated throttle escaped to GitHub");
    },
  });
  assert.deepEqual(fallback, {
    scope: "repository_actions",
    observed_at: new Date(now).toISOString(),
    retry_at: new Date(now + 5 * 60_000).toISOString(),
    provenance: "fallback",
    authoritative: false,
  });
  assert.equal(lookups, 0);

  const authoritative = {
    scope: "repository_actions",
    observed_at: new Date(now).toISOString(),
    retry_at: new Date(now + 60_000).toISOString(),
    provenance: "retry_after",
    authoritative: true,
  };
  assert.equal(
    await selectThrottleObservation({
      coordinated: true,
      existing: authoritative,
      now,
      resolveUncoordinated: async () => {
        lookups += 1;
        return null;
      },
    }),
    authoritative,
  );
  assert.equal(lookups, 0);

  assert.equal(
    await selectThrottleObservation({
      coordinated: false,
      existing: null,
      now,
      resolveUncoordinated: async () => {
        lookups += 1;
        return authoritative;
      },
    }),
    authoritative,
  );
  assert.equal(lookups, 1);
});

test("coordinator-deferred preparation records one unattempted member", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-egress-member-"));
  const outcomePath = join(root, "outcome.json");
  const records = [];
  try {
    writeFileSync(
      outcomePath,
      `${JSON.stringify({
        kind: "retryable_failure",
        reasonCode: "github_rate_limit",
        attempted: false,
      })}\n`,
      "utf8",
    );
    assert.equal(
      recordPreparedGithubEgressMember({
        outcomePath,
        env: { TARGET_REPO: "test/example" },
        sourceAction: "scheduled_normal",
        claimGeneration: 2,
        repeatRevision: true,
        record: (entry) => records.push(entry),
      }),
      false,
    );
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      env: { TARGET_REPO: "test/example" },
      poolClass: "repository_actions",
      stage: "publication_prepare",
      sourceAction: "scheduled_normal",
      claimGeneration: 2,
      repeatRevision: true,
      attempted: false,
      outcome: "pre_wire_failure",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch preparation honors a header-classified coordinator throttle", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-coordinator-outcome-"));
  const outcomePath = join(root, "coordinator-outcome.json");
  try {
    writeFileSync(
      outcomePath,
      `${JSON.stringify({ attempted: true, rateLimited: true })}\n`,
      "utf8",
    );
    assert.equal(coordinatorClassifiedThrottle(outcomePath), true);
    writeFileSync(outcomePath, `${JSON.stringify({ attempted: true, rateLimited: false })}\n`);
    assert.equal(coordinatorClassifiedThrottle(outcomePath), false);
    writeFileSync(outcomePath, "not-json\n");
    assert.equal(coordinatorClassifiedThrottle(outcomePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
