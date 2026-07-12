#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACTION_EVENT_PHASE_TYPES,
  readActionEventShard,
  type ActionEvent,
} from "../action-ledger.js";
import { assertSha256, sha256Canonical } from "./gitcrawl-evidence-contract.js";
import { verifyEmbeddedGitcrawlEvidencePacket } from "./gitcrawl-evidence-graph.js";

const LEGACY_GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA =
  "clawsweeper-gitcrawl-publication-transaction-v1";
export const GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA =
  "clawsweeper-gitcrawl-publication-transaction-v2";
export const GITCRAWL_DISPATCH_RECEIPT_SCHEMA = "clawsweeper-gitcrawl-dispatch-receipt-v1";

export type GitcrawlPublicationTransaction = {
  schema: typeof GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA;
  run_id: string;
  run_attempt: string;
  generated_jobs: Array<{
    path: string;
    packet_sha256: string;
    binding_event_id: string;
    dispatch_key: string;
  }>;
  action_event_shards: string[];
  cursor_path?: string;
  intake_path?: string;
  publish_paths: string[];
};

export type PendingGitcrawlDispatch = {
  transaction_path: string;
  job_path: string;
  packet_sha256: string;
  binding_event_id: string;
  dispatch_key: string;
  receipt_path: string;
};

export type GitcrawlDispatchReceipt = {
  schema: typeof GITCRAWL_DISPATCH_RECEIPT_SCHEMA;
  transaction_path: string;
  job_path: string;
  packet_sha256: string;
  binding_event_id: string;
  dispatch_key: string;
  dispatched_at: string;
  run_id: string;
  run_attempt: string;
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
      dispatch_key: gitcrawlDispatchKey({
        path: generatedPath,
        packetSha256: packet.sha256,
        bindingEventId: binding.bindingEventId,
      }),
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

export function listPendingGitcrawlDispatches(input: {
  root: string;
  transactionsDirectory: string;
  receiptsDirectory: string;
}): PendingGitcrawlDispatch[] {
  const root = fs.realpathSync(input.root);
  const transactionsDirectory = safeRelativePath(
    input.transactionsDirectory,
    "Gitcrawl transactions directory",
  );
  const receiptsDirectory = safeRelativePath(
    input.receiptsDirectory,
    "Gitcrawl dispatch receipts directory",
  );
  const absoluteTransactions = path.resolve(root, transactionsDirectory);
  if (!insideRoot(root, absoluteTransactions)) {
    throw new Error("Gitcrawl transactions directory escapes the publication root");
  }
  if (!fs.existsSync(absoluteTransactions)) return [];
  if (!fs.lstatSync(absoluteTransactions).isDirectory()) {
    throw new Error("Gitcrawl transactions path is not a directory");
  }

  const pending: PendingGitcrawlDispatch[] = [];
  for (const entry of fs.readdirSync(absoluteTransactions, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const transactionPath = path.posix.join(transactionsDirectory, entry.name);
    const transaction = readPublicationTransaction(root, transactionPath);
    if (transaction === undefined) continue;
    for (const job of transaction.generated_jobs) {
      const receiptPath = gitcrawlDispatchReceiptPath(receiptsDirectory, job.dispatch_key);
      const expected = {
        transaction_path: transactionPath,
        job_path: job.path,
        packet_sha256: job.packet_sha256,
        binding_event_id: job.binding_event_id,
        dispatch_key: job.dispatch_key,
      };
      if (fs.existsSync(path.resolve(root, receiptPath))) {
        assertDispatchReceipt(root, receiptPath, expected);
        continue;
      }
      verifyTransactionJob(root, job);
      pending.push({ ...expected, receipt_path: receiptPath });
    }
  }
  return pending.sort((left, right) =>
    `${left.transaction_path}:${left.job_path}`.localeCompare(
      `${right.transaction_path}:${right.job_path}`,
    ),
  );
}

export function recordGitcrawlDispatchReceipt(input: {
  root: string;
  transactionPath: string;
  jobPath: string;
  dispatchKey: string;
  receiptsDirectory: string;
  runId?: string;
  runAttempt?: string;
  dispatchedAt?: string;
}): { path: string; receipt: GitcrawlDispatchReceipt } {
  const root = fs.realpathSync(input.root);
  const transactionPath = safeRelativePath(input.transactionPath, "Gitcrawl transaction manifest");
  const transaction = readPublicationTransaction(root, transactionPath);
  if (transaction === undefined) {
    throw new Error("legacy Gitcrawl publication transactions cannot accept dispatch receipts");
  }
  const jobPath = safeRelativePath(input.jobPath, "Gitcrawl dispatch job");
  const job = transaction.generated_jobs.find((candidate) => candidate.path === jobPath);
  if (!job || job.dispatch_key !== input.dispatchKey) {
    throw new Error("Gitcrawl dispatch receipt does not match its transaction job");
  }
  verifyTransactionJob(root, job);
  const receiptsDirectory = safeRelativePath(
    input.receiptsDirectory,
    "Gitcrawl dispatch receipts directory",
  );
  const receiptPath = gitcrawlDispatchReceiptPath(receiptsDirectory, job.dispatch_key);
  const identity = {
    transaction_path: transactionPath,
    job_path: job.path,
    packet_sha256: job.packet_sha256,
    binding_event_id: job.binding_event_id,
    dispatch_key: job.dispatch_key,
  };
  if (fs.existsSync(path.resolve(root, receiptPath))) {
    return {
      path: receiptPath,
      receipt: assertDispatchReceipt(root, receiptPath, identity),
    };
  }
  const receipt: GitcrawlDispatchReceipt = {
    schema: GITCRAWL_DISPATCH_RECEIPT_SCHEMA,
    ...identity,
    dispatched_at: input.dispatchedAt ?? new Date().toISOString(),
    run_id: input.runId ?? "",
    run_attempt: input.runAttempt ?? "",
  };
  writeJsonAtomic(root, receiptPath, receipt, true);
  return { path: receiptPath, receipt };
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

function readPublicationTransaction(
  root: string,
  transactionPath: string,
): GitcrawlPublicationTransaction | undefined {
  const absolutePath = existingRegularFile(root, transactionPath, "Gitcrawl transaction manifest");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    throw new Error(`Gitcrawl transaction manifest is malformed: ${transactionPath}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Gitcrawl transaction manifest is malformed: ${transactionPath}`);
  }
  const record = value as Record<string, unknown>;
  if (record.schema === LEGACY_GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA) return undefined;
  if (record.schema !== GITCRAWL_PUBLICATION_TRANSACTION_SCHEMA) {
    throw new Error(
      `unsupported Gitcrawl publication transaction schema: ${String(record.schema)}`,
    );
  }
  if (!Array.isArray(record.generated_jobs)) {
    throw new Error(`Gitcrawl transaction manifest has no generated jobs: ${transactionPath}`);
  }
  for (const candidate of record.generated_jobs) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Gitcrawl transaction manifest has a malformed job: ${transactionPath}`);
    }
    const job = candidate as Record<string, unknown>;
    safeRelativePath(String(job.path ?? ""), "Gitcrawl generated job");
    assertSha256(String(job.packet_sha256 ?? ""), "Gitcrawl transaction packet sha256");
    if (!String(job.binding_event_id ?? "").trim()) {
      throw new Error(`Gitcrawl transaction binding event id is missing: ${transactionPath}`);
    }
    assertDispatchKey(String(job.dispatch_key ?? ""));
    const expectedKey = gitcrawlDispatchKey({
      path: String(job.path),
      packetSha256: String(job.packet_sha256),
      bindingEventId: String(job.binding_event_id),
    });
    if (job.dispatch_key !== expectedKey) {
      throw new Error(`Gitcrawl transaction dispatch key mismatch: ${transactionPath}`);
    }
  }
  return value as GitcrawlPublicationTransaction;
}

function verifyTransactionJob(
  root: string,
  job: GitcrawlPublicationTransaction["generated_jobs"][number],
): void {
  const absolutePath = existingRegularFile(root, job.path, "Gitcrawl generated job");
  const packet = verifyEmbeddedGitcrawlEvidencePacket(
    fs.readFileSync(absolutePath, "utf8"),
    undefined,
    true,
  )!;
  if (packet.sha256 !== job.packet_sha256) {
    throw new Error(`Gitcrawl transaction packet digest does not match job: ${job.path}`);
  }
}

function gitcrawlDispatchKey(input: {
  path: string;
  packetSha256: string;
  bindingEventId: string;
}): string {
  return `gitcrawl-${sha256Canonical({
    path: input.path,
    packet_sha256: input.packetSha256,
    binding_event_id: input.bindingEventId,
  })}`;
}

function gitcrawlDispatchReceiptPath(receiptsDirectory: string, dispatchKey: string): string {
  assertDispatchKey(dispatchKey);
  return path.posix.join(receiptsDirectory, `${dispatchKey}.json`);
}

function assertDispatchKey(value: string): void {
  if (!/^gitcrawl-[a-f0-9]{64}$/.test(value)) {
    throw new Error("Gitcrawl dispatch key is malformed");
  }
}

function assertDispatchReceipt(
  root: string,
  receiptPath: string,
  expected: Omit<GitcrawlDispatchReceipt, "schema" | "dispatched_at" | "run_id" | "run_attempt">,
): GitcrawlDispatchReceipt {
  const absolutePath = existingRegularFile(root, receiptPath, "Gitcrawl dispatch receipt");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    throw new Error(`Gitcrawl dispatch receipt is malformed: ${receiptPath}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Gitcrawl dispatch receipt is malformed: ${receiptPath}`);
  }
  const receipt = value as GitcrawlDispatchReceipt;
  if (
    receipt.schema !== GITCRAWL_DISPATCH_RECEIPT_SCHEMA ||
    receipt.transaction_path !== expected.transaction_path ||
    receipt.job_path !== expected.job_path ||
    receipt.packet_sha256 !== expected.packet_sha256 ||
    receipt.binding_event_id !== expected.binding_event_id ||
    receipt.dispatch_key !== expected.dispatch_key ||
    typeof receipt.dispatched_at !== "string" ||
    typeof receipt.run_id !== "string" ||
    typeof receipt.run_attempt !== "string"
  ) {
    throw new Error(`Gitcrawl dispatch receipt identity mismatch: ${receiptPath}`);
  }
  return receipt;
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
  value: GitcrawlPublicationTransaction | GitcrawlDispatchReceipt,
  noClobber = false,
): void {
  const destination = path.resolve(root, relativePath);
  if (!insideRoot(root, destination)) {
    throw new Error(`Gitcrawl transaction manifest escapes the publication root: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    if (noClobber) fs.linkSync(temporary, destination);
    else fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const command = argv[0]?.startsWith("--") || argv[0] === undefined ? "prepare" : argv.shift()!;
  const args = parseArgs(argv);
  const root = process.cwd();
  if (command === "pending") {
    const durableRoot = args["--root"]
      ? fs.realpathSync(path.resolve(root, requiredArg(args, "--root")))
      : root;
    const pending = listPendingGitcrawlDispatches({
      root: durableRoot,
      transactionsDirectory: requiredArg(args, "--transactions-dir"),
      receiptsDirectory: requiredArg(args, "--receipts-dir"),
    });
    writeLines(
      path.resolve(root, requiredArg(args, "--pending-file")),
      pending.map((entry) =>
        [entry.transaction_path, entry.job_path, entry.dispatch_key, entry.receipt_path].join("\t"),
      ),
    );
    console.log(JSON.stringify({ pending }));
    process.exit(0);
  }
  if (command === "receipt") {
    const result = recordGitcrawlDispatchReceipt({
      root,
      transactionPath: requiredArg(args, "--transaction"),
      jobPath: requiredArg(args, "--job"),
      dispatchKey: requiredArg(args, "--dispatch-key"),
      receiptsDirectory: requiredArg(args, "--receipts-dir"),
      ...(process.env.GITHUB_RUN_ID === undefined ? {} : { runId: process.env.GITHUB_RUN_ID }),
      ...(process.env.GITHUB_RUN_ATTEMPT === undefined
        ? {}
        : { runAttempt: process.env.GITHUB_RUN_ATTEMPT }),
    });
    const pathsFile = path.resolve(root, requiredArg(args, "--paths-file"));
    fs.mkdirSync(path.dirname(pathsFile), { recursive: true });
    fs.appendFileSync(pathsFile, `${result.path}\n`);
    console.log(JSON.stringify(result.receipt));
    process.exit(0);
  }
  if (command !== "prepare") throw new Error(`Unknown Gitcrawl publication command: ${command}`);
  const eventPaths = readPathList(path.resolve(root, requiredArg(args, "--event-paths-file")));
  const generatedPaths = readPathList(
    path.resolve(root, requiredArg(args, "--generated-paths-file")),
  );
  const transaction = prepareGitcrawlPublicationTransaction({
    root,
    eventPaths,
    generatedPaths,
    manifestPath: requiredArg(args, "--manifest"),
    ...(args.cursor === undefined ? {} : { cursorPath: args.cursor }),
    ...(args.intake === undefined ? {} : { intakePath: args.intake }),
    ...(process.env.GITHUB_RUN_ID === undefined ? {} : { runId: process.env.GITHUB_RUN_ID }),
    ...(process.env.GITHUB_RUN_ATTEMPT === undefined
      ? {}
      : { runAttempt: process.env.GITHUB_RUN_ATTEMPT }),
  });
  const pathsFile = path.resolve(root, requiredArg(args, "--paths-file"));
  fs.mkdirSync(path.dirname(pathsFile), { recursive: true });
  fs.writeFileSync(pathsFile, `${transaction.publish_paths.join("\n")}\n`);
  console.log(JSON.stringify(transaction));
}

function writeLines(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

function readPathList(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseArgs(argv: readonly string[]): Record<string, string> & {
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
  const parsed = Object.fromEntries(values) as Record<string, string> & {
    eventPathsFile: string;
    generatedPathsFile: string;
    manifest: string;
    pathsFile: string;
    cursor?: string;
    intake?: string;
  };
  parsed.eventPathsFile = values.get("--event-paths-file") ?? "";
  parsed.generatedPathsFile = values.get("--generated-paths-file") ?? "";
  parsed.manifest = values.get("--manifest") ?? "";
  parsed.pathsFile = values.get("--paths-file") ?? "";
  if (values.has("--cursor")) parsed.cursor = values.get("--cursor")!;
  if (values.has("--intake")) parsed.intake = values.get("--intake")!;
  return parsed;
}

function requiredArg(args: Record<string, string>, flag: string): string {
  const value = args[flag];
  if (!value) throw new Error(`${flag} is required`);
  return value;
}
