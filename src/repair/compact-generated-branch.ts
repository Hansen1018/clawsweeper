import { runCommand as run } from "./command-runner.js";
import {
  runRepairMutation,
  type RepairLifecycleInput,
  type RepairMutationOutcome,
} from "./repair-action-ledger.js";
import { uniqueStrings } from "./validation-command-utils.js";

const LOCAL_LINEAGE_OPERATION = "repair_local_lineage";

type GitCommitCommand = (args: string[]) => void;

export type GeneratedBranchCompaction =
  | {
      status: "unchanged";
      commit: string;
      previous_commit_count: number;
    }
  | {
      status: "compacted";
      commit: string;
      previous_head: string;
      previous_commit_count: number;
    };

type LocalCheckpointCommit =
  | {
      status: "unchanged";
      commit: string;
    }
  | {
      status: "committed";
      commit: string;
    };

export function commitGeneratedCheckpointIfNeeded({
  targetDir,
  message,
  trailers = [],
  checkpoint,
  lifecycle,
  component = "execute_fix",
  commitCommand,
}: {
  targetDir: string;
  message: string;
  trailers?: readonly string[];
  checkpoint: string;
  lifecycle: RepairLifecycleInput;
  component?: string;
  commitCommand?: GitCommitCommand;
}): string {
  const normalizedTrailers = uniqueStrings([...trailers]);
  const previousHead = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const previousTree = run("git", ["rev-parse", `${previousHead}^{tree}`], {
    cwd: targetDir,
  }).trim();
  const status = run("git", ["status", "--porcelain"], { cwd: targetDir }).trim();
  if (status) run("git", ["add", "--all"], { cwd: targetDir });
  const checkpointTree = status
    ? run("git", ["write-tree"], { cwd: targetDir }).trim()
    : previousTree;
  let deferredError: unknown;
  let hasDeferredError = false;

  const result = runRepairMutation<LocalCheckpointCommit>(lifecycle, {
    kind: "local_checkpoint_commit",
    identity: {
      checkpoint,
      parentHead: previousHead,
      tree: checkpointTree,
      message,
      trailers: normalizedTrailers,
    },
    operationName: LOCAL_LINEAGE_OPERATION,
    component,
    outcome: localMutationOutcome,
    knownNoMutation: () => readHeadSafely(targetDir) === previousHead,
    operation: () => {
      if (!status) return { status: "unchanged", commit: previousHead };
      const commitArgs = ["commit", "-m", message];
      for (const trailer of normalizedTrailers) commitArgs.push("-m", trailer);
      try {
        runCommit(targetDir, commitArgs, commitCommand);
        return {
          status: "committed",
          commit: run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim(),
        };
      } catch (error) {
        const observedHead = readHeadSafely(targetDir);
        if (observedHead && observedHead !== previousHead) {
          deferredError = error;
          hasDeferredError = true;
          return { status: "committed", commit: observedHead };
        }
        throw error;
      }
    },
  });

  if (hasDeferredError) throw deferredError;
  return result.status === "committed" ? result.commit : "";
}

export function compactGeneratedBranchHistory({
  targetDir,
  baseRef,
  message,
  trailers = [],
  lifecycle,
  component = "execute_fix",
  commitCommand,
}: {
  targetDir: string;
  baseRef: string;
  message: string;
  trailers?: readonly string[];
  lifecycle: RepairLifecycleInput;
  component?: string;
  commitCommand?: GitCommitCommand;
}): GeneratedBranchCompaction {
  const status = run("git", ["status", "--porcelain"], { cwd: targetDir }).trim();
  const baseSha = run("git", ["rev-parse", baseRef], { cwd: targetDir }).trim();
  const previousHead = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const previousCommitCount = Number(
    run("git", ["rev-list", "--count", `${baseSha}..${previousHead}`], {
      cwd: targetDir,
    }).trim(),
  );
  const changedFiles = run("git", ["diff", "--name-only", baseSha, previousHead], {
    cwd: targetDir,
  }).trim();
  const previousTree = run("git", ["rev-parse", `${previousHead}^{tree}`], {
    cwd: targetDir,
  }).trim();
  const normalizedTrailers = uniqueStrings([...trailers]);
  let deferredError: unknown;
  let hasDeferredError = false;

  const result = runRepairMutation<GeneratedBranchCompaction>(lifecycle, {
    kind: "generated_history_compaction",
    identity: {
      base: baseSha,
      previousHead,
      tree: previousTree,
      message,
      trailers: normalizedTrailers,
    },
    operationName: LOCAL_LINEAGE_OPERATION,
    component,
    outcome: localMutationOutcome,
    knownNoMutation: () => readHeadSafely(targetDir) === previousHead,
    operation: () => {
      if (status) {
        throw new Error("cannot compact generated branch history with worktree changes");
      }
      if (!Number.isInteger(previousCommitCount) || previousCommitCount <= 1 || !changedFiles) {
        return {
          status: "unchanged",
          commit: previousHead,
          previous_commit_count: previousCommitCount,
        };
      }

      run("git", ["reset", "--soft", baseSha], { cwd: targetDir });
      const commitArgs = ["commit", "-m", message];
      for (const trailer of normalizedTrailers) commitArgs.push("-m", trailer);
      try {
        runCommit(targetDir, commitArgs, commitCommand);
        const commit = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
        const compactedTree = run("git", ["rev-parse", `${commit}^{tree}`], {
          cwd: targetDir,
        }).trim();
        if (compactedTree !== previousTree) {
          throw new Error("generated branch compaction changed the reviewed tree");
        }
        if (run("git", ["status", "--porcelain"], { cwd: targetDir }).trim()) {
          throw new Error("generated branch compaction left worktree changes");
        }
        return {
          status: "compacted",
          commit,
          previous_head: previousHead,
          previous_commit_count: previousCommitCount,
        };
      } catch (error) {
        const observedHead = readHeadSafely(targetDir);
        if (observedHead && observedHead !== previousHead && observedHead !== baseSha) {
          deferredError = error;
          hasDeferredError = true;
          return {
            status: "compacted",
            commit: observedHead,
            previous_head: previousHead,
            previous_commit_count: previousCommitCount,
          };
        }
        throw error;
      }
    },
  });

  if (hasDeferredError) throw deferredError;
  return result;
}

function localMutationOutcome(
  result: LocalCheckpointCommit | GeneratedBranchCompaction,
): RepairMutationOutcome {
  return result.status === "unchanged" ? "rejected" : "accepted";
}

function runCommit(targetDir: string, args: string[], commitCommand?: GitCommitCommand): void {
  if (commitCommand) {
    commitCommand(args);
    return;
  }
  run("git", args, { cwd: targetDir });
}

function readHeadSafely(targetDir: string): string | null {
  try {
    return run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim() || null;
  } catch {
    return null;
  }
}
