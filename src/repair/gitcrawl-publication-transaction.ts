#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACTION_EVENT_PHASE_TYPES,
  readActionEventShard,
  type ActionEvent,
} from "../action-ledger.js";
import { verifyEmbeddedGitcrawlEvidencePacket } from "./gitcrawl-evidence-graph.js";

export const GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA =
  "clawsweeper-gitcrawl-publication-transaction-v1";

export type GitcrawlPublicationTransaction = {
  schema: typeof GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA;
  run_id: string;
  run_attempt: string;
  generated_jobs: Array<{
    path: string;
    packet_sha256: string;
    binding_event_id: string;
  }>;
  action_event_shards: string[];
  cursor_path?: string;
  intake_path?: string;
  publish_paths: string[];
};

export function prepareGitcrawlPublicationTransaction(input: {
  root: string;
  eventPaths: readonly string[];
  generatedPaths: readonly string[];
  manifestPath: string;
  cursorPath?: string;
  intakePath?: string;
  runId?: string;
  runAttempt?: string;
}): GitcrawlPublicationTransaction {
  const root = fs.realpathSync(input.root);
  const eventPaths = uniqueSorted(
    input.eventPaths.map((value) => safeRelativePath(value, "action event shard")),
  );
  const generatedPaths = uniqueSorted(
    input.generatedPaths.map((value) => safeRelativePath(value, "generated job")),
  );
  for (const generatedPath of generatedPaths) {
    if (!generatedPath.startsWith("jobs/")) {
      throw new Error(`Gitcrawl generated job is outside jobs/: ${generatedPath}`);
    }
  }

  const bindings = new Map<
    string,
    { path: string; packetSha256: string; bindingEventId: string }
  >();
  for (const eventPath of eventPaths) {
    const shardPath = existingRegularFile(root, eventPath, "Gitcrawl action event shard");
    for (const event of readActionEventShard(shardPath)) {
      if (event.event_type !== ACTION_EVENT_PHASE_TYPES.gitcrawlBinding) continue;
      const binding = bindingFromEvent(event);
      const previous = bindings.get(binding.path);
      if (
        previous &&
        (previous.packetSha256 !== binding.packetSha256 ||
          previous.bindingEventId !== binding.bindingEventId)
      ) {
        throw new Error(`Gitcrawl job has conflicting binding events: ${binding.path}`);
      }
      bindings.set(binding.path, binding);
    }
  }

  const bindingPaths = uniqueSorted(bindings.keys());
  if (JSON.stringify(generatedPaths) !== JSON.stringify(bindingPaths)) {
    throw new Error(
      `Gitcrawl generated jobs do not exactly match binding events: generated=${generatedPaths.length} bindings=${bindingPaths.length}`,
    );
  }

  const generatedJobs = generatedPaths.map((generatedPath) => {
    const binding = bindings.get(generatedPath)!;
    const jobPath = existingRegularFile(root, generatedPath, "Gitcrawl generated job");
    const packet = verifyEmbeddedGitcrawlEvidencePacket(
      fs.readFileSync(jobPath, "utf8"),
      undefined,
      true,
    )!;
    if (packet.sha256 !== binding.packetSha256) {
      throw new Error(`Gitcrawl binding packet digest does not match job: ${generatedPath}`);
    }
    return {
      path: generatedPath,
      packet_sha256: packet.sha256,
      binding_event_id: binding.bindingEventId,
    };
  });

  const cursorPath = optionalExistingPath(root, input.cursorPath, "Gitcrawl scan cursor");
  const intakePath = optionalExistingPath(root, input.intakePath, "Gitcrawl intake record");
  if ((generatedJobs.length > 0 || cursorPath || intakePath) && eventPaths.length === 0) {
    throw new Error("Gitcrawl publication state exists without finalized action event shards");
  }

  const manifestPath = safeRelativePath(input.manifestPath, "Gitcrawl transaction manifest");
  const publishPaths = uniqueSorted([
    ...generatedPaths,
    ...eventPaths,
    ...(cursorPath ? [cursorPath] : []),
    ...(intakePath ? [intakePath] : []),
    manifestPath,
  ]);
  const transaction: GitcrawlPublicationTransaction = {
    schema: GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA,
    run_id: input.runId ?? "",
    run_attempt: input.runAttempt ?? "",
    generated_jobs: generatedJobs,
    action_event_shards: eventPaths,
    ...(cursorPath ? { cursor_path: cursorPath } : {}),
    ...(intakePath ? { intake_path: intakePath } : {}),
    publish_paths: publishPaths,
  };
  writeJsonAtomic(root, manifestPath, transaction);
  return transaction;
}

function bindingFromEvent(event: ActionEvent): {
  path: string;
  packetSha256: string;
  bindingEventId: string;
} {
  const packets = (event.evidence ?? []).filter(
    (entry) => entry.kind === "gitcrawl_evidence_packet",
  );
  if (packets.length !== 1) {
    throw new Error(`Gitcrawl binding event ${event.event_id} must contain one packet evidence`);
  }
  const packet = packets[0]!;
  const reportPath = safeRelativePath(
    packet.report_path ?? "",
    `Gitcrawl binding event ${event.event_id} report path`,
  );
  if (event.subject.record_path !== reportPath) {
    throw new Error(`Gitcrawl binding event ${event.event_id} has divergent record paths`);
  }
  if (!/^[a-f0-9]{64}$/.test(packet.sha256 ?? "")) {
    throw new Error(`Gitcrawl binding event ${event.event_id} has an invalid packet digest`);
  }
  return {
    path: reportPath,
    packetSha256: packet.sha256!,
    bindingEventId: event.event_id,
  };
}

function optionalExistingPath(
  root: string,
  value: string | undefined,
  label: string,
): string | undefined {
  if (!value) return undefined;
  const relativePath = safeRelativePath(value, label);
  const absolutePath = path.resolve(root, relativePath);
  if (!fs.existsSync(absolutePath)) return undefined;
  existingRegularFile(root, relativePath, label);
  return relativePath;
}

function existingRegularFile(root: string, relativePath: string, label: string): string {
  const absolutePath = path.resolve(root, relativePath);
  if (!insideRoot(root, absolutePath)) {
    throw new Error(`${label} escapes the publication root: ${relativePath}`);
  }
  const stat = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is missing or is not a regular file: ${relativePath}`);
  }
  return absolutePath;
}

function safeRelativePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    trimmed.includes("\\") ||
    path.posix.isAbsolute(trimmed) ||
    path.posix.normalize(trimmed) !== trimmed ||
    trimmed === ".." ||
    trimmed.startsWith("../")
  ) {
    throw new Error(`${label} is not a canonical repository-relative path: ${value}`);
  }
  return trimmed;
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function writeJsonAtomic(
  root: string,
  relativePath: string,
  value: GitcrawlPublicationTransaction,
): void {
  const destination = path.resolve(root, relativePath);
  if (!insideRoot(root, destination)) {
    throw new Error(`Gitcrawl transaction manifest escapes the publication root: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const eventPaths = readPathList(path.resolve(root, args.eventPathsFile));
  const generatedPaths = readPathList(path.resolve(root, args.generatedPathsFile));
  const transaction = prepareGitcrawlPublicationTransaction({
    root,
    eventPaths,
    generatedPaths,
    manifestPath: args.manifest,
    ...(args.cursor === undefined ? {} : { cursorPath: args.cursor }),
    ...(args.intake === undefined ? {} : { intakePath: args.intake }),
    ...(process.env.GITHUB_RUN_ID === undefined ? {} : { runId: process.env.GITHUB_RUN_ID }),
    ...(process.env.GITHUB_RUN_ATTEMPT === undefined
      ? {}
      : { runAttempt: process.env.GITHUB_RUN_ATTEMPT }),
  });
  fs.mkdirSync(path.dirname(path.resolve(root, args.pathsFile)), { recursive: true });
  fs.writeFileSync(path.resolve(root, args.pathsFile), `${transaction.publish_paths.join("\n")}\n`);
  console.log(JSON.stringify(transaction));
}

function readPathList(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseArgs(argv: readonly string[]): {
  eventPathsFile: string;
  generatedPathsFile: string;
  manifest: string;
  pathsFile: string;
  cursor?: string;
  intake?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    eventPathsFile: required("--event-paths-file"),
    generatedPathsFile: required("--generated-paths-file"),
    manifest: required("--manifest"),
    pathsFile: required("--paths-file"),
    ...(values.has("--cursor") ? { cursor: values.get("--cursor")! } : {}),
    ...(values.has("--intake") ? { intake: values.get("--intake")! } : {}),
  };
}
