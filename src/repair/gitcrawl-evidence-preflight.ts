#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { inventoryGitcrawlEvidenceMigration } from "./gitcrawl-evidence-migration.js";
import { parseArgs, repoRoot } from "./lib.js";

const args = parseArgs(process.argv.slice(2));

try {
  const maxSnapshotAgeHours =
    args["max-snapshot-age-hours"] === undefined
      ? undefined
      : positiveNumber(args["max-snapshot-age-hours"], "--max-snapshot-age-hours");
  const report = inventoryGitcrawlEvidenceMigration({
    jobsDirectory: String(args.jobs ?? path.join(repoRoot(), "jobs")),
    ...(args.archive === undefined ? {} : { archiveDirectory: String(args.archive) }),
    ...(args["gitcrawl-provider"] === undefined
      ? {}
      : { provider: provider(String(args["gitcrawl-provider"])) }),
    ...(args.db === undefined ? {} : { dbPath: String(args.db) }),
    ...(args["cloud-url"] === undefined ? {} : { cloudUrl: String(args["cloud-url"]) }),
    ...(args["cloud-archive"] === undefined ? {} : { cloudArchive: String(args["cloud-archive"]) }),
    ...(maxSnapshotAgeHours === undefined ? {} : { maxSnapshotAgeHours }),
    allowLegacyLocal: args["allow-legacy-local"] === true,
    writerExcluded: args["writer-excluded"] === true,
  });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (args["write-manifest"] !== undefined) {
    const manifestPath = path.resolve(String(args["write-manifest"]));
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, rendered, { mode: 0o600 });
  }
  process.stdout.write(rendered);
  const replacementBlocked =
    args["require-replacements"] === true &&
    (report.invalid_jobs.length > 0 || report.legacy_jobs.some((entry) => !entry.ready_to_archive));
  const cleanBlocked =
    args["require-clean"] === true &&
    (report.invalid_jobs.length > 0 || report.legacy_jobs.length > 0);
  if (replacementBlocked || cleanBlocked) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function provider(value: string): "local" | "cloud" | "parity" {
  if (value === "local" || value === "cloud" || value === "parity") return value;
  throw new Error("--gitcrawl-provider must be local, cloud, or parity");
}

function positiveNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}
