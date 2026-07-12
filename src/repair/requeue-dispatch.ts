import { runCommandResult } from "./command-runner.js";

export function runDeadlineBoundRequeueDispatch({
  args,
  cwd,
  deadlineAtMs,
  env = process.env,
}: {
  args: string[];
  cwd: string;
  deadlineAtMs: number;
  env?: NodeJS.ProcessEnv;
}) {
  const timeoutMs = remainingDispatchDeadlineMs(deadlineAtMs);
  try {
    const result = runCommandResult("gh", args, {
      cwd,
      env,
      timeoutMs,
    });
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(detail || `gh workflow run exited ${result.status ?? "without status"}`);
    }
  } catch (error) {
    if (/command timed out after \d+ms: gh workflow run\b/i.test(String(error?.message ?? error))) {
      const timeout = new Error(
        "requeue dispatch timed out before confirmation; the workflow may have been accepted, so refusing a blind retry",
        { cause: error },
      ) as NodeJS.ErrnoException;
      timeout.code = "REQUEUE_DISPATCH_INDETERMINATE";
      throw timeout;
    }
    throw error;
  }
}

function remainingDispatchDeadlineMs(deadlineAtMs: number) {
  const remaining = deadlineAtMs - Date.now();
  if (!Number.isSafeInteger(deadlineAtMs) || remaining <= 0) {
    throw new Error("requeue dispatch deadline expired");
  }
  return Math.min(remaining, 2_147_483_647);
}
