#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  GitcrawlEvidenceAdapter,
  type GitcrawlReviewContext,
  type GitcrawlReviewFile,
  type GitcrawlThreadEvidence,
  gitcrawlEvidenceOptionsFromArgs,
} from "./gitcrawl-evidence-adapter.js";
import { type GitcrawlEvidenceClaim, sha256Canonical } from "./gitcrawl-evidence-contract.js";
import {
  buildGitcrawlEvidencePacket,
  renderGitcrawlEvidencePacket,
  verifyGitcrawlEvidenceJobTargets,
} from "./gitcrawl-evidence-graph.js";
import { beginGitcrawlActionLedger, type GitcrawlActionLedger } from "./gitcrawl-action-ledger.js";
import {
  compatibleGitcrawlScanCursor,
  readGitcrawlScanCursor,
  writeGitcrawlScanOffset,
} from "./gitcrawl-scan-cursor.js";
import { publishGitcrawlGeneratedJob } from "./gitcrawl-job-publication.js";
import {
  assertGitcrawlThreadSafetyProjectionMatches,
  stripGitcrawlHtmlComments,
} from "./gitcrawl-evidence-policy.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import { parseArgs, parseSimpleYaml, repoRoot } from "./lib.js";
import { flushRepairActionEvents, repairActionLedgerRoot } from "./repair-action-ledger.js";

type Candidate = {
  number: number;
  ref: string;
  title: string;
  author: string;
  authorAssociation: string | null;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  files: string[];
  fileCount: number;
  filesOmitted: number;
  labels: string[];
  score: number;
  signals: string[];
  blockers: string[];
  bodyExcerpt: string;
};

type CandidateEvidence = {
  candidate: Candidate;
  claims: GitcrawlEvidenceClaim[];
  queryEventId: string | null;
};

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? "openclaw/openclaw");
const outDir = path.resolve(
  String(args.out ?? path.join(repoRoot(), "jobs", repo.split("/")[0] ?? "unknown", "inbox")),
);
const mode = String(args.mode ?? "autonomous");
const limit = numberArg("limit", 20);
const batchSize = numberArg("batch-size", 5);
const queryConcurrency = numberArg("query-concurrency", 4);
const scanLimit = numberArg("scan-limit", Math.max(limit * 10, 200));
const minScore = numberArg("min-score", 2);
const maxFiles = numberArg("max-files", 120);
const sort = String(args.sort ?? "stale");
const skipExisting = args["skip-existing"] !== "false";
const dryRun = Boolean(args["dry-run"]);
const jsonOutput = Boolean(args.json);

if (!["plan", "execute", "autonomous"].includes(mode)) {
  console.error("mode must be plan, execute, or autonomous");
  process.exit(2);
}
if (!["stale", "recent", "score"].includes(sort)) {
  console.error("sort must be stale, recent, or score");
  process.exit(2);
}
if (scanLimit < limit) {
  console.error("--scan-limit must be greater than or equal to --limit");
  process.exit(2);
}

let commandError: unknown = null;
try {
  await main();
} catch (error) {
  commandError = error;
}
try {
  await flushRepairActionEvents();
} catch (error) {
  if (commandError) {
    console.error(
      `[action-ledger] failed to finalize Gitcrawl low-signal evidence after importer failure: ${errorText(error)}`,
    );
  } else {
    commandError = error;
  }
}
if (commandError) {
  console.error(errorText(commandError));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const adapter = await GitcrawlEvidenceAdapter.open(
    gitcrawlEvidenceOptionsFromArgs({
      repository: repo,
      repoRoot: repoRoot(),
      args,
    }),
  );
  const actionLedger = beginGitcrawlActionLedger(repairActionLedgerRoot(), {
    repository: repo,
    consumer: "low_signal_intake",
    provider: adapter.provider,
    snapshotId: adapter.snapshotId,
    ...(adapter.paritySnapshotId === undefined
      ? {}
      : { paritySnapshotId: adapter.paritySnapshotId }),
    coverage: adapter.coverage,
  });
  let actionPhaseSeq = 10;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const existing = skipExisting ? existingLowSignalRefs(outDir) : new Set<string>();
    const cursorKey = lowSignalScanCursorKey(adapter);
    const storedCursor = skipExisting ? readGitcrawlScanCursor(outDir, cursorKey) : undefined;
    const resume = compatibleGitcrawlScanCursor(
      storedCursor,
      adapter.archive,
      adapter.snapshotId,
      adapter.parityArchive,
      adapter.paritySnapshotId,
    );
    let scanOffset = resume?.offset ?? 0;
    let search = await adapter.searchOpenPullRequestsWindow({
      offset: scanOffset,
      maxRows: scanLimit,
      order: sort === "stale" ? "oldest" : "newest",
      ...(resume === undefined ? {} : { resume }),
    });
    let restarted = false;
    if (search.rows.length === 0 && search.exhausted && scanOffset > 0) {
      restarted = true;
      scanOffset = 0;
      search = await adapter.searchOpenPullRequestsWindow({
        offset: 0,
        maxRows: scanLimit,
        order: sort === "stale" ? "oldest" : "newest",
      });
    }
    const searchQueryEvent = actionLedger.recordQuery({
      queryName: "gitcrawl.threads.search",
      phaseSeq: actionPhaseSeq++,
      identity: {
        order: sort === "stale" ? "oldest" : "newest",
        scanOffset,
        scanLimit,
        restarted,
      },
      rowCount: search.rows.length,
      claims: search.claims,
      subject: {
        repository: repo,
        kind: "repository",
      },
    });
    const searchClaims = new Map(
      search.claims.map((claim) => [(claim.data as GitcrawlThreadEvidence).number, claim]),
    );
    for (const row of search.rows) assertLowSignalSafetyContract(row);
    const eligibleRows = search.rows
      .filter((row) => !existing.has(`#${row.number}`))
      .filter((row) => !preReviewBlocked(row))
      .sort(compareSearchRows);
    const hydrated = await mapConcurrent(eligibleRows, queryConcurrency, async (row) => {
      const review = await adapter.reviewContext(row.number);
      const context = review.rows.find(isReviewContext);
      if (context === undefined) {
        throw new Error(`Gitcrawl review context for #${row.number} is missing PR details`);
      }
      const searchClaim = searchClaims.get(row.number);
      return {
        candidate: scoreCandidate(row, context),
        claims: [...(searchClaim === undefined ? [] : [searchClaim]), ...review.claims],
        reviewClaims: review.claims,
        reviewRowCount: review.rows.length,
      };
    });
    const hydratedWithEvents: CandidateEvidence[] = hydrated.map((item) => ({
      candidate: item.candidate,
      claims: item.claims,
      queryEventId:
        actionLedger.recordQuery({
          queryName: "gitcrawl.pull_requests.review_context",
          phaseSeq: actionPhaseSeq++,
          identity: { number: item.candidate.number },
          rowCount: item.reviewRowCount,
          claims: item.reviewClaims,
          subject: {
            repository: repo,
            kind: "pull_request",
            number: item.candidate.number,
          },
          parentEventId: searchQueryEvent?.event_id ?? actionLedger.snapshotEventId,
        })?.event_id ?? null,
    }));
    const qualified = hydratedWithEvents
      .filter((item) => item.candidate.score >= minScore)
      .filter((item) => item.candidate.fileCount <= maxFiles)
      .sort((left, right) => compareCandidates(left.candidate, right.candidate));
    const candidates = qualified.slice(0, limit);
    const batches: CandidateEvidence[][] = [];
    for (let index = 0; index < candidates.length; index += batchSize) {
      batches.push(candidates.slice(index, index + batchSize));
    }

    const generated = batches.map((batch, index) =>
      writeJob(actionLedger, adapter, batch, index + 1, actionPhaseSeq++),
    );
    const preservesMonotonicProgress =
      !restarted ||
      storedCursor === undefined ||
      storedCursor.snapshotId !== adapter.snapshotId ||
      search.nextOffset === 0 ||
      search.nextOffset > storedCursor.offset;
    if (skipExisting && !dryRun && qualified.length <= limit && preservesMonotonicProgress) {
      if (search.nextOffset > 0 && search.lastOrderKey === undefined) {
        throw new Error("Gitcrawl pull request scan did not return a stable order boundary");
      }
      writeGitcrawlScanOffset({
        directory: outDir,
        key: cursorKey,
        offset: search.nextOffset,
        archive: adapter.archive,
        snapshotId: adapter.snapshotId,
        providerCursor: search.nextProviderCursor,
        querySha256: search.querySha256,
        ...(adapter.parityArchive === undefined ? {} : { parityArchive: adapter.parityArchive }),
        ...(adapter.paritySnapshotId === undefined
          ? {}
          : { paritySnapshotId: adapter.paritySnapshotId }),
        ...(search.parityNextProviderCursor === undefined
          ? {}
          : { parityProviderCursor: search.parityNextProviderCursor }),
        ...(search.nextOffset === 0 || search.lastOrderKey === undefined
          ? {}
          : { orderKey: search.lastOrderKey }),
        ...(storedCursor === undefined ? {} : { expected: storedCursor }),
      });
    }

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            provider: adapter.provider,
            snapshot_id: adapter.snapshotId,
            generated,
            candidates: candidates.map((item) => item.candidate),
          },
          null,
          2,
        ),
      );
    } else {
      for (const item of generated) console.log(item.path);
    }
  } finally {
    await adapter.close();
  }
}

function lowSignalScanCursorKey(adapter: GitcrawlEvidenceAdapter): string {
  return [
    `low-signal:${adapter.provider}:${repo}`,
    `source=${sourceIdentityDigest(adapter)}`,
    `sort=${sort}`,
    `min-score=${minScore}`,
    `max-files=${maxFiles}`,
    "policy=v1",
  ].join(":");
}

function sourceIdentityDigest(adapter: GitcrawlEvidenceAdapter): string {
  return sha256Canonical({
    archive: adapter.archive,
    parity_archive: adapter.parityArchive ?? null,
  }).slice(0, 16);
}

function scoreCandidate(
  searchRow: GitcrawlThreadEvidence,
  context: GitcrawlReviewContext,
): Candidate {
  assertGitcrawlThreadSafetyProjectionMatches(searchRow, context.thread);
  const thread = context.thread;
  const labels = displayNames(thread.labels);
  const assignees = displayNames(thread.assignees);
  const files = context.files.map((file) => file.path);
  const filesComplete = context.filesOmitted === 0;
  const title = thread.title;
  const body = thread.body;
  const signals: string[] = [];
  const blockers: string[] = [];

  if (isMaintainerAssociated(thread.authorAssociation)) {
    blockers.push(`author association is ${thread.authorAssociation}`);
  }
  if (thread.authorAssociation === undefined) {
    blockers.push("author association unavailable in Gitcrawl snapshot");
  }
  if (!thread.securityMetadataComplete) {
    blockers.push("security metadata incomplete in Gitcrawl snapshot");
  }
  if (thread.labels === undefined) blockers.push("labels unavailable in Gitcrawl snapshot");
  if (thread.assignees === undefined) blockers.push("assignees unavailable in Gitcrawl snapshot");
  if (assignees.length > 0) blockers.push("assigned PR");
  if (thread.securitySensitive) {
    blockers.push("security-sensitive text or labels");
  }

  addSignal(signals, thread.policySignals.blankTemplate, "blank_template");
  addSignal(signals, docsOnlySignal(title, files, filesComplete), "docs_only");
  addSignal(signals, testsOnlySignal(title, files, filesComplete), "test_only");
  addSignal(
    signals,
    refactorOnlySignal(title, thread.policySignals.issueReference, files, context.changedFiles),
    "refactor_or_cleanup",
  );
  addSignal(
    signals,
    thirdPartyCoreSignal(thread.policySignals.thirdPartyCapability, files),
    "third_party_or_external_capability",
  );
  addSignal(signals, riskyInfraSignal(title, files), "risky_infra");
  addSignal(signals, dirtyBranchSignal(files, context.changedFiles), "dirty_branch");

  const hasConcreteFix = thread.policySignals.concreteFix;
  if (hasConcreteFix && signals.length === 1 && signals[0] !== "blank_template") {
    blockers.push("possible focused fix needs human review");
  }

  return {
    number: thread.number,
    ref: `#${thread.number}`,
    title,
    author: thread.authorLogin,
    authorAssociation: thread.authorAssociation ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt || context.detailsUpdatedAt || context.detailsFetchedAt,
    isDraft: thread.isDraft,
    files,
    fileCount: context.changedFiles,
    filesOmitted: context.filesOmitted,
    labels,
    score: blockers.length > 0 ? 0 : signals.length,
    signals,
    blockers,
    bodyExcerpt: excerpt(stripGitcrawlHtmlComments(body)),
  };
}

function preReviewBlocked(thread: GitcrawlThreadEvidence): boolean {
  if (isMaintainerAssociated(thread.authorAssociation)) return true;
  if (displayNames(thread.assignees ?? []).length > 0) return true;
  return thread.securitySensitive;
}

function assertLowSignalSafetyContract(thread: GitcrawlThreadEvidence): void {
  if (thread.authorAssociation === undefined) {
    throw new Error(
      `Gitcrawl low-signal intake requires author association evidence for #${thread.number}`,
    );
  }
  if (!thread.securityMetadataComplete || thread.labels === undefined) {
    throw new Error(
      `Gitcrawl low-signal intake requires complete title, body, and label evidence for #${thread.number}`,
    );
  }
  if (thread.assignees === undefined) {
    throw new Error(`Gitcrawl low-signal intake requires assignee evidence for #${thread.number}`);
  }
}

function compareSearchRows(left: GitcrawlThreadEvidence, right: GitcrawlThreadEvidence): number {
  if (sort === "recent") return timestampCompare(right.updatedAt, left.updatedAt);
  if (sort === "score") {
    return (
      preliminaryScore(right) - preliminaryScore(left) ||
      timestampCompare(left.updatedAt, right.updatedAt)
    );
  }
  return timestampCompare(left.updatedAt, right.updatedAt);
}

function preliminaryScore(thread: GitcrawlThreadEvidence): number {
  return [
    thread.policySignals.blankTemplate,
    /\bdocs?\b/i.test(thread.title),
    /\btest\b/i.test(thread.title),
    /\b(refactor|cleanup|format|chore)\b/i.test(thread.title),
    thread.policySignals.thirdPartyCapability,
    /\b(ci|infra|docker|build|release|workflow)\b/i.test(thread.title),
  ].filter(Boolean).length;
}

function writeJob(
  actionLedger: GitcrawlActionLedger,
  adapter: GitcrawlEvidenceAdapter,
  batch: CandidateEvidence[],
  index: number,
  bindingPhaseSeq: number,
): { path: string; cluster_id: string; candidates: string[]; evidence_sha256: string } {
  const now = new Date();
  const generatedAt = now.toISOString();
  const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 13);
  const batchDigest = sha256Canonical(batch.map((item) => item.candidate.number)).slice(0, 12);
  const clusterId = `low-signal-pr-sweep-v1-${stamp}-${batchDigest}-${String(index).padStart(2, "0")}`;
  const filePath = path.join(outDir, `${clusterId}.md`);
  const candidates = batch.map((item) => item.candidate);
  const packet = buildGitcrawlEvidencePacket({
    provider: adapter.provider,
    repository: adapter.repository,
    snapshotId: adapter.snapshotId,
    ...(adapter.paritySnapshotId === undefined
      ? {}
      : { paritySnapshotId: adapter.paritySnapshotId }),
    coverage: adapter.coverage,
    requiredCoverage: adapter.requiredCoverageFor(
      "gitcrawl.threads.search",
      "gitcrawl.pull_requests.review_context",
    ),
    claims: batch.flatMap((item) => item.claims),
    generatedAt,
  });
  const candidateRefs = candidates.map((candidate) => candidate.ref);
  verifyGitcrawlEvidenceJobTargets(packet, {
    repo,
    canonical: [],
    candidates: candidateRefs,
    cluster_refs: candidateRefs,
  });
  const markdown = [
    "---",
    `repo: ${repo}`,
    `cluster_id: ${clusterId}`,
    `mode: ${mode}`,
    renderJobIntentFrontmatter("low_signal_pr_cleanup"),
    "gitcrawl_evidence_schema: gitcrawl-evidence-job-v1",
    "gitcrawl_evidence_required: true",
    "triage_policy: low_signal_prs",
    "allowed_actions:",
    "  - comment",
    "  - close",
    "blocked_actions:",
    "  - force_push",
    "  - bypass_checks",
    "  - merge",
    "  - fix",
    "  - label",
    "require_human_for:",
    "  - security_sensitive",
    "  - maintainer_signal",
    "  - active_author_followup",
    "  - focused_bug_fix",
    "  - green_checks",
    "  - technical_correctness_judgment",
    "canonical: []",
    "candidates:",
    ...yamlList(candidateRefs),
    "cluster_refs:",
    ...yamlList(candidateRefs),
    "security_policy: central_security_only",
    "security_sensitive: false",
    "allow_instant_close: false",
    "allow_low_signal_pr_close: true",
    "allow_fix_pr: false",
    "allow_merge: false",
    "allow_post_merge_close: false",
    `canonical_hint: ${quoteYaml("No canonical is needed; this is an opt-in low-signal PR cleanup sweep.")}`,
    `notes: ${quoteYaml(`Generated from coverage-checked Gitcrawl ${adapter.provider} snapshot ${adapter.snapshotId} at ${generatedAt}.`)}`,
    "---",
    "",
    `# Low-Signal PR Sweep ${index}`,
    "",
    "Use `instructions/low-signal-prs.md`. This job is not a dedupe cluster.",
    "",
    "## Goal",
    "",
    'Review only the listed open pull requests. Emit `close_low_signal` with `classification: "low_signal"` only when the PR is boringly clear under the low-signal policy and live GitHub state still has no maintainer signal. Otherwise emit `needs_human`, `keep_related`, or `keep_independent`.',
    "",
    "The deterministic applicator will re-fetch live state, reject non-PRs, reject maintainer-authored/reviewed/commented/assigned PRs, and close only planned `close_low_signal` actions.",
    "",
    "## Gitcrawl Candidate Signals",
    "",
    ...candidates.flatMap(candidateBlock),
    "",
    ...renderGitcrawlEvidencePacket(packet),
  ].join("\n");

  const recordPath = path.relative(repoRoot(), filePath);
  const durableRecordPath = repositoryRelativePath(recordPath);
  if (!dryRun) {
    publishGitcrawlGeneratedJob(filePath, markdown);
    actionLedger.recordBinding({
      phaseSeq: bindingPhaseSeq,
      identity: { clusterId },
      packet,
      ...(durableRecordPath === undefined ? {} : { recordPath: durableRecordPath }),
      itemCount: candidates.length,
      subject: {
        repository: repo,
        kind: "cluster",
        clusterId,
      },
      parentEventId:
        [...batch].reverse().find((item) => item.queryEventId !== null)?.queryEventId ??
        actionLedger.snapshotEventId,
    });
  }
  return {
    path: recordPath,
    cluster_id: clusterId,
    candidates: candidates.map((candidate) => candidate.ref),
    evidence_sha256: packet.sha256,
  };
}

function repositoryRelativePath(filePath: string): string | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)
    ? undefined
    : normalized;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function candidateBlock(candidate: Candidate): string[] {
  return [
    `### ${candidate.ref} ${candidate.title}`,
    "",
    `- author: ${candidate.author}`,
    `- author association: ${candidate.authorAssociation ?? "unavailable; verify live"}`,
    `- updated: ${candidate.updatedAt}`,
    `- score: ${candidate.score}`,
    `- signals: ${candidate.signals.join(", ")}`,
    `- files: ${candidate.fileCount}`,
    `- body excerpt: ${candidate.bodyExcerpt || "none"}`,
    `- changed files: ${candidate.files.slice(0, 18).join(", ") || "none"}${candidate.filesOmitted > 0 ? ` (${candidate.filesOmitted} omitted from bounded context)` : ""}`,
    "",
  ];
}

function existingLowSignalRefs(outputDirectory: string): Set<string> {
  const refs = new Set<string>();
  const directories = new Set([path.join(repoRoot(), "jobs"), outputDirectory]);
  for (const jobsDir of directories) {
    if (!fs.existsSync(jobsDir)) continue;
    for (const entry of fs.readdirSync(jobsDir, { recursive: true })) {
      const file = path.join(jobsDir, String(entry));
      if (file.split(path.sep).includes(".legacy-gitcrawl-quarantine")) continue;
      if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/^---\n([\s\S]*?)\n---/);
      if (!match?.[1]) continue;
      const frontmatter = parseSimpleYaml(match[1]);
      if (frontmatter.triage_policy !== "low_signal_prs") continue;
      for (const key of ["candidates", "cluster_refs"]) {
        const values = frontmatter[key];
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          const ref = String(value);
          if (/^#\d+$/.test(ref)) refs.add(ref);
        }
      }
    }
  }
  return refs;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (sort === "score") return right.score - left.score || staleCompare(left, right);
  if (sort === "recent") return timestampCompare(right.updatedAt, left.updatedAt);
  return staleCompare(left, right);
}

function staleCompare(left: Candidate, right: Candidate): number {
  return timestampCompare(left.updatedAt, right.updatedAt);
}

function timestampCompare(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function docsOnlySignal(title: string, files: string[], complete: boolean): boolean {
  return (
    complete &&
    /\bdocs?\b/i.test(title) &&
    files.length > 0 &&
    files.every((file) => isDocsPath(file))
  );
}

function testsOnlySignal(title: string, files: string[], complete: boolean): boolean {
  return (
    complete &&
    /\btest\b/i.test(title) &&
    files.length > 0 &&
    files.every((file) => isTestPath(file))
  );
}

function refactorOnlySignal(
  title: string,
  issueReference: boolean,
  files: string[],
  fileCount: number,
): boolean {
  return (
    /\b(refactor|cleanup|format|chore)\b/i.test(title) &&
    !issueReference &&
    files.length > 0 &&
    fileCount > 0
  );
}

function thirdPartyCoreSignal(policySignal: boolean, files: string[]): boolean {
  return policySignal || files.some((file) => file.startsWith("apps/linux/"));
}

function riskyInfraSignal(title: string, files: string[]): boolean {
  return (
    /\b(ci|infra|docker|build|release|workflow)\b/i.test(title) &&
    files.some((file) =>
      /^\.github\/|^Dockerfile|^scripts\/|^fly\.|^render\.|^docker-compose/.test(file),
    )
  );
}

function dirtyBranchSignal(files: string[], fileCount: number): boolean {
  if (fileCount < 12) return false;
  const topLevels = new Set(files.map((file) => file.split("/")[0]));
  return (
    topLevels.size >= 4 ||
    (files.some((file) => file.includes(".generated")) && topLevels.size >= 2)
  );
}

function isDocsPath(file: string): boolean {
  return /(^docs\/|^README|\.md$|\.mdx$|^skills\/|^\.github\/ISSUE_TEMPLATE)/.test(file);
}

function isTestPath(file: string): boolean {
  return /(\.test\.|\.spec\.|__tests__|^test\/|^test-fixtures\/)/.test(file);
}

function isMaintainerAssociated(value: string | undefined): boolean {
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(value ?? "").toUpperCase());
}

function addSignal(signals: string[], enabled: boolean, name: string): void {
  if (enabled) signals.push(name);
}

function displayNames(values: unknown[] | undefined): string[] {
  if (values === undefined) return [];
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return String(record.name ?? record.login ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

function isReviewContext(
  value: GitcrawlReviewContext | GitcrawlReviewFile,
): value is GitcrawlReviewContext {
  return "thread" in value;
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = Array.from({ length: values.length }) as U[];
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        if (failed) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        try {
          output[index] = await worker(values[index]!);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          return;
        }
      }
    }),
  );
  if (failed) throw firstError;
  return output;
}

function numberArg(name: string, fallback: number): number {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function yamlList(values: string[]): string[] {
  if (values.length === 0) return ["  []"];
  return values.map((value) => `  - ${quoteYaml(value)}`);
}

function quoteYaml(value: unknown): string {
  return JSON.stringify(String(value));
}

function excerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
