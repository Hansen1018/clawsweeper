#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { hasSecuritySignalText, parseArgs, repoRoot } from "./lib.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import {
  GitcrawlEvidenceAdapter,
  gitcrawlEvidenceOptionsFromArgs,
  type GitcrawlClusterEvidence,
  type GitcrawlThreadEvidence,
} from "./gitcrawl-evidence-adapter.js";

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
const evidenceOptions = gitcrawlEvidenceOptionsFromArgs({
  repository: repo,
  repoRoot: repoRoot(),
  args,
});
const provenanceOut =
  typeof args["provenance-out"] === "string"
    ? path.resolve(String(args["provenance-out"]))
    : undefined;
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
const minSize = numberArg("min-size", 2);
const minOpenMembers = numberArg("min-open-members", 1);
const skipClosedPercent = percentArg("skip-closed-percent", 75);
let clusterIds = args._.map((value: string) => Number(value)).filter(Boolean);
const selectingFromGitcrawl = clusterIds.length === 0 && fromGitcrawl;

const adapter = await GitcrawlEvidenceAdapter.open(evidenceOptions);
try {
  await importClusters();
} finally {
  await adapter.close();
}

async function importClusters() {
  const clusterResult = await adapter.listClusters({
    status: "active",
    minSize: selectingFromGitcrawl ? minSize : 1,
  });
  const clustersById = new Map(clusterResult.rows.map((cluster) => [cluster.id, cluster]));
  if (selectingFromGitcrawl) {
    clusterIds = clusterResult.rows.map((cluster) => cluster.id);
  }

  if (clusterIds.length === 0) {
    if (selectingFromGitcrawl && allowEmpty) {
      writeProvenance([]);
      console.error("no eligible gitcrawl clusters found");
      return;
    }
    console.error(
      "usage: node scripts/import-gitcrawl-clusters.ts <cluster-id> [...] [--from-gitcrawl] [--gitcrawl-provider local|cloud|parity] [--cloud-url URL] [--cloud-archive NAME] [--snapshot-id ID] [--provenance-out path] [--allow-empty] [--limit N] [--min-size N] [--min-open-members N] [--skip-closed-percent N] [--repo owner/repo] [--db path] [--out dir] [--mode plan|autonomous] [--suffix name] [--allow-instant-close] [--allow-merge true|false] [--allow-fix-pr true|false] [--allow-post-merge-close true|false]",
    );
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const existingClusterIds = skipExisting ? existingGitcrawlClusterIds(outDir) : new Set();
  const existingMemberRefs = skipExisting ? existingGitcrawlMemberRefs(outDir, suffix) : new Map();
  const generated: string[] = [];
  let createdCount = 0;

  for (const clusterId of clusterIds) {
    if (selectingFromGitcrawl && createdCount >= limit) break;
    if (existingClusterIds.has(clusterId)) {
      console.error(`skip existing cluster: ${clusterId}`);
      continue;
    }

    const cluster = clustersById.get(clusterId);
    if (!cluster) {
      console.error(`cluster not found or inactive: ${clusterId}`);
      continue;
    }
    const memberResult = await adapter.clusterMembers(clusterId);
    const members = memberResult.rows.map((member) => legacyMember(cluster, member));

    if (members.length === 0) {
      console.error(`cluster not found: ${clusterId}`);
      continue;
    }
    const overlappingRefs = members
      .map((member: JsonValue) => Number(member.number))
      .filter((number: number) => existingMemberRefs.has(number));
    if (overlappingRefs.length > 0) {
      const examples = overlappingRefs
        .slice(0, 4)
        .map((number: number) => `#${number}`)
        .join(", ");
      const existingFiles = [
        ...new Set(
          overlappingRefs.flatMap((number: number) => existingMemberRefs.get(number) ?? []),
        ),
      ];
      console.error(
        `skip existing member overlap cluster: ${clusterId} ${members[0].representative_title ?? ""} (${examples}${overlappingRefs.length > 4 ? ", ..." : ""}; ${existingFiles.slice(0, 2).join(", ")})`,
      );
      continue;
    }

    const securitySensitiveMembers = members.filter((member: JsonValue) =>
      hasSecuritySignalText(member.title, member.body, safeJson(member.labels_json)),
    );
    const securitySensitive = securitySensitiveMembers.length > 0;
    if (securitySensitive && skipSecurity) {
      const refs = securitySensitiveMembers
        .map((member: JsonValue) => `#${member.number}`)
        .join(", ");
      console.error(
        `skip security-sensitive cluster: ${clusterId} ${members[0].representative_title ?? ""} (${refs})`,
      );
      continue;
    }
    if (skipFeatureRequests && isProductFeatureRequest(members[0].representative_title)) {
      console.error(
        `skip product feature-request cluster: ${clusterId} ${members[0].representative_title ?? ""}`,
      );
      continue;
    }

    const first = members[0];
    const representative = {
      number: first.representative_number,
      kind: first.representative_kind,
      state: first.representative_state,
      title: first.representative_title,
    };
    const openMembers = members.filter((member: JsonValue) => member.state === "open");
    const closedMembers = members.filter((member: JsonValue) => member.state !== "open");
    if (openMembers.length === 0) {
      console.error(`skip closed-only cluster: ${clusterId} ${representative.title ?? ""}`);
      continue;
    }
    const closedPercent = Math.floor((closedMembers.length * 100) / members.length);
    if (closedPercent >= skipClosedPercent) {
      console.error(
        `skip mostly-closed cluster: ${clusterId} ${representative.title ?? ""} (${closedPercent}% closed >= ${skipClosedPercent}%)`,
      );
      continue;
    }
    if (openMembers.length < minOpenMembers) {
      console.error(
        `skip low-open cluster: ${clusterId} ${representative.title ?? ""} (${openMembers.length} open < ${minOpenMembers})`,
      );
      continue;
    }
    const issueCount = members.filter((member: JsonValue) => member.kind === "issue").length;
    const pullRequestCount = members.filter(
      (member: JsonValue) => member.kind === "pull_request",
    ).length;
    const latestUpdatedAt = members
      .map((member: JsonValue) => member.updated_at)
      .sort()
      .at(-1);
    const slug = slugify(representative.title || `cluster-${clusterId}`);
    const fileStem = suffix
      ? `gitcrawl-${clusterId}-${slugify(suffix)}`
      : `gitcrawl-${clusterId}-${slug}`;
    const filePath = path.join(outDir, `${fileStem}.md`);
    const clusterSlug = suffix
      ? `gitcrawl-${clusterId}-${slugify(suffix)}`
      : `gitcrawl-${clusterId}-${slug}`;
    const canonical = representative.number ? [`#${representative.number}`] : [];

    const markdown = [
      "---",
      `repo: ${repo}`,
      `cluster_id: ${clusterSlug}`,
      `mode: ${mode}`,
      renderJobIntentFrontmatter("repair_cluster"),
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
      ...yamlList(openMembers.map((member: JsonValue) => `#${member.number}`)),
      "cluster_refs:",
      ...yamlList(members.map((member: JsonValue) => `#${member.number}`)),
      "security_policy: central_security_only",
      "security_sensitive: false",
      `gitcrawl_provider: ${quoteYaml(adapter.provider)}`,
      `gitcrawl_snapshot_id: ${quoteYaml(adapter.snapshotId)}`,
      `gitcrawl_source_identity_sha256: ${quoteYaml(adapter.provenance.identity_sha256)}`,
      ...(adapter.paritySnapshotId
        ? [`gitcrawl_parity_snapshot_id: ${quoteYaml(adapter.paritySnapshotId)}`]
        : []),
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
      `notes: ${quoteYaml(jobNotes(clusterId, securitySensitiveMembers))}`,
      "---",
      "",
      `# Gitcrawl Cluster ${clusterId}`,
      "",
      `Generated from ${adapter.provider} Gitcrawl snapshot \`${adapter.snapshotId}\` cluster ${clusterId} for \`${repo}\`.`,
      "",
      "Display title:",
      "",
      `> ${representative.title || "Untitled representative"}`,
      "",
      "Cluster shape from gitcrawl:",
      "",
      `- total members: ${members.length}`,
      `- issues: ${issueCount}`,
      `- pull requests: ${pullRequestCount}`,
      `- open candidates in snapshot: ${openMembers.length}`,
      `- representative: #${representative.number}, currently ${representative.state} in snapshot`,
      `- latest member update: ${latestUpdatedAt}`,
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
    ].join("\n");

    fs.writeFileSync(filePath, markdown);
    for (const member of members) {
      const number = Number(member.number);
      if (!Number.isSafeInteger(number)) continue;
      const files = existingMemberRefs.get(number) ?? [];
      files.push(path.relative(repoRoot(), filePath));
      existingMemberRefs.set(number, files);
    }
    createdCount += 1;
    const generatedPath = path.relative(repoRoot(), filePath);
    generated.push(generatedPath);
    console.log(generatedPath);
  }
  writeProvenance(generated);
}

function legacyMember(
  cluster: GitcrawlClusterEvidence,
  member: GitcrawlThreadEvidence,
): LooseRecord {
  return {
    cluster_id: cluster.id,
    member_count: cluster.memberCount,
    cluster_created_at: cluster.createdAt,
    closed_at_local: cluster.closedAt || null,
    close_reason_local: cluster.status,
    representative_number: cluster.representative.number,
    representative_kind: cluster.representative.kind,
    representative_state: cluster.representative.state,
    representative_title: cluster.representative.title,
    number: member.number,
    kind: member.kind,
    state: member.state,
    title: member.title,
    body: member.body,
    labels_json: JSON.stringify(member.labels ?? []),
    updated_at: member.updatedAt,
  };
}

function writeProvenance(generated: string[]) {
  if (!provenanceOut) return;
  fs.mkdirSync(path.dirname(provenanceOut), { recursive: true });
  fs.writeFileSync(
    provenanceOut,
    `${JSON.stringify(
      {
        schema: "clawsweeper-gitcrawl-cluster-import-v1",
        repository: repo,
        provider: adapter.provider,
        snapshot_id: adapter.snapshotId,
        parity_snapshot_id: adapter.paritySnapshotId ?? null,
        source: adapter.provenance,
        selected_cluster_ids: clusterIds,
        generated,
      },
      null,
      2,
    )}\n`,
  );
}

function numberArg(name: string, fallback: JsonValue) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function percentArg(name: string, fallback: JsonValue) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`--${name} must be an integer from 1 to 100`);
  }
  return value;
}

function booleanArg(name: string, fallback: JsonValue) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function safeJson(value: JsonValue) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function isProductFeatureRequest(title: JsonValue) {
  return /^\s*\[?\s*feature(?:\s+(?:request|proposal))?\b/i.test(String(title ?? ""));
}

function existingGitcrawlClusterIds(dir: string) {
  if (!fs.existsSync(dir)) return new Set();
  const ids = new Set();
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry));
    if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b(?:ghcrawl|gitcrawl)-(\d+)\b/g)) ids.add(Number(match[1]));
  }
  return ids;
}

function existingGitcrawlMemberRefs(dir: string, suffix: JsonValue) {
  const refs = new Map();
  if (!fs.existsSync(dir)) return refs;
  const suffixSlug = suffix ? slugify(suffix) : "";
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry));
    if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
    if (suffixSlug && !path.basename(file).endsWith(`-${suffixSlug}.md`)) continue;
    const text = fs.readFileSync(file, "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
    const clusterRefs = frontmatter?.[1]?.match(/^cluster_refs:\n((?:  - .+\n?)*)/m)?.[1] ?? "";
    for (const match of clusterRefs.matchAll(/#(\d+)/g)) {
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number)) continue;
      const files = refs.get(number) ?? [];
      files.push(path.relative(repoRoot(), file));
      refs.set(number, files);
    }
  }
  return refs;
}

function yamlList(values: LooseRecord[]) {
  if (values.length === 0) return ["  []"];
  return values.map((value: string) => `  - ${quoteYaml(value)}`);
}

function quoteYaml(value: JsonValue) {
  return JSON.stringify(String(value));
}

function canonicalHint(representative: JsonValue) {
  if (!representative.number)
    return "No gitcrawl representative was available; worker must choose a live canonical.";
  if (representative.state === "open") {
    return `gitcrawl representative #${representative.number} is open; worker must verify it is still the best live canonical.`;
  }
  return `gitcrawl representative #${representative.number} is ${representative.state}; worker must verify whether an open canonical should replace it.`;
}

function goalText(mode: string) {
  if (mode === "plan") {
    return "Classify the open candidate issues and PRs in read-only plan mode. Do not close anything. If the representative is closed, report whether another open item should become the live canonical. If the cluster contains multiple root causes, split them in the action matrix instead of forcing a single duplicate family.";
  }
  return "Run one live autonomous classification pass. Classify open candidates only, verify live GitHub state, choose the current canonical issue or PR if the representative is obsolete, and emit only high-confidence planned close/comment/label actions. Closed context refs are evidence only and must not receive close actions.";
}

function jobNotes(clusterId: string, securitySensitiveMembers: JsonValue) {
  const base = `Generated from ${adapter.provider} Gitcrawl snapshot ${adapter.snapshotId} cluster ${clusterId} on ${new Date().toISOString().slice(0, 10)}.`;
  if (securitySensitiveMembers.length === 0) return base;
  return `${base} Security-sensitive refs ${securitySensitiveMembers.map((member: JsonValue) => `#${member.number}`).join(", ")} must be routed with route_security and must not block unrelated non-security work.`;
}

function bulletList(members: JsonValue) {
  if (members.length === 0) return ["- none"];
  return members.map((member: JsonValue) => `- #${member.number} ${member.title}`);
}

function slugify(value: JsonValue) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "cluster"
  );
}
