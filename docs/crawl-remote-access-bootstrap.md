# crawl-remote Access bootstrap

The manual `Bootstrap crawl-remote Access` workflow owns configuration only. It
does not deploy crawl-remote, alter deployment protection, or provide a fallback
Cloudflare token to the deploy workflow.

## First bootstrap

Dispatch the workflow from current `main` with:

- confirmation: `bootstrap crawl-remote access`
- rotate service token: off
- runtime provider: `local`
- publisher enabled: off

The workflow creates the path-specific Access application for
`reports.openclaw.ai/crawl-remote/*`, attaches one Service Auth policy, and
writes the one-time service credentials into blue/green slots at:

- the `crawl-remote-production` environment in `openclaw/clawsweeper`
- the ClawSweeper repository Gitcrawl runtime secrets
- the `openclaw/gitcrawl-store` publisher secrets

Each destination has two client-ID/secret slots and one non-secret generation
variable. The marker has the form `v1:<slot>:<sha256-service-token-id>`. A
consumer resolves both values from the marked slot; the bootstrap never
publishes an unversioned mixed pair.

It also writes the protected deployment authority, proof mode, Workers token
hash, cloud endpoint/archive, and conservative rollout variables. The initial
settings keep ClawSweeper on the local provider and keep cloud publication
disabled.

## Reconciliation and rotation

A repeat run without rotation reconciles the application, policy, variables,
and production Workers token only when every active slot exists and every
generation marker hashes to the selected Cloudflare service-token ID. Missing,
malformed, or stale markers fail before Cloudflare mutation because GitHub does
not reveal stored secret values.

Use `rotate service token` only when replacing credentials. Rotation temporarily
allows every old and new token ID, writes both values into each inactive slot,
then switches the three generation markers. Only after all markers switch does
it narrow the policy and delete old tokens. A pair-write failure changes no
marker; a marker-write failure can leave consumers on different generations,
but every selected generation remains authorized. A later explicit rotation
either finishes a fully published generation or supersedes a partial one.

After crawl-remote deployment and staged archive proof:

1. Rerun with publisher enabled to stage snapshots while
   `GITCRAWL_CLOUD_STAGE_ONLY=1`.
2. Rerun with runtime provider `parity` for comparison.
3. Move to provider `cloud` and disable stage-only only through the separately
   reviewed rollout that activates the crawl-remote capability fences.

## Required source credentials

The ClawSweeper repository must already contain:

- `OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN` with Access applications, policies,
  and service-token write permissions
- `OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN`
- `CLAWSWEEPER_APP_PRIVATE_KEY`; the workflow mints separate short-lived
  installation tokens for the two repositories

The bootstrap never prints returned service credentials. GitHub secret writes
are passed to `gh secret set` over standard input so encryption happens locally
before the API request. The ClawSweeper token requests environment, Actions
secret, and Actions variable write permissions. The gitcrawl-store token
requests only Actions secret and Actions variable write permissions.

This workflow provisions the slot contract only. Existing deploy or Gitcrawl
consumers must not be activated against it until their separately reviewed
owner reads the generation marker and selects the matching slot. There is no
unversioned deploy fallback.
