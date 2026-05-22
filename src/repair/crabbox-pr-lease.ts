#!/usr/bin/env node
import type { LooseRecord } from "./json-types.js";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CRABBOX_PR_LEASE_IDLE_TIMEOUT_MINUTES,
  buildCrabboxWarmupArgs,
  crabboxLeaseSlug,
  renderCrabboxLeaseComment,
  type CrabboxPrLeaseAction,
  type CrabboxPrLeasePlatform,
} from "./crabbox-pr-lease-core.js";

const payload = readPayload();
const repo = required("target_repo");
const prNumber = Number(required("item_number"));
const action = normalizeAction(required("action"));
const platform = normalizePlatform(required("platform"));
const requestedHeadSha = String(payload.head_sha ?? "");
const ttlMinutes = Number(payload.ttl_minutes || (platform === "mac" ? 60 : 90));
const statePath = path.join(
  "results",
  "crabbox-leases",
  repo.replace(/[^A-Za-z0-9_.-]+/g, "-").toLowerCase(),
  String(prNumber),
  `${platform}.json`,
);

await main();

async function main() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const pull = ghJson<LooseRecord>([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,headRefOid,url",
  ]);
  const headSha = String(pull.headRefOid ?? "");
  if (requestedHeadSha && headSha && requestedHeadSha !== headSha) {
    postStateComment({
      status: "failed",
      failed_step: "head check",
      failure_excerpt: `PR head changed from ${requestedHeadSha} to ${headSha}. Re-run the command on the latest PR head.`,
    });
    return;
  }
  if (action === "lease") return lease(headSha);
  const state = readState();
  if (!state?.lease_id) {
    postStateComment({
      status: "failed",
      failed_step: "state lookup",
      failure_excerpt: `No Crabbox ${platform} lease state exists for ${repo}#${prNumber}.`,
    });
    return;
  }
  if (action === "status") {
    runCrabbox(["webvnc", "status", "--id", String(state.lease_id)], { allowFailure: true });
    postStateComment({ ...state, status: "already_active" });
    return;
  }
  if (action === "stop") {
    runCrabbox(["stop", String(state.lease_id)], { allowFailure: true });
    writeState({ ...state, state: "stopped" });
    postStateComment({ ...state, status: "stopped" });
    return;
  }
  runCrabbox(["webvnc", "reset", "--id", String(state.lease_id)], { allowFailure: true });
  postStateComment({ ...state, status: "reset", webvnc_bridge: "connected" });
}

function lease(headSha: string) {
  const existing = readState();
  if (existing?.lease_id && existing.state !== "stopped") {
    postStateComment({ ...existing, status: "already_active" });
    return;
  }

  let leaseID = "";
  try {
    const warmup = runCrabbox(buildCrabboxWarmupArgs({ platform, ttlMinutes, prNumber }));
    leaseID = extractLeaseID(warmup.stdout);
    if (!leaseID) throw new Error("warmup did not print a cbx_ lease id");
    const baseState = {
      repo,
      pr_number: prNumber,
      platform,
      lease_id: leaseID,
      slug: crabboxLeaseSlug(prNumber, platform),
      head_sha: headSha,
      ttl_minutes: ttlMinutes,
      idle_timeout_minutes: CRABBOX_PR_LEASE_IDLE_TIMEOUT_MINUTES,
      state: "creating",
      created_at: new Date().toISOString(),
      sharing: "org use",
    };
    writeState(baseState);
    runCrabbox(["run", "--id", leaseID, "--fresh-pr", `${repo}#${prNumber}`, "--", "true"]);
    const hydration = maybeHydrate(leaseID);
    runCrabbox(["share", "--id", leaseID, "--org"], { allowFailure: true });
    runCrabbox(["webvnc", "daemon", "start", "--id", leaseID], { allowFailure: true });
    const webvncStatus = runCrabbox(["webvnc", "status", "--id", leaseID], { allowFailure: true });
    const webvncURL = extractWebvncURL(webvncStatus.stdout) ?? portalURL(leaseID);
    const ready = {
      ...baseState,
      state: "ready",
      status: "ready",
      hydration,
      webvnc_url: webvncURL,
      expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    };
    writeState(ready);
    postStateComment(ready);
  } catch (error) {
    const failure = {
      repo,
      pr_number: prNumber,
      platform,
      lease_id: leaseID || null,
      status: "failed",
      failed_step: leaseID ? "setup" : "warmup",
      failure_excerpt: error instanceof Error ? error.message : String(error),
      webvnc_url: leaseID ? portalURL(leaseID) : null,
    };
    console.error(`Crabbox PR lease failed during ${failure.failed_step}: ${failure.failure_excerpt}`);
    postStateComment(failure);
  }
}

function maybeHydrate(leaseID: string) {
  if (platform !== "linux") return "skipped";
  const result = runCrabbox(["actions", "hydrate", "--id", leaseID], { allowFailure: true });
  return result.status === 0 ? "succeeded" : "failed";
}

function postStateComment(state: LooseRecord) {
  const body = renderCrabboxLeaseComment({
    repo,
    pr_number: prNumber,
    platform,
    ...state,
  });
  const bodyPath = path.join("results", "crabbox-leases", `comment-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, body);
  try {
    gh(["api", `repos/${repo}/issues/${prNumber}/comments`, "-F", `body=@${bodyPath}`]);
  } catch (error) {
    console.error(
      `Failed to post Crabbox PR lease comment to ${repo}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

function runCrabbox(args: string[], options: { allowFailure?: boolean } = {}) {
  const result = spawnSync("crabbox", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${["crabbox", ...args].join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gh(args: string[]) {
  execFileSync("gh", args, { stdio: "inherit" });
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" })) as T;
}

function readPayload() {
  const raw = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).client_payload
    : Object.fromEntries(process.argv.slice(2).map((entry) => entry.split("=", 2)));
  return raw ?? {};
}

function required(key: string): string {
  const value = payload[key];
  if (!value) throw new Error(`missing payload.${key}`);
  return String(value);
}

function readState(): LooseRecord | null {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function writeState(state: LooseRecord) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function extractLeaseID(text: string) {
  return text.match(/\bcbx_[A-Za-z0-9_-]+\b/)?.[0] ?? "";
}

function extractWebvncURL(text: string) {
  return text.match(/https:\/\/\S+\/portal\/leases\/\S+\/vnc\S*/)?.[0] ?? null;
}

function portalURL(leaseID: string) {
  return `https://crabbox.openclaw.ai/portal/leases/${encodeURIComponent(leaseID)}/vnc`;
}

function normalizeAction(value: string): CrabboxPrLeaseAction {
  if (["lease", "status", "stop", "reset-vnc"].includes(value))
    return value as CrabboxPrLeaseAction;
  throw new Error(`unsupported action: ${value}`);
}

function normalizePlatform(value: string): CrabboxPrLeasePlatform {
  if (["linux", "mac", "windows"].includes(value)) return value as CrabboxPrLeasePlatform;
  throw new Error(`unsupported platform: ${value}`);
}
