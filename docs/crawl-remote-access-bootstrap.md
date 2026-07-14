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
writes the one-time service credentials to:

- the `crawl-remote-production` environment in `openclaw/clawsweeper`
- the ClawSweeper repository Gitcrawl runtime secrets
- the `openclaw/gitcrawl-store` publisher secrets

It also writes the protected deployment authority, proof mode, Workers token
hash, cloud endpoint/archive, and conservative rollout variables. The initial
settings keep ClawSweeper on the local provider and keep cloud publication
disabled.

## Reconciliation and rotation

A repeat run without rotation reconciles the application, policy, variables,
and production Workers token when every Access secret slot already exists.
GitHub does not reveal stored secret values, so a missing slot makes the run
fail before Cloudflare mutation.

Use `rotate service token` only when replacing credentials. Rotation temporarily
allows both old and new token IDs, updates every GitHub destination, narrows the
policy to the new token, and then deletes the old token. If credential
publication fails, the old token remains authorized.

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
- `OPENCLAW_GH_TOKEN` with administration access to ClawSweeper environments
  and Actions secrets/variables in ClawSweeper and gitcrawl-store

The bootstrap never prints returned service credentials. GitHub secret writes
are passed to `gh secret set` over standard input so encryption happens locally
before the API request.
