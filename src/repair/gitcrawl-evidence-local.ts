import crypto from "node:crypto";
import fs, { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  GITCRAWL_QUERY_COVERAGE,
  GITCRAWL_QUERY_CONTRACT_VERSION,
  GITCRAWL_QUERY_NAMES,
  type GitcrawlCoverageRow,
  type GitcrawlQueryEnvelope,
  type GitcrawlQueryName,
  type GitcrawlQueryRequest,
  type GitcrawlQuerySource,
  gitcrawlQueryDigest,
} from "./gitcrawl-evidence-contract.js";

export type LocalGitcrawlQuerySourceOptions = {
  dbPath: string;
  repository: string;
  allowLegacy: boolean;
};

export class LocalGitcrawlQuerySource implements GitcrawlQuerySource {
  readonly provider = "local";
  readonly legacy: boolean;

  readonly snapshotId: string;

  private readonly db: DatabaseSync;
  private readonly tempDir: string;
  private readonly repository: string;
  private readonly repoId: number;
  private readonly portable: boolean;
  private readonly sourceSyncAt: string;
  private readonly datasetGeneratedAt: string;
  private readonly coverage: GitcrawlCoverageRow[];
  private closed = false;

  private constructor(input: {
    db: DatabaseSync;
    tempDir: string;
    snapshotId: string;
    repository: string;
    repoId: number;
    portable: boolean;
    legacy: boolean;
    sourceSyncAt: string;
  }) {
    this.db = input.db;
    this.tempDir = input.tempDir;
    this.snapshotId = input.snapshotId;
    this.repository = input.repository;
    this.repoId = input.repoId;
    this.portable = input.portable;
    this.legacy = input.legacy;
    this.sourceSyncAt = input.sourceSyncAt;
    this.datasetGeneratedAt = this.resolveDatasetGeneratedAt();
    this.coverage = this.buildCoverage();
  }

  static async open(options: LocalGitcrawlQuerySourceOptions): Promise<LocalGitcrawlQuerySource> {
    const dbPath = path.resolve(options.dbPath);
    if (!fs.existsSync(dbPath)) throw new Error(`Gitcrawl database not found: ${dbPath}`);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawsweeper-gitcrawl-"));
    const snapshotPath = path.join(tempDir, "snapshot.db");
    let source: DatabaseSync | undefined;
    let snapshotDb: DatabaseSync | undefined;
    try {
      source = new DatabaseSync(dbPath, {
        readOnly: true,
        enableForeignKeyConstraints: false,
        timeout: 5_000,
      });
      source.exec(`vacuum into ${sqliteString(snapshotPath)}`);
      source.close();
      source = undefined;
      const snapshotId = `local:${await sha256File(snapshotPath)}`;
      snapshotDb = new DatabaseSync(snapshotPath, {
        readOnly: true,
        enableForeignKeyConstraints: false,
        timeout: 5_000,
      });
      const quickCheck = String(snapshotDb.prepare("pragma quick_check").get()?.quick_check ?? "");
      if (quickCheck !== "ok")
        throw new Error(`Gitcrawl snapshot quick_check failed: ${quickCheck}`);
      const repoId = repositoryId(snapshotDb, options.repository);
      const portableTable = tableExists(snapshotDb, "cluster_groups");
      const legacyTable = tableExists(snapshotDb, "clusters");
      const portableRows = portableTable
        ? Number(
            snapshotDb
              .prepare("select count(*) as value from cluster_groups where repo_id = ?")
              .get(repoId)?.value ?? 0,
          )
        : 0;
      const legacyRows = legacyTable
        ? Number(
            snapshotDb
              .prepare("select count(*) as value from clusters where repo_id = ?")
              .get(repoId)?.value ?? 0,
          )
        : 0;
      const portable = portableTable && (portableRows > 0 || legacyRows === 0);
      const legacy = legacyTable && !portable;
      if (!portable && !legacy) {
        throw new Error("Gitcrawl snapshot has no supported cluster tables");
      }
      if (legacy && !options.allowLegacy) {
        throw new Error(
          "legacy Gitcrawl schema requires --allow-legacy-local after explicit coverage review",
        );
      }
      const sourceSyncAt = localSourceSyncAt(snapshotDb, repoId);
      const opened = new LocalGitcrawlQuerySource({
        db: snapshotDb,
        tempDir,
        snapshotId,
        repository: options.repository,
        repoId,
        portable,
        legacy,
        sourceSyncAt,
      });
      snapshotDb = undefined;
      return opened;
    } catch (error) {
      try {
        source?.close();
      } catch {}
      try {
        snapshotDb?.close();
      } catch {}
      await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async query(request: GitcrawlQueryRequest): Promise<GitcrawlQueryEnvelope> {
    if (request.snapshot_id && request.snapshot_id !== this.snapshotId) {
      throw new Error(
        `local Gitcrawl snapshot mismatch: ${request.snapshot_id} != ${this.snapshotId}`,
      );
    }
    const offset = decodeCursor(request.cursor, request.name, request.args, this.snapshotId);
    if (request.name === "gitcrawl.clusters.list" || request.name === "gitcrawl.threads.search") {
      const pageRows =
        request.name === "gitcrawl.clusters.list"
          ? this.clusterListRows(request.args, request.limit + 1, offset)
          : this.threadSearchRows(request.args, request.limit + 1, offset);
      const hasNext = pageRows.length > request.limit;
      return this.envelope(
        request.name,
        request.args,
        pageRows.slice(0, request.limit),
        hasNext ? offset + request.limit : null,
      );
    }
    const pageRows = this.queryRows(request.name, request.args, request.limit + 1, offset);
    const hasNext = pageRows.length > request.limit;
    return this.envelope(
      request.name,
      request.args,
      pageRows.slice(0, request.limit),
      hasNext ? offset + request.limit : null,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      await rm(this.tempDir, { force: true, recursive: true });
    }
  }

  private queryRows(
    name: GitcrawlQueryName,
    args: Record<string, unknown>,
    limit = -1,
    offset = 0,
  ): Record<string, unknown>[] {
    switch (name) {
      case "gitcrawl.coverage":
        return sliceRows(
          this.coverage.filter(
            (row) => !args.dataset || row.dataset === String(args.dataset),
          ) as unknown as Record<string, unknown>[],
          limit,
          offset,
        );
      case "gitcrawl.clusters.list":
        return this.clusterListRows(args, limit, offset);
      case "gitcrawl.clusters.members":
        return this.clusterMemberRows(
          positiveInteger(args.cluster_id, "cluster_id"),
          limit,
          offset,
        );
      case "gitcrawl.clusters.related":
        return this.relatedRows(positiveInteger(args.number, "number"), limit, offset);
      case "gitcrawl.pull_requests.review_context":
        return this.reviewContextRows(positiveInteger(args.number, "number"), limit, offset);
      case "gitcrawl.threads.search":
        return this.threadSearchRows(args, limit, offset);
    }
  }

  private clusterListRows(
    args: Record<string, unknown>,
    limit = -1,
    offset = 0,
  ): Record<string, unknown>[] {
    const status = String(args.status ?? "active");
    const minSize = nonNegativeInteger(args.min_size, 1);
    if (this.portable) {
      const filters = ["cg.repo_id = ?"];
      const binds: (string | number)[] = [this.repoId];
      if (status !== "all") {
        filters.push("cg.status = ?");
        binds.push(status);
      }
      const having = ["count(mt.id) >= ?"];
      const havingBinds: (string | number)[] = [minSize];
      binds.push(...havingBinds, limit, offset);
      return this.all(
        `select cg.id as cluster_id, cg.stable_key, cg.stable_slug, cg.status,
                cg.cluster_type, cg.title, cg.representative_thread_id,
                rt.number as representative_number, rt.kind as representative_kind,
                rt.state as representative_state, rt.title as representative_title,
                count(mt.id) as member_count, cg.created_at, cg.updated_at, cg.closed_at
         from cluster_groups cg
         left join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
         left join threads mt on mt.id = cm.thread_id and mt.repo_id = cg.repo_id
         left join threads rt on rt.id = cg.representative_thread_id and rt.repo_id = cg.repo_id
         where ${filters.join(" and ")}
         group by cg.id
         having ${having.join(" and ")}
         order by member_count desc, julianday(cg.updated_at) desc, cg.id asc
         limit ? offset ?`,
        ...binds,
      );
    }
    const filters = ["c.repo_id = ?", "c.member_count >= ?"];
    const binds: (string | number)[] = [this.repoId, minSize];
    const updatedAt = columnExists(this.db, "clusters", "updated_at")
      ? "c.updated_at"
      : "c.created_at";
    if (status === "active") filters.push("c.closed_at_local is null");
    if (status === "closed") filters.push("c.closed_at_local is not null");
    binds.push(limit, offset);
    return this.all(
      `select c.id as cluster_id, '' as stable_key,
              'legacy-' || c.id as stable_slug,
              case when c.closed_at_local is null then 'active' else 'closed' end as status,
              '' as cluster_type, rt.title as title, c.representative_thread_id,
              rt.number as representative_number, rt.kind as representative_kind,
              rt.state as representative_state, rt.title as representative_title,
              c.member_count, c.created_at, ${updatedAt} as updated_at,
              c.closed_at_local as closed_at
       from clusters c
       left join threads rt on rt.id = c.representative_thread_id and rt.repo_id = c.repo_id
       where ${filters.join(" and ")}
       order by c.member_count desc, julianday(${updatedAt}) desc, c.id asc
       limit ? offset ?`,
      ...binds,
    );
  }

  private clusterMemberRows(clusterId: number, limit = -1, offset = 0): Record<string, unknown>[] {
    const body = this.threadColumn("t", "body", this.threadColumn("t", "body_excerpt", "''"));
    const labels = this.threadColumn("t", "labels_json", "null");
    const assignees = this.threadColumn("t", "assignees_json", "null");
    const association = this.threadColumn("t", "author_association", "null");
    const authorLogin = this.threadColumn("t", "author_login", "''");
    const authorType = this.threadColumn("t", "author_type", "''");
    const htmlUrl = this.threadColumn("t", "html_url", "''");
    const isDraft = this.threadColumn("t", "is_draft", "0");
    const createdAtGh = this.threadColumn("t", "created_at_gh", "''");
    const updatedAtGh = this.threadColumn("t", "updated_at_gh", "''");
    const updatedAt = this.threadUpdatedAt("t");
    const enrichment = this.enrichmentSelects("t");
    const securityMetadataComplete = this.securityMetadataComplete();
    if (this.portable) {
      return this.all(
        `select cg.id as cluster_id, cg.stable_slug, cg.status as cluster_status,
                cm.role, cm.state as membership_state, cm.score_to_representative,
                count(*) over () as cluster_member_count,
                t.id as thread_id, t.number, t.kind, t.state, t.title,
                ${body} as body, ${authorLogin} as author_login, ${authorType} as author_type,
                ${association} as author_association, ${htmlUrl} as html_url,
                ${labels} as labels_json, ${assignees} as assignees_json,
                ${securityMetadataComplete} as security_metadata_complete,
                ${isDraft} as is_draft, ${createdAtGh} as created_at_gh,
                ${updatedAtGh} as updated_at_gh, ${updatedAt} as updated_at,
                ${enrichment}
         from cluster_groups cg
         join cluster_memberships cm on cm.cluster_id = cg.id
         join threads t on t.id = cm.thread_id and t.repo_id = cg.repo_id
         where cg.repo_id = ? and cg.id = ? and cm.state = 'active'
         order by case cm.role when 'canonical' then 0 when 'representative' then 1 else 2 end,
                  coalesce(cm.score_to_representative, 0) desc, t.number asc
         limit ? offset ?`,
        this.repoId,
        clusterId,
        limit,
        offset,
      );
    }
    return this.all(
      `select c.id as cluster_id, 'legacy-' || c.id as stable_slug,
              case when c.closed_at_local is null then 'active' else 'closed' end as cluster_status,
              case when c.representative_thread_id = t.id then 'representative' else 'member' end as role,
              'active' as membership_state, null as score_to_representative,
              count(*) over () as cluster_member_count,
              t.id as thread_id, t.number, t.kind, t.state, t.title,
              ${body} as body, ${authorLogin} as author_login, ${authorType} as author_type,
              ${association} as author_association, ${htmlUrl} as html_url,
              ${labels} as labels_json, ${assignees} as assignees_json,
              ${securityMetadataComplete} as security_metadata_complete,
              ${isDraft} as is_draft, ${createdAtGh} as created_at_gh,
              ${updatedAtGh} as updated_at_gh, ${updatedAt} as updated_at,
              ${enrichment}
       from clusters c
       join cluster_members cm on cm.cluster_id = c.id
       join threads t on t.id = cm.thread_id and t.repo_id = c.repo_id
       where c.repo_id = ? and c.id = ?
       order by case when c.representative_thread_id = t.id then 0 else 1 end, t.number asc
       limit ? offset ?`,
      this.repoId,
      clusterId,
      limit,
      offset,
    );
  }

  private relatedRows(number: number, limit: number, offset: number): Record<string, unknown>[] {
    const membershipTable = this.portable ? "cluster_memberships" : "cluster_members";
    const stateFilter = this.portable ? "and cm.state = 'active'" : "";
    const rows: Record<string, unknown>[] = [];
    let remainingOffset = offset;
    const clusters = this.db
      .prepare(
        `select cm.cluster_id
         from ${membershipTable} cm
         join threads t on t.id = cm.thread_id
         where t.repo_id = ? and t.number = ? ${stateFilter}
         order by cm.cluster_id`,
      )
      .iterate(this.repoId, number);
    for (const rawCluster of clusters) {
      const clusterId = Number(rawCluster.cluster_id);
      let memberOffset = 0;
      while (rows.length < limit) {
        const members = this.clusterMemberRows(clusterId, Math.min(128, limit + 1), memberOffset);
        if (members.length === 0) break;
        for (const member of members) {
          if (Number(member.number) === number) continue;
          if (remainingOffset > 0) {
            remainingOffset -= 1;
            continue;
          }
          rows.push({ source_number: number, ...member });
          if (rows.length >= limit) break;
        }
        memberOffset += members.length;
        if (members.length < Math.min(128, limit + 1)) break;
      }
      if (rows.length >= limit) break;
    }
    return rows;
  }

  private reviewContextRows(
    number: number,
    limit: number,
    offset: number,
  ): Record<string, unknown>[] {
    if (!tableExists(this.db, "pull_request_details")) return [];
    const body = this.threadColumn("t", "body", this.threadColumn("t", "body_excerpt", "''"));
    const labels = this.threadColumn("t", "labels_json", "null");
    const assignees = this.threadColumn("t", "assignees_json", "null");
    const association = this.threadColumn("t", "author_association", "null");
    const authorLogin = this.threadColumn("t", "author_login", "''");
    const authorType = this.threadColumn("t", "author_type", "''");
    const htmlUrl = this.threadColumn("t", "html_url", "''");
    const isDraft = this.threadColumn("t", "is_draft", "0");
    const createdAtGh = this.threadColumn("t", "created_at_gh", "''");
    const updatedAtGh = this.threadColumn("t", "updated_at_gh", "''");
    const mergedAtGh = this.threadColumn("t", "merged_at_gh", "''");
    const enrichment = this.enrichmentSelects("t");
    const securityMetadataComplete = this.securityMetadataComplete();
    const clusterContext = this.reviewClusterContext();
    const detailsFetchedAt = this.tableColumn("pull_request_details", "pr", "fetched_at", "''");
    const detailsUpdatedAt = this.tableColumn("pull_request_details", "pr", "updated_at", "''");
    const context = this.all(
      `select 'context' as row_kind, t.id as thread_id, t.number, t.kind, t.state, t.title,
              ${body} as body, ${authorLogin} as author_login, ${authorType} as author_type,
              ${association} as author_association, ${htmlUrl} as html_url,
              ${labels} as labels_json, ${assignees} as assignees_json,
              ${securityMetadataComplete} as security_metadata_complete,
              ${isDraft} as is_draft, ${createdAtGh} as created_at_gh,
              ${updatedAtGh} as updated_at_gh, ${mergedAtGh} as merged_at_gh,
              pr.base_sha, pr.head_sha, pr.head_ref, pr.head_repo_full_name,
              pr.mergeable_state, pr.additions, pr.deletions, pr.changed_files,
              ${detailsFetchedAt} as details_fetched_at,
              ${detailsUpdatedAt} as details_updated_at,
              ${clusterContext.select},
              ${enrichment}
       from threads t
       left join pull_request_details pr on pr.thread_id = t.id
       ${clusterContext.joins}
       where t.repo_id = ? and t.number = ? and t.kind = 'pull_request'
       limit 1`,
      this.repoId,
      number,
    );
    if (context.length === 0) return [];
    const threadId = Number(context[0]!.thread_id);
    const returnedContext = offset === 0 ? context : [];
    const fileLimit = Math.max(0, limit - returnedContext.length);
    const files =
      tableExists(this.db, "pull_request_files") && fileLimit > 0
        ? this.all(
            `select 'file' as row_kind, thread_id, position as file_position,
                  path as file_path, status as file_status,
                  additions as file_additions, deletions as file_deletions,
                  changes as file_changes, previous_path as file_previous_path,
                  fetched_at as file_fetched_at
           from pull_request_files
           where thread_id = ?
           order by position
           limit ? offset ?`,
            threadId,
            fileLimit,
            Math.max(0, offset - 1),
          )
        : [];
    return [...returnedContext, ...files];
  }

  private threadSearchRows(
    args: Record<string, unknown>,
    limit = -1,
    offset = 0,
  ): Record<string, unknown>[] {
    const body = this.threadColumn("t", "body", this.threadColumn("t", "body_excerpt", "''"));
    const labels = this.threadColumn("t", "labels_json", "null");
    const assignees = this.threadColumn("t", "assignees_json", "null");
    const association = this.threadColumn("t", "author_association", "null");
    const authorLogin = this.threadColumn("t", "author_login", "''");
    const authorType = this.threadColumn("t", "author_type", "''");
    const htmlUrl = this.threadColumn("t", "html_url", "''");
    const isDraft = this.threadColumn("t", "is_draft", "0");
    const createdAtGh = this.threadColumn("t", "created_at_gh", "''");
    const updatedAtGh = this.threadColumn("t", "updated_at_gh", "''");
    const closedAtGh = this.threadColumn("t", "closed_at_gh", "''");
    const mergedAtGh = this.threadColumn("t", "merged_at_gh", "''");
    const securityMetadataComplete = this.securityMetadataComplete();
    const filters = ["t.repo_id = ?"];
    const binds: (string | number)[] = [this.repoId];
    const query = String(args.query ?? "")
      .trim()
      .toLowerCase();
    if (query) {
      filters.push(`(lower(t.title) like ? escape '\\' or lower(${body}) like ? escape '\\')`);
      const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      binds.push(pattern, pattern);
    }
    const kind = String(args.kind ?? "");
    if (kind) {
      filters.push("t.kind = ?");
      binds.push(kind);
    }
    const state = String(args.state ?? "");
    if (state && state !== "all") {
      filters.push("t.state = ?");
      binds.push(state);
    }
    const order = String(args.order ?? "newest");
    if (!["newest", "oldest"].includes(order)) {
      throw new Error("Gitcrawl thread search order must be newest or oldest");
    }
    const direction = order === "oldest" ? "asc" : "desc";
    const updatedAt = this.threadUpdatedAt("t");
    binds.push(limit, offset);
    return this.all(
      `select t.id as thread_id, t.number, t.kind, t.state, t.title, ${body} as body,
              ${authorLogin} as author_login, ${authorType} as author_type,
              ${association} as author_association, ${htmlUrl} as html_url,
              ${labels} as labels_json, ${assignees} as assignees_json,
              ${securityMetadataComplete} as security_metadata_complete,
              ${isDraft} as is_draft, ${createdAtGh} as created_at_gh,
              ${updatedAtGh} as updated_at_gh, ${closedAtGh} as closed_at_gh,
              ${mergedAtGh} as merged_at_gh, ${updatedAt} as updated_at
       from threads t
       where ${filters.join(" and ")}
       order by julianday(${updatedAt}) ${direction}, t.number ${direction}
       limit ? offset ?`,
      ...binds,
    );
  }

  private buildCoverage(): GitcrawlCoverageRow[] {
    const rows: GitcrawlCoverageRow[] = [];
    const generatedAt = this.datasetGeneratedAt;
    const repoCount = this.scalarNumber(
      "select count(*) as value from repositories where id = ?",
      this.repoId,
    );
    const threadCount = this.scalarNumber(
      "select count(*) as value from threads where repo_id = ?",
      this.repoId,
    );
    rows.push(
      metric("repositories", repoCount, repoCount, repoCount, this.sourceSyncAt, generatedAt),
    );
    rows.push(
      metric("threads", threadCount, threadCount, threadCount, this.sourceSyncAt, generatedAt),
    );

    const revisions = this.threadChildCoverage("thread_revisions", "");
    rows.push(
      metric(
        "thread_revisions",
        revisions.rows,
        threadCount,
        revisions.covered,
        revisions.latest,
        generatedAt,
      ),
    );
    const fingerprints = this.threadRevisionChildCoverage(
      "thread_fingerprints",
      "and child.algorithm_version = 'thread-fingerprint-v2'",
    );
    rows.push(
      metric(
        "thread_fingerprints",
        fingerprints.rows,
        threadCount,
        fingerprints.covered,
        fingerprints.latest,
        generatedAt,
      ),
    );
    const summaries = this.threadRevisionChildCoverage("thread_key_summaries", "");
    rows.push(
      metric(
        "thread_key_summaries",
        summaries.rows,
        threadCount,
        summaries.covered,
        summaries.latest,
        generatedAt,
      ),
    );

    const clusterTable = this.portable ? "cluster_groups" : "clusters";
    const membershipTable = this.portable ? "cluster_memberships" : "cluster_members";
    const activeClusterWhere = this.portable ? "status = 'active'" : "closed_at_local is null";
    const activeClusterAliasWhere = this.portable
      ? "c.status = 'active'"
      : "c.closed_at_local is null";
    const membershipWhere = this.portable ? "cm.state = 'active'" : "1 = 1";
    const clusterRows = tableExists(this.db, clusterTable)
      ? this.scalarNumber(
          `select count(*) as value from ${clusterTable} where repo_id = ? and ${activeClusterWhere}`,
          this.repoId,
        )
      : 0;
    const clusterCovered = tableExists(this.db, membershipTable)
      ? this.scalarNumber(
          `select count(*) as value
             from ${clusterTable} c
             where c.repo_id = ? and ${activeClusterAliasWhere}
               and not exists (
                 select 1
                 from ${membershipTable} cm
                 left join threads t on t.id = cm.thread_id and t.repo_id = c.repo_id
                 where cm.cluster_id = c.id and ${membershipWhere}
                   and t.id is null
               )`,
          this.repoId,
        )
      : 0;
    rows.push(
      metric(
        "cluster_groups",
        clusterRows,
        clusterRows,
        clusterCovered,
        this.repositoryTableMax(
          clusterTable,
          columnExists(this.db, clusterTable, "updated_at") ? "updated_at" : "created_at",
        ),
        generatedAt,
      ),
    );
    const activeClusterFilter = this.portable ? "c.status = 'active'" : "c.closed_at_local is null";
    const membershipRows = tableExists(this.db, membershipTable)
      ? this.scalarNumber(
          `select count(*) as value
           from ${membershipTable} cm
           join ${clusterTable} c on c.id = cm.cluster_id
           where c.repo_id = ? and ${activeClusterFilter} and ${membershipWhere}`,
          this.repoId,
        )
      : 0;
    const membershipCovered = tableExists(this.db, membershipTable)
      ? this.scalarNumber(
          `select count(*) as value
           from ${membershipTable} cm
           join ${clusterTable} c on c.id = cm.cluster_id
           join threads t on t.id = cm.thread_id and t.repo_id = c.repo_id
           where c.repo_id = ? and ${activeClusterFilter} and ${membershipWhere}`,
          this.repoId,
        )
      : 0;
    rows.push(
      metric(
        "cluster_memberships",
        membershipRows,
        membershipRows,
        membershipCovered,
        this.repositoryTableMax(
          membershipTable,
          columnExists(this.db, membershipTable, "updated_at") ? "updated_at" : "created_at",
        ),
        generatedAt,
      ),
    );

    const prEligible = this.scalarNumber(
      "select count(*) as value from threads where repo_id = ? and kind = 'pull_request'",
      this.repoId,
    );
    const prRows = tableExists(this.db, "pull_request_details")
      ? this.scalarNumber(
          `select count(*) as value
           from pull_request_details pr
           join threads t on t.id = pr.thread_id
           where t.repo_id = ?`,
          this.repoId,
        )
      : 0;
    const prFreshness = this.pullRequestFreshness("pr");
    const prCovered =
      tableExists(this.db, "pull_request_details") && prFreshness !== "''"
        ? this.scalarNumber(
            `select count(*) as value
           from pull_request_details pr
           join threads t on t.id = pr.thread_id
           where t.repo_id = ?
             and julianday(${prFreshness})
                 >= julianday(${this.threadUpdatedAt("t")})`,
            this.repoId,
          )
        : 0;
    rows.push(
      metric(
        "pull_request_details",
        prRows,
        prEligible,
        prCovered,
        this.repositoryTableMax("pull_request_details", "fetched_at"),
        generatedAt,
      ),
    );
    const hasChangedFiles =
      tableExists(this.db, "pull_request_details") &&
      columnExists(this.db, "pull_request_details", "changed_files");
    const fileEligible = hasChangedFiles
      ? this.scalarNumber(
          `select coalesce(sum(pr.changed_files), 0) as value
           from pull_request_details pr
           join threads t on t.id = pr.thread_id
           where t.repo_id = ?`,
          this.repoId,
        )
      : 0;
    const fileRows = tableExists(this.db, "pull_request_files")
      ? this.scalarNumber(
          `select count(*) as value
           from pull_request_files pf
           join threads t on t.id = pf.thread_id
           where t.repo_id = ?`,
          this.repoId,
        )
      : 0;
    const fileCovered =
      tableExists(this.db, "pull_request_files") &&
      tableExists(this.db, "pull_request_details") &&
      hasChangedFiles &&
      columnExists(this.db, "pull_request_files", "position") &&
      columnExists(this.db, "pull_request_files", "fetched_at") &&
      prFreshness !== "''"
        ? this.scalarNumber(
            `select coalesce(sum(pr.changed_files), 0) as value
             from pull_request_details pr
             join threads t on t.id = pr.thread_id
             where t.repo_id = ?
               and (
                 select count(*)
                 from pull_request_files pf
                 where pf.thread_id = pr.thread_id
               ) = pr.changed_files
               and (
                 select count(distinct pf.position)
                 from pull_request_files pf
                 where pf.thread_id = pr.thread_id
               ) = pr.changed_files
               and (
                 pr.changed_files = 0 or (
                   select min(pf.position) = 0 and max(pf.position) = pr.changed_files - 1
                   from pull_request_files pf
                   where pf.thread_id = pr.thread_id
                 )
               )
               and julianday(${prFreshness}) is not null
               and not exists (
                 select 1
                 from pull_request_files pf
                 where pf.thread_id = pr.thread_id
                   and (
                     julianday(pf.fetched_at) is null
                     or julianday(pf.fetched_at)
                        < julianday(${prFreshness})
                   )
               )`,
            this.repoId,
          )
        : 0;
    const fileCoverage = metric(
      "pull_request_files",
      fileRows,
      fileEligible,
      fileCovered,
      this.repositoryTableMax("pull_request_files", "fetched_at"),
      generatedAt,
    );
    fileCoverage.complete =
      hasChangedFiles &&
      columnExists(this.db, "pull_request_files", "position") &&
      columnExists(this.db, "pull_request_files", "fetched_at") &&
      prFreshness !== "''" &&
      fileRows === fileEligible &&
      fileCovered === fileEligible;
    rows.push(fileCoverage);
    return rows;
  }

  private threadChildCoverage(
    table: string,
    condition: string,
  ): { rows: number; covered: number; latest: string } {
    if (!tableExists(this.db, table)) return { rows: 0, covered: 0, latest: "" };
    const rows = this.scalarNumber(
      `select count(*) as value
       from ${table} child join threads t on t.id = child.thread_id
       where t.repo_id = ? ${condition}`,
      this.repoId,
    );
    const covered = this.scalarNumber(
      `select count(*) as value
       from threads t
       where t.repo_id = ? and exists (
         select 1 from ${table} child
         where child.thread_id = t.id ${condition}
           and julianday(coalesce(nullif(child.source_updated_at, ''), child.created_at))
               >= julianday(${this.threadUpdatedAt("t")})
       )`,
      this.repoId,
    );
    return { rows, covered, latest: this.repositoryTableMax(table, "created_at") };
  }

  private threadRevisionChildCoverage(
    table: string,
    condition: string,
  ): { rows: number; covered: number; latest: string } {
    if (!tableExists(this.db, table) || !tableExists(this.db, "thread_revisions")) {
      return { rows: 0, covered: 0, latest: "" };
    }
    const rows = this.scalarNumber(
      `select count(*) as value
       from ${table} child
       join thread_revisions revision on revision.id = child.thread_revision_id
       join threads t on t.id = revision.thread_id
       where t.repo_id = ? ${condition}`,
      this.repoId,
    );
    const covered = this.scalarNumber(
      `select count(*) as value
       from threads t
       where t.repo_id = ? and exists (
         select 1
         from thread_revisions revision
         join ${table} child on child.thread_revision_id = revision.id
         where revision.thread_id = t.id ${condition}
           and julianday(coalesce(nullif(revision.source_updated_at, ''), revision.created_at))
               >= julianday(${this.threadUpdatedAt("t")})
       )`,
      this.repoId,
    );
    return { rows, covered, latest: this.repositoryTableMax(table, "created_at") };
  }

  private resolveDatasetGeneratedAt(): string {
    return latestTimestamp(
      this.sourceSyncAt,
      this.repositoryTableMax("thread_revisions", "created_at"),
      this.repositoryTableMax("thread_fingerprints", "created_at"),
      this.repositoryTableMax("thread_key_summaries", "created_at"),
      this.repositoryTableMax(
        this.portable ? "cluster_groups" : "clusters",
        columnExists(this.db, this.portable ? "cluster_groups" : "clusters", "updated_at")
          ? "updated_at"
          : "created_at",
      ),
      this.repositoryTableMax("pull_request_details", "fetched_at"),
      this.repositoryTableMax("pull_request_files", "fetched_at"),
    );
  }

  private enrichmentSelects(alias: string): string {
    if (!tableExists(this.db, "thread_revisions")) {
      return `null as revision_id, '' as revision_content_hash,
              '' as revision_source_updated_at, '' as key_summary,
              '' as fingerprint_algorithm, '' as fingerprint_hash, '' as fingerprint_slug`;
    }
    const latestRevision = `(select revision.id from thread_revisions revision
      where revision.thread_id = ${alias}.id
      order by julianday(coalesce(nullif(revision.source_updated_at, ''), revision.created_at)) desc,
               revision.id desc limit 1)`;
    const revisionId = latestRevision;
    const revisionHash = `(select revision.content_hash from thread_revisions revision
      where revision.id = ${latestRevision})`;
    const revisionUpdated = `(select coalesce(nullif(revision.source_updated_at, ''), revision.created_at)
      from thread_revisions revision
      where revision.id = ${latestRevision})`;
    const summary = tableExists(this.db, "thread_key_summaries")
      ? `(select summary.key_text from thread_key_summaries summary
          where summary.thread_revision_id = ${latestRevision}
          order by summary.created_at desc, summary.id desc limit 1)`
      : "''";
    const fingerprintAlgorithm = tableExists(this.db, "thread_fingerprints")
      ? `(select fingerprint.algorithm_version from thread_fingerprints fingerprint
          where fingerprint.thread_revision_id = ${latestRevision}
            and fingerprint.algorithm_version = 'thread-fingerprint-v2'
          order by fingerprint.created_at desc, fingerprint.id desc limit 1)`
      : "''";
    const fingerprintHash = tableExists(this.db, "thread_fingerprints")
      ? `(select fingerprint.fingerprint_hash from thread_fingerprints fingerprint
          where fingerprint.thread_revision_id = ${latestRevision}
            and fingerprint.algorithm_version = 'thread-fingerprint-v2'
          order by fingerprint.created_at desc, fingerprint.id desc limit 1)`
      : "''";
    const fingerprintSlug = tableExists(this.db, "thread_fingerprints")
      ? `(select fingerprint.fingerprint_slug from thread_fingerprints fingerprint
          where fingerprint.thread_revision_id = ${latestRevision}
            and fingerprint.algorithm_version = 'thread-fingerprint-v2'
          order by fingerprint.created_at desc, fingerprint.id desc limit 1)`
      : "''";
    return `${revisionId} as revision_id,
            ${revisionHash} as revision_content_hash,
            ${revisionUpdated} as revision_source_updated_at,
            ${summary} as key_summary,
            ${fingerprintAlgorithm} as fingerprint_algorithm,
            ${fingerprintHash} as fingerprint_hash,
            ${fingerprintSlug} as fingerprint_slug`;
  }

  private threadColumn(alias: string, column: string, fallback: string): string {
    return columnExists(this.db, "threads", column) ? `${alias}.${column}` : fallback;
  }

  private tableColumn(table: string, alias: string, column: string, fallback: string): string {
    return columnExists(this.db, table, column) ? `${alias}.${column}` : fallback;
  }

  private pullRequestFreshness(alias: string): string {
    const candidates = ["fetched_at", "updated_at"]
      .filter((column) => columnExists(this.db, "pull_request_details", column))
      .map((column) => `nullif(${alias}.${column}, '')`);
    return candidates.length === 0 ? "''" : `coalesce(${candidates.join(", ")}, '')`;
  }

  private reviewClusterContext(): { select: string; joins: string } {
    if (this.portable) {
      return {
        select: `cg.id as cluster_id, cg.stable_slug as cluster_slug,
                 cg.title as cluster_title, cg.status as cluster_status,
                 cm.role as cluster_role, cm.score_to_representative`,
        joins: `left join cluster_memberships cm
                  on cm.thread_id = t.id and cm.state = 'active' and cm.cluster_id = (
                    select candidate.cluster_id
                    from cluster_memberships candidate
                    join cluster_groups candidate_group on candidate_group.id = candidate.cluster_id
                    where candidate.thread_id = t.id and candidate.state = 'active'
                      and candidate_group.repo_id = t.repo_id
                    order by case candidate.role
                               when 'canonical' then 0
                               when 'representative' then 1
                               else 2
                             end,
                             candidate.cluster_id
                    limit 1
                  )
                left join cluster_groups cg
                  on cg.id = cm.cluster_id and cg.repo_id = t.repo_id`,
      };
    }
    return {
      select: `c.id as cluster_id, 'legacy-' || c.id as cluster_slug,
               rt.title as cluster_title,
               case when c.closed_at_local is null then 'active' else 'closed' end as cluster_status,
               case when c.representative_thread_id = t.id
                    then 'representative' else 'member' end as cluster_role,
               cm.score_to_representative`,
      joins: `left join cluster_members cm
                on cm.thread_id = t.id and cm.cluster_id = (
                  select candidate.cluster_id
                  from cluster_members candidate
                  join clusters candidate_cluster on candidate_cluster.id = candidate.cluster_id
                  where candidate.thread_id = t.id and candidate_cluster.repo_id = t.repo_id
                  order by case when candidate_cluster.representative_thread_id = t.id
                                then 0 else 1 end,
                           candidate.cluster_id
                  limit 1
                )
              left join clusters c on c.id = cm.cluster_id and c.repo_id = t.repo_id
              left join threads rt
                on rt.id = c.representative_thread_id and rt.repo_id = c.repo_id`,
    };
  }

  private securityMetadataComplete(): number {
    return columnExists(this.db, "threads", "title") &&
      columnExists(this.db, "threads", "body") &&
      columnExists(this.db, "threads", "labels_json")
      ? 1
      : 0;
  }

  private queryCoverageComplete(name: GitcrawlQueryName): boolean {
    const coverage = new Map(this.coverage.map((row) => [row.dataset, row.complete]));
    return GITCRAWL_QUERY_COVERAGE[name].every((dataset) => coverage.get(dataset) === true);
  }

  private envelope(
    name: GitcrawlQueryName,
    args: Record<string, unknown>,
    rows: Record<string, unknown>[],
    nextOffset: number | null,
  ): GitcrawlQueryEnvelope {
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return {
      columns,
      rows: rows.map((row) => columns.map((column) => row[column])),
      values: rows,
      snapshot: {
        id: this.snapshotId,
        source_sha256: this.snapshotId.slice("local:".length),
        schema_name: this.portable ? "gitcrawl-portable-sqlite" : "gitcrawl-legacy-sqlite",
        schema_version: Number(this.db.prepare("pragma user_version").get()?.user_version ?? 0),
        schema_hash: this.portable ? "gitcrawl-portable-sqlite" : "gitcrawl-legacy-sqlite",
        capabilities: [...GITCRAWL_QUERY_NAMES],
        source_sync_at: this.sourceSyncAt,
        dataset_generated_at: this.datasetGeneratedAt,
        coverage_complete: this.queryCoverageComplete(name),
        published_at: this.datasetGeneratedAt,
        cutover_at: this.datasetGeneratedAt,
      },
      stats: {
        contract_version: GITCRAWL_QUERY_CONTRACT_VERSION,
        repository: this.repository,
        archive: "local-sqlite",
        snapshot_id: this.snapshotId,
        source_sync_at: this.sourceSyncAt,
        dataset_generated_at: this.datasetGeneratedAt,
        coverage_complete: this.queryCoverageComplete(name),
        next_cursor:
          nextOffset === null ? "" : encodeCursor(name, args, this.snapshotId, nextOffset),
      },
    };
  }

  private threadUpdatedAt(alias: string): string {
    const candidates = ["updated_at_gh", "updated_at", "last_pulled_at"]
      .filter((column) => columnExists(this.db, "threads", column))
      .map((column) => `nullif(${alias}.${column}, '')`);
    if (candidates.length === 0) return sqliteString(this.sourceSyncAt);
    return `coalesce(${candidates.join(", ")}, '')`;
  }

  private repositoryTableMax(table: string, column: string): string {
    if (!tableExists(this.db, table) || !columnExists(this.db, table, column)) return "";
    const sources: Record<string, { from: string; where: string }> = {
      repositories: { from: "repositories source", where: "source.id = ?" },
      threads: { from: "threads source", where: "source.repo_id = ?" },
      thread_revisions: {
        from: "thread_revisions source join threads t on t.id = source.thread_id",
        where: "t.repo_id = ?",
      },
      thread_fingerprints: {
        from: `thread_fingerprints source
               join thread_revisions revision on revision.id = source.thread_revision_id
               join threads t on t.id = revision.thread_id`,
        where: "t.repo_id = ?",
      },
      thread_key_summaries: {
        from: `thread_key_summaries source
               join thread_revisions revision on revision.id = source.thread_revision_id
               join threads t on t.id = revision.thread_id`,
        where: "t.repo_id = ?",
      },
      cluster_groups: { from: "cluster_groups source", where: "source.repo_id = ?" },
      clusters: { from: "clusters source", where: "source.repo_id = ?" },
      cluster_memberships: {
        from: "cluster_memberships source join cluster_groups c on c.id = source.cluster_id",
        where: "c.repo_id = ?",
      },
      cluster_members: {
        from: "cluster_members source join clusters c on c.id = source.cluster_id",
        where: "c.repo_id = ?",
      },
      pull_request_details: {
        from: "pull_request_details source join threads t on t.id = source.thread_id",
        where: "t.repo_id = ?",
      },
      pull_request_files: {
        from: "pull_request_files source join threads t on t.id = source.thread_id",
        where: "t.repo_id = ?",
      },
    };
    const source = sources[table];
    if (!source) throw new Error(`unsupported Gitcrawl repository-scoped table: ${table}`);
    return String(
      this.db
        .prepare(`select max(source.${column}) as value from ${source.from} where ${source.where}`)
        .get(this.repoId)?.value ?? "",
    );
  }

  private scalarNumber(sql: string, ...params: (string | number)[]): number {
    return Number(this.db.prepare(sql).get(...params)?.value ?? 0);
  }

  private all(sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map(normalizeSqliteRow);
  }
}

function metric(
  dataset: GitcrawlCoverageRow["dataset"],
  rowCount: number,
  eligibleCount: number,
  coveredCount: number,
  maxSourceAt: string,
  generatedAt: string,
): GitcrawlCoverageRow {
  return {
    dataset,
    row_count: rowCount,
    eligible_count: eligibleCount,
    covered_count: coveredCount,
    max_source_at: maxSourceAt,
    dataset_generated_at: generatedAt,
    complete: eligibleCount === coveredCount,
  };
}

function sliceRows(
  rows: Record<string, unknown>[],
  limit: number,
  offset: number,
): Record<string, unknown>[] {
  return limit < 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);
}

function repositoryId(db: DatabaseSync, repository: string): number {
  let row: Record<string, SQLOutputValue> | undefined;
  if (columnExists(db, "repositories", "full_name")) {
    row = db.prepare("select id from repositories where full_name = ?").get(repository);
  } else {
    const [owner, name] = repository.split("/", 2);
    row = db.prepare("select id from repositories where owner = ? and name = ?").get(owner!, name!);
  }
  const id = Number(row?.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Gitcrawl repository not found in snapshot: ${repository}`);
  }
  return id;
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function localSourceSyncAt(db: DatabaseSync, repoId: number): string {
  const candidates: string[] = [];
  if (
    tableExists(db, "sync_runs") &&
    columnExists(db, "sync_runs", "repo_id") &&
    columnExists(db, "sync_runs", "finished_at")
  ) {
    const finished = db
      .prepare(
        `select max(finished_at) as value
         from sync_runs
         where repo_id = ?
           and status in ('success', 'completed', 'complete')
           and scope in ('open', 'all', 'repo')`,
      )
      .get(repoId)?.value;
    if (typeof finished === "string") candidates.push(finished);
  }
  if (
    tableExists(db, "repo_sync_state") &&
    [
      "last_overlapping_open_scan_completed_at",
      "last_non_overlapping_scan_completed_at",
      "last_open_close_reconciled_at",
    ].every((column) => columnExists(db, "repo_sync_state", column))
  ) {
    const reconciled = db
      .prepare(
        `select min(
           last_overlapping_open_scan_completed_at,
           last_non_overlapping_scan_completed_at,
           last_open_close_reconciled_at
         ) as value
         from repo_sync_state
         where repo_id = ?`,
      )
      .get(repoId)?.value;
    if (typeof reconciled === "string") candidates.push(reconciled);
  }
  return latestTimestamp(...candidates);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    Number(
      db
        .prepare("select count(*) as value from sqlite_master where type = 'table' and name = ?")
        .get(table)?.value ?? 0,
    ) > 0
  );
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return db
    .prepare(`pragma table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function normalizeSqliteRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Gitcrawl query integer must be non-negative");
  }
  return number;
}

function latestTimestamp(...values: string[]): string {
  return (
    values
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? ""
  );
}

function encodeCursor(
  query: GitcrawlQueryName,
  args: Record<string, unknown>,
  snapshotId: string,
  offset: number,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      q: query,
      d: gitcrawlQueryDigest(query, args),
      s: snapshotId,
      o: offset,
    }),
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
  query: GitcrawlQueryName,
  args: Record<string, unknown>,
  snapshotId: string,
): number {
  if (!cursor) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid local Gitcrawl cursor");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid local Gitcrawl cursor");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.v !== 2 ||
    value.q !== query ||
    value.d !== gitcrawlQueryDigest(query, args) ||
    value.s !== snapshotId
  ) {
    throw new Error("local Gitcrawl cursor drift");
  }
  const offset = Number(value.o);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("invalid local Gitcrawl cursor offset");
  }
  return offset;
}
