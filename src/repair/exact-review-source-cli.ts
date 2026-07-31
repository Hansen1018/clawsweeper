#!/usr/bin/env node
import fs from "node:fs";

import { materializeExactReviewSource } from "./exact-review-source.js";

const args = parseArgs(process.argv.slice(2));
const result = materializeExactReviewSource({
  targetDir: required(args.targetDir, "--target-dir"),
  itemKind: itemKind(required(args.itemKind, "--item-kind")),
  itemNumber: positiveInteger(required(args.itemNumber, "--item-number"), "--item-number"),
  ...(args.sourceHeadSha ? { sourceHeadSha: args.sourceHeadSha } : {}),
});

writeOutput("status", result.status);
writeOutput("source_drift", result.status === "source_drift" ? "true" : "false");
if (result.status === "source_drift") {
  writeOutput("fetched_head_sha", result.fetchedHeadSha);
  console.error(
    `Fetched PR head ${result.fetchedHeadSha} moved past leased source head ${result.leasedHeadSha}; skipping review so the durable queue can requeue the latest source.`,
  );
} else {
  writeOutput("materialized_head_sha", result.headSha);
  console.log(result.headSha.slice(0, 12));
}

function parseArgs(argv: readonly string[]) {
  const parsed: {
    targetDir?: string;
    itemKind?: string;
    itemNumber?: string;
    sourceHeadSha?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (flag !== "--source-head-sha" && value.startsWith("--"))) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--target-dir") parsed.targetDir = value;
    else if (flag === "--item-kind") parsed.itemKind = value;
    else if (flag === "--item-number") parsed.itemNumber = value;
    else if (flag === "--source-head-sha") parsed.sourceHeadSha = value;
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function itemKind(value: string): "issue" | "pull_request" {
  if (value === "issue" || value === "pull_request") return value;
  throw new Error("--item-kind must be issue or pull_request");
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function writeOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  else console.log(`${name}=${value}`);
}
