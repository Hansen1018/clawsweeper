import type { LooseRecord } from "./json-types.js";
import { repairSourceRevision } from "./repair-action-ledger.js";

export function reviewedResultRevision(
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
  sourceContext: LooseRecord | null = null,
): string | null {
  const revisions = [
    canonicalPullRequestRevision(result, clusterPlan),
    exactRevision(repairSourceRevision(sourceContext ?? {})),
  ].filter((revision): revision is string => Boolean(revision));
  return new Set(revisions).size === 1 ? revisions[0]! : null;
}

function canonicalPullRequestRevision(
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
): string | null {
  const canonicalNumber = githubItemNumber(result.canonical_pr);
  if (!canonicalNumber || !Array.isArray(clusterPlan?.items)) return null;
  const resultRepo = String(result.repo ?? "")
    .trim()
    .toLowerCase();
  const matches = clusterPlan.items.filter(
    (item: LooseRecord) =>
      String(item?.kind ?? "") === "pull_request" &&
      githubItemNumber(item?.ref ?? item?.number) === canonicalNumber &&
      (!resultRepo ||
        String(item?.repo ?? "")
          .trim()
          .toLowerCase() === resultRepo),
  );
  if (matches.length !== 1) return null;
  return exactRevision(matches[0]?.pull_request?.head_sha);
}

function githubItemNumber(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  const match =
    normalized.match(/^#?([1-9][0-9]*)$/) ??
    normalized.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/([1-9][0-9]*)$/i);
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function exactRevision(value: unknown): string | null {
  const revision = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) ? revision : null;
}
