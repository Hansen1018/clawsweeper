# Gitcrawl Query Evidence

ClawSweeper has a read-only, provider-neutral Gitcrawl evidence core for six
queries:

- `gitcrawl.clusters.list`
- `gitcrawl.clusters.members`
- `gitcrawl.clusters.related`
- `gitcrawl.threads.search`
- `gitcrawl.pull_requests.review_context`
- `gitcrawl.coverage`

The core snapshots, validates, normalizes, and digest-binds query results. It
does not mutate Gitcrawl, GitHub, repair jobs, workflows, or durable state.

## Providers

`local` opens the configured SQLite database read-only, creates a private
`VACUUM INTO` snapshot, verifies it with `pragma quick_check`, and serves all
queries from that snapshot. The snapshot file digest becomes its identity.
Legacy cluster tables are rejected unless explicitly allowed.

`cloud` posts the versioned query contract to a crawl-remote HTTPS endpoint.
It requires a bearer token, a complete Cloudflare Access service-token pair,
or both. Redirects, origin changes, unbounded responses, malformed row
projections, and response bodies over 512 KiB are rejected.

`parity` treats cloud as primary and compares normalized rows and required
coverage against a local snapshot before returning evidence.

## Snapshot Contract

Every response is bound to one repository, archive, snapshot, source sync,
dataset generation, schema, capability set, and coverage state. The cloud
snapshot id must be the same lowercase SHA-256 digest as `source_sha256`.

The initial `gitcrawl.coverage` query pins the session. Later pages or queries
that change any pinned identity field fail closed. Opaque pagination is
transport-local and bounded by page and row limits. Row limits are part of the
canonical query arguments, and reaching one before the provider's terminal page
is rejected rather than represented as complete evidence. This core does not
expose or persist repair scan cursors.

Coverage is query-specific:

- cluster queries require repository, thread, cluster-group, and membership
  coverage;
- thread search requires repository and thread coverage;
- pull-request review context additionally requires complete PR detail and file
  coverage.

Local freshness is accepted only from a completed, repository-scoped full/open
sync or a complete open-reconciliation tuple. Export timestamps and database
mtime are not freshness proof.

Cluster coverage additionally requires the latest successful cluster run to
have started at or after the accepted source sync. Portable exports that omit
cluster-run provenance cannot certify cluster queries.

## Evidence Binding

Normalized rows become digest-bound claims containing:

- provider, repository, and snapshot identity;
- query name and canonical argument digest;
- canonical repository subject;
- source revision and thread fingerprint when available;
- graph relations;
- bounded normalized data;
- semantic and full claim SHA-256 digests.

Claims can be assembled into a bounded evidence packet with coverage, graph
nodes, graph edges, included counts, and a packet digest. Version 2 packets are
complete or rejected: claim, graph, and byte bounds never silently discard
evidence. Verification rebuilds the full canonical graph from verified claims
and rejects repository relabeling, unknown claim fields, mixed snapshots,
missing required coverage, malformed persisted coverage, and digest tampering.

Thread safety classification uses the complete source title, body, labels,
assignees, actor identity, and author association before prompt fields are
bounded. Every query shape for one thread must produce the same safety
projection. Nested HTML comments are removed completely from prompt-facing
values, and sanitized object-key collisions are rejected.

## Fail-Closed Rules

The query core rejects:

- stale, incomplete, mixed, or malformed snapshot provenance;
- unsupported query names or contract versions;
- incomplete required dataset coverage;
- provider cursor replay, duplicate row identity, nonterminal row truncation, or
  page-limit exhaustion;
- cloud authentication, HTTPS, redirect, origin, envelope, or size failures;
- server throttling windows that exceed the configured retry wait budget;
- cloud/local parity drift;
- active clusters without valid active memberships, or cluster members from
  another cluster or incomplete declared membership;
- conflicting or replayed related rows; duplicate threads reached through
  multiple shared clusters are deduplicated by canonical thread identity;
- related rows bound to another source or to themselves;
- unknown issue or pull-request thread kinds;
- search rows that are not open pull requests or violate requested ordering;
- review context without one exact pull request and its complete contiguous
  file set;
- malformed or cross-repository graph identity, revision, fingerprint, Git
  object, timestamp, actor, or numeric fields;
- hidden HTML-comment content reaching a claim;
- mixed, partial, relabeled, or tampered claims, coverage, graph data, or
  packet digests.

## Deliberate Non-Goals

This core does not include repair-action-ledger events, job publication
transactions, importer state, durable scan cursors, workflow activation,
GitHub mutation, PR lifecycle handling, or raw provider logs.
