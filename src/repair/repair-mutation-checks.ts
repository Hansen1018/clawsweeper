import type { LooseRecord } from "./json-types.js";

export function repairRequiredCheckRollupSnapshot(checks: LooseRecord[]) {
  return {
    checks: checks
      .map((check) => ({
        id: scalar(check.databaseId ?? check.id),
        name: scalar(check.name ?? check.context),
        workflowName: scalar(check.workflowName),
        status: scalar(check.status ?? check.state)?.toUpperCase() ?? null,
        conclusion: scalar(check.conclusion)?.toUpperCase() ?? null,
        startedAt: scalar(check.startedAt ?? check.started_at),
        completedAt: scalar(check.completedAt ?? check.completed_at),
        createdAt: scalar(check.createdAt ?? check.created_at),
        updatedAt: scalar(check.updatedAt ?? check.updated_at),
      }))
      .sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}
