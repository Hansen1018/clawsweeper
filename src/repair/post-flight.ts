#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { stripAnsi } from "./comment-router-utils.js";
import {
  ghErrorText,
  ghJson as ghJsonOneShot,
  ghJsonWithRetry as ghJson,
  ghText as ghOneShot,
  ghTextWithRetry as ghWithRetry,
} from "./github-cli.js";
import { issueNumberFromRef, parsePullRequestUrl } from "./github-ref.js";
import { isLockedConversationCommentError } from "../github-retry.js";
import { sleepMs } from "./timing.js";
import {
  CLAWSWEEPER_LABEL,
  CLAWSWEEPER_LABEL_COLOR,
  CLAWSWEEPER_LABEL_DESCRIPTION,
} from "./constants.js";
import { AUTOMERGE_LABEL } from "./comment-router-core.js";
import { numberEnv } from "./env-utils.js";
import {
  buildRepairSquashMergeMessage,
  writeRepairSquashMergeBody,
} from "./repair-merge-message.js";
import {
  RepairMutationFreshnessError,
  createRepairMutationFreshnessGuard,
  flushRepairMutationActionEvents,
  repairCreatedCommentChange,
  runRepairMutation,
  type RepairMutationContext,
  type RepairMutationFreshnessGuard,
} from "./repair-mutation-safety.js";
import { resolveRepairMutationReviewActivityCursor } from "./repair-mutation-review-baseline.js";
import { compactText as compactPlainText } from "./text-utils.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FIX_PR_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const FIX_PR_ACTIONS = new Set(["open_fix_pr", "repair_contributor_branch"]);
const FIX_PR_READY_STATUSES = new Set(["opened", "pushed"]);
const DEFAULT_IGNORED_CHECKS = ["auto-response", "Labeler", "Stale"];
const POST_FLIGHT_WAIT_MS = numberEnv("CLAWSWEEPER_POST_FLIGHT_WAIT_MS", 10 * 60 * 1000);
const POST_FLIGHT_POLL_MS = numberEnv("CLAWSWEEPER_POST_FLIGHT_POLL_MS", 15 * 1000);

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_POST_FLIGHT_DRY_RUN === "1");

if (!jobPath) {
  console.error("usage: node scripts/post-flight.ts <job.md> [result.json] [--latest] [--dry-run]");
  process.exit(2);
}
if (!resultPathArg && !latest) {
  console.error("result path is required unless --latest is set");
  process.exit(2);
}

const job = parseJob(jobPath);
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

if (!["execute", "autonomous"].includes(job.frontmatter.mode)) {
  throw new Error("refusing post-flight: job frontmatter mode is not execute or autonomous");
}
if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
  throw new Error("refusing post-flight: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
}

const resultPath = resultPathArg ? path.resolve(resultPathArg) : findLatestResultPath();
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const clusterPlan = readSiblingJson(resultPath, "cluster-plan.json");
if (result.repo !== job.frontmatter.repo) {
  throw new Error(`result repo ${result.repo} does not match job repo ${job.frontmatter.repo}`);
}
if (result.cluster_id !== job.frontmatter.cluster_id) {
  throw new Error(
    `result cluster ${result.cluster_id} does not match job cluster ${job.frontmatter.cluster_id}`,
  );
}
if (!["execute", "autonomous"].includes(result.mode)) {
  throw new Error(`refusing post-flight: result mode is ${result.mode}`);
}

const fixReport = readSiblingJson(resultPath, "fix-execution-report.json");
const report: LooseRecord = {
  repo: result.repo,
  cluster_id: result.cluster_id,
  dry_run: dryRun,
  result_path: path.relative(repoRoot(), resultPath),
  post_flight_at: new Date().toISOString(),
  actions: [],
};

try {
  if (!fixReport) {
    report.actions.push({
      action: "post_flight",
      status: "skipped",
      reason: "no fix-execution-report.json",
    });
  } else {
    for (const action of fixReport.actions ?? []) {
      if (!FIX_PR_ACTIONS.has(String(action.action ?? ""))) continue;
      const finalized = finalizeFixPr(action);
      report.actions.push(finalized);
      if (finalized.status === "executed") {
        report.actions.push(...finalizePostMergeCloseouts(action, finalized));
      }
    }
  }

  if (report.actions.length === 0) {
    report.actions.push({
      action: "post_flight",
      status: "skipped",
      reason: "no ClawSweeper Repair fix PR actions to finalize",
    });
  }

  report.closure_authorization = buildClosureAuthorization(report.actions);
  writeReport(report, resultPath);
} finally {
  await flushRepairMutationActionEvents();
}

function buildClosureAuthorization(actions: LooseRecord[]) {
  const mergedFixes = actions
    .filter(
      (action) =>
        action.action === "finalize_fix_pr" &&
        action.status === "executed" &&
        typeof action.pr === "string" &&
        /^#\d+$/.test(action.pr) &&
        typeof action.merge_commit_sha === "string" &&
        action.merge_commit_sha.trim(),
    )
    .map((action) => ({
      fix_ref: action.pr,
      merge_commit_sha: action.merge_commit_sha,
    }));
  return {
    version: 1,
    status: mergedFixes.length > 0 ? "authorized" : "not_authorized",
    merged_fixes: mergedFixes,
  };
}

function finalizeFixPr(action: LooseRecord) {
  const base = {
    action: "finalize_fix_pr",
    source_action: action.action,
    source_status: action.status,
    target: action.pr_url ?? action.target ?? null,
  };

  if (!FIX_PR_READY_STATUSES.has(String(action.status ?? ""))) {
    return {
      ...base,
      status: "skipped",
      reason: `fix PR action status is ${action.status ?? "missing"}`,
    };
  }

  const parsed = parsePullRequestUrl(action.pr_url ?? action.target);
  if (!parsed || parsed.repo !== result.repo) {
    return { ...base, status: "blocked", reason: "fix PR URL is missing or outside target repo" };
  }

  if (isIssueImplementationJob()) {
    return finalizeIssueImplementationPr({ base, parsed });
  }

  const deadline = Date.now() + POST_FLIGHT_WAIT_MS;
  let pull;
  let view;
  let prBase;
  let mergeBlock = "";
  let freshness: RepairMutationFreshnessGuard | null = null;
  let waitedMs = 0;
  for (;;) {
    pull = fetchPullRequest(result.repo, parsed.number);
    view = fetchPullRequestView(result.repo, parsed.number);
    prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
    const policyBlock = validateMergePolicy(action, pull);
    if (policyBlock) return { ...prBase, status: "blocked", reason: policyBlock };

    const mergedAt = pull.merged_at ?? view.mergedAt ?? null;
    if (mergedAt) {
      return {
        ...prBase,
        status: "executed",
        reason: "already merged",
        merged_at: mergedAt,
        merge_commit_sha: pull.merge_commit_sha ?? view.mergeCommit?.oid ?? null,
        waited_ms: waitedMs,
      };
    }

    if (!dryRun) {
      try {
        freshness = createRepairMutationFreshnessGuard({
          repository: result.repo,
          number: parsed.number,
          targetKind: "pull_request",
          expectedUpdatedAt: pull.updated_at ?? view.updatedAt,
          expectedReviewActivityCursor: resolveRepairMutationReviewActivityCursor({
            repository: result.repo,
            number: parsed.number,
            targetKind: "pull_request",
            explicitCursor:
              action.review_activity_cursor ?? action.merge_preflight?.review_activity_cursor,
            expectedUpdatedAt: pull.updated_at ?? view.updatedAt,
            reviewedBefore:
              fixReport?.executed_at ?? clusterPlan?.generated_at ?? result.generated_at,
          }),
        });
      } catch (error) {
        if (error instanceof RepairMutationFreshnessError) {
          return postFlightFreshnessBlock(prBase, error, waitedMs);
        }
        throw error;
      }
    }

    mergeBlock = validateMergeableFixPr({ pull, view, preflight: action.merge_preflight });
    if (!mergeBlock) break;
    if (dryRun || !shouldWaitForMergeReadiness({ mergeBlock, view }) || Date.now() >= deadline) {
      return {
        ...prBase,
        status: "blocked",
        reason: mergeBlock,
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        waited_ms: waitedMs,
      };
    }
    const sleepFor = Math.min(POST_FLIGHT_POLL_MS, Math.max(0, deadline - Date.now()));
    sleepMs(sleepFor);
    waitedMs += sleepFor;
  }

  if (dryRun) {
    return {
      ...prBase,
      status: "planned",
      reason: "dry run",
      merge_method: "squash",
      waited_ms: waitedMs,
    };
  }
  if (!freshness) throw new Error("post-flight merge mutation guard was not initialized");
  const mutationContext = postFlightMutationContext({
    action,
    number: parsed.number,
    targetKind: "pull_request",
    sourceRevision: pull.head?.sha ?? result.reviewed_sha ?? result.head_sha,
  });

  if (process.env.CLAWSWEEPER_ALLOW_MERGE !== "1") {
    try {
      labelForClawSweeperReview(mutationContext, freshness);
    } catch (error) {
      if (error instanceof RepairMutationFreshnessError) {
        return postFlightFreshnessBlock(prBase, error, waitedMs);
      }
      throw error;
    }
    return {
      ...prBase,
      status: "blocked",
      reason: "merge requires CLAWSWEEPER_ALLOW_MERGE=1; labeled clawsweeper",
      merge_method: "squash",
      waited_ms: waitedMs,
    };
  }

  const mergeMessage = buildRepairSquashMergeMessage({
    target: parsed.number,
    title: view.title ?? pull.title,
    headSha: pull.head?.sha,
    preflight: action.merge_preflight,
    reason: "merged by ClawSweeper Repair post-flight",
  });
  const bodyFile = writeRepairSquashMergeBody(parsed.number, pull.head?.sha, mergeMessage.body);
  const mergeArgs = [
    "pr",
    "merge",
    String(parsed.number),
    "--repo",
    result.repo,
    "--squash",
    "--subject",
    String(mergeMessage.subject),
    "--body-file",
    bodyFile,
  ];
  if (pull.head?.sha) mergeArgs.push("--match-head-commit", String(pull.head.sha));
  try {
    runRepairMutation(mutationContext, {
      kind: "pull_request_merge",
      identity: {
        repository: result.repo,
        number: parsed.number,
        headSha: pull.head?.sha ?? null,
        method: "squash",
        subjectSha256: createHash("sha256").update(mergeMessage.subject).digest("hex"),
        bodySha256: createHash("sha256").update(mergeMessage.body).digest("hex"),
      },
      freshness,
      operation: () => ghOneShot(mergeArgs),
      knownNoMutation: isRecoverableMergeRaceError,
    });
  } catch (error) {
    if (error instanceof RepairMutationFreshnessError) {
      return postFlightFreshnessBlock(prBase, error, waitedMs);
    }
    const detail = ghErrorText(error);
    if (isRecoverableMergeRace(detail)) {
      const latestView = fetchPullRequestView(result.repo, parsed.number);
      return {
        ...prBase,
        status: "blocked",
        reason: `merge attempt needs branch refresh: ${compactText(detail, 500)}`,
        mergeable: latestView.mergeable ?? null,
        merge_state_status: latestView.mergeStateStatus ?? null,
        review_decision: latestView.reviewDecision ?? null,
        retry_recommended: true,
        waited_ms: waitedMs,
      };
    }
    throw error;
  }
  const merged = fetchPullRequest(result.repo, parsed.number);
  return {
    ...prBase,
    status: "executed",
    reason: "merged by ClawSweeper Repair post-flight",
    merged_at: merged.merged_at ?? null,
    merge_commit_sha: merged.merge_commit_sha ?? null,
    merge_method: "squash",
    commit_subject: mergeMessage.subject,
    summary_lines: mergeMessage.summaryLines,
    fixup_lines: mergeMessage.fixupLines,
    waited_ms: waitedMs,
  };
}

function finalizeIssueImplementationPr({ base, parsed }: LooseRecord) {
  const deadline = Date.now() + POST_FLIGHT_WAIT_MS;
  let waitedMs = 0;
  for (;;) {
    const pull = fetchPullRequest(result.repo, parsed.number);
    const view = fetchPullRequestView(result.repo, parsed.number);
    const prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };

    if (pull.state !== "open") {
      return {
        ...prBase,
        status: "blocked",
        reason: `pull request is ${pull.state}`,
        waited_ms: waitedMs,
      };
    }

    const checkBlock = validateStatusChecks(view.statusCheckRollup ?? []);
    if (!checkBlock) {
      return {
        ...prBase,
        status: "ready",
        reason:
          "issue implementation PR checks are green; merge intentionally blocked for this lane",
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        waited_ms: waitedMs,
      };
    }

    if (
      dryRun ||
      !shouldWaitForIssueImplementationChecks(checkBlock, view) ||
      Date.now() >= deadline
    ) {
      return {
        ...prBase,
        status: "blocked",
        reason: checkBlock,
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        waited_ms: waitedMs,
      };
    }

    const sleepFor = Math.min(POST_FLIGHT_POLL_MS, Math.max(0, deadline - Date.now()));
    sleepMs(sleepFor);
    waitedMs += sleepFor;
  }
}

function finalizePostMergeCloseouts(fixAction: LooseRecord, finalized: LooseRecord) {
  const fixPr = parsePullRequestUrl(fixAction.pr_url ?? fixAction.target);
  if (!fixPr) return [];
  const fixRef = `#${fixPr.number}`;
  const fixUrl = `https://github.com/${result.repo}/pull/${fixPr.number}`;
  const closeouts: JsonValue[] = [];
  for (const action of result.actions ?? []) {
    const actionName = String(action.action ?? "");
    if (!POST_MERGE_CLOSE_ACTIONS.has(actionName)) continue;
    if (!["blocked", "planned"].includes(String(action.status ?? ""))) continue;
    const target = normalizeIssueRef(action.target);
    if (!target || target === fixPr.number) continue;
    const candidateFix = normalizeIssueRef(
      action.candidate_fix ?? action.fixed_by ?? action.fix_candidate,
    );
    if (candidateFix !== fixPr.number) continue;
    closeouts.push(
      finalizePostMergeCloseout({ action, actionName, target, fixRef, fixUrl, finalized }),
    );
  }
  return closeouts;
}

function finalizePostMergeCloseout({
  action,
  actionName,
  target,
  fixRef,
  fixUrl,
  finalized,
}: LooseRecord) {
  const base = {
    action: "post_merge_closeout",
    source_action: actionName,
    target: `#${target}`,
    canonical: action.canonical ?? undefined,
    candidate_fix: fixRef,
    fix_pr: fixUrl,
  };
  const live = fetchIssue(result.repo, target);
  if (live.state !== "open") {
    return {
      ...base,
      status: live.state === "closed" ? "executed" : "skipped",
      reason:
        live.state === "closed"
          ? "target already closed after canonical fix merged"
          : `target is ${live.state}`,
      live_state: live.state,
      merge_commit_sha: finalized.merge_commit_sha ?? null,
    };
  }
  const expectedUpdatedAt = action.target_updated_at ?? action.live_updated_at;
  if (!expectedUpdatedAt) {
    return {
      ...base,
      status: "blocked",
      reason: "missing target_updated_at; rerun the worker against live GitHub state",
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  if (expectedUpdatedAt !== live.updated_at) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }
  let mutationContext: RepairMutationContext | null = null;
  let freshness: RepairMutationFreshnessGuard | null = null;
  if (!dryRun) {
    try {
      mutationContext = postFlightMutationContext({
        action,
        number: target,
        targetKind: live.pull_request ? "pull_request" : "issue",
        operationKey: `${actionName}:${fixRef}:${finalized.merge_commit_sha ?? "unknown"}`,
        sourceRevision:
          finalized.merge_commit_sha ?? action.commit ?? result.reviewed_sha ?? result.head_sha,
      });
      freshness = createRepairMutationFreshnessGuard({
        repository: result.repo,
        number: target,
        targetKind: live.pull_request ? "pull_request" : "issue",
        expectedUpdatedAt,
        expectedReviewActivityCursor: resolveRepairMutationReviewActivityCursor({
          repository: result.repo,
          number: target,
          targetKind: live.pull_request ? "pull_request" : "issue",
          explicitCursor: action.target_review_activity_cursor,
          expectedUpdatedAt,
          reviewedBefore: clusterPlan?.generated_at ?? result.generated_at,
        }),
      });
    } catch (error) {
      if (error instanceof RepairMutationFreshnessError) {
        return postMergeCloseoutFreshnessBlock(base, finalized, error);
      }
      throw error;
    }
  }
  if (hasLiveSecuritySignal(target, live.labels ?? [])) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
    };
  }
  if (dryRun) {
    return {
      ...base,
      status: "planned",
      reason: "dry run",
      merge_commit_sha: finalized.merge_commit_sha ?? null,
    };
  }
  if (!mutationContext || !freshness) {
    throw new Error("post-flight closeout mutation guard was not initialized");
  }

  const commentBody = postMergeCloseoutComment({
    actionName,
    fixUrl,
    provenance: externalMessageProvenance({
      reviewedSha:
        finalized.merge_commit_sha ?? action.commit ?? result.reviewed_sha ?? result.head_sha,
    }),
  });
  try {
    runRepairMutation(mutationContext, {
      kind: "label_add",
      identity: {
        repository: result.repo,
        number: target,
        label: CLAWSWEEPER_LABEL,
      },
      freshness,
      operation: () =>
        ghOneShot([
          "issue",
          "edit",
          String(target),
          "--repo",
          result.repo,
          "--add-label",
          CLAWSWEEPER_LABEL,
        ]),
      knownNoMutation: isAlreadyExistsError,
      acceptedChange: () => ({ kind: "label_add", label: CLAWSWEEPER_LABEL }),
    });
    const bodySha256 = createHash("sha256").update(commentBody).digest("hex");
    const payloadPath = writePayload(`post-flight-comment-${target}`, { body: commentBody });
    runRepairMutation(mutationContext, {
      kind: "comment_create",
      identity: {
        repository: result.repo,
        number: target,
        bodySha256,
      },
      freshness,
      operation: () =>
        ghJsonOneShot<unknown>([
          "api",
          `repos/${result.repo}/issues/${target}/comments`,
          "--method",
          "POST",
          "--input",
          payloadPath,
        ]),
      knownNoMutation: isLockedConversationCommentError,
      acceptedChange: (created) => repairCreatedCommentChange(created, bodySha256),
    });
    runRepairMutation(mutationContext, {
      kind: live.pull_request ? "pull_request_close" : "issue_close",
      identity: {
        repository: result.repo,
        number: target,
        stateReason: live.pull_request ? null : "completed",
      },
      freshness,
      operation: () =>
        live.pull_request
          ? ghOneShot(["pr", "close", String(target), "--repo", result.repo])
          : ghOneShot([
              "issue",
              "close",
              String(target),
              "--repo",
              result.repo,
              "--reason",
              "completed",
            ]),
      knownNoMutation: isLockedConversationCommentError,
    });
  } catch (error) {
    if (error instanceof RepairMutationFreshnessError) {
      return postMergeCloseoutFreshnessBlock(base, finalized, error);
    }
    throw error;
  }
  const after = fetchIssue(result.repo, target);
  return {
    ...base,
    status: after.state === "closed" ? "executed" : "blocked",
    reason:
      after.state === "closed" ? "closed after canonical fix merged" : `target is ${after.state}`,
    live_state: after.state,
    merge_commit_sha: finalized.merge_commit_sha ?? null,
  };
}

function validateMergePolicy(action: LooseRecord, pull: LooseRecord) {
  if (isAutomergeReplacementMerge(action, pull)) return "";
  if (!job.frontmatter.allowed_actions.includes("merge")) return "job does not allow merge";
  if ((job.frontmatter.blocked_actions ?? []).includes("merge"))
    return "merge is blocked by job frontmatter";
  if (job.frontmatter.allow_merge !== true) return "merge requires allow_merge: true";
  return "";
}

function isAutomergeReplacementMerge(action: LooseRecord, pull: LooseRecord) {
  return (
    job.frontmatter.source === "pr_automerge" &&
    action.action === "open_fix_pr" &&
    result.fix_artifact?.repair_strategy === "replace_uneditable_branch" &&
    hasLabel(pull.labels, AUTOMERGE_LABEL)
  );
}

function isIssueImplementationJob() {
  return job.frontmatter.source === "issue_implementation";
}

function hasLabel(labels: LooseRecord[], wanted: string) {
  return (labels ?? []).some(
    (label: JsonValue) => String(label?.name ?? label).toLowerCase() === wanted.toLowerCase(),
  );
}

function labelForClawSweeperReview(
  context: RepairMutationContext,
  freshness: RepairMutationFreshnessGuard,
) {
  ensureLabel(
    context,
    freshness,
    CLAWSWEEPER_LABEL,
    CLAWSWEEPER_LABEL_COLOR,
    CLAWSWEEPER_LABEL_DESCRIPTION,
  );
  runRepairMutation(context, {
    kind: "label_add",
    identity: {
      repository: context.repository,
      number: context.number,
      label: CLAWSWEEPER_LABEL,
    },
    freshness,
    operation: () =>
      ghOneShot([
        "issue",
        "edit",
        String(context.number),
        "--repo",
        context.repository,
        "--add-label",
        CLAWSWEEPER_LABEL,
      ]),
    knownNoMutation: isAlreadyExistsError,
    acceptedChange: () => ({ kind: "label_add", label: CLAWSWEEPER_LABEL }),
  });
}

function ensureLabel(
  context: RepairMutationContext,
  freshness: RepairMutationFreshnessGuard,
  name: string,
  color: JsonValue,
  description: JsonValue,
) {
  try {
    runRepairMutation(context, {
      kind: "label_create",
      identity: {
        repository: context.repository,
        label: name,
        color: String(color),
        descriptionSha256: createHash("sha256").update(String(description)).digest("hex"),
      },
      freshness,
      operation: () =>
        ghOneShot([
          "label",
          "create",
          name,
          "--repo",
          context.repository,
          "--color",
          String(color),
          "--description",
          String(description),
        ]),
      knownNoMutation: isAlreadyExistsError,
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function hasLiveSecuritySignal(number: JsonValue, labels: LooseRecord[]) {
  if (hasDeterministicSecuritySignal({ labels })) return true;
  const bodies = ghWithRetry([
    "api",
    `repos/${result.repo}/issues/${number}/comments?per_page=100`,
    "--paginate",
    "--jq",
    ".[].body",
  ]);
  return hasDeterministicSecuritySignal({ comments: [bodies] });
}

function validateMergeableFixPr({ pull, view, preflight }: LooseRecord) {
  if (pull.state !== "open") return `pull request is ${pull.state}`;
  if (pull.draft || view.isDraft) return "pull request is draft";
  if (String(view.baseRefName ?? pull.base?.ref ?? "") !== "main")
    return "pull request base is not main";
  if (hasLiveSecuritySignal(pull.number, pull.labels ?? [])) {
    return "security-sensitive PR requires central security triage";
  }
  if (view.mergeable !== "MERGEABLE") return `mergeable state is ${view.mergeable || "unknown"}`;
  if (!FIX_PR_MERGE_STATES.has(String(view.mergeStateStatus ?? ""))) {
    return `merge state status is ${view.mergeStateStatus || "unknown"}`;
  }
  if (["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(String(view.reviewDecision ?? ""))) {
    return `review decision is ${view.reviewDecision}`;
  }

  const preflightBlock = validateMergePreflight(preflight);
  if (preflightBlock) return preflightBlock;

  const threadBlock = validateResolvedReviewThreads(result.repo, pull.number);
  if (threadBlock) return threadBlock;

  const checkBlock = shouldRequirePrChecks()
    ? validateStatusChecks(view.statusCheckRollup ?? [])
    : "";
  if (checkBlock) return checkBlock;

  return "";
}

function validateMergePreflight(preflight: LooseRecord) {
  if (!preflight || typeof preflight !== "object") return "merge_preflight is missing";
  if (preflight.security_status !== "cleared") return "security preflight is not cleared";
  if (!Array.isArray(preflight.security_evidence) || preflight.security_evidence.length === 0) {
    return "security preflight evidence is missing";
  }
  if (preflight.comments_status !== "resolved") return "review comments are not resolved";
  if (!Array.isArray(preflight.comments_evidence) || preflight.comments_evidence.length === 0) {
    return "review comments resolution evidence is missing";
  }
  if (preflight.bot_comments_status !== "resolved") return "review-bot comments are not resolved";
  if (
    !Array.isArray(preflight.bot_comments_evidence) ||
    preflight.bot_comments_evidence.length === 0
  ) {
    return "review-bot comment resolution evidence is missing";
  }
  if (!Array.isArray(preflight.validation_commands) || preflight.validation_commands.length === 0) {
    return "merge validation commands are missing";
  }
  const codexReview = preflight.codex_review;
  if (!codexReview || codexReview.command !== "/review")
    return "Codex /review preflight is missing";
  if (!["passed", "clean"].includes(codexReview.status))
    return `Codex /review status is ${codexReview.status || "missing"}`;
  if (codexReview.findings_addressed !== true) return "Codex /review findings are not addressed";
  if (!Array.isArray(codexReview.evidence) || codexReview.evidence.length === 0) {
    return "Codex /review evidence is missing";
  }
  return "";
}

function validateStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks) || checks.length === 0) return "no PR checks found";
  const ignored = ignoredCheckNames();
  const blockers: LooseRecord[] = [];
  let considered = 0;
  for (const check of latestCheckRuns(checks)) {
    const name = String(check.name ?? check.context ?? "unknown check");
    if (isIgnoredStatusCheck(check, ignored)) continue;
    considered += 1;
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (status && !["COMPLETED", "SUCCESS"].includes(status)) {
      blockers.push(`${name}: ${status}`);
      continue;
    }
    if (conclusion && !PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      blockers.push(`${name}: ${conclusion}`);
    }
  }
  if (considered === 0) return "no PR checks found";
  if (blockers.length > 0) return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  return "";
}

function shouldWaitForMergeReadiness({ mergeBlock, view }: LooseRecord) {
  const message = String(mergeBlock ?? "").toLowerCase();
  if (message.includes("mergeable state is unknown")) return true;
  if (message.includes("merge state status is unknown")) return true;
  if (message === "no pr checks found") return true;
  if (message.includes("merge state status is unstable"))
    return hasPendingChecks(view.statusCheckRollup ?? []);
  if (message.includes("checks are not clean"))
    return hasPendingChecks(view.statusCheckRollup ?? []);
  return false;
}

function shouldWaitForIssueImplementationChecks(checkBlock: string, view: LooseRecord) {
  if (/^no PR checks found$/i.test(checkBlock)) return true;
  return shouldWaitForMergeReadiness({ mergeBlock: checkBlock, view });
}

function hasPendingChecks(checks: LooseRecord[]) {
  const ignored = ignoredCheckNames();
  return latestCheckRuns(checks ?? []).some((check: JsonValue) => {
    if (isIgnoredStatusCheck(check, ignored)) return false;
    return isPendingStatusCheck(check);
  });
}

function isIgnoredStatusCheck(check: LooseRecord, ignored: Set<string>) {
  const name = String(check.name ?? check.context ?? "unknown check").toLowerCase();
  const workflow = String(check.workflowName ?? "").toLowerCase();
  return ignored.has(name) || Boolean(workflow && ignored.has(workflow));
}

function latestCheckRuns(checks: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const check of checks) {
    const key = checkIdentity(check);
    const previous = byKey.get(key);
    if (!previous || checkTimestamp(check) >= checkTimestamp(previous)) byKey.set(key, check);
  }
  return [...byKey.values()];
}

function checkIdentity(check: LooseRecord) {
  const name = String(check.name ?? check.context ?? "unknown check").toLowerCase();
  const workflow = String(check.workflowName ?? "").toLowerCase();
  return `${workflow}\n${name}`;
}

function checkTimestamp(check: LooseRecord) {
  for (const field of [
    "startedAt",
    "started_at",
    "createdAt",
    "created_at",
    "completedAt",
    "completed_at",
  ]) {
    const parsed = Date.parse(String(check[field] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (isPendingStatusCheck(check)) return Number.MAX_SAFE_INTEGER;
  return 0;
}

function isPendingStatusCheck(check: LooseRecord) {
  const status = String(check.status ?? check.state ?? "").toUpperCase();
  const conclusion = String(check.conclusion ?? "").toUpperCase();
  return !conclusion && Boolean(status) && !["COMPLETED", "SUCCESS"].includes(status);
}

function ignoredCheckNames() {
  const configured = String(
    process.env.CLAWSWEEPER_POST_FLIGHT_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
  return new Set(
    configured
      .split(",")
      .map((item: JsonValue) => item.trim())
      .map((item: string) => item.toLowerCase())
      .filter(Boolean),
  );
}

function shouldRequirePrChecks() {
  return process.env.CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS === "1";
}

function validateResolvedReviewThreads(repo: string, number: JsonValue) {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              isResolved
              path
              line
              comments(first: 1) {
                nodes {
                  url
                  author { login }
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = ghJson([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=${query}`,
  ]);
  const threads = data?.data?.repository?.pullRequest?.reviewThreads;
  if (threads?.pageInfo?.hasNextPage) return "too many review threads to prove resolved";
  const unresolved = (threads?.nodes ?? []).filter(
    (thread: JsonValue) => thread && !thread.isResolved,
  );
  if (unresolved.length === 0) return "";
  const examples = unresolved
    .slice(0, 3)
    .map(
      (thread: JsonValue) =>
        thread.comments?.nodes?.[0]?.url ?? `${thread.path}:${thread.line ?? "?"}`,
    );
  return `unresolved review threads remain: ${examples.join(", ")}`;
}

function fetchPullRequest(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/pulls/${number}`]);
}

function fetchPullRequestView(repo: string, number: JsonValue) {
  return ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    [
      "baseRefName",
      "isDraft",
      "mergeable",
      "mergeCommit",
      "mergeStateStatus",
      "mergedAt",
      "reviewDecision",
      "state",
      "statusCheckRollup",
      "title",
      "updatedAt",
      "url",
    ].join(","),
  ]);
}

function findLatestResultPath() {
  const runsRoot = path.join(repoRoot(), ".clawsweeper-repair", "runs");
  if (!fs.existsSync(runsRoot)) throw new Error("no run directory exists");
  const candidates: LooseRecord[] = [];
  for (const runName of fs.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, runName, "result.json");
    if (fs.existsSync(candidate))
      candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
  }
  candidates.sort((left: JsonValue, right: JsonValue) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

function readSiblingJson(resultPath: string, name: string) {
  const file = path.join(path.dirname(resultPath), name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeReport(report: LooseRecord, resultPath: string) {
  const reportPath = path.join(path.dirname(resultPath), "post-flight-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

function writePayload(name: string, value: JsonValue) {
  const dir = path.join(repoRoot(), ".clawsweeper-repair", "payloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function normalizeIssueRef(value: JsonValue) {
  return issueNumberFromRef(value);
}

function postFlightMutationContext({
  action,
  number,
  targetKind,
  operationKey,
  sourceRevision,
}: LooseRecord): RepairMutationContext {
  const targetNumber = Number(number);
  if (!Number.isSafeInteger(targetNumber) || targetNumber <= 0) {
    throw new Error("post-flight mutation target number is invalid");
  }
  return {
    phase: "post_flight",
    repository: String(result.repo),
    clusterId: String(result.cluster_id),
    number: targetNumber,
    targetKind: targetKind === "pull_request" ? "pull_request" : "issue",
    operationKey: String(
      operationKey ?? action.idempotency_key ?? action.pr_url ?? action.target ?? targetNumber,
    ),
    sourceRevision: String(sourceRevision ?? result.reviewed_sha ?? result.head_sha ?? "") || null,
  };
}

function postFlightFreshnessBlock(
  base: LooseRecord,
  error: RepairMutationFreshnessError,
  waitedMs: number,
) {
  return {
    ...base,
    status: "blocked",
    reason: error.message,
    ...(error.retryable ? { retry_recommended: true } : {}),
    waited_ms: waitedMs,
  };
}

function postMergeCloseoutFreshnessBlock(
  base: LooseRecord,
  finalized: LooseRecord,
  error: RepairMutationFreshnessError,
) {
  return {
    ...base,
    status: "blocked",
    reason: error.message,
    ...(error.retryable ? { retry_recommended: true } : {}),
    merge_commit_sha: finalized.merge_commit_sha ?? null,
  };
}

function compactText(text: string, maxLength: number) {
  return compactPlainText(stripAnsi(text), maxLength);
}

function isRecoverableMergeRace(message: string) {
  return /pull request has merge conflicts|merge conflict|base branch was modified|head branch was modified|not mergeable/i.test(
    String(message ?? ""),
  );
}

function isRecoverableMergeRaceError(error: unknown) {
  return isRecoverableMergeRace(ghErrorText(error));
}

function isAlreadyExistsError(error: unknown) {
  return /\balready exists\b|\bHTTP\s*422\b/i.test(ghErrorText(error));
}
