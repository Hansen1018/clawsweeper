# crawl-remote Access bootstrap

The manual `Bootstrap crawl-remote Access` workflow owns configuration only. It
does not deploy crawl-remote, alter deployment protection, or provide a fallback
Cloudflare token to the deploy workflow.

Until the separately reviewed slot-aware consumer lands, production deployment
continues to use the existing `CRAWL_REMOTE_CLOUDFLARE_TOKEN_SHA256` contract.
The bootstrap does not read or write that token, its SHA-256 binding, deployment
authority, or route-proof controls. Those live inputs remain owned by the
protected deployment path.

The workflow is intentionally inert until the separately owned deploy consumer
adds one exact `crawl_remote_access_verify` job after `preflight` and `deploy`.
That fresh protected-environment job has only a pinned sparse checkout at the
workflow SHA followed by an unconditional
`Resolve and verify crawl-remote Access credentials` step. No earlier run step,
package install, mutable workspace, `GITHUB_ENV`, or `GITHUB_PATH` state can
cross the job boundary.

The single resolver process binds the generation marker and all four slot
secrets, selects the matching pair in memory, and directly invokes
`node scripts/resolve-crawl-remote-access-credentials.mjs
--resolve-and-verify-access`. It emits no credential outputs. The same process
first requires the canonical `/health` route to deny an unauthenticated probe,
then sends both Access headers to `/health` and `/v1/contract` and requires the
exact approved release SHA, both rollout states, the observation-order and
snapshot-provenance notes, both Gitcrawl capability fences, and the required
routes.

The bootstrap compares the complete verifier job against this exact contract
before minting privileged GitHub tokens and again before any Cloudflare or
GitHub mutation. Extra steps or controls, encoded YAML scalar values, workflow
run defaults, direct slot-secret references outside the verifier, and legacy
unversioned secret references fail closed. Any direct, computed, or bulk access
to the GitHub `secrets` context outside the verifier also fails closed. The
verifier job and step both bind `BASH_ENV`, `ENV`, and `NODE_OPTIONS` to empty
values. Until the separately owned consumer change lands, every dispatch fails
closed before privileged work.

The bootstrap rechecks the live ClawSweeper `main` SHA immediately before every
privileged mutation phase: kill-switch writes, token creation, application and
policy reconciliation, secret-pair publication, generation-marker cutover,
each repository's staged configuration, policy narrowing, and each old-token
revocation. It writes and reads back both Gitcrawl kill switches before
creating a token, changing Access policy, or publishing any credential
generation.

Bootstrap and production deploy runs share one non-cancelling concurrency group,
so rotation cannot revoke a credential held by an in-flight deploy. During
rotation, the transitional Access policy includes only marker-selected existing
generations plus the newly minted generation; orphan name-matching tokens are
never authorized.

## First bootstrap

After the generation-slot deploy consumer lands, dispatch the workflow from
current `main` with:

- confirmation: `bootstrap crawl-remote access`
- rotate service token: off

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

It writes only cloud endpoint/archive and conservative rollout variables. The
initial settings stage ClawSweeper on the cloud provider while keeping scheduled
cluster repair intake and cloud publication disabled. Existing production
deployment credentials and controls are deliberately untouched.

## Reconciliation and rotation

A repeat run without rotation reconciles the application, policy, and staged
variables only when every active slot exists and every generation marker hashes
to the selected Cloudflare service-token ID. Missing, malformed, or stale
markers fail before Cloudflare mutation because GitHub does not reveal stored
secret values.

Use `rotate service token` only when replacing credentials. Rotation temporarily
allows marker-selected existing token IDs plus the newly minted token ID, writes
both values into each inactive slot, then switches the three generation markers.
Only after all markers switch does it narrow the policy and delete old tokens. A
pair-write failure changes no marker; a marker-write failure can leave consumers
on different generations, but every selected generation remains authorized. A
renamed marker-bound token requires explicit rotation and remains in the
transitional policy until cutover. A later explicit rotation finishes a fully
published generation only when its managed generation label is strictly newer
than every leftover token. Otherwise it mints a fresh generation and supersedes
every ambiguous partial token.

This workflow always keeps `CLAWSWEEPER_GITCRAWL_PROVIDER=cloud`,
`CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED=0`,
`GITCRAWL_CLOUD_PUBLISH_ENABLED=0`, and `GITCRAWL_CLOUD_STAGE_ONLY=1`. The cloud
provider value stages source selection only; it does not activate scheduled
actionable intake or publication. Those transitions belong to separate reviewed
changes after crawl-remote is ready and each consumer proves it resolves its own
generation marker and matching slot.

## Required source credentials

The ClawSweeper repository must already contain:

- `OPENCLAW_CLOUDFLARE_CONFIG_API_TOKEN` with Access applications, policies,
  and service-token write permissions
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
