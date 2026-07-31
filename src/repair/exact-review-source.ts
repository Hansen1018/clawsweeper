import { currentHead } from "./git-repo-utils.js";
import { runCommand as run } from "./command-runner.js";

const gitNetworkTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      5 * 60 * 1000,
  ),
);

export type ExactReviewSourceResult =
  | { status: "ready"; headSha: string }
  | { status: "source_drift"; leasedHeadSha: string; fetchedHeadSha: string };

export function materializeExactReviewSource(options: {
  targetDir: string;
  itemKind: "issue" | "pull_request";
  itemNumber: number;
  sourceHeadSha?: string;
}): ExactReviewSourceResult {
  if (!Number.isSafeInteger(options.itemNumber) || options.itemNumber < 1) {
    throw new Error("itemNumber must be a positive integer");
  }
  if (options.itemKind === "issue") {
    return { status: "ready", headSha: currentHead(options.targetDir) };
  }

  const leasedHeadSha = String(options.sourceHeadSha ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(leasedHeadSha)) {
    throw new Error("Exact PR review requires a valid leased source head SHA");
  }

  run("git", ["fetch", "--force", "--depth=50", "origin", `refs/pull/${options.itemNumber}/head`], {
    cwd: options.targetDir,
    timeoutMs: gitNetworkTimeoutMs,
  });
  const fetchedHeadSha = run("git", ["rev-parse", "FETCH_HEAD"], {
    cwd: options.targetDir,
  })
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(fetchedHeadSha)) {
    throw new Error(`Fetched PR head is not a full commit SHA: ${fetchedHeadSha || "empty"}`);
  }
  if (fetchedHeadSha !== leasedHeadSha) {
    return { status: "source_drift", leasedHeadSha, fetchedHeadSha };
  }

  run("git", ["checkout", "--detach", leasedHeadSha], { cwd: options.targetDir });
  const headSha = currentHead(options.targetDir).toLowerCase();
  if (headSha !== leasedHeadSha) {
    throw new Error(
      `Target checkout head ${headSha || "empty"} does not match leased source head ${leasedHeadSha}`,
    );
  }
  return { status: "ready", headSha };
}
