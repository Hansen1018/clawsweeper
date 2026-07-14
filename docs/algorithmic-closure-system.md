# Algorithmic Closure System

Read when changing review reuse, closure planning, worker admission, action
receipts, mutation recovery, or Gitcrawl-backed evidence.

ClawSweeper can reduce review latency and close related work faster without
making closure less conservative. The system is six cooperating algorithmic
layers:

1. semantic identity and incremental reuse;
2. dependency-graph closure planning;
3. risk/utility admission scheduling;
4. event-sourced actions, reviews, and review logs;
5. mutation safety and recovery; and
6. Gitcrawl local/cloud/parity evidence.

Implementation status on July 14, 2026, before this rollout finishes:

| Layer                | Status                    | Operational boundary                                                                                                                                                                                    |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Semantic identity | Partial, active           | Structural reuse and TypeScript/compiler-AST semantic identity are active. Tree-sitter language adapters remain planned.                                                                                |
| 2. Closure graph     | In rollout                | The bounded planner and reviewed graph gate exist in the PR stack. Production review/apply must not rely on them until both land.                                                                       |
| 3. Admission         | Partial, active           | Pressure telemetry and opt-in background yielding are active. Adaptive or bandit allocation remains planned.                                                                                            |
| 4. Action ledger     | In rollout                | The core receipt ledger is active; broader review, dispatch, proof, and projection coverage is still landing. The family table below is the target contract, not a claim of complete coverage.          |
| 5. Mutation safety   | In rollout                | Review-activity, immutable-retry, validation, repair, proof, and dispatch guards are being landed as a stack. Existing lanes keep their current guarantees until each owner lands.                      |
| 6. Gitcrawl evidence | In rollout, cloud blocked | Local six-query, canary, receipt, import, and Cloudflare parity changes exist in reviewed branches. Cloud-primary use remains disabled until the protected production deployment and parity proof pass. |

`In rollout` means reviewed code exists but is not yet a production guarantee.
`Planned` behavior must not be used for admission, mutation, or close decisions.

These layers optimize evidence collection, ordering, and resource use. They do
not replace the policy decision. Review remains proposal-only, and apply remains
the only issue/PR closure authority.

## Authority Boundaries

| Layer               | May decide                                                        | Must not decide                                                      |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Semantic identity   | Whether a prior keep-open review is reusable                      | Whether an item should close                                         |
| Closure graph       | Whether proposed close actions have one safe dependency order     | Whether a proposed close is factually correct                        |
| Admission scheduler | Which bounded work runs next                                      | Whether a mutation is allowed                                        |
| Action ledger       | What was attempted, observed, accepted, rejected, or left unknown | Whether replaying an unknown mutation is safe without reconciliation |
| Mutation guard      | Whether reviewed state is still current at the request boundary   | Product direction or canonical ownership                             |
| Gitcrawl evidence   | Which bounded graph claims are available and mutually consistent  | Whether graph similarity alone proves duplication                    |

The practical rule is simple: algorithms may save work and reject unsafe work.
They may not promote weak evidence into a close.

## 1. Semantic Identity And Incremental Reuse

The fastest review is the review that can be proven unnecessary.

ClawSweeper already separates review reuse into structural, semantic, and exact
content stages. Structural identity covers GitHub state. Semantic identity
covers code meaning. Exact content identity is the final fallback.

### Identity Pipeline

1. Run the structural probe from lightweight GitHub state. A matching structural
   record can avoid full hydration.
2. On a pull request cache miss, acquire the durable review lease before
   hydrating the complete review context. On an issue cache miss, hydrate first
   to derive `context.sourceRevision`, then acquire the issue review lease
   before reuse or publication.
3. Build a semantic digest from complete supported patches, file modes, syntax,
   and behavior-affecting directives. Build exact content identity as the
   fallback.
4. Bind the identities to policy, model, repository, base, head, and review
   activity.
5. Repeat the cheap live probes under the lease.
6. Reuse only a completed keep-open verdict when every required identity still
   matches.

Semantic reuse is `O(P)` in changed patch bytes plus parser cost. It avoids the
much larger cost of a model review. Any incomplete input falls back to a fresh
review.

### Compiler AST And Tree-sitter

TypeScript and JavaScript should continue to use the TypeScript compiler AST.
It understands the language's directive and lexical behavior better than a
generic concrete-syntax parser.

Tree-sitter is the right extension for additional languages, not a replacement
for the compiler path. Add one language adapter at a time:

- pin the grammar package and grammar version;
- version the normalization query set;
- include language, grammar version, query version, file mode, and path in the
  digest;
- preserve shebangs, suppressions, generated-code directives, build tags,
  pragmas, and other behavior-affecting comments;
- reject error nodes, missing nodes, ambiguous changed ranges, unsupported
  encodings, deletions, renames, and incomplete patches;
- use incremental trees only as an in-process optimization;
- persist canonical digests, not parser-native tree objects.

The first useful Tree-sitter targets are languages with frequent ClawSweeper
review volume and stable grammars. Adoption should be driven by cache-miss
metrics, not by adding every available grammar.

### Deterministic Identity

All semantic and structural collections use locale-independent code-unit or
byte ordering. A worker's locale must never change a digest, cache hit, graph
order, or receipt identity.

Semantic cache versions advance whenever grammar, normalization, directive, or
ordering behavior changes. Old identities are never silently reinterpreted.

## 2. Dependency-Graph Closure Planning

Related items are a graph, not a flat batch.

For each canonical group:

- nodes are the canonical root and reviewed closure candidates;
- an edge `A -> B` means `A` must close successfully before `B`;
- every closure candidate selects exactly one open canonical root;
- the root is evidence and never appears in a closure layer.

The planner performs:

1. bounded node and edge validation;
2. canonical-root validation;
3. dependency-target validation;
4. Tarjan strongly connected components for cycle detection;
5. deterministic Kahn topological layering.

Both graph passes are `O(V + E)`. Cycles, self-cycles, missing nodes, mixed
roots, root-targeting dependencies, independent-action dependencies, duplicate
conflicts, and out-of-bound graphs return `needs_human`. The planner emits no
partial safe-looking prefix.

Each action retains its reviewed evidence and live-state guard. A topological
plan only says which already-reviewed action may run next. If one layer fails or
drifts, dependent layers stop.

This structure improves closure throughput because independent members of one
layer may be processed together while dependent work stays ordered.

## 3. Risk/Utility Admission Scheduling

Game theory is useful for capacity allocation, not factual review.

ClawSweeper's worker lanes form a congestion game: each lane benefits from more
workers, while every extra worker increases queue contention, API pressure,
model cost, and the delay imposed on other lanes. A central admission mechanism
should make truthful bounded demand cheaper than aggressive over-claiming.

Start with a deterministic utility function:

```text
utility =
  freshness_debt
  + maintainer_unblock_value
  + expected_evidence_gain
  + dependency_unlock_value
  - expected_compute_cost
  - stale_input_risk
  - shared_capacity_contention
```

Use the score only inside a lane's policy envelope. Exact-item review, repair,
apply, and active maintainer commands remain priority work. Broad review,
commit review, Gitcrawl import, proof scans, and other background work yield
under exact-review pressure.

The mechanism needs:

- fixed lane ceilings and reserved priority capacity;
- pressure states derived from total, retry-ready, and target-admissible work;
- one serialized admission decision before a workflow matrix expands;
- continuation-time revalidation so stale plans do not retain old capacity;
- per-repository and per-target fairness;
- aging credits so quiet old work cannot starve forever;
- cost estimates from existing run history;
- deterministic tie-breakers;
- fail-open normal capacity when advisory telemetry is absent or stale.

Do not begin with reinforcement learning or a multi-armed bandit. Deterministic
utility, quotas, and measured cost estimates are explainable and reversible.
Bandit allocation becomes reasonable only after the receipt stream can measure
reward, cost, and policy violations without survivorship bias.

## 4. Event-Sourced Actions, Reviews, And Review Logs

Every authoritative action needs one immutable causal history.

The action ledger uses:

- `operation_id` for the logical lifecycle;
- `attempt_id` for one execution attempt;
- `parent_event_id` and `phase_seq` for causal order;
- `idempotency_key_sha256` for the external side effect;
- accepted, rejected-before-write, and unknown outcomes.

First-writer event bytes win. Replaying identical semantic content is
idempotent. Reusing an identity for different content is a hard conflict.

### Action Families

The same receipt model covers all ClawSweeper work:

| Family        | Lifecycle that must be represented                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review        | selection, lease, structural probe, hydration, semantic/content cache decision, Codex start/result, report write, public comment sync, history update, label projection, failed-review retry |
| Commit review | range expansion, code-bearing selection, Codex review, report publication, optional finding dispatch                                                                                         |
| Commands      | receive, authorize, parse, acknowledge, classify, status/explain, review dispatch, repair dispatch, approve, stop, requeue, terminal result                                                  |
| Dispatch      | target fanout, workflow dispatch, webhook intake, self-heal, spam intake, sweep continuation, commit-finding intake                                                                          |
| Repair        | job creation, immutable input capture, planning, edit attempt, validation, internal review, review fix, base reconcile, checkpoint, publication, exact-head re-review                        |
| Apply         | comment sync, label sync, decision packet, close, source-PR supersession, merge, post-flight                                                                                                 |
| Proof         | contributor nudge, bot-proof decision, Mantis request, comment/label mutation, reconciliation                                                                                                |
| Evidence      | Gitcrawl snapshot, six queries, coverage, graph packet, parity result, import, job publication                                                                                               |
| Projection    | state shard publication, dashboard projection, notification delivery, CrabFleet projection                                                                                                   |

Workflow-owned publication terminalizes any still-open attempt as unknown when
the process or workflow is interrupted. Unknown is not failure and not success;
it requires reconciliation before retry.

### Review Log Boundary

ClawSweeper has three different review-log surfaces:

1. **Public review history:** the bounded earlier-cycle ledger inside the one
   marker-backed GitHub comment.
2. **Durable machine history:** typed verdicts, finding titles, counts, digests,
   timings, cache metrics, run URLs, report paths, and action receipts.
3. **Ephemeral debug history:** prompts, model streams, raw Codex JSONL, raw
   provider responses, patches, full comments, and workflow logs.

Only the first two belong in durable state. Raw review and provider logs stay in
bounded GitHub Actions artifacts or local scratch output. The durable ledger
must never retain prompts, arbitrary model prose, bodies, diffs, credentials,
private hosts, absolute paths, or raw error messages.

The durable review lifecycle should be enough to answer:

- Was the item selected and leased?
- Was a cache considered, eligible, revalidated, and used?
- Which source revision and review activity were reviewed?
- Did hydration or Codex fail?
- Which report and public comment were published?
- Was a repair, proof, apply, or merge follow-up dispatched?
- Did a later attempt supersede an earlier unknown outcome?

## 5. Mutation Safety And Recovery

The decisive safety check happens immediately before the external request.

While layer 5 remains in rollout, the following sequence is the target contract
for every mutation path:

1. capture reviewed target state and bounded review activity;
2. prepare an immutable action and idempotency identity;
3. refresh live target and activity state;
4. durably open the attempt receipt;
5. publish the immutable recovery intent and state;
6. refresh again at the request boundary;
7. make at most one GitHub request;
8. publish accepted, rejected-before-write, or unknown;
9. reconcile unknown outcomes before retry.

Recovery-state publication is part of the pre-request transaction. If it fails,
the attempt closes as rejected-before-write and no scan cursor or checkpoint may
advance. After an accepted transport result, later receipt-flush failure is
reported as a durability fault but must not cause the external request to be
replayed.

### Review Activity Cursor

The cursor digests reviews, inline comments, and thread resolution state with
stable ordering. Apply, repair, proof, and automerge compare it immediately
before mutation. Missing, incomplete, unstable, or legacy cursor state forces a
fresh review.

### Immutable Recovery Inputs

Every repair attempt persists the exact job path, mode, sandbox, model, runner,
dry-run state, source revision, and authorization digest. Requeue and self-heal
recover that snapshot. They do not reconstruct stronger permissions from
current workflow defaults.

### Validated Publication

Repair validation binds:

- the exact Git commit and tree;
- worktree content and Git administrative state;
- ignored runtime inputs such as dependency environments;
- allowed validation commands;
- the pinned base and final reconciled base;
- isolated Git configuration and network publication;
- dependency setup and validation inside a disposable Linux user, PID, mount,
  and network namespace with loopback brought up explicitly;
- a read-only host view plus bounded writable roots enforced by mounts and
  Landlock, followed by clearing every inherited, permitted, effective,
  bounding, and ambient capability;
- contained process-tree completion.

The executor commits and pushes the validated SHA, not a mutable `HEAD`.
Recovery materializes the saved commit before continuing. Rebase, continuation,
hooks, filters, askpass, dependency lifecycle scripts, and publication remain
inside the isolated boundary. Any surviving descendant is killed and reaped
before the validation result can be accepted.

## 6. Gitcrawl Local, Cloud, And Parity Evidence

Gitcrawl supplies a bounded evidence graph through six provider-neutral queries:

- `gitcrawl.clusters.list`;
- `gitcrawl.clusters.members`;
- `gitcrawl.clusters.related`;
- `gitcrawl.threads.search`;
- `gitcrawl.pull_requests.review_context`; and
- `gitcrawl.coverage`.

### Provider Modes

`local` reads a verified read-only SQLite snapshot.

`cloud` calls the Cloudflare-hosted crawl-remote service through the same
versioned contract. GitHub Actions exchanges its OIDC identity for a short-lived
reader-only session bound to the exact repository, workflow, protected branch,
event, and workflow SHA.

`parity` uses cloud as primary and requires normalized local and cloud evidence
to agree before publishing repair jobs.

Every packet binds repository, snapshot, source digest, release SHA, schema,
capabilities, query arguments, coverage, rows, graph nodes, graph edges, and
canonical digests. Pagination, row, claim, graph, response-byte, and retry-wait
bounds are part of the contract.

Gitcrawl evidence accelerates:

- related-item hydration;
- canonical-root candidate discovery;
- cluster repair intake;
- review context for pull requests;
- coverage-gap detection;
- duplicate-family and dependency-edge proposals.

It never closes an item by similarity alone. A graph relation becomes review
context, then a typed proposal, then a dependency-checked plan, then a
live-state-guarded apply action.

## End-To-End Closure Flow

```text
GitHub event / scheduled scan / maintainer command / Gitcrawl cluster
  -> admission scheduler
  -> structural + semantic identity
  -> bounded hydration and Gitcrawl evidence packet
  -> Codex typed review or repair result
  -> review activity binding
  -> closure dependency graph
  -> proposal-only report and durable public review comment
  -> apply admission
  -> request-boundary compare-and-set guard
  -> GitHub mutation
  -> accepted / rejected / unknown receipt
  -> state, dashboard, notification, and review-history projections
```

At every arrow, a stale, incomplete, ambiguous, cyclic, oversized, or
privacy-unsafe input stops or falls back to a fresh review. It never receives a
more permissive interpretation.

## Complexity And Performance

| Operation                              | Bound                                       | Expected benefit                                        |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| Structural identity                    | `O(M)` bounded metadata                     | Avoid full hydration                                    |
| Compiler/Tree-sitter semantic identity | `O(P)` patch bytes                          | Avoid repeated model review                             |
| Tarjan SCC + Kahn layering             | `O(V + E)`                                  | Parallel safe layers, no cyclic closeout                |
| Admission selection                    | `O(N log N)` with stable ranking            | Protect priority latency and reduce idle capacity       |
| Receipt append/finalization            | `O(A log A)` for bounded canonical ordering | Crash-safe replay and reconciliation                    |
| Gitcrawl packet verification           | `O(R + G)` rows plus graph                  | Reuse existing cluster/review data without live recrawl |

`M`, `P`, `V`, `E`, `N`, `A`, `R`, and `G` are all explicitly bounded. The
system rejects rather than silently truncates authoritative evidence.

## Rollout Gates

1. **Observation:** ship cache, queue-pressure, Gitcrawl, and receipt metrics
   without changing selection or mutation behavior.
2. **Planning:** enable dependency plans and parity checks as fail-closed review
   gates, still without automatic graph-driven closure.
3. **Receipts:** cover review, command, dispatch, repair, proof, apply, and
   projection families; prove interruption and first-writer replay.
4. **Mutation guards:** require current review activity, immutable recovery
   inputs, validated SHAs, and request-boundary reconciliation.
5. **Admission:** enable background yielding behind an opt-in variable, compare
   exact-review latency and starvation metrics, then make it the default.
6. **Cloud evidence:** require release-bound six-query canaries and protected
   local/cloud parity before cloud-primary intake.
7. **Tree-sitter:** add one language adapter behind semantic-cache metrics,
   advance the cache version, and enable reuse only after cross-platform and
   cross-locale digest proof.

Rollback is per layer. Disabling cloud, semantic reuse, graph planning, or
adaptive admission must leave ordinary fresh review and guarded apply working.

## Success Metrics

Track:

- structural, semantic, and exact cache eligibility, hits, revalidations, and
  fallbacks;
- model calls, hydration requests, review latency, and cost avoided;
- exact-review queue pressure, target-admissible backlog, lane utilization, and
  oldest-work age;
- dependency cycles, ambiguous roots, invalid dependency targets, layer count,
  and blocked dependents;
- mutation attempts, accepted, rejected-before-write, unknown, reconciled, and
  duplicate-prevented outcomes by action family;
- review-activity drift blocks and immutable-input recovery fallbacks;
- local/cloud parity results, release mismatches, coverage gaps, and packet
  verification failures;
- raw-log privacy violations, which must remain zero.

The optimization target is not "more closures." It is lower time-to-correct
decision, fewer repeated model and API calls, fewer stale mutations, and a
larger fraction of safe closure groups completed without maintainer cleanup.
