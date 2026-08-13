# GitHub publication egress telemetry

- Status: active operator reference
- Owner: ClawSweeper publication and dashboard maintainers
- Source of truth: `src/github-egress-observer.ts`,
  `src/github-egress-telemetry-contract.ts`,
  `dashboard/github-egress-telemetry.ts`,
  `dashboard/github-egress-pool-coordinator.ts`, and the publication workflows
- Last verified: `openclaw/clawsweeper@559da850fddd4d56e9f3f710014d22e205440cfb`
- Update when: a publication request path, credential selection rule, telemetry
  dimension, retention limit, or public response changes
- Checked by: focused telemetry tests plus `pnpm run check:docs`

ClawSweeper records bounded observations of GitHub requests made while publishing
exact reviews. The version-2 observer is diagnostic only: it does not admit,
defer, retry, cancel, or reprioritize work, and it does not open or close a
credential circuit. A separate, default-disabled repository Actions pool
coordinator can enforce publication egress permits without changing this
observation contract. Existing version-1 request and circuit metrics continue in
parallel.

## Read the six-hour view

Use the public, read-only endpoint for time-aligned diagnosis:

```bash
curl --fail --silent --show-error \
  'https://clawsweeper.openclaw.ai/api/github-egress-observability?hours=6'
```

`hours` accepts only `0.25` (15 minutes), `1`, `6`, or `24`. Use the 15-minute
view for periodic collection when a high-cardinality one-hour detail response
would reach the public row cap. The response contains closed aggregate
dimensions and sanitized rate-limit observations. It never contains private
pool identities, repository or item identifiers, branches, raw SHAs, paths,
queries, cursors, URLs, request IDs, ETags, bodies, tokens, or installation IDs.

The exact-review queue status also includes a compact six-hour
`publication.github_egress_metrics_v2` summary. Use the dedicated endpoint when
the operation, route, page, outcome, or rate-limit-header breakdown is needed.

## Counting units

Do not add unlike units. Each row declares one of these units:

| Unit           | What one count means                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `member`       | One durable publication member entering a direct, artifact, or batch publication boundary.       |
| `invocation`   | One `gh` command invocation, including a pre-wire failure or an opaque artifact download action. |
| `wire_attempt` | One HTTP request observed in a safe `GH_DEBUG=api` transport frame; each pagination page counts. |

A paginated invocation therefore contributes one `invocation` and N
`wire_attempt` rows. An artifact download whose binary redirect is unsafe to
debug contributes an incomplete `invocation` but no invented wire count.
`attempted=false` is emitted only for a directly observed pre-wire condition or
an existing batch circuit skip. Phase 0 does not manufacture requests that a
future coordinator might have avoided.

Use the unit totals as a conservation check:

1. Compare `member` counts with durable direct, artifact, and batch publication
   starts for the same window.
2. Compare `invocation` with `wire_attempt` by stage and operation. A larger wire
   count is expected for pagination; an incomplete opaque invocation has no wire
   denominator.
3. Compare attempted and non-attempted members with the existing publication
   completion, retry, and circuit-skip counters. A gap indicates missing or
   incomplete telemetry, not zero demand.

## `first` and `repeat`

`first_repeat` is fixed when the durable item is claimed for publication:

- `first` means `publicationFailureAttempts` is zero for that exact durable item
  revision at claim time.
- `repeat` means the same durable item revision already has at least one charged
  publication failure at claim time.
- `unknown` means the workflow could not safely bind this command to that
  durable fact; the row is incomplete.

This dimension does not mean a second HTTP request, another pagination page,
another member in the same batch, or every later claim generation. Every GitHub
invocation and wire request performed for one claim inherits the same
first/repeat value. `claim_generation_bucket` separately records the bounded
claim generation (`1`, `2`, `3_5`, `6_10`, `11_32`, or `33_plus`).

## Credential and request dimensions

Pool attribution follows the token actually selected at the call site. It is
never inferred from GitHub's generic error text.

| `pool_class`           | Meaning                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `repository_actions`   | The ClawSweeper repository Actions credential used for artifacts, workflow dispatch, or explicit calls. |
| `target_app`           | The target owner's GitHub App installation credential.                                                  |
| `public_read_fallback` | A public target read deliberately moved to the repository Actions credential after pool selection.      |
| `other`                | Attribution was unsafe; the row is incomplete.                                                          |

The private pool identity is a one-way, versioned fingerprint of the real
credential boundary: ClawSweeper repository Actions or target owner. It is
retained only inside the Durable Object and is omitted from public rows.

The remaining dimensions are closed allowlists:

- `stage`: preparation, apply, router, or recovery;
- `source_action`: exact event, command, scheduled hot, scheduled normal,
  repair, or publication retry;
- `operation`: artifact download, item metadata, comments, reviews, labels,
  reactions, checks, contents, authorization, GraphQL, workflow dispatch, rate
  status, or other;
- `method`: an allowlisted HTTP method or `UNKNOWN`;
- `route_template`: a normalized route family such as `issue_comments` or
  `actions_workflow_dispatch`;
- `page_bucket`, `status_bucket`, and `latency_bucket`: bounded buckets rather
  than raw values.

`deployment_revision` is a one-way 16-hex fingerprint derived from the exact
checked-out deployment SHA. `config_revision` is a separate 16-hex fingerprint
of a versioned allowlist of non-secret egress controls. Operators can correlate
a known SHA or configuration locally without publishing a raw SHA or control
payload.

## Rate-limit observations

Only HTTP 403 and 429 responses produce detail rows. The observer records the
approximate response receive time (request timestamp plus measured duration),
status, closed request dimensions, and presence plus bounded numeric values for:

- `Retry-After`;
- `X-RateLimit-Limit`;
- `X-RateLimit-Remaining`;
- `X-RateLimit-Used`;
- `X-RateLimit-Reset`;
- the allowlisted `X-RateLimit-Resource` value.

`reset_authority_candidate` reports `retry_after`, `rate_limit_reset`, `absent`,
or `invalid`. A present but non-numeric authority remains present and is
classified `invalid`.

The signed ingest path also reuses a narrowly attributable subset of complete
observations as durable queue circuit evidence. `repository_actions` and
`public_read_fallback` both identify the workflow `GITHUB_TOKEN` quota and may
advance the shared repository-Actions `blocked_until` when `Retry-After` is
numeric, or when `X-RateLimit-Reset` is numeric and
`X-RateLimit-Remaining: 0`. The reset must be in the future and within two
hours. Recovery is released per durable publication member at that reset plus
one to 30 seconds of deterministic jitter. An observation never authorizes an
early probe.

`target_app` telemetry remains observational because the privacy-safe payload
does not carry the target owner needed to select an App credential pool.
Owner-aware Worker and batch paths continue to populate those circuits
directly. Incomplete observations, permission-style 403 responses with quota
remaining, invalid headers, stale resets, and unattributable pools never alter
admission.

Receipt deduplication also binds downstream circuit evidence to the first
accepted payload. A retry may replay that payload's stored circuit candidates
after an interrupted handoff, but reusing the receipt ID with different rate
limit evidence cannot introduce or extend a circuit.

## Completeness and safe failure

`telemetry_complete=true` requires a known credential boundary, stage, source
class, durable claim generation, first/repeat fact, safe route template, parsed
method/status, and response receive time. Unsafe parsing emits or uploads an
incomplete bounded marker. It never uploads a partially parsed raw frame.

Completeness is computed independently for each requested 15-minute, one-,
six-, or 24-hour window. Rollup queries include the complete five-minute or
hourly bucket that overlaps the window's lower boundary, so totals can include at
most one bucket of observations immediately before the exact cutoff. Raw
rate-limit observations use the exact cutoff. `rows_truncated` and
`rate_limit_rows_truncated` identify a bounded public response, while
`rollup_window_complete` and
`rate_limit_window_complete` identify any cap eviction during the requested
window. `query_complete` is true only when neither condition applies. These
query bounds are separate from transport `telemetry_complete`.

The public view also returns full-window `units` totals for members,
invocations, and wire attempts. These conservation denominators remain exact
when the bounded dimensional `rows` array is truncated; operators must still
treat `completeness.query_complete=false` as insufficient for a complete
per-route breakdown.

The `gh` wrapper preserves the command's stdout, cleaned non-debug stderr, and
exit status. Observation and upload failures do not fail publication. This
fail-open rule means an uploader that finds no readable metric records sends
one bounded, incomplete, unattempted invocation marker; it never invents a wire
attempt or member count. A completely missing uploader still cannot report its
own absence, so use stage conservation against durable publication starts and workflow results
to detect that case.

Known incomplete boundaries are explicit:

- coordinator-admitted `gh run download` reports one bounded incomplete
  invocation, but its archive request/pages remain wire-opaque because debug
  output can include redirected archive bytes; `actions/download-artifact`
  boundaries elsewhere remain opaque for the same reason;
- direct-lifecycle replay performed before the repaired implementation checkout
  is not observed;
- calls outside the direct, artifact, and batch publication paths are outside
  this Phase 0 denominator;
- public views expose pool class, not the private owner-sharded pool identity;
- a closed route family cannot separate endpoint variants that are not in the
  allowlist.

## Retention and cardinality

| Boundary                         | Limit                                  |
| -------------------------------- | -------------------------------------- |
| Workflow JSONL input             | 2,000 lines per file                   |
| Signed upload                    | 128 metrics and 16 rate rows per chunk |
| Five-minute rollups              | 7 days                                 |
| Hourly rollups                   | 30 days                                |
| Sanitized 403/429 detail         | 24 hours                               |
| Deduplication receipts           | 7 days                                 |
| Durable rollup rows              | 50,000                                 |
| Durable rate-limit detail rows   | 10,000                                 |
| Public aggregate rows per query  | 2,000 plus a truncation flag           |
| Public rate-limit rows per query | 256                                    |

The Durable Object validates every enum, digest length, timestamp window,
numeric header, count, and chunk limit before committing a receipt. It stores
both five-minute and hourly rollups transactionally and deduplicates upload
retries by producer-run-scoped, content-derived receipt ID. Cap evictions are
cumulative diagnostics and mark affected public windows incomplete.

The 15-minute view does not raise or bypass the public row cap. A collector
must preserve `rows_truncated` and `query_complete` and record a gap if even the
smaller view exceeds the bound.

## Phase 0 rollback boundary

Rollback removes the workflow setup and upload steps and the public route. The
version-2 tables are additive and may remain dormant; version-1 metrics and
publication behavior continue unchanged. No queue drain, schedule change,
credential change, or state migration is required.

## Repository Actions pool coordinator

`CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED` is the workflow kill switch.
It defaults to `false`; deploying the code and Durable Object migration does not
activate publication enforcement. When enabled, every publication-path `gh`
invocation that actually uses the repository Actions credential obtains a short
permit and marks the operation started immediately before invoking `gh`. This
includes artifact downloads, classifier-approved public reads, and direct,
recovery, or batch comment-router dispatches. `public_read_fallback` remains the
logical telemetry class for a public target read, but when credential selection
places that read on the repository Actions token it joins the same coordinated
pool. Calls that actually use a target-owner App installation bypass this
coordinator and retain their independent owner-correct circuits.

The Worker derives the Durable Object shard from its configured ClawSweeper
repository identity. Callers cannot choose a pool name, item shard, owner shard,
or global singleton. Mutating coordinator calls use the existing signed internal
request boundary. The public
`GET /api/github-egress-pool-coordinator` response contains only the pool class,
state, epoch, reset provenance, blocked-until time, in-flight and avoided counts,
probe/ramp state, bounded configuration, and a completeness flag.

The coordinator enforces these transitions:

1. `acquire` creates a short, caller-deduplicated permit for one declared egress
   operation; `start` fences it to the current epoch before the command can run.
   The runner retries each idempotent boundary once if its response is lost, so
   an ambiguous post-commit response cannot strand the only probe permit.
   Rejected acquire/start responses also have bounded private deduplication
   receipts: replaying a lost rejection returns the original sanitized result
   without incrementing `rejected_before_start` or `avoided_operations` again.
2. The first classified 403/429 atomically advances the epoch and opens the pool.
   Acquired siblings become stale and are rejected before `gh`; already-started
   commands may finish and are counted separately.
3. `Retry-After` and credible `X-RateLimit-Reset` values remain authoritative.
   Numeric deadlines outside the two-hour credibility horizon are treated as
   absent rather than invalidating the classified throttle. A headerless or
   unusable-deadline throttle uses one persisted exponential backoff with bounded
   jitter instead of a per-process one-minute reopen loop. Fresh headerless
   evidence from an already-on-wire stale sibling extends that same shared
   fallback boundary; duplicate receipts remain idempotent.
4. At the boundary, exactly one half-open probe is admitted. A completed
   non-throttled command proves that the pool can serve egress even if the
   requested GitHub operation fails for an application reason. A classified
   `/throttle` observation reopens the rate-limit circuit, while an explicit
   `unexecuted_failure` (for example, an attempt-receipt or command-launch
   failure after permit start) reopens conservatively without claiming that
   GitHub was reached. Recovery admits deterministic `1 -> 2 -> 4 -> 8` fixed
   permit cohorts before returning to closed. A cohort cannot replenish freed
   slots after reaching its admission target, and the pool advances or closes
   only after every admitted operation completes without a throttle. Any
   recovery permit that expires reopens the pool; an expired unstarted permit
   is not replaced within the same cohort.
5. Coordinator-deferred batch, direct, and recovery publication operations exit
   through the durable `github_rate_limit`, `attempted=false` path, so they do not
   consume publication failure, retry, dead-letter, or mutation budgets. A
   previously started publication failure-age window is paused while the item is
   coordinator-deferred and resumes on the next genuinely attempted completion,
   so a long shared-pool outage cannot exhaust the 24-hour retry age by itself. A
   coordinated command also writes one private per-invocation throttle bit for
   its caller. Batch preparation uses that bit to retain a header-classified 403
   even when the unchanged `gh` stderr does not contain a throttle phrase; the
   sidecar contains no repository, item, token, URL, header, or request identity.
   A lifecycle-router operation records an atomic local attempt receipt after
   `start` succeeds and immediately before `gh` is invoked. An already-on-wire
   operation therefore retains normal attempted failure accounting, while
   siblings without that receipt remain unattempted. A canonical permanent
   publication receipt always wins over a later pool deferral.

Permit, receipt, rejection, epoch, backoff, and ramp state live in SQLite-backed
Durable Object storage and survive Worker restarts. Finish/throttle receipt IDs
and acquire/start request identities make acknowledgements idempotent. Completed
permit rows, operation rows, acknowledgement receipts, and private rejection
receipts have a 24-hour TTL. The configured permit TTL bounds abandoned acquires
and started commands; expiry of an unacknowledged started command marks operator
telemetry incomplete. An expired started probe or any expired recovery-ramp
permit also reopens the pool with shared fallback backoff, so unknown or
unclaimed outcomes cannot increase recovery capacity. Already-started work from an obsolete epoch remains visible
for late-completion and late-throttle accounting, but it does not consume the
current epoch's single-probe or recovery-ramp capacity. Private receipts contain
only bounded digests, permit-local identifiers, enums, epochs, and timestamps;
they are never returned by the public endpoint.

The coordinator does not introduce a second waiting queue. Capacity, circuit,
probe, and stale-epoch deferrals return to the existing durable publication
queue, which retains its established owner/freshness ordering and retry jitter.
One permit currently fences one external `gh` invocation. For opaque artifact
downloads that invocation can contain more than one HTTP request; Phase 0 remains
the authoritative wire denominator. Consequently, `permits_in_flight_at_open`,
`already_on_wire_completions`, and `avoided_operations` describe coordinator
operation boundaries, not a fabricated exact count of hidden artifact requests.
Each coordinated command writes its sanitized Phase 0 rate-limit details to a
private temporary sink. The runner classifies only that command's observations,
then appends the unchanged records to the shared Phase 0 stream and removes the
temporary sink. Parallel publication commands therefore cannot classify a
sibling's 403/429 as their own; if isolation cannot be established, the runner
falls back to its own stderr signal and leaves shared detail completeness to the
existing Phase 0 contract. If a throttled coordinated command cannot acknowledge
the coordinator, batch preparation records a local five-minute fallback and
defers; it never performs an unpermitted `gh api rate_limit` lookup after the
throttle. The coordinator-disabled legacy path retains its existing bounded
status lookup.

## Rollback and activation boundary

Turning `CLAWSWEEPER_REPOSITORY_POOL_COORDINATOR_ENABLED` back to `false`
immediately restores the pre-coordinator command path. Persisted coordinator
state may remain dormant and does not affect disabled workflows. No queue drain,
schedule change, credential change, or Durable Object data deletion is required.
The observer remains active and fail-open in either mode.

Production activation requires separately reviewed Phase 0 quota-window evidence
and a canary decision. The initial deployment must not infer safe permit or ramp
settings from repository defaults alone.
