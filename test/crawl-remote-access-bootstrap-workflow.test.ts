import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/bootstrap-crawl-remote-access.yml";
const scriptPath = "scripts/bootstrap-crawl-remote-access.mjs";
const docsPath = "docs/crawl-remote-access-bootstrap.md";

test("manual workflow keeps bootstrap separate from deployment authority", () => {
  const source = readFileSync(workflowPath, "utf8");
  const workflow = parse(source);
  const job = workflow.jobs.bootstrap;
  const bootstrap = job.steps.find(
    (candidate: { name?: string }) => candidate.name === "Bootstrap crawl-remote Access",
  );

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job.environment, undefined);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 10);
  assert.match(job.if, /github\.actor == 'vincentkoc'/);
  assert.match(job.if, /github\.actor_id == '25068'/);
  assert.match(job.if, /github\.triggering_actor == 'vincentkoc'/);
  assert.match(job.if, /github\.run_attempt == 1/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /inputs\.confirmation == 'bootstrap crawl-remote access'/);
  assert.equal(
    bootstrap.env.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN,
    "${{ secrets.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN }}",
  );
  assert.equal(
    bootstrap.env.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN,
    "${{ secrets.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN }}",
  );
  assert.equal(bootstrap.env.OPENCLAW_GH_TOKEN, "${{ secrets.OPENCLAW_GH_TOKEN }}");
  assert.match(bootstrap.run, /bootstrap:crawl-remote-access/);
  assert.match(bootstrap.run, /--rotate-service-token/);
  assert.doesNotMatch(source, /deploy-crawl-remote/);
  assert.doesNotMatch(source, /schedule:|push:|pull_request:/);
  assert.equal(
    JSON.parse(readFileSync("package.json", "utf8")).scripts["bootstrap:crawl-remote-access"],
    `node ${scriptPath}`,
  );
});

test("operator docs preserve the two-phase rollout and no-deploy boundary", () => {
  const docs = readFileSync(docsPath, "utf8");
  assert.match(docs, /does not deploy crawl-remote/);
  assert.match(docs, /runtime provider: `local`/);
  assert.match(docs, /publisher enabled: off/);
  assert.match(docs, /GITCRAWL_CLOUD_STAGE_ONLY=1/);
  assert.match(docs, /temporarily\s+allows both old and new token IDs/);
  assert.match(docs, /never prints returned service credentials/);
});
