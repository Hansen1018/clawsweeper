import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GITCRAWL_JOB_EVIDENCE_SCHEMA, sha256Canonical } from "./gitcrawl-evidence-contract.js";
import {
  verifyEmbeddedGitcrawlEvidencePacket,
  verifyGitcrawlEvidenceJobTargets,
} from "./gitcrawl-evidence-graph.js";
import { parseSimpleYaml } from "./lib.js";

export type GitcrawlMigrationCommand = {
  command: string;
  args: string[];
};

export type GitcrawlMigrationEntry = {
  path: string;
  repository: string;
  cluster_id: string;
  kind: "cluster" | "low_signal";
  targets: string[];
  replacement_paths: string[];
  ready_to_archive: boolean;
  writer_exclusion_required: boolean;
  writer_exclusion_confirmed: boolean;
  source_sha256: string;
  source_size: number;
  source_device: number;
  source_inode: number;
  reimport_strategy: "exact_cluster" | "current_policy_rescan";
  reimport: GitcrawlMigrationCommand;
  archive: GitcrawlMigrationCommand;
  rollback: GitcrawlMigrationCommand;
};

export type GitcrawlMigrationReport = {
  schema: "clawsweeper-gitcrawl-evidence-migration-v2";
  jobs_directory: string;
  archive_directory: string;
  summary: {
    markdown_files: number;
    current_jobs: number;
    legacy_jobs: number;
    legacy_ready_to_archive: number;
    invalid_jobs: number;
  };
  legacy_jobs: GitcrawlMigrationEntry[];
  invalid_jobs: { path: string; reason: string }[];
  operator_sequence: string[];
};

type CurrentJob = {
  path: string;
  repository: string;
  kind: "cluster" | "low_signal";
  clusterNumber?: number;
  targets: Set<string>;
};

type LegacyJob = {
  absolutePath: string;
  relativePath: string;
  repository: string;
  clusterId: string;
  kind: "cluster" | "low_signal";
  clusterNumber?: number;
  mode: string;
  targets: string[];
  sourceSha256: string;
  sourceSize: number;
  sourceDevice: number;
  sourceInode: number;
};

export function inventoryGitcrawlEvidenceMigration(input: {
  jobsDirectory: string;
  archiveDirectory?: string;
  provider?: "local" | "cloud" | "parity";
  dbPath?: string;
  cloudUrl?: string;
  cloudArchive?: string;
  maxSnapshotAgeHours?: number;
  allowLegacyLocal?: boolean;
  writerExcluded?: boolean;
}): GitcrawlMigrationReport {
  const jobsDirectory = path.resolve(input.jobsDirectory);
  if (!fs.statSync(jobsDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Gitcrawl migration jobs directory not found: ${jobsDirectory}`);
  }
  const jobsTreeRoot = activeJobsTreeRoot(jobsDirectory);
  const archiveDirectory = path.resolve(
    input.archiveDirectory ?? path.join(path.dirname(jobsTreeRoot), ".legacy-gitcrawl-quarantine"),
  );
  const jobsTreeRealRoot = fs.realpathSync(jobsTreeRoot);
  const archiveRealPath = resolveThroughExistingParents(archiveDirectory);
  if (
    pathIsInside(jobsTreeRoot, archiveDirectory) ||
    pathIsInside(jobsTreeRealRoot, archiveRealPath)
  ) {
    throw new Error(
      `Gitcrawl migration archive must be outside the active jobs tree: ${archiveDirectory}`,
    );
  }
  const current: CurrentJob[] = [];
  const legacy: LegacyJob[] = [];
  const invalid: { path: string; reason: string }[] = [];
  const files = markdownFiles(jobsDirectory, archiveDirectory);

  for (const absolutePath of files) {
    const relativePath = portablePath(path.relative(jobsDirectory, absolutePath));
    const source = readPinnedMigrationSource(absolutePath);
    const raw = source.raw;
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match?.[1]) {
      recordMalformedGeneratedJob(relativePath, raw, "missing YAML frontmatter", invalid);
      continue;
    }
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseSimpleYaml(match[1]);
    } catch (error) {
      recordMalformedGeneratedJob(
        relativePath,
        raw,
        error instanceof Error ? error.message : String(error),
        invalid,
      );
      continue;
    }
    const clusterId = String(frontmatter.cluster_id ?? "").trim();
    const repository = String(frontmatter.repo ?? "").trim();
    const currentIdentity = currentJobIdentity(clusterId);
    if (
      currentIdentity !== undefined ||
      frontmatter.gitcrawl_evidence_schema !== undefined ||
      frontmatter.gitcrawl_evidence_required === true
    ) {
      try {
        if (frontmatter.gitcrawl_evidence_schema !== GITCRAWL_JOB_EVIDENCE_SCHEMA) {
          throw new Error(`missing ${GITCRAWL_JOB_EVIDENCE_SCHEMA} schema`);
        }
        if (frontmatter.gitcrawl_evidence_required !== true) {
          throw new Error("missing gitcrawl_evidence_required: true");
        }
        if (currentIdentity === undefined) {
          throw new Error("versioned evidence job has an unrecognized cluster id");
        }
        const packet = verifyEmbeddedGitcrawlEvidencePacket(raw, repository, true);
        verifyGitcrawlEvidenceJobTargets(packet!, frontmatter);
        current.push({
          path: relativePath,
          repository,
          kind: currentIdentity.kind,
          ...(currentIdentity.clusterNumber === undefined
            ? {}
            : { clusterNumber: currentIdentity.clusterNumber }),
          targets: targetSet(frontmatter),
        });
      } catch (error) {
        invalid.push({
          path: relativePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    const legacyIdentity = legacyJobIdentity(clusterId);
    if (legacyIdentity === undefined) continue;
    const targets = [...targetSet(frontmatter)].sort();
    if (!/^[^/]+\/[^/]+$/.test(repository) || targets.length === 0) {
      invalid.push({
        path: relativePath,
        reason: "legacy Gitcrawl job is missing a repository or target inventory",
      });
      continue;
    }
    legacy.push({
      absolutePath,
      relativePath,
      repository,
      clusterId,
      kind: legacyIdentity.kind,
      ...(legacyIdentity.clusterNumber === undefined
        ? {}
        : { clusterNumber: legacyIdentity.clusterNumber }),
      mode: ["plan", "execute", "autonomous"].includes(String(frontmatter.mode))
        ? String(frontmatter.mode)
        : "plan",
      targets,
      sourceSha256: source.sha256,
      sourceSize: source.size,
      sourceDevice: source.device,
      sourceInode: source.inode,
    });
  }

  const entries = legacy
    .map((job) => migrationEntry(job, current, jobsDirectory, archiveDirectory, input))
    .sort((left, right) => left.path.localeCompare(right.path));
  invalid.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: "clawsweeper-gitcrawl-evidence-migration-v2",
    jobs_directory: jobsDirectory,
    archive_directory: archiveDirectory,
    summary: {
      markdown_files: files.length,
      current_jobs: current.length,
      legacy_jobs: entries.length,
      legacy_ready_to_archive: entries.filter((entry) => entry.ready_to_archive).length,
      invalid_jobs: invalid.length,
    },
    legacy_jobs: entries,
    invalid_jobs: invalid,
    operator_sequence: [
      "Run every reimport command for entries without replacement_paths.",
      "Validate each replacement job and inspect its current snapshot targets.",
      "Run the preflight again with --require-replacements.",
      ...(entries.some(
        (entry) => entry.writer_exclusion_required && !entry.writer_exclusion_confirmed,
      )
        ? [
            "Exclude active queue writers, then rerun the preflight with --writer-excluded before any archive command.",
          ]
        : []),
      "Run archive commands only for entries marked ready_to_archive.",
      "Retain each rollback command until the replacement queue has been validated.",
      "Run the preflight with --require-clean before enabling legacy-job quarantine.",
    ],
  };
}

function migrationEntry(
  job: LegacyJob,
  current: CurrentJob[],
  jobsDirectory: string,
  archiveDirectory: string,
  options: Parameters<typeof inventoryGitcrawlEvidenceMigration>[0],
): GitcrawlMigrationEntry {
  const replacements = current
    .filter((candidate) => replacementMatches(job, candidate))
    .map((candidate) => candidate.path)
    .sort();
  const outputDirectory = path.dirname(job.absolutePath);
  const archiveDestination = path.join(archiveDirectory, job.relativePath);
  const writerExclusionRequired = true;
  const writerExclusionConfirmed = options.writerExcluded === true;
  const archiveFlags = writerExclusionConfirmed ? ["--writer-excluded"] : [];
  const sourceBindingFlags = [
    "--expected-sha256",
    job.sourceSha256,
    "--expected-size",
    String(job.sourceSize),
  ];
  const clusterMigrationSuffix =
    job.kind === "cluster" ? availableClusterMigrationSuffix(job, outputDirectory) : undefined;
  const reimport =
    job.kind === "cluster"
      ? command("node", [
          "dist/repair/import-gitcrawl-clusters.js",
          String(job.clusterNumber),
          "--repo",
          job.repository,
          "--out",
          outputDirectory,
          "--mode",
          job.mode,
          "--skip-existing",
          "false",
          "--suffix",
          clusterMigrationSuffix!,
          ...providerArgs(options),
        ])
      : command("node", [
          "dist/repair/import-gitcrawl-low-signal-prs.js",
          "--repo",
          job.repository,
          "--out",
          outputDirectory,
          "--mode",
          job.mode,
          "--limit",
          String(Math.max(1, job.targets.length)),
          "--batch-size",
          String(Math.max(1, job.targets.length)),
          "--scan-limit",
          String(Math.max(200, job.targets.length * 20)),
          "--skip-existing",
          "false",
          ...providerArgs(options),
        ]);
  return {
    path: job.relativePath,
    repository: job.repository,
    cluster_id: job.clusterId,
    kind: job.kind,
    targets: job.targets,
    replacement_paths: replacements,
    ready_to_archive: replacements.length > 0 && writerExclusionConfirmed,
    writer_exclusion_required: writerExclusionRequired,
    writer_exclusion_confirmed: writerExclusionConfirmed,
    source_sha256: job.sourceSha256,
    source_size: job.sourceSize,
    source_device: job.sourceDevice,
    source_inode: job.sourceInode,
    reimport_strategy: job.kind === "cluster" ? "exact_cluster" : "current_policy_rescan",
    reimport,
    archive: command("node", [
      "dist/repair/gitcrawl-evidence-archive.js",
      "archive",
      path.join(jobsDirectory, job.relativePath),
      archiveDestination,
      ...sourceBindingFlags,
      "--expected-dev",
      String(job.sourceDevice),
      "--expected-ino",
      String(job.sourceInode),
      ...archiveFlags,
    ]),
    rollback: command("node", [
      "dist/repair/gitcrawl-evidence-archive.js",
      "rollback",
      archiveDestination,
      path.join(jobsDirectory, job.relativePath),
      ...sourceBindingFlags,
      ...archiveFlags,
    ]),
  };
}

function availableClusterMigrationSuffix(job: LegacyJob, outputDirectory: string): string {
  const clusterNumber = job.clusterNumber;
  if (clusterNumber === undefined) {
    throw new Error(`legacy Gitcrawl cluster job has no cluster number: ${job.relativePath}`);
  }
  const digest = sha256Canonical({
    path: job.relativePath,
    repository: job.repository,
    cluster: clusterNumber,
  }).slice(0, 12);
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const suffix = `migration-${digest}${attempt === 1 ? "" : `-${attempt}`}`;
    const candidate = path.join(
      outputDirectory,
      `gitcrawl-evidence-v1-${clusterNumber}-${suffix}.md`,
    );
    if (!fs.existsSync(candidate)) return suffix;
  }
  throw new Error(`unable to allocate Gitcrawl migration output for ${job.relativePath}`);
}

function replacementMatches(legacy: LegacyJob, current: CurrentJob): boolean {
  if (legacy.repository !== current.repository || legacy.kind !== current.kind) return false;
  if (legacy.kind === "cluster") return legacy.clusterNumber === current.clusterNumber;
  return legacy.targets.length > 0 && legacy.targets.every((target) => current.targets.has(target));
}

function providerArgs(options: Parameters<typeof inventoryGitcrawlEvidenceMigration>[0]): string[] {
  const args = ["--gitcrawl-provider", options.provider ?? "local"];
  if (options.dbPath) args.push("--db", path.resolve(options.dbPath));
  if (options.cloudUrl) args.push("--cloud-url", options.cloudUrl);
  if (options.cloudArchive) args.push("--cloud-archive", options.cloudArchive);
  if (options.maxSnapshotAgeHours !== undefined) {
    args.push("--max-snapshot-age-hours", String(options.maxSnapshotAgeHours));
  }
  if (options.allowLegacyLocal) args.push("--allow-legacy-local");
  return args;
}

function currentJobIdentity(
  clusterId: string,
): { kind: "cluster" | "low_signal"; clusterNumber?: number } | undefined {
  const cluster = /^(?:gitcrawl|ghcrawl)-evidence-v1-(\d+)(?:-|$)/.exec(clusterId);
  if (cluster?.[1]) return { kind: "cluster", clusterNumber: Number(cluster[1]) };
  if (/^low-signal-pr-sweep-v1-\d/.test(clusterId)) return { kind: "low_signal" };
  return undefined;
}

function legacyJobIdentity(
  clusterId: string,
): { kind: "cluster" | "low_signal"; clusterNumber?: number } | undefined {
  const cluster = /^(?:gitcrawl|ghcrawl)-(\d+)(?:-|$)/.exec(clusterId);
  if (cluster?.[1]) return { kind: "cluster", clusterNumber: Number(cluster[1]) };
  if (/^low-signal-pr-sweep-\d/.test(clusterId)) return { kind: "low_signal" };
  return undefined;
}

function recordMalformedGeneratedJob(
  relativePath: string,
  raw: string,
  reason: string,
  invalid: { path: string; reason: string }[],
): void {
  const clusterId = raw.match(/^cluster_id:\s*["']?([^"' \r\n]+)["']?\s*$/m)?.[1] ?? "";
  if (currentJobIdentity(clusterId) === undefined && legacyJobIdentity(clusterId) === undefined) {
    return;
  }
  invalid.push({ path: relativePath, reason });
}

function targetSet(frontmatter: Record<string, unknown>): Set<string> {
  const targets = new Set<string>();
  for (const field of ["canonical", "candidates", "cluster_refs"]) {
    const values = frontmatter[field];
    if (!Array.isArray(values)) continue;
    for (const value of values) targets.add(String(value));
  }
  return targets;
}

function markdownFiles(root: string, archiveDirectory: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (path.resolve(absolute) === archiveDirectory) continue;
      if (entry.isDirectory() && entry.name === ".legacy-gitcrawl-quarantine") continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function activeJobsTreeRoot(jobsDirectory: string): string {
  let current = jobsDirectory;
  for (;;) {
    if (path.basename(current) === "jobs") return current;
    const parent = path.dirname(current);
    if (parent === current) return jobsDirectory;
    current = parent;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function resolveThroughExistingParents(candidate: string): string {
  const suffix: string[] = [];
  let current = candidate;
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat !== undefined) {
      const resolved = fs.realpathSync(current);
      return path.join(resolved, ...suffix.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Gitcrawl migration archive parent not found: ${candidate}`);
    }
    suffix.push(path.basename(current));
    current = parent;
  }
}

function command(commandName: string, args: string[]): GitcrawlMigrationCommand {
  return { command: commandName, args };
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function readPinnedMigrationSource(filePath: string): {
  raw: string;
  sha256: string;
  size: number;
  device: number;
  inode: number;
} {
  const pathStat = fs.lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Gitcrawl migration source must be a regular file: ${filePath}`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const pinned = fs.fstatSync(descriptor);
    if (!sameMigrationIdentity(pathStat, pinned)) {
      throw new Error(`Gitcrawl migration source changed before preflight: ${filePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor);
    const currentPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      currentPath === undefined ||
      !sameMigrationIdentity(pinned, afterRead) ||
      !sameMigrationIdentity(pinned, currentPath) ||
      bytes.byteLength !== pinned.size
    ) {
      throw new Error(`Gitcrawl migration source changed during preflight: ${filePath}`);
    }
    return {
      raw: bytes.toString("utf8"),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: pinned.size,
      device: pinned.dev,
      inode: pinned.ino,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameMigrationIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.mode === actual.mode &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}
