# Gitcrawl Evidence Binding

ClawSweeper repair import uses one provider-neutral evidence adapter for local
Gitcrawl SQLite stores and the crawl-remote Cloudflare service. The adapter
does not mutate Gitcrawl or GitHub. It snapshots, validates, normalizes, and
binds evidence before a repair job reaches a Codex prompt.

The existing `repair:import-gitcrawl` and
`repair:import-gitcrawl-low-signal` commands are the local CLI surface. Local
queries run against an immutable SQLite backup because the Gitcrawl CLI does
not expose the complete snapshot-bound cluster and PR review contract.

## Provider Modes

`local` is the default. It resolves a SQLite store in this order:

1. `--db` or `CLAWSWEEPER_GITCRAWL_DB`
2. `../gitcrawl-store/data/<owner>__<repo>.sync.db`
3. `~/.config/gitcrawl/stores/gitcrawl-store/data/<owner>__<repo>.sync.db`
4. `~/.config/gitcrawl/gitcrawl.db`

The source database is opened read-only and copied with SQLite's backup API.
Queries run only against that checked snapshot. Its SHA-256 becomes the local
snapshot id.

`cloud` calls the crawl-remote Cloudflare query service. Configure:

```text
CLAWSWEEPER_GITCRAWL_PROVIDER=cloud
CLAWSWEEPER_GITCRAWL_CLOUD_URL=https://crawl-remote.example
CLAWSWEEPER_GITCRAWL_CLOUD_ARCHIVE=gitcrawl/openclaw__openclaw
CLAWSWEEPER_GITCRAWL_CLOUD_TOKEN=<reader bearer token>
```

Equivalent flags are `--gitcrawl-provider`, `--cloud-url`, and
`--cloud-archive`. The token is environment-only. Cloud URLs must use HTTPS
and must not contain embedded credentials. Response bodies are streamed into a
512 KiB hard cap before JSON parsing. Redirects are refused, and the final
response URL must remain on the configured HTTPS origin.

Every cloud request asks for `gitcrawl-query-safety-v2` and sends the expected
repository plus archive identity. Every response must echo that exact contract,
repository, and archive in `stats`. Cloud and parity mode fail closed until
crawl-remote advertises this contract and supplies the complete title, body,
labels, assignees, author association, membership count, and PR review fields
consumed by ClawSweeper. An older successful HTTP response is not treated as
compatible evidence.

`parity` runs every query against the cloud source and a local SQLite snapshot.
It returns cloud data only after normalized rows and coverage counts match.
Use the cloud settings plus `--db`:

```bash
CLAWSWEEPER_GITCRAWL_CLOUD_TOKEN=... \
pnpm run repair:import-gitcrawl -- \
  --from-gitcrawl \
  --gitcrawl-provider parity \
  --cloud-url https://crawl-remote.example \
  --cloud-archive gitcrawl/openclaw__openclaw \
  --db ../gitcrawl-store/data/openclaw__openclaw.sync.db
```

## Query Contract

The adapter exposes these snapshot-bound operations:

- cluster list
- cluster members
- related cluster members
- open pull-request search
- pull-request review context
- dataset coverage

Cloud mode maps them to:

```text
gitcrawl.clusters.list
gitcrawl.clusters.members
gitcrawl.clusters.related
gitcrawl.threads.search
gitcrawl.pull_requests.review_context
gitcrawl.coverage
```

The first coverage response pins the snapshot id, source sync timestamp, and
dataset generation. Every later page must return the same tuple. Opaque cursors
may advance once; replay, drift, snapshot changes, or generation changes abort
the import. Pagination stats are required typed fields; missing or malformed
`next_cursor` data never means successful completion.

Local freshness is based only on a completed repository-scoped `sync_runs`
record or a complete `repo_sync_state` reconciliation tuple. A fresh portable
export timestamp, database mtime, or one recently pulled thread does not make
the repository snapshot fresh.

Coverage is operation-scoped. Cluster reads require repository, thread,
cluster-group, and membership coverage. Thread search requires repository and
thread coverage. Exact PR review hydration additionally requires complete PR
detail and file coverage. An unrelated incomplete enrichment dataset therefore
does not disable a cluster-only import, but the operation that consumes it
still fails closed.

Portable cluster counts are derived from active membership rows. ClawSweeper
does not require a denormalized `cluster_groups.member_count` column, but it
does require every returned member row to carry the same derived count and
requires that count to equal the complete result set.

## Claims And Packets

Each normalized result becomes a claim containing:

- provider and snapshot id
- parity snapshot id when enabled
- query name and query contract version
- canonical subject id
- source revision id, timestamp, and SHA-256 when available
- thread fingerprint algorithm and SHA-256 when available
- graph relations
- normalized bounded data
- a pre-truncation security projection SHA-256 and security classification
- semantic SHA-256 and full claim SHA-256

Canonical JSON sorts object keys and evidence records with byte-stable lexical
ordering. Digests therefore do not depend on machine locale or provider row
shape.

Claims are assembled into a prompt packet with coverage, graph nodes, graph
edges, exact included counts, and a packet SHA-256. Packet v2 deliberately makes
no unverifiable assertion about data outside the bounded packet. Persisted
packet verification rebuilds the canonical bounded graph from verified claims
and requires exact node, edge, and included-count equality. Packet v1 remains
readable for migration compatibility, but its declared total and omission
counts are compatibility metadata only and never authorize repair targets.
Default bounds are:

```text
64 claims
64 graph nodes
128 graph edges
64 KiB serialized packet
24 changed files per PR context
```

Primary cluster, thread-search, and PR-context claims are retained before
relation-detail claims. The adapter still hydrates and verifies every PR file
before reducing the prompt representation. PR file positions must form the
complete contiguous snapshot-local identity set; repeated paths remain valid
because GitHub can report remove/add entries for the same path. Graph edges are
retained only when both endpoint nodes remain in the bounded graph.

Generated jobs are validated before their file is written or a scan cursor is
advanced. Cluster jobs require one retained `gitcrawl.clusters.members` claim
for every member target. Low-signal jobs require both a
`gitcrawl.threads.search` claim and a root
`gitcrawl.pull_requests.review_context` claim for every candidate. If packet
bounds omit any mandatory target claim, import stops without emitting a partial
job or advancing durable progress. Both importers publish through random,
exclusive, no-follow temporaries and no-clobber hard links, then verify the
published inode before advancing durable progress.

Thread bodies and labels are screened before their prompt representation is
bounded. The claim retains the classification, completeness flag, and canonical
SHA-256 of the complete query-row safety projection. Parity mode compares that
projection instead of discarding provider-specific labels. Repair import aborts
when a source cannot provide complete safety metadata for a candidate. A
provider assertion alone is insufficient: the row must contain the full body
and labels used to compute the projection. Excerpt-only portable stores remain
usable for best-effort related-item discovery, but they cannot admit repair or
low-signal candidates.

Low-signal policy bits such as issue references, focused-fix language, blank
templates, and external-capability requests are derived from the complete body
before the body is reduced to prompt size. The bounded claim carries only those
derived booleans and the excerpt. Blank-template detection removes multiline
HTML instructions and permits only known template headings before empty fields;
arbitrary prose or headings remain substantive.

Imported cluster and low-signal PR job files embed the packet under
`Gitcrawl Evidence Packet`. Normal repair prompt rendering includes the job
verbatim, so review and repair workers receive the same digest-bound evidence.
New jobs use versioned IDs, set
`gitcrawl_evidence_schema: gitcrawl-evidence-job-v1`, and set
`gitcrawl_evidence_required: true`. Job parsing and prompt rendering
independently locate the exact top-level evidence section and reverify the
embedded packet, including its repository binding, before a worker can consume
it. Removing the version, required marker, section, or digest fails closed.
Pre-evidence unversioned Gitcrawl jobs remain readable by durable-state tooling
but are quarantined from prompt rendering until they are archived or re-imported.
Marker-like text inside bounded claim data does not affect structural parsing.
The packet is advisory evidence, not mutation authority. Live GitHub hydration,
review logs, comments, checks, labels, and apply-time drift guards remain
authoritative.

Before enabling that quarantine on an existing queue, build repair code and run:

```bash
node dist/repair/gitcrawl-evidence-preflight.js \
  --jobs jobs \
  --gitcrawl-provider local \
  --write-manifest artifacts/gitcrawl-evidence-migration.json \
  --require-replacements
```

The preflight is non-mutating. It inventories valid current jobs, malformed or
invalid generated jobs, and every legacy cluster or low-signal job. Each legacy entry
contains structured `reimport`, no-clobber `archive`, and no-clobber `rollback`
command argv, its original target refs, matching replacement paths, and
`ready_to_archive`. Cross-filesystem entries also report whether writer
exclusion is required and confirmed. Cluster jobs re-import the exact source
cluster into a collision-free migration-suffixed path, including when a malformed
deterministic replacement path already exists. Low-signal jobs rerun the current
policy against a fresh snapshot while preserving the old candidate inventory in
the manifest.

Run missing re-import commands, validate the generated replacement jobs, rerun
with `--require-replacements`, then execute archive commands only for entries
marked ready. Archive commands refuse to replace an existing quarantine file;
retain the emitted rollback command until the replacement queue is validated.
Same-filesystem archive and rollback moves publish from a random hard-link
anchor and preserve the source inode before removing the identity-checked source
name. The destination is verified before source deletion.
When the archive is on another filesystem, stop every queue writer and rerun the
preflight with `--writer-excluded`; only that explicit assertion marks the entry
ready and adds the same flag to its archive and rollback commands. Cross-filesystem
copies remain descriptor-pinned and digest-verified, but writer exclusion is
mandatory because an open source descriptor can still receive writes during a
copy.
Finally run `--require-clean`; exit code 2 means legacy or invalid current jobs
still block the cutover. Pass the same `--db`, Cloudflare provider, archive, and
snapshot-age flags used by the importer so emitted commands are directly
runnable.

The default archive is `.legacy-gitcrawl-quarantine` beside the top-level
`jobs/` directory, never below it. An explicit `--archive` inside the active
jobs tree is rejected. Active validation and importer deduplication also ignore
the old in-tree quarantine name so a partially completed earlier migration
cannot consume dispatch capacity or suppress a replacement job.

## Failure Policy

Import fails closed for:

- an absent or incompatible cloud safety contract
- stale source sync or dataset generation
- incomplete required dataset coverage
- mixed dataset generations
- mixed or malformed snapshot ids
- cursor replay or cursor drift
- malformed or missing pagination stats
- missing or malformed numeric coverage and pagination fields
- malformed source revision or fingerprint digests
- malformed persisted scan cursors
- missing or partial PR detail/file hydration
- malformed PR detail or file freshness timestamps
- null or missing bodies claimed as complete safety metadata
- duplicate, missing, or non-contiguous PR file positions
- cluster member rows bound to a different cluster
- missing, conflicting, or incomplete declared cluster membership counts
- PR context or file rows bound to a different pull request
- review context not explicitly typed as a pull request
- search rows not explicitly typed as open pull requests
- search streams that violate chronological ordering, including resumed boundaries
- missing complete security metadata
- missing author-association or assignee evidence for low-signal intake
- cross-repository cluster memberships
- a provider that does not honor requested PR discovery order
- malformed cloud `columns`, `rows`, or `values`
- non-HTTPS cloud endpoints, redirects, origin changes, or responses over 512 KiB
- cloud/local coverage or admission-field parity mismatch
- mixed claim bindings or a tampered claim/packet digest
- frontmatter targets that do not exactly match packet-derived roles
- a target missing its operation-specific search, member, or review claim
- a required Gitcrawl packet that is absent, renamed, duplicated, or malformed

The default freshness limit is six hours. Override it with
`--max-snapshot-age-hours` or
`CLAWSWEEPER_GITCRAWL_MAX_SNAPSHOT_AGE_HOURS`.

Legacy local cluster tables are disabled by default. Enable them only with
`--allow-legacy-local` or
`CLAWSWEEPER_GITCRAWL_ALLOW_LEGACY_LOCAL=1`. Legacy packets list the exact
datasets that passed coverage checks; missing enrichment is not presented as
verified. Operations such as PR review context still require complete PR
detail and file coverage. Schema selection is based on populated repository
rows, not only table existence, and legacy cluster freshness supports stores
that expose `created_at` without `updated_at`.

Cluster discovery uses a hard `--scan-limit` window, defaulting to the larger of
`200` or ten times `--limit`, and examines up to four windows per invocation.
`--max-scan-windows` can lower that bound or raise it to at most 32. The
importer stores the next opaque provider cursor, ordinal, snapshot binding,
parity cursor when applicable, and ordering boundary in
`jobs/**/.gitcrawl-scan-cursors.json`. Later runs resume directly from that
snapshot-bound cursor, so large corpora do not replay every earlier page or hit
the per-run page ceiling. Cursor state is reused only when all snapshot
bindings still match. A new generation restarts at zero and relies on durable
job frontmatter to deduplicate already emitted clusters or pull requests. The
importer then persists a fresh opaque cursor bound to the new snapshot.
Existing or policy-rejected rows therefore advance discovery instead of
permanently pinning the first window. Cluster windows advance only after the
whole fetched window is examined. Malformed cursor state aborts intake. Explicit
cluster IDs and `--skip-existing false` start at zero and do not use persisted
progression.

Query-bound cursor files use schema v4 and persist primary and parity archive
identities alongside snapshot ids, opaque provider cursors, ordering boundaries,
and the full query digest. Cursor keys also include a digest of those archive
identities. Structurally valid v2 or v3 cursor files from older deployments are
treated as exhausted compatibility boundaries and safely reset, so the importer
rescans from zero instead of reusing progress without the complete source
identity.

Cursor writers serialize through a persistent SQLite lock database in the
separate `.gitcrawl-scan-cursors.lock-v2` namespace. During mixed-version
rollout, new writers also transact through the recognizable legacy
`.gitcrawl-scan-cursors.lock-migration.sqlite` database before acquiring the
legacy file or SQLite bridge, so an older writer cannot race the cutover.
Migration and lock databases are created through random, exclusive, no-follow
temporaries and verified by filesystem identity. Stale legacy entries are
identity-pinned before quarantine, so a successor lock is restored rather than
unlinked.

## Low-Signal Review Intake

Low-signal import hydrates exact PR review contexts with bounded parallelism.
`--query-concurrency` defaults to `4`. `--scan-limit` defaults to the larger of
`200` or ten times `--limit`. Stale mode requests oldest-first provider order
before applying that bound; recent and score modes request newest-first order.
The adapter parses RFC3339 timestamps, verifies every consumed row and page
boundary before advancing, and fails closed when a provider ignores the order.
The persisted cursor advances after every successfully examined window,
including windows containing only previously processed or blocked rows, but a
window with more qualifying PRs than `--limit` is replayed until every
qualifying candidate has been emitted. Processed references are read only from `candidates` and
`cluster_refs` frontmatter, never from evidence JSON or job prose. Score mode
uses full-body-derived policy bits before exact file hydration. PRs already
blocked by maintainer association, assignment, missing label/assignee data, or
security signals are discarded before the more expensive review-context query.

The snapshot is only a candidate-generation source. The deterministic
applicator still re-fetches the live PR and rejects maintainer-authored,
reviewed, commented, assigned, changed, or otherwise unsafe close candidates.

## Action Ledger

Workflow intake emits immutable action events for the evidence lifecycle:

- `gitcrawl.snapshot` binds the provider, snapshot digest, parity snapshot, and
  coverage digest.
- `gitcrawl.query` binds the versioned query name, result and claim counts, and
  a digest of the query identity and claim set.
- `gitcrawl.binding` binds the final packet digest to the generated repair job
  only after its atomic publication succeeds and before the scan cursor moves.

The ledger never stores SQL, query arguments, returned rows, raw payloads,
prompt text, logs, or cloud failure bodies. Snapshot identifiers are stored
only when they match the durable public snapshot format; all other identifiers
remain digest-only. The cluster intake workflow finalizes and imports these
events with the shared `repair:action-ledger` command before dispatching
generated jobs.

## Merge Dependencies

Cloud cluster and review intake requires crawl-remote to return complete
security inputs, author association/type, and assignment metadata or an
equivalent independently verifiable projection. Review context must explicitly
identify its result as `kind: pull_request`. Cloud low-signal stale intake
additionally requires `gitcrawl.threads.search` to honor `order`. ClawSweeper
rejects responses that omit those guarantees instead of silently weakening the
policy.
