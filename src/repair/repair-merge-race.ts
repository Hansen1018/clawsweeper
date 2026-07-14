import { ghErrorText } from "./github-cli.js";

export function isRecoverableRepairMergeRace(message: string) {
  return /pull request has merge conflicts|merge conflict|base branch was modified|head branch was modified|not mergeable/i.test(
    String(message ?? ""),
  );
}

export function isRecoverableRepairMergeRaceError(error: unknown) {
  return isRecoverableRepairMergeRace(ghErrorText(error));
}
