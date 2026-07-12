import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonValue, LooseRecord } from "./json-types.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const DEFAULT_IGNORED_CHECKS = [
  "auto-response",
  "ClawSweeper Dispatch",
  "dispatch",
  "Labeler",
  "notify",
  "Stale",
];
const TRANSIENT_CANCELLED_CHECKS = new Set(["real behavior proof"]);
const LEDGER_COMMAND_STATUSES = new Set(["claimed", "executed", "skipped", "waiting"]);
const LEDGER_COMMAND_STRING_FIELDS = [
  "idempotency_key",
  "comment_id",
  "comment_version_key",
  "comment_created_at",
  "comment_updated_at",
  "repo",
  "processed_at",
] as const;
const COMMENT_ROUTER_LEDGER_ENTRY_LIMIT = 1000;
const COMMENT_ROUTER_LEDGER_ACTION_LIMIT = 64;
const COMMENT_ROUTER_LEDGER_ENTRY_FIELDS = new Set([
  "idempotency_key",
  "comment_id",
  "comment_version_key",
  "comment_url",
  "comment_created_at",
  "comment_updated_at",
  "status_comment_id",
  "comment_body_sha256",
  "forced_replay",
  "attempt_id",
  "attempt_sequence",
  "attempt_nonce",
  "resolution_reason",
  "repo",
  "issue_number",
  "author",
  "author_id",
  "author_name",
  "author_association",
  "trigger",
  "command",
  "intent",
  "trusted_bot",
  "trusted_bot_author",
  "automation_source",
  "repair_reason",
  "expected_head_sha",
  "finding_id",
  "dispatch_context",
  "status",
  "processed_at",
  "target",
  "actions",
]);
const COMMENT_ROUTER_LEDGER_ACTION_FIELDS = new Set(["action", "status", "label", "job_path"]);
const COMMENT_ROUTER_LEDGER_DISPATCH_FIELDS = new Set([
  "target_branch",
  "runner",
  "execution_runner",
  "since",
]);
const COMMENT_ROUTER_LEDGER_TARGET_FIELDS = new Set([
  "kind",
  "branch",
  "head_sha",
  "cluster_id",
  "job_path",
]);
export const COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT = 1000;
const ACTIVE_COMMENT_ROUTER_STATUSES = new Set(["waiting", "claimed"]);
export const EDITED_DURABLE_COMMENT_VERSION_REASON =
  "durable comment version was edited before dispatch";
export const DELETED_DURABLE_COMMENT_VERSION_REASON =
  "durable comment version was deleted before dispatch";

export function dispatchClaimLookupKeys(entry: LooseRecord) {
  const keys: string[] = [];
  const attempt = dispatchAttemptIdentity(entry);
  const commentId = String(entry.comment_id ?? "").trim();
  const commentUpdatedAt = String(entry.comment_updated_at ?? "").trim();
  if (commentId && commentUpdatedAt) {
    keys.push(scopedDispatchLookupKey(`comment:${commentId}:${commentUpdatedAt}`, attempt));
  }
  const idempotencyKey = String(entry.idempotency_key ?? "").trim();
  if (idempotencyKey) {
    keys.push(scopedDispatchLookupKey(`idempotency:${idempotencyKey}`, attempt));
  }
  return keys;
}

export function dispatchReceiptKeyMaterial(entry: LooseRecord, claim: LooseRecord | null) {
  const idempotencyKey = String(entry.idempotency_key ?? entry.comment_version_key ?? "unknown");
  const attempt = dispatchAttemptIdentity(entry);
  if (attempt?.kind === "forced_replay") {
    return JSON.stringify({
      idempotency_key: idempotencyKey,
      forced_replay_attempt_id: attempt.attemptId,
    });
  }
  if (attempt?.kind === "repair_loop_label_sweep") {
    return `${idempotencyKey}:attempt:${attempt.attemptId}`;
  }
  if (entry.automation_source !== "repair_loop_label_sweep") return idempotencyKey;
  const legacyAttempt = String(
    claim?.processed_at ?? entry.processed_at ?? entry.comment_updated_at ?? "unknown-attempt",
  );
  return `${idempotencyKey}:${legacyAttempt}`;
}

export function routerDispatchReceiptKey(entry: LooseRecord, claim: LooseRecord | null) {
  return `router-${createHash("sha256")
    .update(dispatchReceiptKeyMaterial(entry, claim))
    .digest("hex")
    .slice(0, 16)}`;
}

function forcedReplayAttemptId(entry: LooseRecord): string | null {
  if (entry.forced_replay !== true) return null;
  const identity = forcedReplayIdentityFields(entry);
  return identity.attempt_id ? String(identity.attempt_id) : null;
}

function repairLoopSweepAttemptId(entry: LooseRecord): string | null {
  if (
    entry.forced_replay === true ||
    entry.automation_source !== "repair_loop_label_sweep" ||
    entry.attempt_id === undefined ||
    entry.attempt_id === null
  ) {
    return null;
  }
  return validatedAttemptId(entry.attempt_id, "repair-loop sweep");
}

function dispatchAttemptIdentity(
  entry: LooseRecord,
): { kind: "forced_replay" | "repair_loop_label_sweep"; attemptId: string } | null {
  const forcedReplayAttempt = forcedReplayAttemptId(entry);
  if (forcedReplayAttempt) {
    return { kind: "forced_replay", attemptId: forcedReplayAttempt };
  }
  const repairLoopAttempt = repairLoopSweepAttemptId(entry);
  return repairLoopAttempt
    ? { kind: "repair_loop_label_sweep", attemptId: repairLoopAttempt }
    : null;
}

function scopedDispatchLookupKey(
  key: string,
  attempt: ReturnType<typeof dispatchAttemptIdentity>,
): string {
  if (!attempt) return key;
  if (attempt.kind === "forced_replay") {
    return `forced-replay:${JSON.stringify([key, attempt.attemptId])}`;
  }
  return `repair-loop-attempt:${JSON.stringify([key, attempt.attemptId])}`;
}

export function hasSuccessfulDispatchExecutionJob(jobs: LooseRecord[], requiredJobName: string) {
  return jobs.some(
    (job) =>
      String(job.name ?? "") === requiredJobName &&
      String(job.conclusion ?? "").toLowerCase() === "success",
  );
}

export function summarizeChecks(checks: LooseRecord[]) {
  const ignored = ignoredCheckNames();
  const latestChecks = latestCheckRuns(checks);
  const counts: Record<string, number> = {};
  const blockers: LooseRecord[] = [];
  const pending: LooseRecord[] = [];
  const terminalBlockers: LooseRecord[] = [];
  const externalBlockers: LooseRecord[] = [];
  let gatingTotal = 0;
  for (const check of latestChecks) {
    const name = String(check.name ?? check.context ?? "unknown check");
    const workflow = String(check.workflowName ?? "");
    const ignoredCheck = ignored.has(name.toLowerCase()) || ignored.has(workflow.toLowerCase());
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const externalActionRequired = isExternalActionRequiredCheck(check);
    const key = externalActionRequired ? "ACTION_REQUIRED" : conclusion || status || "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
    if (ignoredCheck) continue;
    gatingTotal += 1;
    if (externalActionRequired) {
      const blocker = `${name}:ACTION_REQUIRED`;
      blockers.push(blocker);
      terminalBlockers.push(blocker);
      externalBlockers.push(blocker);
      continue;
    }
    if (status && !["COMPLETED", "SUCCESS"].includes(status)) {
      const blocker = `${name}:${status}`;
      blockers.push(blocker);
      pending.push(blocker);
    }
    if (conclusion === "CANCELLED" && TRANSIENT_CANCELLED_CHECKS.has(name.toLowerCase())) {
      const blocker = `${name}:${conclusion}`;
      blockers.push(blocker);
      pending.push(blocker);
      continue;
    }
    if (conclusion && !PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      const blocker = `${name}:${conclusion}`;
      blockers.push(blocker);
      terminalBlockers.push(blocker);
    }
  }
  return {
    total: latestChecks.length,
    gatingTotal,
    counts,
    blockers,
    pending,
    terminalBlockers,
    externalBlockers,
  };
}

function isExternalActionRequiredCheck(check: LooseRecord) {
  const url = String(
    check.targetUrl ?? check.target_url ?? check.detailsUrl ?? check.details_url ?? "",
  );
  if (/^https:\/\/vercel\.com\/git\/authorize\b/i.test(url)) return true;
  return false;
}

function latestCheckRuns(checks: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const check of checks) {
    const key = checkIdentity(check);
    const previous = byKey.get(key);
    if (!previous || checkTimestamp(check) >= checkTimestamp(previous)) {
      byKey.set(key, check);
    }
  }
  return [...byKey.values()];
}

function checkIdentity(check: LooseRecord) {
  const name = String(check.name ?? check.context ?? "unknown check").toLowerCase();
  const workflow = String(check.workflowName ?? "").toLowerCase();
  return `${workflow}\n${name}`;
}

function checkTimestamp(check: LooseRecord) {
  for (const field of ["completedAt", "completed_at", "startedAt", "started_at"]) {
    const parsed = Date.parse(String(check[field] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function shouldSuppressProcessedCommentVersion(entry: LooseRecord) {
  const status = String(entry.status ?? "").toLowerCase();
  if (!["executed", "skipped"].includes(status)) return false;
  const intent = String(entry.intent ?? "");
  if (
    status === "skipped" &&
    (intent === "clawsweeper_auto_merge" || intent === "maintainer_approve_automerge")
  ) {
    return false;
  }
  return true;
}

export function commentBodySha256(body: JsonValue) {
  return createHash("sha256")
    .update(String(body ?? ""), "utf8")
    .digest("hex");
}

export function exactCommentVersionMatchesLive(command: LooseRecord, live: JsonValue) {
  if (!live || typeof live !== "object" || Array.isArray(live)) return false;
  const comment = live as LooseRecord;
  return (
    String(comment.id ?? "") === String(command.comment_id ?? "") &&
    String(comment.updated_at ?? "") === String(command.comment_updated_at ?? "") &&
    commentBodySha256(comment.body) === String(command.comment_body_sha256 ?? "")
  );
}

export function repairLoopSweepAttemptIdentity({
  commands,
  idempotencyKey,
  attemptSequences = {},
  attemptHighWater = 0,
}: {
  commands: LooseRecord[];
  idempotencyKey: string;
  attemptSequences?: JsonValue;
  attemptHighWater?: JsonValue;
}) {
  const matching = commands.filter(
    (entry) =>
      entry.automation_source === "repair_loop_label_sweep" &&
      entry.forced_replay !== true &&
      String(entry.idempotency_key ?? "") === idempotencyKey,
  );
  const active = matching
    .filter((entry) => ACTIVE_COMMENT_ROUTER_STATUSES.has(String(entry.status ?? "")))
    .sort((left, right) => {
      const sequenceDifference =
        (ledgerAttemptSequence(left) ?? 0) - (ledgerAttemptSequence(right) ?? 0);
      return sequenceDifference || ledgerEntryTime(left) - ledgerEntryTime(right);
    })
    .at(-1);
  if (active) {
    const attemptId = repairLoopSweepAttemptId(active);
    const attemptSequence = ledgerAttemptSequence(active);
    const attemptNonce = ledgerAttemptNonce(active);
    return {
      ...(attemptId ? { attemptId } : {}),
      ...(attemptSequence !== null ? { attemptSequence } : {}),
      ...(attemptNonce !== null ? { attemptNonce } : {}),
    };
  }

  const persistedSequence =
    normalizedRepairLoopAttemptSequences(attemptSequences)[idempotencyKey] ?? 0;
  const attemptSequence =
    Math.max(
      persistedSequence,
      matching.reduce((maximum, entry) => Math.max(maximum, ledgerAttemptSequence(entry) ?? 0), 0),
    ) + 1;
  const attemptNonce =
    Math.max(
      normalizedRepairLoopAttemptHighWater(attemptHighWater),
      matching.reduce(
        (maximum, entry) =>
          Math.max(maximum, ledgerAttemptNonce(entry) ?? ledgerAttemptSequence(entry) ?? 0),
        0,
      ),
    ) + 1;
  const attemptId = createHash("sha256")
    .update(`repair-loop-attempt-v2:${idempotencyKey}:nonce:${attemptNonce}`, "utf8")
    .digest("hex");
  return { attemptId, attemptSequence, attemptNonce };
}

export function reconcileDurableCommentVersions({
  commands,
  liveComments,
  repo,
  itemNumbers,
  processedAt = new Date().toISOString(),
}: {
  commands: LooseRecord[];
  liveComments: ReadonlyMap<string, LooseRecord | null>;
  repo: string;
  itemNumbers: ReadonlySet<number>;
  processedAt?: string;
}) {
  const normalizedRepo = repo.trim().toLowerCase();
  const activeByCommentId = new Map<string, LooseRecord[]>();
  for (const command of commands) {
    if (!ACTIVE_COMMENT_ROUTER_STATUSES.has(String(command.status ?? ""))) continue;
    if (
      String(command.repo ?? "")
        .trim()
        .toLowerCase() !== normalizedRepo
    ) {
      continue;
    }
    if (!itemNumbers.has(Number(command.issue_number))) continue;
    const commentId = String(command.comment_id ?? "");
    if (!/^[1-9]\d*$/.test(commentId) || !liveComments.has(commentId)) continue;
    const entries = activeByCommentId.get(commentId) ?? [];
    entries.push(command);
    activeByCommentId.set(commentId, entries);
  }

  const pendingComments: LooseRecord[] = [];
  const resolutions: LooseRecord[] = [];
  const suppressedCommentIds: string[] = [];
  for (const [commentId, active] of activeByCommentId) {
    const live = liveComments.get(commentId) ?? null;
    const matching = live
      ? active.filter((command) => durableCommentVersionMatchesLive(command, live))
      : [];
    const matchingCommands = new Set(matching);
    if (live && matching.length > 0) pendingComments.push(live);
    if (matching.length === 0) suppressedCommentIds.push(commentId);

    const resolutionReason = live
      ? EDITED_DURABLE_COMMENT_VERSION_REASON
      : DELETED_DURABLE_COMMENT_VERSION_REASON;
    for (const command of active) {
      if (matchingCommands.has(command)) continue;
      resolutions.push({
        ...command,
        status: "skipped",
        processed_at: processedAt,
        resolution_reason: resolutionReason,
        actions: Array.isArray(command.actions)
          ? command.actions.map((action: JsonValue) =>
              action?.status === "executed" ? action : { ...action, status: "skipped" },
            )
          : command.actions,
      });
    }
  }
  return { pendingComments, resolutions, suppressedCommentIds };
}

function durableCommentVersionMatchesLive(command: LooseRecord, live: LooseRecord) {
  if (
    String(command.comment_id ?? "") !== String(live.id ?? "") ||
    String(command.comment_updated_at ?? "") !== String(live.updated_at ?? "")
  ) {
    return false;
  }
  const expectedDigest = String(command.comment_body_sha256 ?? "");
  return !expectedDigest || expectedDigest === commentBodySha256(live.body);
}

export function exactCommentVersionFastPathDecision({
  authenticated,
  sourceAction,
  targetRepo,
  commentId,
  commentUpdatedAt,
  commentBodyDigest,
  forceReprocess,
  ledger,
  verificationLedgers,
}: {
  authenticated: boolean;
  sourceAction: JsonValue;
  targetRepo: JsonValue;
  commentId: JsonValue;
  commentUpdatedAt: JsonValue;
  commentBodyDigest: JsonValue;
  forceReprocess: boolean;
  ledger: LooseRecord;
  verificationLedgers: LooseRecord[];
}) {
  if (forceReprocess) return { suppress: false, reason: "force_reprocess" };
  if (!authenticated) return { suppress: false, reason: "auth_uncertain" };
  if (String(sourceAction ?? "") !== "created") {
    return { suppress: false, reason: "edited_or_unknown_action" };
  }

  const normalizedRepo = String(targetRepo ?? "")
    .trim()
    .toLowerCase();
  const normalizedCommentId = String(commentId ?? "").trim();
  const normalizedUpdatedAt = normalizeExactTimestamp(commentUpdatedAt);
  const normalizedBodyDigest = String(commentBodyDigest ?? "")
    .trim()
    .toLowerCase();
  if (
    !normalizedRepo ||
    !/^[1-9]\d*$/.test(normalizedCommentId) ||
    !normalizedUpdatedAt ||
    !/^[0-9a-f]{64}$/.test(normalizedBodyDigest)
  ) {
    return { suppress: false, reason: "incomplete_exact_version" };
  }

  if (
    verificationLedgers.length < 2 ||
    verificationLedgers.some(
      (verificationLedger) =>
        stableLedgerSnapshot(verificationLedger) !== stableLedgerSnapshot(ledger),
    )
  ) {
    return { suppress: false, reason: "state_drift" };
  }

  const matches = (Array.isArray(ledger.commands) ? ledger.commands : []).filter(
    (entry: JsonValue) =>
      String(entry?.repo ?? "")
        .trim()
        .toLowerCase() === normalizedRepo &&
      String(entry?.comment_id ?? "").trim() === normalizedCommentId &&
      normalizeExactTimestamp(entry?.comment_updated_at) === normalizedUpdatedAt,
  );
  if (matches.length !== 1) {
    return {
      suppress: false,
      reason: matches.length === 0 ? "version_not_terminal" : "ambiguous_ledger_version",
    };
  }

  const entry = matches[0] as LooseRecord;
  if (
    String(entry.comment_body_sha256 ?? "")
      .trim()
      .toLowerCase() !== normalizedBodyDigest
  ) {
    return { suppress: false, reason: "body_digest_mismatch" };
  }
  if (!shouldSuppressProcessedCommentVersion(entry)) {
    return { suppress: false, reason: "version_retryable" };
  }
  if (
    (Array.isArray(entry.actions) ? entry.actions : []).some((action: JsonValue) =>
      ["claimed", "failed", "pending", "waiting"].includes(
        String(action?.status ?? "").toLowerCase(),
      ),
    )
  ) {
    return { suppress: false, reason: "lease_uncertain" };
  }
  return {
    suppress: true,
    reason: "exact_terminal_comment_version",
    commentVersionKey: `${normalizedCommentId}:${String(entry.comment_updated_at)}`,
    status: String(entry.status ?? "").toLowerCase(),
  };
}

function normalizeExactTimestamp(value: JsonValue) {
  const text = String(value ?? "").trim();
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function stableLedgerSnapshot(ledger: LooseRecord) {
  return JSON.stringify({
    updated_at: ledger.updated_at ?? null,
    attempt_high_water: normalizedRepairLoopAttemptHighWater(ledger.attempt_high_water),
    attempt_sequences: normalizedRepairLoopAttemptSequences(ledger.attempt_sequences),
    commands: Array.isArray(ledger.commands) ? ledger.commands : [],
  });
}

export function dispatchClaimDecision({
  claim,
  runs,
  expectedTitle,
  nowMs = Date.now(),
  graceMs = 300_000,
}: {
  claim: LooseRecord | null;
  runs: LooseRecord[];
  expectedTitle: string;
  nowMs?: number;
  graceMs?: number;
}) {
  if (!claim) return { action: "dispatch", run: null };
  const normalizedGraceMs = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 300_000;
  const claimedAtMs = Date.parse(String(claim.processed_at ?? ""));
  const matchingRuns = runs.filter((run) => {
    if (String(run.display_title ?? run.displayTitle ?? "") !== expectedTitle) return false;
    const createdAtMs = Date.parse(String(run.created_at ?? run.createdAt ?? ""));
    return (
      Number.isFinite(claimedAtMs) &&
      Number.isFinite(createdAtMs) &&
      createdAtMs >= claimedAtMs - 5_000
    );
  });
  const successfulRun = matchingRuns.find(
    (run) =>
      String(run.conclusion ?? "").toLowerCase() === "success" &&
      run.dispatch_execution_verified !== false,
  );
  if (successfulRun) return { action: "recover", run: successfulRun };
  const activeRun = matchingRuns.find((run) =>
    ["queued", "in_progress", "waiting", "pending", "requested"].includes(
      String(run.status ?? "").toLowerCase(),
    ),
  );
  if (activeRun) return { action: "wait", run: null };
  if (Number.isFinite(claimedAtMs) && nowMs - claimedAtMs >= normalizedGraceMs) {
    return { action: "dispatch", run: null };
  }
  return { action: "wait", run: null };
}

export function sortCommentsForRouting(comments: LooseRecord[]) {
  return [...comments].sort((left: LooseRecord, right: LooseRecord) => {
    const leftTime = commentRoutingTime(left);
    const rightTime = commentRoutingTime(right);
    if (rightTime !== leftTime) return rightTime - leftTime;
    return Number(right.id ?? 0) - Number(left.id ?? 0);
  });
}

export function selectCommentsForRouting({
  recentComments,
  durableComments,
  priorityComments = [],
  reservedItemNumbers = [],
  maxComments,
}: {
  recentComments: LooseRecord[];
  durableComments: LooseRecord[];
  priorityComments?: LooseRecord[];
  reservedItemNumbers?: Iterable<number>;
  maxComments: number;
}) {
  const limit = Math.max(0, maxComments);
  const priority = uniqueCommentsById(priorityComments);
  const priorityIds = new Set(priority.map(commentIdentity));
  const remaining = sortCommentsForRouting(
    uniqueCommentsById([...recentComments, ...durableComments]).filter(
      (comment) => !priorityIds.has(commentIdentity(comment)),
    ),
  );
  const reserved: LooseRecord[] = [];
  const reservedIds = new Set<string>();
  for (const number of [...new Set(reservedItemNumbers)].sort((left, right) => left - right)) {
    if (reserved.length >= limit) break;
    const comment = [...priority, ...remaining].find(
      (candidate) =>
        issueNumberFromUrl(candidate.issue_url) === number &&
        !reservedIds.has(commentIdentity(candidate)),
    );
    if (!comment) continue;
    reserved.push(comment);
    reservedIds.add(commentIdentity(comment));
  }
  return [
    ...reserved,
    ...priority.filter((comment) => !reservedIds.has(commentIdentity(comment))),
    ...remaining.filter((comment) => !reservedIds.has(commentIdentity(comment))),
  ].slice(0, limit);
}

function commentIdentity(comment: LooseRecord): string {
  return String(comment.id ?? "");
}

export function routerPendingItemNumbers(commands: LooseRecord[], repo?: string) {
  const normalizedRepo = repo?.trim().toLowerCase();
  return [
    ...new Set(
      commands
        .filter(
          (command) =>
            ["waiting", "claimed"].includes(String(command.status ?? "")) &&
            (!normalizedRepo ||
              String(command.repo ?? "")
                .trim()
                .toLowerCase() === normalizedRepo),
        )
        .map((command) => Number(command.issue_number))
        .filter((number) => Number.isSafeInteger(number) && number > 0),
    ),
  ].sort((left, right) => left - right);
}

export function stageSelectedRouterCommands({
  commands,
  selectedItemNumbers,
  forcedReplay = false,
  attemptId = null,
  claimedCommands = [],
  processedAt = new Date().toISOString(),
  dispatchContext,
}: {
  commands: LooseRecord[];
  selectedItemNumbers: ReadonlySet<number>;
  forcedReplay?: boolean;
  attemptId?: string | null;
  claimedCommands?: LooseRecord[];
  processedAt?: string;
  dispatchContext?: LooseRecord;
}) {
  if (forcedReplay && !attemptId) {
    throw new Error("forced replay staging requires an attempt id");
  }
  const stagedAttemptId = forcedReplay
    ? forcedReplayAttemptId({ forced_replay: true, attempt_id: attemptId })
    : null;
  const claimsByKey = new Map<string, LooseRecord>();
  for (const claim of claimedCommands) {
    if (claim.status !== "claimed") continue;
    for (const key of dispatchClaimLookupKeys(claim)) claimsByKey.set(key, claim);
  }
  return commands
    .filter((command) => selectedItemNumbers.has(Number(command.issue_number)))
    .filter(routerCommandNeedsExactLane)
    .filter((command) => validRouterCommentId(command.comment_id, command.issue_number))
    .map((command) => {
      const existingClaim = forcedReplay
        ? null
        : dispatchClaimLookupKeys(command)
            .map((key) => claimsByKey.get(key))
            .find((claim) => claim !== undefined);
      if (existingClaim) return existingClaim;
      return {
        ...command,
        ...(forcedReplay
          ? {
              forced_replay: true,
              attempt_id: forcedReplayAttemptId(command) ?? stagedAttemptId,
            }
          : {}),
        ...(dispatchContext ? { dispatch_context: dispatchContext } : {}),
        processed_at: processedAt,
        status: "waiting",
        actions: (Array.isArray(command.actions) ? command.actions : []).map((action: JsonValue) =>
          action?.status === "executed" ? action : { ...action, status: "waiting" },
        ),
      };
    });
}

export function stageForcedReplayCommands(commands: LooseRecord[], attemptId: string) {
  return stageSelectedRouterCommands({
    commands,
    selectedItemNumbers: new Set(
      commands
        .map((command) => Number(command.issue_number))
        .filter((number) => Number.isSafeInteger(number) && number > 0),
    ),
    forcedReplay: true,
    attemptId,
  });
}

export function durableForcedReplayCommands({
  commands,
  repo,
  itemNumbers,
  commentIds,
  attemptId,
}: {
  commands: LooseRecord[];
  repo: string;
  itemNumbers: ReadonlySet<number>;
  commentIds?: ReadonlySet<string>;
  attemptId?: string | null;
}) {
  const normalizedRepo = repo.trim().toLowerCase();
  const normalizedAttemptId = String(attemptId ?? "").trim();
  return commands.filter(
    (command) =>
      (command.forced_replay === true ||
        (Boolean(normalizedAttemptId) &&
          command.automation_source === "repair_loop_label_sweep")) &&
      ["waiting", "claimed"].includes(String(command.status ?? "")) &&
      String(command.repo ?? "")
        .trim()
        .toLowerCase() === normalizedRepo &&
      itemNumbers.has(Number(command.issue_number)) &&
      (!commentIds || commentIds.size === 0 || commentIds.has(String(command.comment_id ?? ""))) &&
      (!normalizedAttemptId || String(command.attempt_id ?? "").trim() === normalizedAttemptId) &&
      validRouterCommentId(command.comment_id, command.issue_number),
  );
}

export function durableForcedReplayCommentIds(options: {
  commands: LooseRecord[];
  repo: string;
  itemNumbers: ReadonlySet<number>;
}) {
  return [
    ...new Set(durableForcedReplayCommands(options).map((command) => String(command.comment_id))),
  ];
}

function validRouterCommentId(value: JsonValue, issueNumber: JsonValue) {
  const commentId = String(value ?? "").trim();
  if (/^[1-9]\d*$/.test(commentId)) return true;
  const sweep = parseRepairLoopSweepCommandId(commentId);
  return sweep !== null && sweep.number === Number(issueNumber);
}

export const SUPERSEDED_RE_REVIEW_REASON = "newer re-review command supersedes this request";

export function supersededReReviewCommentVersions(commands: LooseRecord[]) {
  const latestByRequester = new Set<string>();
  const superseded = new Set<string>();
  const newestFirst = [...commands].sort((left, right) => {
    const leftTime = commandRoutingTime(left);
    const rightTime = commandRoutingTime(right);
    if (rightTime !== leftTime) return rightTime - leftTime;
    return Number(right.comment_id ?? 0) - Number(left.comment_id ?? 0);
  });

  for (const command of newestFirst) {
    if (command.intent !== "re_review") continue;
    const version = String(command.comment_version_key ?? "");
    const repo = String(command.repo ?? "").toLowerCase();
    const issueNumber = Number(command.issue_number);
    const requester = command.author_id
      ? `id:${command.author_id}`
      : `login:${normalizeGitHubActor(command.author)}`;
    if (!version || !repo || !issueNumber || requester === "login:") continue;
    const key = `${repo}:${issueNumber}:${requester}`;
    if (latestByRequester.has(key)) superseded.add(version);
    else latestByRequester.add(key);
  }

  return superseded;
}

export function isAllowedMutationActor(login: JsonValue, trustedBots: Iterable<string>) {
  const actor = String(login ?? "")
    .trim()
    .toLowerCase();
  if (!actor) return false;
  for (const trustedBot of trustedBots) {
    if (
      String(trustedBot ?? "")
        .trim()
        .toLowerCase() === actor
    )
      return true;
  }
  return false;
}

export function normalizeGitHubActor(login: JsonValue) {
  return String(login ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/i, "");
}

export function isGitHubAppIntegrationAuthError(message: JsonValue) {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("resource not accessible by integration") &&
    (text.includes("http 403") || /"status"\s*:\s*"403"/.test(text) || text.includes("status: 403"))
  );
}

function uniqueCommentsById(comments: LooseRecord[]) {
  const seen = new Set<string>();
  const unique: LooseRecord[] = [];
  for (const comment of comments) {
    const key = String(comment.id ?? comment.html_url ?? comment.url ?? "");
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(comment);
  }
  return unique;
}

function commentRoutingTime(comment: LooseRecord) {
  const updated = Date.parse(String(comment.updated_at ?? ""));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(comment.created_at ?? ""));
  return Number.isFinite(created) ? created : 0;
}

function commandRoutingTime(command: LooseRecord) {
  const updated = Date.parse(String(command.comment_updated_at ?? ""));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(command.comment_created_at ?? ""));
  return Number.isFinite(created) ? created : 0;
}

function ignoredCheckNames() {
  return commaSet(
    process.env.CLAWSWEEPER_COMMENT_ROUTER_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
}

export function readLedger(file: JsonValue) {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { updated_at: null, attempt_sequences: {}, commands: [] };
    }
    throw new Error(
      `existing comment router ledger is unreadable or malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let data: LooseRecord;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `failed to parse comment router ledger: existing comment router ledger is unreadable or malformed: ${String(file)}`,
      { cause: error },
    );
  }
  assertCommentRouterLedgerReadyForMutation(data);
  const attemptHighWater = normalizedRepairLoopAttemptHighWater(data.attempt_high_water);
  return {
    updated_at: data.updated_at ?? null,
    ...(attemptHighWater > 0 ? { attempt_high_water: attemptHighWater } : {}),
    attempt_sequences: normalizedRepairLoopAttemptSequences(data.attempt_sequences),
    commands: data.commands.map((entry: JsonValue) => validatedLedgerCommand(entry)),
  };
}

export function assertCommentRouterLedgerReadyForMutation(
  data: JsonValue,
): asserts data is LooseRecord {
  const commands = assertCommentRouterLedgerRoot(data);
  assertCommentRouterLedgerCapacity(commands);
  assertCommentRouterLedgerShape(data, commands);
}

function assertCommentRouterLedgerRoot(data: JsonValue): JsonValue[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("existing comment router ledger must be an object");
  }
  if (!Array.isArray(data.commands)) {
    throw new Error("existing comment router ledger commands must be an array");
  }
  return data.commands ?? [];
}

function assertCommentRouterLedgerShape(
  data: LooseRecord,
  commands: JsonValue[],
): asserts data is LooseRecord {
  for (const [index, command] of commands.entries()) {
    assertCommentRouterLedgerEntry(command, index);
  }
  if (
    data.attempt_high_water !== undefined &&
    (typeof data.attempt_high_water !== "number" ||
      !Number.isSafeInteger(data.attempt_high_water) ||
      data.attempt_high_water < 0)
  ) {
    throw new Error(
      "existing comment router ledger attempt_high_water must be a non-negative integer",
    );
  }
  if (data.attempt_sequences === undefined) return;
  if (
    !data.attempt_sequences ||
    typeof data.attempt_sequences !== "object" ||
    Array.isArray(data.attempt_sequences)
  ) {
    throw new Error("existing comment router ledger attempt_sequences must be an object");
  }
  const attemptSequences = Object.entries(data.attempt_sequences);
  if (attemptSequences.length > COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT) {
    throw new Error(
      `existing comment router ledger has ${attemptSequences.length} attempt sequences; maximum is ${COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT}`,
    );
  }
  for (const [key, sequence] of attemptSequences) {
    if (
      !key.startsWith("repair-loop-label-sweep:") ||
      key.length > 512 ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0
    ) {
      throw new Error("existing comment router ledger contains an invalid attempt sequence");
    }
  }
}

function assertCommentRouterLedgerEntry(
  value: JsonValue,
  index: number,
): asserts value is LooseRecord {
  const invalid = (field: string) => {
    throw new Error(`existing comment router ledger command ${index + 1} has invalid ${field}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("entry");
  const entry = value as LooseRecord;
  const commentId = String(entry.comment_id ?? "").trim();
  const sourceComment = /^[1-9]\d*$/.test(commentId);
  const status = String(entry.status ?? "");
  const active = ACTIVE_COMMENT_ROUTER_STATUSES.has(status);
  if (active) {
    for (const field of Object.keys(entry)) {
      if (!COMMENT_ROUTER_LEDGER_ENTRY_FIELDS.has(field)) invalid(`field ${field}`);
    }
  }
  const boundedText = (field: string, maxLength: number, required = false) => {
    const fieldValue = entry[field];
    if (fieldValue === undefined || fieldValue === null) {
      if (required) invalid(field);
      return;
    }
    if (
      typeof fieldValue !== "string" ||
      (required && !fieldValue.trim()) ||
      fieldValue.length > maxLength ||
      hasUnsafeCommentRouterLedgerText(fieldValue)
    ) {
      invalid(field);
    }
  };
  const boundedNullableText = (field: string, maxLength: number, required = false) => {
    const fieldValue = entry[field];
    if (fieldValue === null || fieldValue === undefined) {
      if (required && fieldValue === undefined) invalid(field);
      return;
    }
    boundedText(field, maxLength, required);
  };
  const timestamp = (field: string, required = false) => {
    boundedNullableText(field, 64, required);
    const fieldValue = entry[field];
    if (
      fieldValue !== undefined &&
      fieldValue !== null &&
      !Number.isFinite(Date.parse(String(fieldValue)))
    ) {
      invalid(field);
    }
  };
  boundedText("idempotency_key", 1_024, entry.idempotency_key !== undefined);
  boundedText("comment_id", 512, entry.comment_id !== undefined);
  if (
    active &&
    commentId &&
    commentId !== "0" &&
    !validRouterCommentId(commentId, entry.issue_number)
  ) {
    invalid("comment_id");
  }
  if (sourceComment)
    boundedText("comment_version_key", 1_024, entry.comment_version_key !== undefined);
  else boundedNullableText("comment_version_key", 1_024, entry.comment_version_key !== undefined);
  boundedText("comment_url", 2_048, entry.comment_url !== undefined);
  timestamp("comment_created_at", entry.comment_created_at !== undefined);
  timestamp("comment_updated_at", entry.comment_updated_at !== undefined);
  boundedText("repo", 255, entry.repo !== undefined);
  boundedText("intent", 128, entry.intent !== undefined);
  boundedText("processed_at", 64, true);
  if (entry.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(entry.repo))) {
    invalid("repo");
  }
  if (
    entry.issue_number !== undefined &&
    (!Number.isSafeInteger(Number(entry.issue_number)) || Number(entry.issue_number) <= 0)
  ) {
    invalid("issue_number");
  }
  if (!["claimed", "executed", "skipped", "waiting"].includes(String(entry.status ?? ""))) {
    invalid("status");
  }
  if (!Number.isFinite(Date.parse(String(entry.processed_at ?? "")))) invalid("processed_at");
  if (
    entry.status_comment_id !== undefined &&
    (!Number.isSafeInteger(Number(entry.status_comment_id)) || Number(entry.status_comment_id) <= 0)
  ) {
    invalid("status_comment_id");
  }
  if (
    entry.comment_body_sha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(String(entry.comment_body_sha256))
  ) {
    invalid("comment_body_sha256");
  }
  if (entry.forced_replay !== undefined && typeof entry.forced_replay !== "boolean") {
    invalid("forced_replay");
  }
  boundedNullableText("attempt_id", 512);
  for (const field of ["attempt_sequence", "attempt_nonce"]) {
    if (
      entry[field] !== undefined &&
      (!Number.isSafeInteger(Number(entry[field])) || Number(entry[field]) <= 0)
    ) {
      invalid(field);
    }
  }
  boundedNullableText("resolution_reason", 255);
  boundedText("author", 255, entry.author !== undefined);
  boundedNullableText("author_name", 255, entry.author_name !== undefined);
  boundedText("author_association", 64, entry.author_association !== undefined);
  boundedText("trigger", 128, entry.trigger !== undefined);
  boundedText("command", 128, entry.command !== undefined);
  if (entry.trusted_bot !== undefined && typeof entry.trusted_bot !== "boolean") {
    invalid("trusted_bot");
  }
  boundedNullableText("trusted_bot_author", 255, entry.trusted_bot_author !== undefined);
  boundedNullableText("automation_source", 255, entry.automation_source !== undefined);
  boundedNullableText("repair_reason", 16_384, entry.repair_reason !== undefined);
  boundedNullableText("expected_head_sha", 128, entry.expected_head_sha !== undefined);
  boundedNullableText("finding_id", 1_024, entry.finding_id !== undefined);
  if (
    entry.author_id !== undefined &&
    entry.author_id !== null &&
    (!Number.isSafeInteger(Number(entry.author_id)) || Number(entry.author_id) <= 0)
  ) {
    invalid("author_id");
  }
  assertCommentRouterDispatchContext(entry.dispatch_context, invalid);
  assertCommentRouterTarget(entry.target, invalid, false);
  if (entry.actions !== undefined) {
    if (!Array.isArray(entry.actions)) invalid("actions");
    if (entry.actions.length > COMMENT_ROUTER_LEDGER_ACTION_LIMIT) invalid("actions");
    for (const action of entry.actions) {
      if (!action || typeof action !== "object" || Array.isArray(action)) invalid("actions");
      for (const field of Object.keys(action)) {
        if (!COMMENT_ROUTER_LEDGER_ACTION_FIELDS.has(field)) invalid(`actions.${field}`);
      }
      for (const field of ["action", "status", "label", "job_path"]) {
        const actionValue = action[field];
        if (
          actionValue !== undefined &&
          actionValue !== null &&
          (typeof actionValue !== "string" ||
            actionValue.length > 1_024 ||
            hasUnsafeCommentRouterLedgerText(actionValue))
        ) {
          invalid(`actions.${field}`);
        }
      }
      if (!String(action.action ?? "").trim() || !String(action.status ?? "").trim()) {
        invalid("actions");
      }
      if (action.job_path !== undefined && action.job_path !== null) {
        if (!validCommentRouterLedgerJobPath(String(action.job_path))) {
          invalid("actions.job_path");
        }
      }
    }
  }
}

function assertCommentRouterDispatchContext(value: JsonValue, invalid: (field: string) => never) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("dispatch_context");
  for (const field of Object.keys(value)) {
    if (!COMMENT_ROUTER_LEDGER_DISPATCH_FIELDS.has(field)) {
      invalid(`dispatch_context.${field}`);
    }
  }
  for (const [field, maxLength] of [
    ["target_branch", 255],
    ["runner", 128],
    ["execution_runner", 128],
    ["since", 64],
  ] as const) {
    const fieldValue = value[field];
    if (
      typeof fieldValue !== "string" ||
      (field !== "target_branch" && !fieldValue.trim()) ||
      fieldValue.length > maxLength ||
      hasUnsafeCommentRouterLedgerText(fieldValue)
    ) {
      invalid(`dispatch_context.${field}`);
    }
  }
  if (!Number.isFinite(Date.parse(String(value.since)))) invalid("dispatch_context.since");
}

function assertCommentRouterTarget(
  value: JsonValue,
  invalid: (field: string) => never,
  required: boolean,
) {
  if (value === null) return;
  if (value === undefined) {
    if (required) invalid("target");
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("target");
  for (const field of Object.keys(value)) {
    if (!COMMENT_ROUTER_LEDGER_TARGET_FIELDS.has(field)) invalid(`target.${field}`);
  }
  if (!["issue", "pull_request"].includes(String(value.kind ?? ""))) invalid("target.kind");
  for (const [field, maxLength] of [
    ["kind", 64],
    ["branch", 255],
    ["head_sha", 128],
    ["cluster_id", 255],
    ["job_path", 1_024],
  ] as const) {
    const fieldValue = value[field];
    if (
      fieldValue !== undefined &&
      fieldValue !== null &&
      (typeof fieldValue !== "string" ||
        fieldValue.length > maxLength ||
        hasUnsafeCommentRouterLedgerText(fieldValue))
    ) {
      invalid(`target.${field}`);
    }
  }
  if (
    value.head_sha !== undefined &&
    value.head_sha !== null &&
    !/^[a-f0-9]{40}$/i.test(String(value.head_sha))
  ) {
    invalid("target.head_sha");
  }
  if (
    value.job_path !== undefined &&
    value.job_path !== null &&
    !validCommentRouterLedgerJobPath(String(value.job_path))
  ) {
    invalid("target.job_path");
  }
}

function hasUnsafeCommentRouterLedgerText(value: string) {
  return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

function validCommentRouterLedgerJobPath(value: string) {
  return (
    value.startsWith("jobs/") &&
    value.endsWith(".md") &&
    !value.includes("\\") &&
    path.posix.normalize(value) === value
  );
}

function assertCommentRouterLedgerCapacity(commands: JsonValue[]) {
  if (commands.length > COMMENT_ROUTER_LEDGER_ENTRY_LIMIT) {
    throw new Error(
      `comment router ledger has ${commands.length} commands; maximum is ${COMMENT_ROUTER_LEDGER_ENTRY_LIMIT}`,
    );
  }
  let activeCount = 0;
  for (const entry of commands) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      ACTIVE_COMMENT_ROUTER_STATUSES.has(String(entry.status ?? ""))
    ) {
      activeCount += 1;
      if (activeCount > COMMENT_ROUTER_LEDGER_ENTRY_LIMIT) {
        throw new Error(
          `comment router ledger has ${activeCount} active commands; maximum is ${COMMENT_ROUTER_LEDGER_ENTRY_LIMIT}`,
        );
      }
    }
  }
  const keys = new Set<string>();
  for (const entry of commands) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const key = ledgerEntryKey(entry);
    if (keys.has(key))
      throw new Error(`comment router ledger contains duplicate command key: ${key}`);
    keys.add(key);
  }
}

export function appendLedger(current: LooseRecord, entries: LooseRecord[]) {
  const compact = entries
    .filter((entry: JsonValue) =>
      ["claimed", "executed", "skipped", "waiting"].includes(entry.status),
    )
    .filter((entry: JsonValue) => !isNoopSkip(entry))
    .flatMap((entry: JsonValue) => {
      const actions = compactLedgerActions(entry.actions);
      const identityFields = durableAttemptIdentityFields(entry);
      const normalizedEntry = { ...entry, ...identityFields };
      const attemptIds = ledgerAttemptIds(normalizedEntry);
      const attemptSequence = ledgerAttemptSequence(normalizedEntry);
      const attemptNonce = ledgerAttemptNonce(normalizedEntry);
      const statusCommentId = compactRouterStatusCommentId(entry.status_comment_id);
      const dispatchContext = compactRouterDispatchContext(entry.dispatch_context);
      const resolutionReason = boundedRouterContextString(entry.resolution_reason, 255);
      return attemptIds.map((attemptId) => ({
        idempotency_key: entry.idempotency_key,
        comment_id: entry.comment_id,
        comment_version_key: entry.comment_version_key ?? null,
        comment_url: entry.comment_url,
        comment_created_at: entry.comment_created_at ?? null,
        comment_updated_at: entry.comment_updated_at ?? null,
        ...(statusCommentId ? { status_comment_id: statusCommentId } : {}),
        ...(entry.comment_body_sha256 ? { comment_body_sha256: entry.comment_body_sha256 } : {}),
        ...(normalizedEntry.forced_replay === true ? { forced_replay: true } : {}),
        ...(attemptId ? { attempt_id: attemptId } : {}),
        ...(attemptSequence !== null ? { attempt_sequence: attemptSequence } : {}),
        ...(attemptNonce !== null ? { attempt_nonce: attemptNonce } : {}),
        ...(resolutionReason ? { resolution_reason: resolutionReason } : {}),
        repo: entry.repo,
        issue_number: entry.issue_number,
        author: entry.author,
        author_id: entry.author_id ?? null,
        author_name: entry.author_name ?? null,
        author_association: entry.author_association,
        trigger: entry.trigger,
        command: entry.command,
        intent: entry.intent,
        trusted_bot: Boolean(entry.trusted_bot),
        trusted_bot_author: entry.trusted_bot_author ?? null,
        automation_source: entry.automation_source ?? null,
        repair_reason: entry.repair_reason ?? null,
        expected_head_sha: entry.expected_head_sha ?? null,
        finding_id: entry.finding_id ?? null,
        ...(dispatchContext ? { dispatch_context: dispatchContext } : {}),
        status: entry.status,
        processed_at: entry.processed_at ?? new Date().toISOString(),
        target: entry.target
          ? {
              kind: entry.target.kind,
              branch: entry.target.branch,
              head_sha: entry.target.head_sha,
              cluster_id: entry.target.cluster_id,
              job_path: entry.target.job_path,
            }
          : null,
        ...(actions.length > 0 ? { actions } : {}),
      }));
    });
  if (compact.length === 0) return false;
  const attemptSequences = mergedRepairLoopAttemptSequences(
    current.attempt_sequences,
    current.commands,
    compact,
  );
  const attemptHighWater = mergedRepairLoopAttemptHighWater(
    current.attempt_high_water,
    current.commands,
    compact,
  );
  const attemptSequencesChanged =
    canonicalJson(normalizedRepairLoopAttemptSequences(current.attempt_sequences)) !==
    canonicalJson(attemptSequences);
  const attemptHighWaterChanged =
    normalizedRepairLoopAttemptHighWater(current.attempt_high_water) !== attemptHighWater;
  const byCommentVersion = new Map<string, LooseRecord>(
    (current.commands ?? []).map((entry: LooseRecord) => [ledgerEntryKey(entry), entry] as const),
  );
  let changed = false;
  for (const entry of compact) {
    const key = ledgerEntryKey(entry);
    const previous = byCommentVersion.get(key);
    if (previous && stableLedgerEntry(previous) === stableLedgerEntry(entry)) continue;
    if (previous) byCommentVersion.delete(key);
    byCommentVersion.set(key, entry);
    changed = true;
  }
  if (!changed && !attemptSequencesChanged && !attemptHighWaterChanged) return false;
  const commands = boundedCommentRouterLedgerEntries(byCommentVersion);
  current.updated_at = new Date().toISOString();
  if (attemptHighWater > 0) current.attempt_high_water = attemptHighWater;
  current.attempt_sequences = attemptSequences;
  current.commands = commands;
  return true;
}

function validatedLedgerCommand(entry: JsonValue): LooseRecord {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("comment router ledger commands must be objects");
  }
  const command = { ...entry, ...durableAttemptIdentityFields(entry) };
  for (const field of LEDGER_COMMAND_STRING_FIELDS) {
    const value = command[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim())) {
      throw new Error(`comment router ledger command ${field} must be a non-empty string or null`);
    }
  }
  if (!LEDGER_COMMAND_STATUSES.has(command.status)) {
    throw new Error("comment router ledger command status is invalid");
  }
  if (
    typeof command.processed_at !== "string" ||
    !Number.isFinite(Date.parse(command.processed_at))
  ) {
    throw new Error("comment router ledger command processed_at must be a valid timestamp");
  }
  if (
    command.actions !== undefined &&
    (!Array.isArray(command.actions) ||
      command.actions.some(
        (action: JsonValue) => !action || typeof action !== "object" || Array.isArray(action),
      ))
  ) {
    throw new Error("comment router ledger command actions must be an array of objects");
  }
  if (
    command.target !== undefined &&
    command.target !== null &&
    (typeof command.target !== "object" || Array.isArray(command.target))
  ) {
    throw new Error("comment router ledger command target must be an object or null");
  }
  if (command.status === "claimed" && dispatchClaimLookupKeys(command).length === 0) {
    throw new Error("claimed comment router ledger command requires a durable lookup identity");
  }
  const statusCommentId = compactRouterStatusCommentId(command.status_comment_id);
  if (
    command.status_comment_id !== undefined &&
    command.status_comment_id !== null &&
    statusCommentId === null
  ) {
    throw new Error("comment router ledger command status_comment_id must be a positive integer");
  }
  const dispatchContext = compactRouterDispatchContext(command.dispatch_context);
  if (
    command.dispatch_context !== undefined &&
    command.dispatch_context !== null &&
    dispatchContext === null
  ) {
    throw new Error("comment router ledger command dispatch_context is invalid");
  }
  const resolutionReason = boundedRouterContextString(command.resolution_reason, 255);
  if (
    command.resolution_reason !== undefined &&
    command.resolution_reason !== null &&
    resolutionReason === null
  ) {
    throw new Error("comment router ledger command resolution_reason is invalid");
  }
  return {
    ...command,
    ...(statusCommentId ? { status_comment_id: statusCommentId } : {}),
    ...(dispatchContext ? { dispatch_context: dispatchContext } : {}),
    ...(resolutionReason ? { resolution_reason: resolutionReason } : {}),
  };
}

function forcedReplayIdentityFields(entry: LooseRecord): LooseRecord {
  const forcedReplay = entry.forced_replay;
  if (forcedReplay === undefined || forcedReplay === null || forcedReplay === false) return {};
  if (forcedReplay !== true) {
    throw new Error("forced replay dispatch identity requires forced_replay=true");
  }
  const attemptId = validatedAttemptId(entry.attempt_id, "forced replay");
  return { forced_replay: true, attempt_id: attemptId };
}

function durableAttemptIdentityFields(entry: LooseRecord): LooseRecord {
  if (
    entry.forced_replay !== undefined &&
    entry.forced_replay !== null &&
    entry.forced_replay !== false &&
    entry.forced_replay !== true
  ) {
    throw new Error("forced replay dispatch identity requires forced_replay=true");
  }
  const hasAttemptId = entry.attempt_id !== undefined && entry.attempt_id !== null;
  const hasAttemptSequence =
    entry.attempt_sequence !== undefined && entry.attempt_sequence !== null;
  const hasAttemptNonce = entry.attempt_nonce !== undefined && entry.attempt_nonce !== null;
  const hasForcedReplayAttempts =
    entry.forced_replay_attempt_ids !== undefined && entry.forced_replay_attempt_ids !== null;
  if (entry.forced_replay === true) {
    if (hasAttemptSequence || hasAttemptNonce) {
      throw new Error(
        "forced replay dispatch identity cannot include attempt_sequence or attempt_nonce",
      );
    }
    return forcedReplayIdentityFields(entry);
  }
  if (entry.automation_source === "repair_loop_label_sweep") {
    if (hasForcedReplayAttempts) {
      throw new Error("repair-loop sweep identity cannot include forced replay attempts");
    }
    if (!hasAttemptId && !hasAttemptSequence && !hasAttemptNonce) return {};
    if (!hasAttemptId || !hasAttemptSequence) {
      throw new Error("repair-loop sweep identity requires attempt_id and attempt_sequence");
    }
    const attemptId = validatedAttemptId(entry.attempt_id, "repair-loop sweep");
    const attemptSequence = ledgerAttemptSequence(entry);
    if (attemptSequence === null) {
      throw new Error("repair-loop sweep attempt_sequence must be a positive integer");
    }
    const attemptNonce = ledgerAttemptNonce(entry);
    if (hasAttemptNonce && attemptNonce === null) {
      throw new Error("repair-loop sweep attempt_nonce must be a positive integer");
    }
    return {
      attempt_id: attemptId,
      attempt_sequence: attemptSequence,
      ...(attemptNonce !== null ? { attempt_nonce: attemptNonce } : {}),
    };
  }
  if (hasAttemptId || hasForcedReplayAttempts) {
    throw new Error("forced replay dispatch identity requires forced_replay=true");
  }
  if (hasAttemptSequence || hasAttemptNonce) {
    throw new Error("durable dispatch attempt identity is not valid for this command");
  }
  return {};
}

function validatedAttemptId(value: JsonValue, kind: string): string {
  const attemptId = String(value ?? "").trim();
  if (
    !attemptId ||
    attemptId.length > 128 ||
    /\s/.test(attemptId) ||
    attemptId.includes(String.fromCharCode(0))
  ) {
    throw new Error(
      `${kind} dispatch attempt_id must be a non-empty token of at most 128 characters`,
    );
  }
  return attemptId;
}

function compactRouterDispatchContext(value: JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const targetBranch = boundedRouterContextString(value.target_branch, 255, true);
  const runner = boundedRouterContextString(value.runner, 128);
  const executionRunner = boundedRouterContextString(value.execution_runner, 128);
  const since = boundedRouterContextString(value.since, 64);
  if (targetBranch === null || !runner || !executionRunner || !since) return null;
  return {
    target_branch: targetBranch,
    runner,
    execution_runner: executionRunner,
    since,
  };
}

function compactRouterStatusCommentId(value: JsonValue) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function boundedRouterContextString(value: JsonValue, maxLength: number, allowEmpty = false) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (
    (!text && !allowEmpty) ||
    text.length > maxLength ||
    /[\r\n]/.test(text) ||
    text.includes("\0")
  ) {
    return null;
  }
  return text;
}

export function mergeCommentRouterLedgers(...values: JsonValue[]) {
  const ledgers = values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid comment router ledger ${index + 1}: expected object`);
    }
    if (!Array.isArray(value.commands)) {
      throw new Error(`invalid comment router ledger ${index + 1}: commands must be an array`);
    }
    return value;
  });
  const byKey = new Map<string, LooseRecord>();
  for (const ledger of ledgers) {
    for (const value of ledger.commands) {
      const entry = validatedLedgerCommand(value);
      const key = ledgerEntryKey(entry);
      const previous = byKey.get(key);
      byKey.set(key, previous ? preferredLedgerEntry(previous, entry) : entry);
    }
  }
  const commands = boundedCommentRouterLedgerEntries(byKey);
  const attemptSequences = mergedRepairLoopAttemptSequences(
    ...ledgers.flatMap((ledger) => [ledger.attempt_sequences, ledger.commands]),
  );
  const attemptHighWater = mergedRepairLoopAttemptHighWater(
    ...ledgers.flatMap((ledger) => [ledger.attempt_high_water, ledger.commands]),
  );
  const updatedAt = ledgers
    .map((ledger) => String(ledger.updated_at ?? ""))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1);
  return {
    updated_at: updatedAt || null,
    ...(attemptHighWater > 0 ? { attempt_high_water: attemptHighWater } : {}),
    attempt_sequences: attemptSequences,
    commands,
  };
}

export function mergeCommentRouterLedgerJson(...values: Array<string | null>) {
  const ledgers = values
    .filter((value): value is string => value !== null)
    .map((value, index) => {
      try {
        return JSON.parse(value) as JsonValue;
      } catch {
        throw new Error(`invalid comment router ledger ${index + 1}: malformed JSON`);
      }
    });
  return `${JSON.stringify(mergeCommentRouterLedgers(...ledgers), null, 2)}\n`;
}

function isNoopSkip(entry: LooseRecord) {
  if (String(entry.status ?? "") !== "skipped") return false;
  const reason = String(entry.reason ?? "");
  return (
    reason === "comment version already processed in ledger" ||
    reason === "matching ClawSweeper response comment already exists" ||
    /already enabled for this PR/i.test(reason)
  );
}

function stableLedgerEntry(entry: LooseRecord) {
  return JSON.stringify({
    ...entry,
    processed_at: entry.status === "claimed" ? entry.processed_at : null,
  });
}

function ledgerEntryKey(entry: LooseRecord) {
  let key: string;
  if (
    !entry.comment_version_key &&
    entry.automation_source === "repair_loop_label_sweep" &&
    entry.idempotency_key
  ) {
    key = `idempotency:${entry.idempotency_key}`;
  } else {
    key =
      entry.comment_version_key ??
      `${entry.comment_id ?? "unknown"}:${entry.comment_updated_at ?? "unknown"}`;
  }
  const attempt = dispatchAttemptIdentity(entry);
  return attempt ? `${key}:${attempt.kind}:attempt:${attempt.attemptId}` : key;
}

function ledgerAttemptIds(entry: LooseRecord): Array<string | null> {
  if (entry.forced_replay !== true) {
    return [repairLoopSweepAttemptId(entry)];
  }
  return [forcedReplayAttemptId(entry)];
}

function ledgerAttemptSequence(entry: LooseRecord): number | null {
  const sequence = Number(entry.attempt_sequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function ledgerAttemptNonce(entry: LooseRecord): number | null {
  const nonce = Number(entry.attempt_nonce);
  return Number.isSafeInteger(nonce) && nonce > 0 ? nonce : null;
}

function normalizedRepairLoopAttemptSequences(value: JsonValue): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, sequence]) => {
        const number = Number(sequence);
        return (
          key.startsWith("repair-loop-label-sweep:") &&
          key.length <= 512 &&
          Number.isSafeInteger(number) &&
          number > 0
        );
      })
      .map(([key, sequence]) => [key, Number(sequence)] as [string, number])
      .sort(
        ([leftKey, leftSequence], [rightKey, rightSequence]) =>
          rightSequence - leftSequence || leftKey.localeCompare(rightKey),
      )
      .slice(0, COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function mergedRepairLoopAttemptSequences(...values: JsonValue[]): Record<string, number> {
  const merged = new Map<string, number>();
  const activeKeys = new Set<string>();
  const retain = (key: string, sequence: number) => {
    if (
      !key.startsWith("repair-loop-label-sweep:") ||
      key.length > 512 ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0
    ) {
      return;
    }
    merged.set(key, Math.max(merged.get(key) ?? 0, sequence));
  };
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (entry.automation_source !== "repair_loop_label_sweep") continue;
        const key = String(entry.idempotency_key ?? "");
        retain(key, Number(entry.attempt_sequence));
        if (ACTIVE_COMMENT_ROUTER_STATUSES.has(String(entry.status ?? ""))) activeKeys.add(key);
      }
      continue;
    }
    for (const [key, sequence] of Object.entries(normalizedRepairLoopAttemptSequences(value))) {
      retain(key, sequence);
    }
  }
  if (activeKeys.size > COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT) {
    throw new Error(
      `comment router ledger has ${activeKeys.size} active attempt sequences; maximum is ${COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT}`,
    );
  }
  const retained = [...merged]
    .sort(([leftKey, leftSequence], [rightKey, rightSequence]) => {
      const activeDifference = Number(activeKeys.has(rightKey)) - Number(activeKeys.has(leftKey));
      return activeDifference || rightSequence - leftSequence || leftKey.localeCompare(rightKey);
    })
    .slice(0, COMMENT_ROUTER_ATTEMPT_SEQUENCE_LIMIT)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(retained);
}

function normalizedRepairLoopAttemptHighWater(value: JsonValue): number {
  const highWater = Number(value);
  return Number.isSafeInteger(highWater) && highWater > 0 ? highWater : 0;
}

function mergedRepairLoopAttemptHighWater(...values: JsonValue[]): number {
  let highWater = 0;
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (entry.automation_source !== "repair_loop_label_sweep") continue;
        highWater = Math.max(
          highWater,
          ledgerAttemptNonce(entry) ?? ledgerAttemptSequence(entry) ?? 0,
        );
      }
      continue;
    }
    highWater = Math.max(highWater, normalizedRepairLoopAttemptHighWater(value));
  }
  return highWater;
}

function preferredLedgerEntry(left: LooseRecord, right: LooseRecord): LooseRecord {
  const leftTerminal = ledgerStatusRank(left.status) >= 3;
  const rightTerminal = ledgerStatusRank(right.status) >= 3;
  if (leftTerminal !== rightTerminal) return leftTerminal ? left : right;
  const leftRank = ledgerStatusRank(left.status);
  const rightRank = ledgerStatusRank(right.status);
  if (leftRank !== rightRank) return leftRank > rightRank ? left : right;
  const leftTime = ledgerEntryTime(left);
  const rightTime = ledgerEntryTime(right);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return canonicalJson(left).localeCompare(canonicalJson(right)) >= 0 ? left : right;
}

function ledgerEntryTime(entry: LooseRecord): number {
  for (const value of [entry.processed_at, entry.comment_updated_at, entry.comment_created_at]) {
    const parsed = Date.parse(String(value ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function boundedCommentRouterLedgerEntries(
  entries: ReadonlyMap<string, LooseRecord>,
): LooseRecord[] {
  const sorted = [...entries.entries()].sort(([leftKey, left], [rightKey, right]) => {
    const timeDifference = ledgerEntryTime(left) - ledgerEntryTime(right);
    return timeDifference || leftKey.localeCompare(rightKey);
  });
  const active = sorted.filter(([, entry]) =>
    ACTIVE_COMMENT_ROUTER_STATUSES.has(String(entry.status ?? "")),
  );
  if (active.length > COMMENT_ROUTER_LEDGER_ENTRY_LIMIT) {
    throw new Error(
      `comment router ledger has ${active.length} active commands; maximum is ${COMMENT_ROUTER_LEDGER_ENTRY_LIMIT}`,
    );
  }

  const terminalCapacity = COMMENT_ROUTER_LEDGER_ENTRY_LIMIT - active.length;
  const retainedTerminal =
    terminalCapacity > 0
      ? sorted
          .filter(([, entry]) => !ACTIVE_COMMENT_ROUTER_STATUSES.has(String(entry.status ?? "")))
          .slice(-terminalCapacity)
      : [];
  const retainedKeys = new Set([...active, ...retainedTerminal].map(([key]) => key));
  return sorted.filter(([key]) => retainedKeys.has(key)).map(([, entry]) => entry);
}

function ledgerStatusRank(value: JsonValue): number {
  switch (String(value ?? "")) {
    case "executed":
      return 4;
    case "skipped":
      return 3;
    case "claimed":
      return 2;
    case "waiting":
      return 1;
    default:
      return 0;
  }
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compactLedgerActions(actions: JsonValue) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action: JsonValue) => ({
      action: action?.action ?? null,
      status: action?.status ?? null,
      label: action?.label ?? null,
      job_path: action?.job_path ?? null,
    }))
    .filter((action: LooseRecord) => action.action || action.status);
}

export function writeLedger(file: JsonValue, current: LooseRecord) {
  assertCommentRouterLedgerReadyForMutation(current);
  const ledgerPath = String(file);
  const directory = path.dirname(ledgerPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(ledgerPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = `${JSON.stringify(current, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    const descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, ledgerPath);
    fsyncDirectory(directory);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeReportFile(root: string, data: LooseRecord) {
  const file = path.join(root, "results", "comment-router-latest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writePayload(root: string, name: string, payload: LooseRecord) {
  const dir = path.join(root, ".clawsweeper-repair", "payloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(name)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
  return file;
}

export function issueNumberFromUrl(value: JsonValue) {
  const match = String(value ?? "").match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export function positiveInteger(value: JsonValue, name: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

export function commaSet(value: JsonValue) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item: JsonValue) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function parseRepairLoopSweepCommandId(value: JsonValue) {
  const match = /^repair-loop-label-sweep:(autofix|automerge):([1-9]\d*)$/.exec(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  const intent = match[1] as "autofix" | "automerge";
  return {
    intent,
    number,
    commentId: `repair-loop-label-sweep:${intent}:${number}`,
  };
}

export function routerFanoutItemNumbers(commands: LooseRecord[]) {
  return [
    ...new Set(
      commands
        .filter(routerCommandNeedsExactLane)
        .map((command) => Number(command.issue_number))
        .filter((number) => Number.isSafeInteger(number) && number > 0),
    ),
  ].sort((left, right) => left - right);
}

export function routerCommandNeedsExactLane(command: LooseRecord) {
  if (String(command.status ?? "") === "ready") return true;
  return (Array.isArray(command.actions) ? command.actions : []).some((action: JsonValue) =>
    ["waiting", "active"].includes(String(action?.status ?? "")),
  );
}

export function selectRouterItemFanoutPage({
  itemNumbers,
  after,
  limit,
}: {
  itemNumbers: Iterable<number>;
  after: number | null;
  limit: number;
}) {
  const sorted = [...new Set(itemNumbers)]
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .sort((left, right) => left - right);
  const remaining = after === null ? sorted : sorted.filter((number) => number > after);
  const selected = remaining.slice(0, limit);
  return {
    itemNumbers: selected,
    candidateCount: remaining.length,
    nextAfterItemNumber: remaining.length > selected.length ? (selected.at(-1) ?? null) : null,
  };
}

export function selectRouterCommentItemPage({
  comments,
  additionalItemNumbers = [],
  after,
  limit,
}: {
  comments: LooseRecord[];
  additionalItemNumbers?: Iterable<number>;
  after: number | null;
  limit: number;
}) {
  return selectRouterItemFanoutPage({
    itemNumbers: [
      ...comments.map((comment) => issueNumberFromUrl(comment.issue_url)),
      ...additionalItemNumbers,
    ],
    after,
    limit,
  });
}

export function finalizeRouterItemFanout(
  page: ReturnType<typeof selectRouterItemFanoutPage>,
  commands: LooseRecord[],
  limit: number,
) {
  const eligible = new Set(routerFanoutItemNumbers(commands));
  const selectedItemNumbers = page.itemNumbers.filter((number) => eligible.has(number));
  return {
    limit,
    candidate_count: page.candidateCount,
    examined_count: page.itemNumbers.length,
    selected_count: selectedItemNumbers.length,
    selected_item_numbers: selectedItemNumbers,
    next_after_item_number: page.nextAfterItemNumber,
  };
}

export function stripAnsi(text: string) {
  return String(text ?? "").replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

export function assertRepo(value: JsonValue, name: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error(`${name} must be owner/repo`);
}

function safeName(value: JsonValue) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 120);
}
