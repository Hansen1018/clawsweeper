import type { JsonValue, LooseRecord } from "./json-types.js";
import { ghRetryKind } from "../github-retry.js";
import { stripAnsi } from "./comment-router-utils.js";

export type AutomergeEffectConfirmation = {
  mergedAt: string | null;
  mergeCommitSha: string | null;
  pendingReason: string;
  block: string;
};

export function applyAutomergeResultToCommand(command: LooseRecord, merge: LooseRecord): boolean {
  command.actions = (Array.isArray(command.actions) ? command.actions : []).map(
    (action: LooseRecord) =>
      action.action === "label"
        ? { ...action, status: "executed", label: action.label }
        : action.action === "remove_label"
          ? { ...action, status: "executed", label: action.label }
          : action.action === "update_description_note"
            ? { ...action, status: "executed" }
            : action.action === "merge"
              ? { ...action, ...merge, completed_at: new Date().toISOString() }
              : action,
  );
  if (merge.status !== "waiting") return false;
  command.status = "waiting";
  return true;
}

export function confirmAutomergeEffectSnapshot(
  snapshot: LooseRecord,
  expectedHeadSha: JsonValue,
): AutomergeEffectConfirmation {
  const expected = normalizeSha(expectedHeadSha);
  const pull = snapshot.pull ?? {};
  const view = snapshot.view ?? {};
  const observed = normalizeSha(pull.head?.sha);
  const mergedAt = String(pull.merged_at ?? "").trim() || null;
  const mergeCommitSha = String(pull.merge_commit_sha ?? "").trim() || null;
  if (!expected || observed !== expected) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: mergedAt
        ? "merged pull request head does not match the authorized automerge head"
        : "pull request head changed before the automerge effect could be confirmed",
    };
  }
  if (mergedAt) {
    return {
      mergedAt,
      mergeCommitSha,
      pendingReason: "",
      block: "",
    };
  }

  const viewHead = normalizeSha(view.headRefOid);
  if (viewHead && viewHead !== expected) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: "pull request head changed before the automerge effect could be confirmed",
    };
  }
  const pendingReason =
    viewHead === expected && view.isInMergeQueue === true
      ? `reviewed head ${expected} is pending in the merge queue`
      : viewHead === expected && view.autoMergeRequest
        ? `reviewed head ${expected} has auto-merge pending`
        : pull.auto_merge
          ? `reviewed head ${expected} has auto-merge pending`
          : "";
  return {
    mergedAt: null,
    mergeCommitSha: null,
    pendingReason,
    block: "",
  };
}

export function automergeCommandResponseAmbiguous(attempt: LooseRecord) {
  return Boolean(
    attempt.command_error || attempt.command_result?.error || attempt.command_result?.status !== 0,
  );
}

export function automergeCommandFailure(attempt: LooseRecord) {
  if (attempt.command_error) return compactFailure(attempt.command_error);
  const result = attempt.command_result ?? {};
  return stripAnsi(
    result.stderr || result.stdout || result.error?.message || "unknown error",
  ).trim();
}

export function automergeUnconfirmedFailureDisposition(
  attempt: LooseRecord,
): "waiting" | "blocked" {
  const error =
    attempt.command_error ?? attempt.command_result?.error ?? automergeCommandFailure(attempt);
  return ghRetryKind(error) === "none" ? "blocked" : "waiting";
}

export function automergeAttemptReceiptOutcome(
  attempt: LooseRecord,
): "accepted" | "rejected" | "unknown" {
  const confirmation = attempt.confirmation as AutomergeEffectConfirmation | null | undefined;
  if (
    confirmation &&
    !confirmation.block &&
    (confirmation.mergedAt || confirmation.pendingReason)
  ) {
    return "accepted";
  }
  if (confirmation?.block) return "unknown";
  if (
    automergeCommandResponseAmbiguous(attempt) &&
    automergeUnconfirmedFailureDisposition(attempt) === "blocked"
  ) {
    return "rejected";
  }
  return "unknown";
}

function normalizeSha(value: JsonValue) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function compactFailure(error: unknown) {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return stripAnsi(
    [error instanceof Error ? error.message : String(error ?? ""), record.stderr, record.stdout]
      .filter(Boolean)
      .join("\n"),
  ).trim();
}
