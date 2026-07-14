import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("gitcrawl readers prefer portable gitcrawl-store before legacy local DB", () => {
  const sources = [
    readFileSync("src/clawsweeper.ts", "utf8"),
    readFileSync("src/repair/import-gitcrawl-low-signal-prs.ts", "utf8"),
  ];
  const clusterImport = readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8");
  const adapter = readFileSync("src/repair/gitcrawl-evidence-adapter.ts", "utf8");

  for (const source of sources) {
    assert.match(source, /CLAWSWEEPER_GITCRAWL_DB/);
    assert.match(source, /gitcrawl-store/);
    assert.match(source, /\.sync\.db/);
    assert.match(source, /replace\(/);
    assert(source.indexOf("gitcrawl-store") < source.indexOf('.config", "gitcrawl", "gitcrawl.db'));
  }
  assert.match(clusterImport, /gitcrawlEvidenceOptionsFromArgs/);
  assert.match(clusterImport, /GitcrawlEvidenceAdapter\.open/);
  assert.match(adapter, /CLAWSWEEPER_GITCRAWL_DB/);
  assert.match(adapter, /gitcrawl-store/);
  assert.match(adapter, /\.sync\.db/);
});

test("gitcrawl docs describe external store freshness instead of per-run crawling", () => {
  const relatedDocs = readFileSync("docs/related-issue-discovery.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");

  assert.match(relatedDocs, /does not run a gitcrawl fetch\s+or download issues during review/);
  assert.match(relatedDocs, /git pull --ff-only/);
  assert.match(repairDocs, /does not crawl or download\s+issues during repair import/);
  assert.match(repairDocs, /git -C \.\.\/gitcrawl-store pull --ff-only/);
});

test("gitcrawl cluster import drip-feeds mostly open clusters by default", () => {
  const source = readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8");
  const limitsDocs = readFileSync("docs/limits.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");

  assert.match(source, /const allowEmpty = Boolean\(args\["allow-empty"\]\)/);
  assert.match(source, /const allowInstantClose = booleanArg\("allow-instant-close", false\)/);
  assert.match(source, /const skipClosedPercent = percentArg\("skip-closed-percent", 75\)/);
  assert.match(source, /skip mostly-closed cluster/);
  assert.match(source, /closedPercent >= skipClosedPercent/);
  assert.match(source, /adapter\.listClusters/);
  assert.match(source, /adapter\.clusterMembers/);
  assert.match(limitsDocs, /75% closed members are skipped/);
  assert.match(repairDocs, /75%\+ closed clusters by default/);
});

test("scheduled cluster repair intake supports snapshot-bound providers", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  const limitsDocs = readFileSync("docs/limits.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");
  const internalDocs = readFileSync("docs/repair/internal-features.md", "utf8");

  assert.match(workflow, /cron: "8 8 \* \* \*"/);
  assert.match(workflow, /local, cloud, or parity evidence provider/);
  assert.match(workflow, /CLAWSWEEPER_CLUSTER_REPAIR_GITCRAWL_PROVIDER/);
  assert.match(workflow, /CLAWSWEEPER_GITCRAWL_CLOUD_URL/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(
    workflow,
    /https:\/\/crawl-remote\.services-91b\.workers\.dev\/v1\/auth\/github-actions\/session/,
  );
  assert.match(workflow, /CLAWSWEEPER_GITCRAWL_CLOUD_TOKEN=\$\{session\.token\}/);
  assert.match(workflow, /::add-mask::\$\{session\.token\}/);
  assert.doesNotMatch(workflow, /secrets\.CRAWL_REMOTE_ACCESS_CLIENT_ID/);
  assert.doesNotMatch(workflow, /secrets\.CRAWL_REMOTE_ACCESS_CLIENT_SECRET/);
  assert.doesNotMatch(workflow, /secrets\.CLAWSWEEPER_GITCRAWL_CLOUD_TOKEN/);
  assert.match(workflow, /last_processed_snapshot_id/);
  assert.match(workflow, /last_processed_source_identity_sha256/);
  assert.match(workflow, /last_processed_store_sha256/);
  assert.match(workflow, /CLAWSWEEPER_CLUSTER_REPAIR_IMPORT_LIMIT \|\| '1'/);
  assert.match(workflow, /pnpm run repair:dispatch/);
  assert.doesNotMatch(workflow, /git pull --rebase origin main/);
  assert.match(limitsDocs, /default is `1` cluster per daily\s+run/);
  assert.match(repairDocs, /runs daily against the configured local, cloud, or parity provider/);
  assert.match(internalDocs, /selects `local`, `cloud`, or\s+`parity` evidence/);
});

test("gitcrawl cluster import is not blocked by the scheduled intake gate", () => {
  const source = readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8");
  const lowSignalSource = readFileSync("src/repair/import-gitcrawl-low-signal-prs.ts", "utf8");
  const dispatchJobs = readFileSync("src/repair/dispatch-jobs.ts", "utf8");

  assert.doesNotMatch(source, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  assert.doesNotMatch(lowSignalSource, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  assert.doesNotMatch(dispatchJobs, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
});
