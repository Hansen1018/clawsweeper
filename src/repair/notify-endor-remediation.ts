#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GitHubRateLimitError, ghRetryKind } from "../github-retry.js";
import { summarizeChecks } from "./comment-router-utils.js";
import {
  isTransientHermitNotificationError,
  postHermitEndorNotification,
  resolveHermitNotificationConfig,
} from "./hermit-notification.js";
import { asJsonObject, isJsonObject, type JsonObject } from "./json-types.js";
import { errorText, stringOrNull } from "./openclaw-hook.js";

const ENDOR_APP_USER_ID = 179191674;
const ENDOR_APP_LOGIN = "endor-labs-pro[bot]";
const ENDOR_APP_URL = "https://github.com/apps/endor-labs-pro";
const EVENT_TYPE = "clawsweeper.endor_remediation_reviewed";
const DEFAULT_MAX_CYCLES = 6;
const REQUIRED_CLEAN_STREAK = 3;
const ENDOR_STATE_ROOT = "notifications/endor-remediation";

export type EndorReviewVerdict = "clean" | "has_findings" | "ambiguous";
export type EndorNotificationOutcome = "ready" | "needs_attention" | "unknown";
export type EndorCheckState = "passing" | "pending" | "failing" | "unknown";
export type EndorMergeState = "clean" | "blocked" | "behind" | "unstable" | "unknown";
export type EndorPreparationFailure = {
  kind: "github_rate_limit" | "github_transient" | "permanent";
  retryAt: string | null;
};

export type EndorReviewEvidence = {
  version: 1;
  repo: string;
  prNumber: number;
  prUrl: string;
  title: string;
  findingSummary: string;
  reviewedHeadSha: string;
  reviewDigest: string;
  reviewGeneration: string;
  verdict: EndorReviewVerdict;
  reviewSummary: string;
  reviewUrl: string;
  checks: { state: EndorCheckState; total: number | null; summary: string };
  mergeState: EndorMergeState;
};

export type EndorRemediationReviewedEvent = Omit<
  EndorReviewEvidence,
  "reviewDigest" | "reviewGeneration" | "verdict" | "version"
> & {
  version: 1;
  type: typeof EVENT_TYPE;
  outcome: EndorNotificationOutcome;
  cycles: number;
  cleanStreak: number;
  idempotencyKey: string;
};

export type EndorPreparationInput = {
  repo: string;
  itemNumber: number;
  reviewCommentId: number;
  reviewCommentDigest: string;
  reviewGeneration: string;
};

export type EndorPreparationResult =
  | { status: "eligible"; evidence: EndorReviewEvidence }
  | { status: "skipped"; reason: string };

export type EndorAdvanceResult =
  | {
      action: "requeue";
      cycles: number;
      cleanStreak: number;
      resetReason: "head_changed" | null;
      requeueKey: string;
    }
  | {
      action: "notify";
      cycles: number;
      cleanStreak: number;
      resetReason: "head_changed" | null;
      event: EndorRemediationReviewedEvent;
    };

export type EndorNotifierSummary = {
  action: "notify" | "requeue" | "complete";
  status: "ok" | "failed" | "skipped";
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  exitCode: number;
  reason: string | null;
  requeueHeadSha: string | null;
  requeueUpdatedAt: string | null;
  requeueKey: string | null;
  failureKind: "github_rate_limit" | "github_transient" | "hermit_transient" | null;
  retryAt: string | null;
};

export type EndorRuntime = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
};

export function classifyEndorPreparationFailure(error: unknown): EndorPreparationFailure {
  const retryKind = ghRetryKind(error);
  if (retryKind === "throttle") {
    return { kind: "github_rate_limit", retryAt: new GitHubRateLimitError(error).retryAt };
  }
  if (retryKind === "transient") return { kind: "github_transient", retryAt: null };
  return { kind: "permanent", retryAt: null };
}

type ReviewStateEntry = {
  repo: string;
  prNumber: number;
  reviewedHeadSha: string;
  cycles: number;
  cleanStreak: number;
  reviewGenerations: string[];
  lastVerdict: EndorReviewVerdict;
  terminalOutcome: EndorNotificationOutcome | null;
  stopReason: "finding" | "safety_cap" | null;
  updatedAt: string;
};

type ReviewState = {
  version: 1;
  updated_at: string;
  review: ReviewStateEntry;
};

type DeliveryLedgerEntry = EndorRemediationReviewedEvent & {
  notifiedAt: string;
  hermitMessageId: string;
  deliveryProvider: "hermit";
};

type DeliveryLedger = {
  version: 1;
  notification: DeliveryLedgerEntry;
};

export function endorReviewStatePath(evidence: Pick<EndorReviewEvidence, "repo" | "prNumber">) {
  return path.posix.join(endorPullStateRoot(evidence), "review-state.json");
}

export function endorDeliveryLedgerPath(
  event: Pick<EndorRemediationReviewedEvent, "repo" | "prNumber" | "reviewedHeadSha" | "outcome">,
) {
  return path.posix.join(
    endorPullStateRoot(event),
    "notifications",
    requiredSha(event.reviewedHeadSha, "event reviewed head"),
    `${requiredOutcome(event.outcome)}.json`,
  );
}

export function endorDeliveryReportPath(
  event: Pick<EndorRemediationReviewedEvent, "repo" | "prNumber" | "reviewedHeadSha" | "outcome">,
) {
  return path.posix.join(
    endorPullStateRoot(event),
    "reports",
    requiredSha(event.reviewedHeadSha, "event reviewed head"),
    `${requiredOutcome(event.outcome)}.json`,
  );
}

export async function prepareEndorRemediationReview(
  input: EndorPreparationInput,
  runtime: Pick<EndorRuntime, "env" | "fetch"> = {},
): Promise<EndorPreparationResult> {
  validatePreparationInput(input);
  const env = runtime.env ?? process.env;
  const fetcher = runtime.fetch ?? fetch;
  const item = await githubJson({
    env,
    fetcher,
    apiPath: `/repos/${input.repo}/issues/${input.itemNumber}`,
    label: "GitHub item",
  });
  if (!isJsonObject(item.pull_request)) {
    return { status: "skipped", reason: "reviewed item is not a pull request" };
  }
  const pull = await githubJson({
    env,
    fetcher,
    apiPath: `/repos/${input.repo}/pulls/${input.itemNumber}`,
    label: "pull request",
  });
  if (!isEndorAuthoredPull(pull)) {
    return { status: "skipped", reason: "pull request is not Endor-authored" };
  }
  const inactiveReason = inactivePullReason(pull);
  if (inactiveReason) return { status: "skipped", reason: inactiveReason };
  const comment = await githubJson({
    env,
    fetcher,
    apiPath: `/repos/${input.repo}/issues/comments/${input.reviewCommentId}`,
    label: "durable review comment",
  });
  const commentBody = requiredString(comment.body, "durable review comment body");
  if (sha256(commentBody.trim()) !== input.reviewCommentDigest) {
    throw new Error("durable review comment digest mismatch");
  }
  const currentHeadSha = requiredSha(asJsonObject(pull.head).sha, "pull request head SHA");
  const reviewedHead = reviewedHeadFromComment(commentBody);
  if (!reviewedHead) {
    return {
      status: "skipped",
      reason: "durable review does not contain one authoritative full-head marker",
    };
  }
  if (currentHeadSha !== reviewedHead) {
    return {
      status: "skipped",
      reason: "durable review does not cover the current pull request head",
    };
  }
  const [checkRuns, combinedStatus] = await Promise.all([
    optionalGithubJson({
      env,
      fetcher,
      apiPath: `/repos/${input.repo}/commits/${currentHeadSha}/check-runs?per_page=100`,
    }),
    optionalGithubJson({
      env,
      fetcher,
      apiPath: `/repos/${input.repo}/commits/${currentHeadSha}/status?per_page=100`,
    }),
  ]);
  const review = reviewVerdictFromComment(commentBody);
  const title = cleanInlineText(requiredString(pull.title, "pull request title"));
  const prUrl = requiredString(pull.html_url, "pull request URL");
  return {
    status: "eligible",
    evidence: {
      version: 1,
      repo: input.repo,
      prNumber: input.itemNumber,
      prUrl,
      title: stripEndorTitlePrefix(title),
      findingSummary: findingSummaryFromPull(title, stringOrNull(pull.body)),
      reviewedHeadSha: currentHeadSha,
      reviewDigest: input.reviewCommentDigest,
      reviewGeneration: requiredReviewGeneration(input.reviewGeneration),
      verdict: review.verdict,
      reviewSummary: review.summary,
      reviewUrl: stringOrNull(comment.html_url) ?? `${prUrl}#issuecomment-${input.reviewCommentId}`,
      checks: summarizeGithubChecks(checkRuns, combinedStatus),
      mergeState: normalizeMergeState(pull),
    },
  };
}

export function advanceEndorRemediationReview(
  evidence: EndorReviewEvidence,
  runtime: Pick<EndorRuntime, "root" | "now"> = {},
): EndorAdvanceResult {
  validateEvidence(evidence);
  const root = runtime.root ?? process.cwd();
  const now = (runtime.now ?? (() => new Date()))().toISOString();
  const statePath = path.join(root, endorReviewStatePath(evidence));
  const prior = readReviewState(statePath);
  const headChanged = Boolean(prior && prior.reviewedHeadSha !== evidence.reviewedHeadSha);
  let entry =
    !prior || headChanged
      ? newReviewStateEntry(evidence, now)
      : { ...prior, reviewGenerations: [...prior.reviewGenerations] };
  const replay = entry.reviewGenerations.includes(evidence.reviewGeneration);
  if (!replay) {
    entry.reviewGenerations.push(evidence.reviewGeneration);
    entry.cycles = Math.min(DEFAULT_MAX_CYCLES, entry.cycles + 1);
    entry.lastVerdict = evidence.verdict;
    entry.updatedAt = now;
    if (evidence.verdict === "clean") {
      entry.cleanStreak = Math.min(REQUIRED_CLEAN_STREAK, entry.cleanStreak + 1);
    } else {
      entry.cleanStreak = 0;
    }
  }

  const terminal =
    prior?.stopReason && !headChanged
      ? {
          outcome: "needs_attention" as const,
          summary:
            prior.stopReason === "finding"
              ? "The prior actionable finding still requires a new reviewed head."
              : "The six-review safety cap was already reached for this head.",
          stopReason: prior.stopReason,
        }
      : terminalOutcome(evidence, entry);
  entry.terminalOutcome = terminal?.outcome ?? null;
  entry.stopReason = terminal?.stopReason ?? null;
  writeJsonFile(statePath, { version: 1, updated_at: now, review: entry } satisfies ReviewState);

  const common = {
    cycles: entry.cycles,
    cleanStreak: entry.cleanStreak,
    resetReason: headChanged ? ("head_changed" as const) : null,
  };
  if (!terminal) {
    return {
      action: "requeue",
      ...common,
      requeueKey: [
        "endor-until-clean",
        evidence.repo,
        String(evidence.prNumber),
        evidence.reviewedHeadSha,
        evidence.reviewGeneration,
      ].join(":"),
    };
  }
  return {
    action: "notify",
    ...common,
    event: eventFromEvidence(evidence, entry, terminal.outcome, terminal.summary),
  };
}

export async function deliverEndorRemediationEvent(
  event: EndorRemediationReviewedEvent,
  runtime: EndorRuntime = {},
): Promise<EndorNotifierSummary> {
  validateEvent(event);
  const root = runtime.root ?? process.cwd();
  const env = runtime.env ?? process.env;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? (() => new Date());
  const log = runtime.log ?? console.log;
  const ledgerPath = path.join(root, endorDeliveryLedgerPath(event));
  const reportPath = path.join(root, endorDeliveryReportPath(event));
  const receipt = readDeliveryLedger(ledgerPath);
  if (receipt) {
    if (receipt.notification.idempotencyKey !== event.idempotencyKey) {
      throw new Error("Endor notification receipt path contains a different event");
    }
    const summary = notifierSummary("skipped", 0, 0, 0, 1, "notification already sent");
    writeReport(reportPath, event, summary, null);
    log(JSON.stringify(summary));
    return summary;
  }
  let currentEvent: EndorRemediationReviewedEvent;
  try {
    const revalidation = await revalidateEndorRemediationEvent(event, { env, fetcher });
    if (revalidation.action === "complete") {
      const summary = notifierSummary("skipped", 0, 0, 0, 1, revalidation.reason, {
        action: "complete",
      });
      writeReport(reportPath, event, summary, null);
      log(JSON.stringify(summary));
      return summary;
    }
    if (revalidation.action === "requeue") {
      const summary = notifierSummary("skipped", 0, 0, 0, 1, revalidation.reason, {
        action: "requeue",
        requeueHeadSha: revalidation.headSha,
        requeueUpdatedAt: revalidation.updatedAt,
        requeueKey: [
          "endor-delivery-refresh",
          event.repo,
          String(event.prNumber),
          revalidation.headSha,
        ].join(":"),
      });
      writeReport(reportPath, event, summary, null);
      log(JSON.stringify(summary));
      return summary;
    }
    currentEvent = revalidation.event;
  } catch (error) {
    const failure = classifyEndorPreparationFailure(error);
    const summary = notifierSummary("failed", 1, 0, 1, 0, errorText(error), {
      failureKind: failure.kind === "permanent" ? null : failure.kind,
      retryAt: failure.retryAt,
    });
    writeReport(reportPath, event, summary, null);
    log(JSON.stringify(summary));
    return summary;
  }
  const config = resolveHermitNotificationConfig(env);
  if (!config) {
    const summary = notifierSummary(
      "failed",
      1,
      0,
      1,
      0,
      "CLAWSWEEPER_HERMIT_URL and CLAWSWEEPER_HERMIT_TOKEN are required",
    );
    writeReport(reportPath, event, summary, null);
    log(JSON.stringify(summary));
    return summary;
  }
  try {
    const result = await postHermitEndorNotification({
      config,
      fetcher,
      notification: currentEvent,
      idempotencyKey: currentEvent.idempotencyKey,
    });
    const notifiedAt = now().toISOString();
    writeJsonFile(ledgerPath, {
      version: 1,
      notification: {
        ...currentEvent,
        notifiedAt,
        hermitMessageId: result.messageId,
        deliveryProvider: "hermit",
      },
    } satisfies DeliveryLedger);
    const summary = notifierSummary("ok", 0, 1, 0, 0, null);
    writeReport(reportPath, currentEvent, summary, result.messageId);
    log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    const summary = notifierSummary("failed", 1, 0, 1, 0, errorText(error), {
      failureKind: isTransientHermitNotificationError(error) ? "hermit_transient" : null,
    });
    writeReport(reportPath, event, summary, null);
    log(JSON.stringify(summary));
    return summary;
  }
}

async function revalidateEndorRemediationEvent(
  event: EndorRemediationReviewedEvent,
  runtime: { env: NodeJS.ProcessEnv; fetcher: typeof fetch },
): Promise<
  | { action: "notify"; event: EndorRemediationReviewedEvent }
  | { action: "requeue"; headSha: string; updatedAt: string | null; reason: string }
  | { action: "complete"; reason: string }
> {
  const pull = await githubJson({
    env: runtime.env,
    fetcher: runtime.fetcher,
    apiPath: `/repos/${event.repo}/pulls/${event.prNumber}`,
    label: "delivery-time pull request",
  });
  if (!isEndorAuthoredPull(pull))
    throw new Error("delivery-time pull request is not Endor-authored");
  const inactiveReason = inactivePullReason(pull);
  if (inactiveReason) return { action: "complete", reason: inactiveReason };
  const headSha = requiredSha(asJsonObject(pull.head).sha, "delivery-time pull request head SHA");
  const updatedAt = stringOrNull(pull.updated_at);
  if (headSha !== event.reviewedHeadSha) {
    return {
      action: "requeue",
      headSha,
      updatedAt,
      reason: `pull request head moved from ${event.reviewedHeadSha} to ${headSha}`,
    };
  }
  const [checkRuns, combinedStatus] = await Promise.all([
    githubJson({
      env: runtime.env,
      fetcher: runtime.fetcher,
      apiPath: `/repos/${event.repo}/commits/${headSha}/check-runs?per_page=100`,
      label: "delivery-time check runs",
    }),
    githubJson({
      env: runtime.env,
      fetcher: runtime.fetcher,
      apiPath: `/repos/${event.repo}/commits/${headSha}/status?per_page=100`,
      label: "delivery-time commit status",
    }),
  ]);
  const checks = summarizeGithubChecks(checkRuns, combinedStatus);
  const mergeState = normalizeMergeState(pull);
  const outcome = currentReadinessOutcome(event, checks.state, mergeState);
  if (outcome !== event.outcome) {
    return {
      action: "requeue",
      headSha,
      updatedAt,
      reason: `delivery-time readiness changed from ${event.outcome} to ${outcome}`,
    };
  }
  return { action: "notify", event: { ...event, checks, mergeState } };
}

function currentReadinessOutcome(
  event: EndorRemediationReviewedEvent,
  checkState: EndorCheckState,
  mergeState: EndorMergeState,
): EndorNotificationOutcome {
  if (event.cleanStreak < REQUIRED_CLEAN_STREAK) return event.outcome;
  if (checkState === "failing" || mergeState === "blocked") return "needs_attention";
  if (checkState !== "passing" || mergeState !== "clean") return "unknown";
  return "ready";
}

function terminalOutcome(
  evidence: EndorReviewEvidence,
  entry: ReviewStateEntry,
): {
  outcome: EndorNotificationOutcome;
  summary: string;
  stopReason: ReviewStateEntry["stopReason"];
} | null {
  if (evidence.verdict === "has_findings") {
    return { outcome: "needs_attention", summary: evidence.reviewSummary, stopReason: "finding" };
  }
  if (entry.cleanStreak >= REQUIRED_CLEAN_STREAK) {
    if (evidence.checks.state === "failing" || evidence.mergeState === "blocked") {
      return {
        outcome: "needs_attention",
        summary: `${REQUIRED_CLEAN_STREAK}/${REQUIRED_CLEAN_STREAK} clean reviews completed, but current GitHub readiness is blocked.`,
        stopReason: null,
      };
    }
    if (evidence.checks.state !== "passing" || evidence.mergeState !== "clean") {
      return {
        outcome: "unknown",
        summary: `${REQUIRED_CLEAN_STREAK}/${REQUIRED_CLEAN_STREAK} clean reviews completed, but current checks or merge evidence is unknown.`,
        stopReason: null,
      };
    }
    return { outcome: "ready", summary: evidence.reviewSummary, stopReason: null };
  }
  if (entry.cycles >= DEFAULT_MAX_CYCLES) {
    return {
      outcome: "needs_attention",
      summary: `Stopped at the six-review safety cap with ${entry.cleanStreak}/${REQUIRED_CLEAN_STREAK} consecutive clean reviews.`,
      stopReason: "safety_cap",
    };
  }
  return null;
}

function eventFromEvidence(
  evidence: EndorReviewEvidence,
  entry: ReviewStateEntry,
  outcome: EndorNotificationOutcome,
  reviewSummary: string,
): EndorRemediationReviewedEvent {
  const idempotencyKey = [
    EVENT_TYPE,
    evidence.repo,
    String(evidence.prNumber),
    evidence.reviewedHeadSha,
    outcome,
  ].join(":");
  return {
    version: 1,
    type: EVENT_TYPE,
    repo: evidence.repo,
    prNumber: evidence.prNumber,
    prUrl: evidence.prUrl,
    title: evidence.title,
    findingSummary: evidence.findingSummary,
    reviewedHeadSha: evidence.reviewedHeadSha,
    outcome,
    reviewSummary,
    reviewUrl: evidence.reviewUrl,
    checks: evidence.checks,
    mergeState: evidence.mergeState,
    cycles: entry.cycles,
    cleanStreak: entry.cleanStreak,
    idempotencyKey,
  };
}

function newReviewStateEntry(evidence: EndorReviewEvidence, now: string): ReviewStateEntry {
  return {
    repo: evidence.repo,
    prNumber: evidence.prNumber,
    reviewedHeadSha: evidence.reviewedHeadSha,
    cycles: 0,
    cleanStreak: 0,
    reviewGenerations: [],
    lastVerdict: "ambiguous",
    terminalOutcome: null,
    stopReason: null,
    updatedAt: now,
  };
}

function isEndorAuthoredPull(pull: JsonObject): boolean {
  const author = asJsonObject(pull.user);
  return (
    author.id === ENDOR_APP_USER_ID &&
    author.login === ENDOR_APP_LOGIN &&
    author.type === "Bot" &&
    author.html_url === ENDOR_APP_URL
  );
}

function inactivePullReason(pull: JsonObject): string | null {
  if (pull.merged === true || stringOrNull(pull.merged_at)) return "pull request is merged";
  if (pull.state !== "open") return "pull request is not open";
  return null;
}

function reviewedHeadFromComment(body: string): string | null {
  const markers = [...body.matchAll(/<!--\s*clawsweeper-review-version\b([^>]*)-->/gi)];
  if (markers.length !== 1) return null;
  const attributes = markers[0]?.[1] ?? "";
  const versions = [...attributes.matchAll(/(?:^|\s)v=([^\s>]+)(?=\s|$)/gi)];
  const heads = [...attributes.matchAll(/(?:^|\s)sha=([^\s>]+)(?=\s|$)/gi)];
  if (versions.length !== 1 || versions[0]?.[1] !== "1" || heads.length !== 1) return null;
  const head = heads[0]?.[1]?.toLowerCase() ?? "";
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

function reviewVerdictFromComment(body: string): {
  verdict: EndorReviewVerdict;
  summary: string;
} {
  const heading = /^## Merge readiness\s*$/im.exec(body);
  const tail = heading ? body.slice(heading.index + heading[0].length) : "";
  const nextHeading = /^## /m.exec(tail);
  const section = nextHeading ? tail.slice(0, nextHeading.index) : tail;
  const lines = section
    .split(/\r?\n/)
    .map((line) => cleanInlineText(line))
    .filter(Boolean);
  const summary = lines.slice(0, 2).join(" ") || "Review evidence is unknown.";
  if (/⚠️|⛔|needs? maintainer attention|items? remain|\bblocked\b/i.test(section)) {
    return { verdict: "has_findings", summary };
  }
  if (/✅|\bReady for maintainer review\b/i.test(section)) {
    return { verdict: "clean", summary };
  }
  return { verdict: "ambiguous", summary };
}

function summarizeGithubChecks(
  checkRuns: JsonObject | null,
  combinedStatus: JsonObject | null,
): EndorReviewEvidence["checks"] {
  const checks = [
    ...(Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs.map(asJsonObject) : []),
    ...(Array.isArray(combinedStatus?.statuses)
      ? combinedStatus.statuses.map(asJsonObject).map(legacyStatusAsCheck)
      : []),
  ];
  if (checks.length === 0) {
    return { state: "unknown", total: null, summary: "no check result known" };
  }
  const summary = summarizeChecks(checks);
  if (summary.terminalBlockers.length > 0) {
    return {
      state: "failing",
      total: summary.gatingTotal,
      summary: `${summary.terminalBlockers.length} failing or action-required check${summary.terminalBlockers.length === 1 ? "" : "s"}`,
    };
  }
  if (summary.pending.length > 0) {
    return {
      state: "pending",
      total: summary.gatingTotal,
      summary: `${summary.pending.length} check${summary.pending.length === 1 ? "" : "s"} pending`,
    };
  }
  if (summary.gatingTotal > 0) {
    return {
      state: "passing",
      total: summary.gatingTotal,
      summary: `${summary.gatingTotal} gating check${summary.gatingTotal === 1 ? "" : "s"} passed`,
    };
  }
  return { state: "unknown", total: null, summary: "no gating check result known" };
}

function legacyStatusAsCheck(status: JsonObject): JsonObject {
  const state = String(status.state ?? "").toUpperCase();
  return {
    name: stringOrNull(status.context) ?? "commit status",
    status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
    conclusion:
      state === "SUCCESS" ? "SUCCESS" : state === "FAILURE" || state === "ERROR" ? "FAILURE" : null,
  };
}

function normalizeMergeState(pull: JsonObject): EndorMergeState {
  const state = String(pull.mergeable_state ?? "")
    .trim()
    .toLowerCase();
  if (state === "clean" || state === "has_hooks") return "clean";
  if (state === "dirty" || state === "blocked" || pull.mergeable === false) return "blocked";
  if (state === "behind") return "behind";
  if (state === "unstable") return "unstable";
  return "unknown";
}

function findingSummaryFromPull(title: string, body: string | null): string {
  const parts = [stripEndorTitlePrefix(title)];
  if (!body) return parts[0]!;
  const counts = new Map<string, number>();
  for (const match of body.matchAll(
    /^\|\s*[^\p{L}\p{N}|]*(Critical|High|Medium|Low)\s*\|\s*([0-9]+)\s*\|/gimu,
  )) {
    const severity = match[1];
    const count = Number(match[2]);
    if (severity && Number.isSafeInteger(count)) counts.set(severity, count);
  }
  if (counts.size > 0) {
    parts.push(
      `fixed findings: ${[...counts.entries()]
        .map(([severity, count]) => `${severity}: ${count}`)
        .join(", ")}`,
    );
  }
  const advisories = [
    ...new Set(body.match(/\b(?:GHSA-[a-z0-9-]+|CVE-[0-9]{4}-[0-9]+)\b/gi) ?? []),
  ].slice(0, 5);
  if (advisories.length > 0) parts.push(`advisories: ${advisories.join(", ")}`);
  return parts.join("; ");
}

function stripEndorTitlePrefix(title: string): string {
  return title.replace(/^Endor Labs Version Upgrade:\s*/i, "").trim();
}

function cleanInlineText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(?:✅|⚠️|⛔)/gu, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function githubJson({
  env,
  fetcher,
  apiPath,
  label,
}: {
  env: NodeJS.ProcessEnv;
  fetcher: typeof fetch;
  apiPath: string;
  label: string;
}): Promise<JsonObject> {
  const baseUrl = (stringOrNull(env.GITHUB_API_URL) ?? "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const token = stringOrNull(env.GH_TOKEN) ?? stringOrNull(env.GITHUB_TOKEN);
  const response = await fetcher(`${baseUrl}${apiPath}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  const parsed: unknown = JSON.parse(body);
  if (!isJsonObject(parsed)) throw new Error(`${label} returned a non-object JSON response`);
  return parsed;
}

async function optionalGithubJson(
  options: Omit<Parameters<typeof githubJson>[0], "label">,
): Promise<JsonObject | null> {
  try {
    return await githubJson({ ...options, label: "optional GitHub readiness read" });
  } catch {
    return null;
  }
}

function readReviewState(filePath: string): ReviewStateEntry | null {
  if (!fs.existsSync(filePath)) return null;
  const object = asJsonObject(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  if (object.version !== 1) throw new Error("invalid Endor review state version");
  const review = normalizeReviewStateEntry(object.review);
  if (!review) throw new Error("invalid Endor review state entry");
  return review;
}

function normalizeReviewStateEntry(value: unknown): ReviewStateEntry | null {
  try {
    const object = asJsonObject(value);
    const entry: ReviewStateEntry = {
      repo: requiredRepo(object.repo),
      prNumber: requiredPositiveInteger(object.prNumber, "state PR number"),
      reviewedHeadSha: requiredSha(object.reviewedHeadSha, "state reviewed head"),
      cycles: requiredNonNegativeInteger(object.cycles, "state cycles"),
      cleanStreak: requiredNonNegativeInteger(object.cleanStreak, "state clean streak"),
      reviewGenerations: Array.isArray(object.reviewGenerations)
        ? object.reviewGenerations.filter(
            (generation): generation is string =>
              typeof generation === "string" && /^[0-9A-Za-z._:@/-]{1,256}$/.test(generation),
          )
        : [],
      lastVerdict: requiredVerdict(object.lastVerdict),
      terminalOutcome:
        object.terminalOutcome === null ? null : requiredOutcome(object.terminalOutcome),
      stopReason:
        object.stopReason === "finding" || object.stopReason === "safety_cap"
          ? object.stopReason
          : null,
      updatedAt: requiredString(object.updatedAt, "state updatedAt"),
    };
    if (entry.cycles > DEFAULT_MAX_CYCLES || entry.cleanStreak > REQUIRED_CLEAN_STREAK) return null;
    return entry;
  } catch {
    return null;
  }
}

function readDeliveryLedger(filePath: string): DeliveryLedger | null {
  if (!fs.existsSync(filePath)) return null;
  const object = asJsonObject(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  if (object.version !== 1) throw new Error("invalid Endor notification receipt version");
  const notification = normalizeDeliveryLedgerEntry(object.notification);
  if (!notification) throw new Error("invalid Endor notification receipt");
  return { version: 1, notification };
}

function normalizeDeliveryLedgerEntry(value: unknown): DeliveryLedgerEntry | null {
  try {
    const object = asJsonObject(value);
    const event = normalizeEvent(object);
    return {
      ...event,
      notifiedAt: requiredString(object.notifiedAt, "ledger notifiedAt"),
      hermitMessageId: requiredString(object.hermitMessageId, "ledger Hermit message ID"),
      deliveryProvider: requiredDeliveryProvider(object.deliveryProvider),
    };
  } catch {
    return null;
  }
}

function validatePreparationInput(input: EndorPreparationInput): void {
  requiredRepo(input.repo);
  requiredPositiveInteger(input.itemNumber, "item number");
  requiredPositiveInteger(input.reviewCommentId, "review comment ID");
  if (!/^[0-9a-f]{64}$/.test(input.reviewCommentDigest)) {
    throw new Error("review comment digest must be a lowercase SHA-256");
  }
  requiredReviewGeneration(input.reviewGeneration);
}

function validateEvidence(evidence: EndorReviewEvidence): void {
  if (evidence.version !== 1) throw new Error("invalid Endor evidence version");
  requiredRepo(evidence.repo);
  requiredPositiveInteger(evidence.prNumber, "evidence PR number");
  requiredSha(evidence.reviewedHeadSha, "evidence reviewed head");
  if (!/^[0-9a-z-]{1,128}$/.test(evidence.reviewDigest)) {
    throw new Error("invalid evidence review digest");
  }
  requiredReviewGeneration(evidence.reviewGeneration);
  requiredVerdict(evidence.verdict);
  requiredCheckState(evidence.checks.state);
  requiredMergeState(evidence.mergeState);
}

function validateEvent(event: EndorRemediationReviewedEvent): void {
  if (event.version !== 1 || event.type !== EVENT_TYPE) throw new Error("invalid Endor event type");
  requiredRepo(event.repo);
  requiredPositiveInteger(event.prNumber, "event PR number");
  requiredSha(event.reviewedHeadSha, "event reviewed head");
  requiredOutcome(event.outcome);
  requiredCheckState(event.checks.state);
  requiredMergeState(event.mergeState);
  const expected = [
    EVENT_TYPE,
    event.repo,
    String(event.prNumber),
    event.reviewedHeadSha,
    event.outcome,
  ].join(":");
  if (event.idempotencyKey !== expected) throw new Error("invalid Endor event idempotency key");
}

function normalizeEvent(value: unknown): EndorRemediationReviewedEvent {
  const object = asJsonObject(value);
  const checks = asJsonObject(object.checks);
  const event: EndorRemediationReviewedEvent = {
    version: 1,
    type: EVENT_TYPE,
    repo: requiredRepo(object.repo),
    prNumber: requiredPositiveInteger(object.prNumber, "event PR number"),
    prUrl: requiredString(object.prUrl, "event PR URL"),
    title: requiredString(object.title, "event title"),
    findingSummary: requiredString(object.findingSummary, "event finding summary"),
    reviewedHeadSha: requiredSha(object.reviewedHeadSha, "event reviewed head"),
    outcome: requiredOutcome(object.outcome),
    reviewSummary: requiredString(object.reviewSummary, "event review summary"),
    reviewUrl: requiredString(object.reviewUrl, "event review URL"),
    checks: {
      state: requiredCheckState(checks.state),
      total:
        checks.total === null
          ? null
          : requiredNonNegativeInteger(checks.total, "event check total"),
      summary: requiredString(checks.summary, "event check summary"),
    },
    mergeState: requiredMergeState(object.mergeState),
    cycles: requiredPositiveInteger(object.cycles, "event cycles"),
    cleanStreak: requiredNonNegativeInteger(object.cleanStreak, "event clean streak"),
    idempotencyKey: requiredString(object.idempotencyKey, "event idempotency key"),
  };
  validateEvent(event);
  return event;
}

function requiredRepo(value: unknown): string {
  const repo = requiredString(value, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("invalid repository");
  return repo;
}

function requiredDeliveryProvider(value: unknown): "hermit" {
  if (value !== "hermit") throw new Error("invalid ledger delivery provider");
  return value;
}

function endorPullStateRoot(value: { repo: string; prNumber: number }): string {
  const repo = requiredRepo(value.repo).toLowerCase();
  const prNumber = requiredPositiveInteger(value.prNumber, "PR number");
  return path.posix.join(ENDOR_STATE_ROOT, repo, "pulls", String(prNumber));
}

function requiredString(value: unknown, label: string): string {
  const normalized = stringOrNull(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requiredReviewGeneration(value: unknown): string {
  const generation = requiredString(value, "review generation");
  if (!/^[0-9A-Za-z._:@/-]{1,256}$/.test(generation)) {
    throw new Error("invalid review generation");
  }
  return generation;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be positive`);
  return number;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a 40-character SHA`);
  return sha;
}

function requiredVerdict(value: unknown): EndorReviewVerdict {
  if (value === "clean" || value === "has_findings" || value === "ambiguous") return value;
  throw new Error("invalid Endor review verdict");
}

function requiredOutcome(value: unknown): EndorNotificationOutcome {
  if (value === "ready" || value === "needs_attention" || value === "unknown") return value;
  throw new Error("invalid Endor notification outcome");
}

function requiredCheckState(value: unknown): EndorCheckState {
  if (value === "passing" || value === "pending" || value === "failing" || value === "unknown") {
    return value;
  }
  throw new Error("invalid Endor check state");
}

function requiredMergeState(value: unknown): EndorMergeState {
  if (
    value === "clean" ||
    value === "blocked" ||
    value === "behind" ||
    value === "unstable" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error("invalid Endor merge state");
}

function notifierSummary(
  status: EndorNotifierSummary["status"],
  pending: number,
  sent: number,
  failed: number,
  skipped: number,
  reason: string | null,
  details: Partial<
    Pick<
      EndorNotifierSummary,
      "action" | "requeueHeadSha" | "requeueUpdatedAt" | "requeueKey" | "failureKind" | "retryAt"
    >
  > = {},
): EndorNotifierSummary {
  return {
    action: details.action ?? "notify",
    status,
    pending,
    sent,
    failed,
    skipped,
    exitCode: failed > 0 ? 1 : 0,
    reason,
    requeueHeadSha: details.requeueHeadSha ?? null,
    requeueUpdatedAt: details.requeueUpdatedAt ?? null,
    requeueKey: details.requeueKey ?? null,
    failureKind: details.failureKind ?? null,
    retryAt: details.retryAt ?? null,
  };
}

function writeReport(
  reportPath: string,
  event: EndorRemediationReviewedEvent,
  summary: EndorNotifierSummary,
  hermitMessageId: string | null,
): void {
  writeJsonFile(reportPath, {
    version: 1,
    event_type: EVENT_TYPE,
    event_key: event.idempotencyKey,
    repository: event.repo,
    pr_number: event.prNumber,
    reviewed_head_sha: event.reviewedHeadSha,
    outcome: event.outcome,
    status: summary.status,
    reason: summary.reason,
    action: summary.action,
    hermit_message_id: hermitMessageId,
  });
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewTupleFromRecord(recordPath: string): {
  reviewCommentId: number;
  reviewCommentDigest: string;
} {
  const markdown = fs.readFileSync(recordPath, "utf8");
  const id = strictFrontMatterValue(markdown, "review_comment_id");
  const digest = strictFrontMatterValue(markdown, "review_comment_sha256");
  return {
    reviewCommentId: requiredPositiveInteger(id, "review comment ID"),
    reviewCommentDigest: requiredString(digest, "review comment digest"),
  };
}

function strictFrontMatterValue(markdown: string, key: string): string {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (!frontMatter) throw new Error("review record is missing front matter");
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...frontMatter.matchAll(new RegExp(`^${escaped}:\\s*(.*)$`, "gm"))];
  if (matches.length !== 1 || !matches[0]?.[1]?.trim()) {
    throw new Error(`review record has invalid ${key}`);
  }
  return matches[0][1].trim();
}

async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const options = parseCliOptions(argv.slice(1));
  if (command === "prepare") {
    try {
      const evidencePath = requiredCliOption(options, "evidence-path");
      const tuple = reviewTupleFromRecord(requiredCliOption(options, "record-path"));
      const result = await prepareEndorRemediationReview({
        repo: requiredCliOption(options, "repo"),
        itemNumber: Number(requiredCliOption(options, "item-number")),
        reviewGeneration: requiredCliOption(options, "review-generation"),
        ...tuple,
      });
      if (result.status === "eligible") writeJsonFile(evidencePath, result.evidence);
      else fs.rmSync(evidencePath, { force: true });
      appendGithubOutput("eligible", String(result.status === "eligible"));
      appendGithubOutput("reason", result.status === "eligible" ? "eligible" : result.reason);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } catch (error) {
      const failure = classifyEndorPreparationFailure(error);
      appendGithubOutput("failure_kind", failure.kind);
      appendGithubOutput("retry_at", failure.retryAt ?? "");
      throw error;
    }
  }
  if (command === "advance") {
    const evidence = normalizeEvidence(
      JSON.parse(fs.readFileSync(requiredCliOption(options, "evidence-path"), "utf8")) as unknown,
    );
    const result = advanceEndorRemediationReview(evidence);
    const eventPath = requiredCliOption(options, "event-path");
    if (result.action === "notify") writeJsonFile(eventPath, result.event);
    else fs.rmSync(eventPath, { force: true });
    appendGithubOutput("action", result.action);
    appendGithubOutput("cycles", String(result.cycles));
    appendGithubOutput("clean_streak", String(result.cleanStreak));
    appendGithubOutput("requeue_key", result.action === "requeue" ? result.requeueKey : "");
    appendGithubOutput("state_path", endorReviewStatePath(evidence));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "deliver") {
    const event = normalizeEvent(
      JSON.parse(fs.readFileSync(requiredCliOption(options, "event-path"), "utf8")) as unknown,
    );
    appendGithubOutput("ledger_path", endorDeliveryLedgerPath(event));
    appendGithubOutput("report_path", endorDeliveryReportPath(event));
    const result = await deliverEndorRemediationEvent(event);
    appendGithubOutput("action", result.action);
    appendGithubOutput("requeue_head_sha", result.requeueHeadSha ?? "");
    appendGithubOutput("requeue_updated_at", result.requeueUpdatedAt ?? "");
    appendGithubOutput("requeue_key", result.requeueKey ?? "");
    appendGithubOutput("failure_kind", result.failureKind ?? "");
    appendGithubOutput("retry_at", result.retryAt ?? "");
    return result.exitCode;
  }
  throw new Error("usage: notify-endor-remediation <prepare|advance|deliver> [options]");
}

function normalizeEvidence(value: unknown): EndorReviewEvidence {
  const object = asJsonObject(value);
  const checks = asJsonObject(object.checks);
  const evidence: EndorReviewEvidence = {
    version: 1,
    repo: requiredRepo(object.repo),
    prNumber: requiredPositiveInteger(object.prNumber, "evidence PR number"),
    prUrl: requiredString(object.prUrl, "evidence PR URL"),
    title: requiredString(object.title, "evidence title"),
    findingSummary: requiredString(object.findingSummary, "evidence finding summary"),
    reviewedHeadSha: requiredSha(object.reviewedHeadSha, "evidence reviewed head"),
    reviewDigest: requiredString(object.reviewDigest, "evidence review digest"),
    reviewGeneration: requiredReviewGeneration(object.reviewGeneration),
    verdict: requiredVerdict(object.verdict),
    reviewSummary: requiredString(object.reviewSummary, "evidence review summary"),
    reviewUrl: requiredString(object.reviewUrl, "evidence review URL"),
    checks: {
      state: requiredCheckState(checks.state),
      total:
        checks.total === null
          ? null
          : requiredNonNegativeInteger(checks.total, "evidence check total"),
      summary: requiredString(checks.summary, "evidence check summary"),
    },
    mergeState: requiredMergeState(object.mergeState),
  };
  validateEvidence(evidence);
  return evidence;
}

function parseCliOptions(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid CLI option near ${flag ?? "end of arguments"}`);
    }
    options.set(flag.slice(2), value);
  }
  return options;
}

function requiredCliOption(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function appendGithubOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${name}=${value.replace(/[\r\n]+/g, " ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(errorText(error));
      process.exitCode = 1;
    });
}
