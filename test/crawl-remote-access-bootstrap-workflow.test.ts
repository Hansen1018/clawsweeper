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
  const checkout = job.steps.find(
    (candidate: { name?: string }) => candidate.name === "Check out trusted bootstrap",
  );
  const setupNode = job.steps.find(
    (candidate: { name?: string }) => candidate.name === "Set up Node",
  );
  const consumerContract = job.steps.find(
    (candidate: { name?: string }) => candidate.name === "Verify generation-slot consumer contract",
  );
  const preTokenAuthorization = job.steps.find(
    (candidate: { name?: string }) =>
      candidate.name === "Reauthorize current main before token minting",
  );

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "confirmation",
    "rotate_service_token",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "deploy-crawl-remote-production",
    "cancel-in-progress": false,
  });
  assert.equal(job.environment, undefined);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 10);
  assert.match(job.if, /github\.actor == 'vincentkoc'/);
  assert.match(job.if, /github\.actor_id == '25068'/);
  assert.match(job.if, /github\.triggering_actor == 'vincentkoc'/);
  assert.match(job.if, /github\.run_attempt == 1/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /inputs\.confirmation == 'bootstrap crawl-remote access'/);
  assert.equal(checkout.uses, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
  assert.equal(setupNode.uses, "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
  assert.equal(
    bootstrap.env.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN,
    "${{ secrets.OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN }}",
  );
  assert.equal(bootstrap.env.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN, undefined);
  assert.equal(
    bootstrap.env.CLAWSWEEPER_BOOTSTRAP_GH_TOKEN,
    "${{ steps.clawsweeper-admin-token.outputs.token }}",
  );
  assert.equal(bootstrap.env.CLAWSWEEPER_MAIN_READ_GH_TOKEN, "${{ github.token }}");
  assert.equal(
    bootstrap.env.GITCRAWL_STORE_BOOTSTRAP_GH_TOKEN,
    "${{ steps.gitcrawl-store-admin-token.outputs.token }}",
  );
  const clawsweeperToken = job.steps.find(
    (candidate: { name?: string }) => candidate.name === "Create ClawSweeper bootstrap token",
  );
  const gitcrawlStoreToken = job.steps.find(
    (candidate: { name?: string }) => candidate.name === "Create gitcrawl-store bootstrap token",
  );
  assert.equal(
    consumerContract.run,
    "node scripts/bootstrap-crawl-remote-access.mjs --check-consumer-contract",
  );
  assert.ok(job.steps.indexOf(consumerContract) < job.steps.indexOf(clawsweeperToken));
  assert.ok(job.steps.indexOf(consumerContract) < job.steps.indexOf(preTokenAuthorization));
  assert.ok(job.steps.indexOf(preTokenAuthorization) < job.steps.indexOf(clawsweeperToken));
  assert.equal(preTokenAuthorization.env.GH_TOKEN, "${{ github.token }}");
  assert.match(preTokenAuthorization.run, /GITHUB_SHA.*current_main_sha/s);
  assert.equal(consumerContract.env, undefined);
  assert.equal(
    clawsweeperToken.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(clawsweeperToken.with.owner, "openclaw");
  assert.equal(clawsweeperToken.with.repositories, "clawsweeper");
  assert.equal(clawsweeperToken.with["private-key"], "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}");
  assert.equal(clawsweeperToken.with["permission-environments"], "write");
  assert.equal(clawsweeperToken.with["permission-secrets"], "write");
  assert.equal(clawsweeperToken.with["permission-variables"], "write");
  assert.equal(
    gitcrawlStoreToken.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(gitcrawlStoreToken.with.owner, "openclaw");
  assert.equal(gitcrawlStoreToken.with.repositories, "gitcrawl-store");
  assert.equal(
    gitcrawlStoreToken.with["private-key"],
    "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
  );
  assert.equal(gitcrawlStoreToken.with["permission-environments"], undefined);
  assert.equal(gitcrawlStoreToken.with["permission-secrets"], "write");
  assert.equal(gitcrawlStoreToken.with["permission-variables"], "write");
  assert.match(bootstrap.run, /node scripts\/bootstrap-crawl-remote-access\.mjs/);
  assert.match(bootstrap.run, /--rotate-service-token/);
  assert.match(bootstrap.run, /--publisher-enabled 0/);
  assert.match(bootstrap.run, /--runtime-provider cloud/);
  assert.doesNotMatch(source, /inputs\.(runtime_provider|publisher_enabled)/);
  assert.doesNotMatch(bootstrap.run, /corepack|pnpm/);
  assert.doesNotMatch(source, /uses:.*deploy-crawl-remote|workflow_call:/);
  assert.doesNotMatch(source, /schedule:|push:|pull_request:/);
  assert.doesNotMatch(source, /OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN/);
  assert.equal(
    JSON.parse(readFileSync("package.json", "utf8")).scripts["bootstrap:crawl-remote-access"],
    `node ${scriptPath}`,
  );
});

test("operator docs preserve the dormant consumer and no-deploy boundaries", () => {
  const docs = readFileSync(docsPath, "utf8");
  assert.match(docs, /does not deploy crawl-remote/);
  assert.match(docs, /always keeps `CLAWSWEEPER_GITCRAWL_PROVIDER=cloud`/);
  assert.match(docs, /`CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED=0`/);
  assert.match(docs, /does not activate scheduled\s+actionable intake or publication/);
  assert.match(docs, /GITCRAWL_CLOUD_STAGE_ONLY=1/);
  assert.match(docs, /marker-selected existing token IDs plus the newly minted token ID/);
  assert.match(
    docs,
    /node scripts\/resolve-crawl-remote-access-credentials\.mjs\s+--resolve-and-verify-access/,
  );
  assert.match(docs, /writes and reads back both\s+Gitcrawl kill\s+switches/);
  assert.match(docs, /generation marker and selects the matching slot/);
  assert.match(docs, /fresh protected-environment job has only a pinned sparse checkout/);
  assert.match(docs, /emits no credential outputs/);
  assert.match(docs, /deny an unauthenticated probe/);
  assert.match(docs, /direct, computed, or bulk access\s+to the GitHub `secrets` context/);
  assert.match(docs, /exact approved release SHA, both rollout states/);
  assert.match(docs, /fails\s+closed before\s+privileged\s+work/);
  assert.match(docs, /never prints returned service credentials/);
  assert.match(docs, /production\s+deployment credentials and controls are deliberately untouched/);
});
