#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  GitcrawlEvidenceAdapter,
  type GitcrawlClusterEvidence,
  type GitcrawlThreadEvidence,
  gitcrawlEvidenceOptionsFromArgs,
} from "./gitcrawl-evidence-adapter.js";
import type {
  GitcrawlClusterOrderKey,
  GitcrawlEvidenceClaim,
  GitcrawlEvidenceResumeCursor,
} from "./gitcrawl-evidence-contract.js";
import { sha256Canonical } from "./gitcrawl-evidence-contract.js";
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
import { renderJobIntentFrontmatter } from "./job-intent.js";
import { parseArgs, parseSimpleYaml, repoRoot } from "./lib.js";
import { flushRepairActionEvents, repairActionLedgerRoot } from "./repair-action-ledger.js";

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? "openclaw/openclaw");
const mode = String(args.mode ?? "plan");
if (!["plan", "execute", "autonomous"].includes(mode)) {
  console.error("mode must be plan, execute, or autonomous");
  process.exit(2);
}

const outDir = path.resolve(
  String(args.out ?? path.join(repoRoot(), "jobs", repo.split("/")[0] ?? "unknown", "inbox")),
);
const suffix = typeof args.suffix === "string" ? args.suffix : "";
const allowInstantClose = booleanArg("allow-instant-close", false);
const editEnabledByDefault = mode === "autonomous" || mode === "execute";
const allowMerge = booleanArg("allow-merge", editEnabledByDefault);
const allowFixPr = booleanArg("allow-fix-pr", editEnabledByDefault);
const allowPostMergeClose = booleanArg("allow-post-merge-close", allowMerge || allowFixPr);
const skipExisting = args["skip-existing"] !== "false";
const skipSecurity = args["include-security"] !== true && args["skip-security"] !== "false";
const skipFeatureRequests =
  args["include-feature-requests"] !== true && args["skip-feature-requests"] !== "false";
const allowEmpty = Boolean(args["allow-empty"]);
const fromGitcrawl = Boolean(args["from-gitcrawl"] || args["from-ghcrawl"] || args.all);
const limit = numberArg("limit", 40);
const scanLimit = numberArg("scan-limit", Math.max(limit * 10, 200));
const maxScanWindows = numberArg("max-scan-windows", 4);
const minSize = numberArg("min-size", 2);
const minOpenMembers = numberArg("min-open-members", 1);
const skipClosedPercent = percentArg("skip-closed-percent", 75);
const requestedClusterIds = args._.map((value: string) => Number(value)).filter(Boolean);
const selectingFromGitcrawl = requestedClusterIds.length === 0 && fromGitcrawl;
if (scanLimit < limit) {
  console.error("--scan-limit must be greater than or equal to --limit");
  process.exit(2);
}
if (maxScanWindows > 32) {
  console.error("--max-scan-windows must be at most 32");
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
      `[action-ledger] failed to finalize Gitcrawl cluster evidence after importer failure: ${errorText(error)}`,
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
  if (requestedClusterIds.length === 0 && !selectingFromGitcrawl) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const adapter = await GitcrawlEvidenceAdapter.open(
    gitcrawlEvidenceOptionsFromArgs({
      repository: repo,
      repoRoot: repoRoot(),
      args,
    }),
  );
  const actionLedger = beginGitcrawlActionLedger(repairActionLedgerRoot(), {
    repository: repo,
    consumer: "cluster_intake",
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
    const existingClusterIds = skipExisting
      ? existingGitcrawlClusterIds(outDir)
      : new Set<number>();
    const existingMemberRefs = skipExisting
      ? existingGitcrawlMemberRefs(outDir, suffix)
      : new Map<number, string[]>();
    let createdCount = 0;
    const importCluster = async (
      clusterId: number,
      cluster?: GitcrawlClusterEvidence,
      clusterClaim?: GitcrawlEvidenceClaim,
      parentEventId: string | null = actionLedger.snapshotEventId,
    ): Promise<void> => {
      if (existingClusterIds.has(clusterId)) {
        console.error(`skip existing cluster: ${clusterId}`);
        return;
      }

      const memberResult = await adapter.clusterMembers(clusterId);
      const memberQueryEvent = actionLedger.recordQuery({
        queryName: "gitcrawl.clusters.members",
        phaseSeq: actionPhaseSeq++,
        identity: { clusterId },
        rowCount: memberResult.rows.length,
        claims: memberResult.claims,
        subject: {
          repository: repo,
          kind: "cluster",
          clusterId: String(clusterId),
        },
        parentEventId,
      });
      const members = memberResult.rows;
      if (members.length === 0) {
        console.error(`cluster not found: ${clusterId}`);
        return;
      }
      if (
        await writeClusterJob({
          adapter,
          cluster: cluster ?? clusterFromMembers(clusterId, members),
          ...(clusterClaim === undefined ? {} : { clusterClaim }),
          members,
          memberClaims: memberResult.claims,
          existingMemberRefs,
          actionLedger,
          bindingPhaseSeq: actionPhaseSeq++,
          parentEventId: memberQueryEvent?.event_id ?? parentEventId,
        })
      ) {
        createdCount += 1;
      }
    };

    if (!selectingFromGitcrawl) {
      for (const clusterId of requestedClusterIds) await importCluster(clusterId);
    } else {
      const cursorKey = clusterScanCursorKey(adapter);
      const storedCursor = skipExisting ? readGitcrawlScanCursor(outDir, cursorKey) : undefined;
      let expectedCursor = storedCursor;
      let resume = compatibleGitcrawlScanCursor(
        storedCursor,
        adapter.archive,
        adapter.snapshotId,
        adapter.parityArchive,
        adapter.paritySnapshotId,
      );
      let scanOffset = resume?.offset ?? 0;
      let restarted = false;
      for (let window = 0; window < maxScanWindows && createdCount < limit; window += 1) {
        let clusters = await adapter.listClustersWindow({
          status: "active",
          minSize,
          offset: scanOffset,
          maxRows: scanLimit,
          ...(resume === undefined ? {} : { resume }),
        });
        let listQueryEvent = actionLedger.recordQuery({
          queryName: "gitcrawl.clusters.list",
          phaseSeq: actionPhaseSeq++,
          identity: { status: "active", minSize, scanOffset, scanLimit, window },
          rowCount: clusters.rows.length,
          claims: clusters.claims,
          subject: {
            repository: repo,
            kind: "repository",
          },
        });
        if (clusters.rows.length === 0 && clusters.exhausted && scanOffset > 0 && !restarted) {
          restarted = true;
          scanOffset = 0;
          resume = undefined;
          clusters = await adapter.listClustersWindow({
            status: "active",
            minSize,
            offset: 0,
            maxRows: scanLimit,
          });
          listQueryEvent = actionLedger.recordQuery({
            queryName: "gitcrawl.clusters.list",
            phaseSeq: actionPhaseSeq++,
            identity: { status: "active", minSize, scanOffset: 0, scanLimit, window, restarted },
            rowCount: clusters.rows.length,
            claims: clusters.claims,
            subject: {
              repository: repo,
              kind: "repository",
            },
          });
        }
        if (clusters.rows.length === 0) break;
        const clusterClaims = new Map(
          clusters.claims.map((claim) => [(claim.data as GitcrawlClusterEvidence).id, claim]),
        );
        let examinedCount = 0;
        for (const cluster of clusters.rows) {
          if (createdCount >= limit) break;
          examinedCount += 1;
          await importCluster(
            cluster.id,
            cluster,
            clusterClaims.get(cluster.id),
            listQueryEvent?.event_id ?? actionLedger.snapshotEventId,
          );
        }
        if (examinedCount !== clusters.rows.length) break;
        if (clusters.nextOffset > 0 && clusters.lastClusterOrderKey === undefined) {
          throw new Error("Gitcrawl cluster scan did not return a stable order boundary");
        }
        const preservesMonotonicProgress =
          !restarted ||
          storedCursor === undefined ||
          storedCursor.snapshotId !== adapter.snapshotId ||
          clusters.nextOffset === 0 ||
          clusters.nextOffset > storedCursor.offset;
        if (skipExisting && preservesMonotonicProgress) {
          writeGitcrawlScanOffset({
            directory: outDir,
            key: cursorKey,
            offset: clusters.nextOffset,
            archive: adapter.archive,
            snapshotId: adapter.snapshotId,
            providerCursor: clusters.nextProviderCursor,
            querySha256: clusters.querySha256,
            ...(adapter.parityArchive === undefined
              ? {}
              : { parityArchive: adapter.parityArchive }),
            ...(adapter.paritySnapshotId === undefined
              ? {}
              : { paritySnapshotId: adapter.paritySnapshotId }),
            ...(clusters.parityNextProviderCursor === undefined
              ? {}
              : { parityProviderCursor: clusters.parityNextProviderCursor }),
            ...(clusters.nextOffset === 0 || clusters.lastClusterOrderKey === undefined
              ? {}
              : { clusterOrderKey: clusters.lastClusterOrderKey }),
            ...(expectedCursor === undefined ? {} : { expected: expectedCursor }),
          });
          if (clusters.nextOffset > 0) {
            expectedCursor = clusterWindowResume(adapter, clusters);
          }
        }
        if (clusters.exhausted) break;
        scanOffset = clusters.nextOffset;
        resume = clusterWindowResume(adapter, clusters);
      }
    }
    if (createdCount === 0 && selectingFromGitcrawl && !allowEmpty) {
      console.error("no Gitcrawl clusters passed the import policy");
      process.exitCode = 1;
    }
  } finally {
    await adapter.close();
  }
}

function clusterScanCursorKey(adapter: GitcrawlEvidenceAdapter): string {
  return [
    `clusters:${adapter.provider}:${repo}`,
    `source=${sourceIdentityDigest(adapter)}`,
    `min-size=${minSize}`,
    `min-open=${minOpenMembers}`,
    `skip-closed=${skipClosedPercent}`,
    `skip-security=${skipSecurity}`,
    `skip-features=${skipFeatureRequests}`,
    `suffix=${slugify(suffix) || "default"}`,
    "policy=v1",
  ].join(":");
}

function clusterWindowResume(
  adapter: GitcrawlEvidenceAdapter,
  window: {
    nextOffset: number;
    nextProviderCursor: string;
    querySha256: string;
    parityNextProviderCursor?: string;
    lastClusterOrderKey?: GitcrawlClusterOrderKey;
  },
): GitcrawlEvidenceResumeCursor {
  if (
    window.nextOffset <= 0 ||
    !window.nextProviderCursor ||
    window.lastClusterOrderKey === undefined
  ) {
    throw new Error("Gitcrawl cluster scan cannot resume without a stable order boundary");
  }
  return {
    offset: window.nextOffset,
    archive: adapter.archive,
    snapshotId: adapter.snapshotId,
    providerCursor: window.nextProviderCursor,
    querySha256: window.querySha256,
    ...(adapter.parityArchive === undefined ? {} : { parityArchive: adapter.parityArchive }),
    ...(adapter.paritySnapshotId === undefined
      ? {}
      : { paritySnapshotId: adapter.paritySnapshotId }),
    ...(window.parityNextProviderCursor === undefined
      ? {}
      : { parityProviderCursor: window.parityNextProviderCursor }),
    clusterOrderKey: window.lastClusterOrderKey,
  };
}

function sourceIdentityDigest(adapter: GitcrawlEvidenceAdapter): string {
  return sha256Canonical({
    archive: adapter.archive,
    parity_archive: adapter.parityArchive ?? null,
  }).slice(0, 16);
}

async function writeClusterJob(input: {
  adapter: GitcrawlEvidenceAdapter;
  cluster: GitcrawlClusterEvidence;
  clusterClaim?: GitcrawlEvidenceClaim;
  members: GitcrawlThreadEvidence[];
  memberClaims: GitcrawlEvidenceClaim[];
  existingMemberRefs: Map<number, string[]>;
  actionLedger: GitcrawlActionLedger;
  bindingPhaseSeq: number;
  parentEventId: string | null;
}): Promise<boolean> {
  const {
    adapter,
    cluster,
    clusterClaim,
    members,
    memberClaims,
    existingMemberRefs,
    actionLedger,
    bindingPhaseSeq,
    parentEventId,
  } = input;
  const clusterId = cluster.id;
  const representative = cluster.representative;
  const representativeTitle = representative.title || cluster.title;
  const overlappingRefs = members
    .map((member) => member.number)
    .filter((number) => existingMemberRefs.has(number));
  if (overlappingRefs.length > 0) {
    const examples = overlappingRefs
      .slice(0, 4)
      .map((number) => `#${number}`)
      .join(", ");
    const existingFiles = [
      ...new Set(overlappingRefs.flatMap((number) => existingMemberRefs.get(number) ?? [])),
    ];
    console.error(
      `skip existing member overlap cluster: ${clusterId} ${representativeTitle} (${examples}${overlappingRefs.length > 4 ? ", ..." : ""}; ${existingFiles.slice(0, 2).join(", ")})`,
    );
    return false;
  }

  const incompleteSecurityMembers = members.filter((member) => !member.securityMetadataComplete);
  if (incompleteSecurityMembers.length > 0) {
    const refs = incompleteSecurityMembers
      .slice(0, 8)
      .map((member) => `#${member.number}`)
      .join(", ");
    throw new Error(
      `Gitcrawl cluster ${clusterId} has incomplete security metadata for ${refs}${incompleteSecurityMembers.length > 8 ? ", ..." : ""}`,
    );
  }
  const securitySensitiveMembers = members.filter((member) => member.securitySensitive);
  const securitySensitive = securitySensitiveMembers.length > 0;
  if (securitySensitive && skipSecurity) {
    const refs = securitySensitiveMembers.map((member) => `#${member.number}`).join(", ");
    console.error(`skip security-sensitive cluster: ${clusterId} ${representativeTitle} (${refs})`);
    return false;
  }
  if (skipFeatureRequests && isProductFeatureRequest(representativeTitle)) {
    console.error(`skip product feature-request cluster: ${clusterId} ${representativeTitle}`);
    return false;
  }

  const openMembers = members.filter((member) => member.state === "open");
  const closedMembers = members.filter((member) => member.state !== "open");
  if (openMembers.length === 0) {
    console.error(`skip closed-only cluster: ${clusterId} ${representativeTitle}`);
    return false;
  }
  const closedPercent = Math.floor((closedMembers.length * 100) / members.length);
  if (closedPercent >= skipClosedPercent) {
    console.error(
      `skip mostly-closed cluster: ${clusterId} ${representativeTitle} (${closedPercent}% closed >= ${skipClosedPercent}%)`,
    );
    return false;
  }
  if (openMembers.length < minOpenMembers) {
    console.error(
      `skip low-open cluster: ${clusterId} ${representativeTitle} (${openMembers.length} open < ${minOpenMembers})`,
    );
    return false;
  }

  const issueCount = members.filter((member) => member.kind === "issue").length;
  const pullRequestCount = members.filter((member) => member.kind === "pull_request").length;
  const latestUpdatedAt = members
    .map((member) => member.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const slug = slugify(representativeTitle || `cluster-${clusterId}`);
  const fileStem = suffix
    ? `gitcrawl-evidence-v1-${clusterId}-${slugify(suffix)}`
    : `gitcrawl-evidence-v1-${clusterId}-${slug}`;
  const filePath = path.join(outDir, `${fileStem}.md`);
  const canonical = representative.number ? [`#${representative.number}`] : [];
  const generatedAt = new Date().toISOString();
  const packet = buildGitcrawlEvidencePacket({
    provider: adapter.provider,
    repository: adapter.repository,
    snapshotId: adapter.snapshotId,
    ...(adapter.paritySnapshotId === undefined
      ? {}
      : { paritySnapshotId: adapter.paritySnapshotId }),
    coverage: adapter.coverage,
    requiredCoverage: adapter.requiredCoverageFor(
      "gitcrawl.clusters.list",
      "gitcrawl.clusters.members",
    ),
    claims: [...(clusterClaim === undefined ? [] : [clusterClaim]), ...memberClaims],
    generatedAt,
  });
  const includedClaims = new Set(packet.claims.map((claim) => claim.sha256));
  const omittedMemberClaims = memberClaims.filter((claim) => !includedClaims.has(claim.sha256));
  if (omittedMemberClaims.length > 0) {
    throw new Error(
      `Gitcrawl cluster ${clusterId} evidence packet omitted ${omittedMemberClaims.length} member claim(s); refusing a partial repair job`,
    );
  }
  const candidates = openMembers.map((member) => `#${member.number}`);
  const clusterRefs = members.map((member) => `#${member.number}`);
  verifyGitcrawlEvidenceJobTargets(packet, {
    repo,
    canonical,
    candidates,
    cluster_refs: clusterRefs,
  });

  const markdown = [
    "---",
    `repo: ${repo}`,
    `cluster_id: ${fileStem}`,
    `mode: ${mode}`,
    renderJobIntentFrontmatter("repair_cluster"),
    "gitcrawl_evidence_schema: gitcrawl-evidence-job-v1",
    "gitcrawl_evidence_required: true",
    "allowed_actions:",
    "  - comment",
    "  - label",
    "  - close",
    ...(allowMerge ? ["  - merge"] : []),
    ...(allowFixPr ? ["  - fix", "  - raise_pr"] : []),
    "blocked_actions:",
    "  - force_push",
    "  - bypass_checks",
    ...(allowMerge ? [] : ["  - merge"]),
    ...(allowFixPr ? [] : ["  - fix", "  - raise_pr"]),
    "require_human_for:",
    "  - security_sensitive",
    "  - failing_checks",
    "  - conflicting_prs",
    "  - unclear_canonical",
    "  - broad_code_delta",
    "canonical:",
    ...yamlList(canonical),
    "candidates:",
    ...yamlList(candidates),
    "cluster_refs:",
    ...yamlList(clusterRefs),
    "security_policy: central_security_only",
    "security_sensitive: false",
    ...(mode === "autonomous" || mode === "execute"
      ? [
          `allow_instant_close: ${allowInstantClose ? "true" : "false"}`,
          `allow_fix_pr: ${allowFixPr ? "true" : "false"}`,
          `allow_merge: ${allowMerge ? "true" : "false"}`,
          `allow_post_merge_close: ${allowPostMergeClose ? "true" : "false"}`,
          `require_fix_before_close: ${allowFixPr || allowMerge ? "true" : "false"}`,
        ]
      : []),
    `canonical_hint: ${quoteYaml(canonicalHint(representative))}`,
    `notes: ${quoteYaml(jobNotes(clusterId, securitySensitiveMembers, adapter, generatedAt))}`,
    "---",
    "",
    `# Gitcrawl Cluster ${clusterId}`,
    "",
    `Generated from a coverage-checked Gitcrawl ${adapter.provider} snapshot for \`${repo}\`.`,
    "",
    "Display title:",
    "",
    `> ${representativeTitle || "Untitled representative"}`,
    "",
    "Cluster shape from Gitcrawl:",
    "",
    `- total members: ${members.length}`,
    `- issues: ${issueCount}`,
    `- pull requests: ${pullRequestCount}`,
    `- open candidates in snapshot: ${openMembers.length}`,
    `- representative: #${representative.number ?? "none"}, currently ${representative.state || "unknown"} in snapshot`,
    `- latest member update: ${latestUpdatedAt || "unknown"}`,
    "",
    "## Goal",
    "",
    goalText(mode),
    "",
    "## Member Inventory",
    "",
    "Closed context refs:",
    "",
    ...bulletList(closedMembers),
    "",
    "Open candidates:",
    "",
    ...bulletList(openMembers),
    "",
    ...renderGitcrawlEvidencePacket(packet),
  ].join("\n");

  publishGitcrawlGeneratedJob(filePath, markdown);
  const recordPath = path.relative(repoRoot(), filePath);
  const durableRecordPath = repositoryRelativePath(recordPath);
  actionLedger.recordBinding({
    phaseSeq: bindingPhaseSeq,
    identity: { clusterId, fileStem },
    packet,
    ...(durableRecordPath === undefined ? {} : { recordPath: durableRecordPath }),
    itemCount: members.length,
    subject: {
      repository: repo,
      kind: "cluster",
      clusterId: fileStem,
    },
    parentEventId,
  });
  for (const member of members) {
    const files = existingMemberRefs.get(member.number) ?? [];
    files.push(recordPath);
    existingMemberRefs.set(member.number, files);
  }
  console.log(recordPath);
  return true;
}

function clusterFromMembers(
  clusterId: number,
  members: GitcrawlThreadEvidence[],
): GitcrawlClusterEvidence {
  const representative =
    members.find((member) => member.role === "canonical") ??
    members.find((member) => member.role === "representative") ??
    members[0]!;
  return {
    id: clusterId,
    stableSlug: representative.clusterSlug ?? `cluster-${clusterId}`,
    status: representative.clusterStatus ?? "",
    clusterType: "",
    title: representative.title,
    representative: {
      threadId: representative.threadId,
      number: representative.number,
      kind: representative.kind,
      state: representative.state,
      title: representative.title,
    },
    memberCount: members.length,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
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

function printUsage(): void {
  console.error(
    "usage: node dist/repair/import-gitcrawl-clusters.js <cluster-id> [...] [--from-gitcrawl] [--allow-empty] [--gitcrawl-provider local|cloud|parity] [--db path] [--cloud-url url] [--cloud-archive name] [--max-snapshot-age-hours N] [--allow-legacy-local] [--limit N] [--scan-limit N] [--max-scan-windows N] [--min-size N] [--min-open-members N] [--skip-closed-percent N] [--repo owner/repo] [--out dir] [--mode plan|autonomous] [--suffix name] [--allow-instant-close] [--allow-merge true|false] [--allow-fix-pr true|false] [--allow-post-merge-close true|false]",
  );
}

function numberArg(name: string, fallback: number): number {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function percentArg(name: string, fallback: number): number {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`--${name} must be an integer from 1 to 100`);
  }
  return value;
}

function booleanArg(name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function isProductFeatureRequest(title: string): boolean {
  return /^\s*\[?\s*feature(?:\s+(?:request|proposal))?\b/i.test(title);
}

function existingGitcrawlClusterIds(dir: string): Set<number> {
  if (!fs.existsSync(dir)) return new Set();
  const ids = new Set<number>();
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry));
    if (file.split(path.sep).includes(".legacy-gitcrawl-quarantine")) continue;
    if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
    const clusterId = jobFrontmatter(file).cluster_id;
    if (typeof clusterId !== "string") continue;
    const match = clusterId.match(/^(?:ghcrawl|gitcrawl)-(?:evidence-v1-)?(\d+)(?:-|$)/);
    if (match?.[1]) ids.add(Number(match[1]));
  }
  return ids;
}

function existingGitcrawlMemberRefs(dir: string, fileSuffix: string): Map<number, string[]> {
  const refs = new Map<number, string[]>();
  if (!fs.existsSync(dir)) return refs;
  const suffixSlug = fileSuffix ? slugify(fileSuffix) : "";
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry));
    if (file.split(path.sep).includes(".legacy-gitcrawl-quarantine")) continue;
    if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
    if (suffixSlug && !path.basename(file).endsWith(`-${suffixSlug}.md`)) continue;
    const clusterRefs = jobFrontmatter(file).cluster_refs;
    if (!Array.isArray(clusterRefs)) continue;
    for (const ref of clusterRefs) {
      const match = String(ref).match(/^#(\d+)$/);
      const number = Number(match?.[1]);
      if (!Number.isSafeInteger(number)) continue;
      const files = refs.get(number) ?? [];
      files.push(path.relative(repoRoot(), file));
      refs.set(number, files);
    }
  }
  return refs;
}

function jobFrontmatter(file: string): Record<string, unknown> {
  const match = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};
  return parseSimpleYaml(match[1]);
}

function yamlList(values: string[]): string[] {
  if (values.length === 0) return ["  []"];
  return values.map((value) => `  - ${quoteYaml(value)}`);
}

function quoteYaml(value: unknown): string {
  return JSON.stringify(String(value));
}

function canonicalHint(representative: GitcrawlClusterEvidence["representative"]): string {
  if (!representative.number) {
    return "No Gitcrawl representative was available; worker must choose a live canonical.";
  }
  if (representative.state === "open") {
    return `Gitcrawl representative #${representative.number} is open; worker must verify it is still the best live canonical.`;
  }
  return `Gitcrawl representative #${representative.number} is ${representative.state}; worker must verify whether an open canonical should replace it.`;
}

function goalText(jobMode: string): string {
  if (jobMode === "plan") {
    return "Classify the open candidate issues and PRs in read-only plan mode. Do not close anything. If the representative is closed, report whether another open item should become the live canonical. If the cluster contains multiple root causes, split them in the action matrix instead of forcing a single duplicate family.";
  }
  return "Run one live autonomous classification pass. Classify open candidates only, verify live GitHub state, choose the current canonical issue or PR if the representative is obsolete, and emit only high-confidence planned close/comment/label actions. Closed context refs are evidence only and must not receive close actions.";
}

function jobNotes(
  clusterId: number,
  securitySensitiveMembers: GitcrawlThreadEvidence[],
  adapter: GitcrawlEvidenceAdapter,
  generatedAt: string,
): string {
  const base = `Generated from Gitcrawl cluster ${clusterId} at ${generatedAt}; snapshot ${adapter.snapshotId}; provider ${adapter.provider}.`;
  if (securitySensitiveMembers.length === 0) return base;
  return `${base} Security-sensitive refs ${securitySensitiveMembers.map((member) => `#${member.number}`).join(", ")} must be routed with route_security and must not block unrelated non-security work.`;
}

function bulletList(members: GitcrawlThreadEvidence[]): string[] {
  if (members.length === 0) return ["- none"];
  return members.map((member) => `- #${member.number} ${member.title}`);
}

function slugify(value: unknown): string {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "cluster"
  );
}
