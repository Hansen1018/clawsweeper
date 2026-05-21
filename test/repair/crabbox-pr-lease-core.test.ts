import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCrabboxWarmupArgs,
  parseCrabboxPrLeaseCommand,
  renderCrabboxLeaseComment,
} from "../../dist/repair/crabbox-pr-lease-core.js";

test("parseCrabboxPrLeaseCommand parses defaults and platform durations", () => {
  assert.deepEqual(parseCrabboxPrLeaseCommand("crabbox lease"), {
    action: "lease",
    platform: "linux",
    ttlMinutes: 90,
  });
  assert.deepEqual(parseCrabboxPrLeaseCommand("crabbox lease mac 2h"), {
    action: "lease",
    platform: "mac",
    ttlMinutes: 120,
  });
  assert.deepEqual(parseCrabboxPrLeaseCommand("crabbox stop windows"), {
    action: "stop",
    platform: "windows",
    ttlMinutes: 90,
  });
  assert.equal(parseCrabboxPrLeaseCommand("status"), null);
});

test("buildCrabboxWarmupArgs uses platform-specific targets", () => {
  assert.deepEqual(buildCrabboxWarmupArgs({ platform: "linux", ttlMinutes: 90, prNumber: 123 }), [
    "warmup",
    "--provider",
    "aws",
    "--desktop",
    "--browser",
    "--ttl",
    "90m",
    "--idle-timeout",
    "30m",
    "--slug",
    "pr-123-linux",
    "--target",
    "linux",
  ]);
  assert.ok(
    buildCrabboxWarmupArgs({ platform: "mac", ttlMinutes: 60, prNumber: 123 }).includes("macos"),
  );
  assert.ok(
    buildCrabboxWarmupArgs({ platform: "windows", ttlMinutes: 90, prNumber: 123 }).includes(
      "normal",
    ),
  );
});

test("renderCrabboxLeaseComment renders ready and failure handoffs", () => {
  const ready = renderCrabboxLeaseComment({
    status: "ready",
    repo: "openclaw/openclaw",
    pr_number: 123,
    platform: "linux",
    lease_id: "cbx_abc",
    slug: "pr-123-linux",
    head_sha: "abcdef1234567890",
    webvnc_url: "https://crabbox.openclaw.ai/portal/leases/cbx_abc/vnc",
    hydration: "succeeded",
    sharing: "org use",
  });
  assert.match(ready, /Crabbox lease ready/);
  assert.match(ready, /crabbox stop cbx_abc/);

  const failed = renderCrabboxLeaseComment({
    status: "failed",
    repo: "openclaw/openclaw",
    pr_number: 123,
    platform: "mac",
    failed_step: "warmup",
    failure_excerpt: "capacity unavailable",
  });
  assert.match(failed, /could not be created/);
  assert.match(failed, /capacity unavailable/);
});
