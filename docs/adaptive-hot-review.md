# Adaptive Scheduled Hot Review

- Status: active implementation, production behavior default-disabled
- Owner: ClawSweeper maintainers
- Source of truth: `config/automation-limits.json`,
  `src/repair/adaptive-hot-allocation.ts`,
  `src/repair/adaptive-hot-runtime.ts`, `src/repair/target-fanout.ts`,
  `dashboard/adaptive-hot-review.ts`, and `.github/workflows/sweep.yml`
- Last verified: PR #1110 implementation branch; replace with the merge revision
  before production activation
- Update when: observation schemas, allocation rounds, caps, readiness gates,
  activation variables, queue pressure fields, or rollback behavior change

This system replaces the long-term assumption that every selected repository
deserves the same expensive planning opportunity. It is shipped as one
cross-component package, but it does not activate itself. The existing
20-minute hot-fanout cadence, legacy selection, 50-candidate planner offer, and
queue admission of 300 items/hour with burst 30 remain authoritative while the
kill switch is on.

## Flow

| Boundary    | Legacy/default behavior                                                                 | Adaptive behavior when explicitly enabled                                                              |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Inventory   | Eligible repositories with live open issues or PRs                                      | Same inventory and deny rules                                                                          |
| Observation | Each scheduled planner posts its bounded admission funnel, including zero-demand cycles | Same signed observations feed the allocator                                                            |
| Capacity    | Up to 20 rotated repositories, each offered the normal 50-candidate planner window      | Minimum of free review-queue capacity, global scheduled tokens, and hot-lane tokens                    |
| Allocation  | Equal repository rotation                                                               | Overdue fairness, source novelty, at most two unknown probes, ordinary demand, then residual expansion |
| Admission   | Durable queue dedupe, shedding, pacing, and leases                                      | Unchanged; allocation cannot bypass admission                                                          |
| Execution   | Structural/semantic/content cache and full review                                       | Same execution; aggregate cache/no-op/runtime outcomes return through lease-authorized completion      |
| Visibility  | Queue and scheduled-feed status                                                         | Proposed-versus-actual decisions, observation aggregates, readiness windows, and offline replay        |

The allocator never uses maintainer identity, contributor identity, other
personal attributes, or publication queue depth as a repository signal.
Repository priority must come from an explicit maintainer-owned policy change;
the v1 live integration does not infer it. Credential circuits from the
request-accounting taxonomy constrain work: a repository-actions circuit stops
discretionary allocation globally, while a target-app owner circuit defers only
that owner's repositories.

## Policy semantics

One cycle computes service capacity before repository planning:

```text
service capacity = min(
  free review candidate capacity,
  global scheduled token balance,
  hot-intake token balance
)
offer budget = min(ceil(service capacity * 1.5), 30)
```

The allocator selects no more than 20 repositories. One repository receives no
more than 25% of the over-offered candidate budget, with an integer minimum of one and an
absolute cap of 10 candidates. Fresh observed demand is considered in this
order:

1. one candidate for repositories whose oldest unserved work is at least 24
   hours old;
2. one candidate for source-novel issue or PR demand;
3. at most two one-candidate probes for missing, stale, or malformed
   observations, using a separate durable cursor;
4. one ordinary-demand candidate;
5. round-robin residual expansion up to each repository cap.

If the observation snapshot as a whole is unavailable, the allocator falls
back to at most five repositories with one candidate each. If queue capability,
scheduled tokens, or the global request circuit is unavailable in an active
mode, it selects no adaptive work and advances no legacy, adaptive, or probe
cursor. Stale observations are older than six hours. The main adaptive and
probe cursors are durable and independent from the legacy fanout cursor.

## Observation and feedback boundaries

The planner posts a signed, idempotent observation after queue dispositions are
known. It includes eligible and source-novel demand, oldest due/unserved age,
and offered, admitted, deduped, shed, deferred, rejected, and throttled counts.
Observation failure is fail-open because it must not invalidate already valid
queue admissions. An observation written under a different policy version is
retained for comparison but treated as unknown by the current allocator; a
policy change never reinterprets historical demand.

`oldestUnservedAt` advances after admission to the oldest selected item that
was not queued or deduped, or to the plan's exact oldest unselected due item.
It remains unknown when neither timestamp is observable; an admitted item is
never reused as a fairness signal.

Scheduled lease completion may attach aggregate structural, semantic, content,
hydration, early-no-op, outcome, retry, and runtime facts. The Durable Object
accepts those facts only on a currently claimed scheduled review item and
deduplicates them by the fenced completion receipt. This prevents dashboard or
publication activity from manufacturing allocator demand.

The Durable Object keeps planner and execution observations for 14 days, capped
at 20,000 rows per observation table. It keeps at most 640 decisions and exposes
at most the most recent 100 in `GET /api/exact-review-queue`. Repository
snapshots contain aggregates, not issue bodies, review text, filesystem paths,
or credentials. Each decision retains actual and proposed repository budgets,
round-by-round reasons, offer reduction, an observation-based dedupe/shed
avoidance estimate, and fairness age before and after the bounded proposal.
Those estimates are diagnostic comparisons, not admission inputs.

## Modes and controls

The target-fanout job reads these repository variables:

| Variable                                       | Checked-in fallback | Contract                                                       |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `CLAWSWEEPER_ADAPTIVE_HOT_MODE`                | `legacy`            | `legacy`, `shadow`, `canary`, or `full`                        |
| `CLAWSWEEPER_ADAPTIVE_HOT_KILL_SWITCH`         | `1`                 | Any true value forces effective mode to `legacy` immediately   |
| `CLAWSWEEPER_ADAPTIVE_HOT_ACTIVATION_APPROVAL` | `none`              | `canary` or `full` is a separate explicit approval gate        |
| `CLAWSWEEPER_ADAPTIVE_HOT_CANARY_REPOSITORIES` | empty               | Exactly three to five `owner/repository` slugs in canary mode  |
| `CLAWSWEEPER_ADAPTIVE_HOT_ROLLOUT_PERCENT`     | `100`               | Deterministic `10`, `50`, or `100` percent cohort in full mode |

Modes are deliberately asymmetric:

- `legacy`: no allocator read or decision write; existing selection and cursor
  remain authoritative. Planner and execution observations may still collect.
- `shadow`: computes and durably records the adaptive proposal, but dispatches
  the exact legacy repository list and 50-candidate capacities. A telemetry or
  adaptive-cursor batch failure warns without blocking legacy work or counting
  the comparison toward readiness. The main and probe cursors reserve and
  commit together when the adaptive batch is available. The authoritative
  legacy cursor stays outside that comparison reservation and persists
  independently, so an adaptive reserve or commit failure remains fail-open
  for legacy work.
- `canary`: replaces only legacy slots belonging to the explicit three-to-five
  repository allowlist. Control-plane, decision, and cursor durability are
  required for a successful active cycle. The legacy cursor when used, the main
  adaptive cursor, and the probe cursor are covered by one atomic one-hour
  Durable Object reservation before any GitHub dispatch, but their positions do
  not advance yet. After every dispatch succeeds, one commit transaction
  advances all covered cursors. A reservation conflict dispatches nothing. If
  the first GitHub dispatch fails, the matching reservation aborts without
  advancing cursors; an unavailable abort retains the bounded lease rather than
  clearing an uncertain owner. If a later dispatch fails after an earlier one
  succeeded, the whole reserved cursor batch commits. GitHub repository dispatch
  has no rollback or idempotency key, so this deliberately chooses at-most-once
  Actions dispatch over replaying already-started work. The failed and remaining
  repositories are not removed from inventory: their due demand remains visible
  to the next demand, novelty, probe, and 24-hour fairness rounds. A commit
  failure after any successful dispatch retains the lease for an idempotent
  retry or bounded expiry.
  An expired lease cannot commit. A bounded ledger retains up to 80 live
  24-hour commit receipts: one for each of the 72 cycles possible at the
  contained 20-minute cadence plus eight manual/retry slots. A live receipt
  also makes its reservation identifier one-shot. These rules make a successful
  commit idempotent if its response is lost without allowing the same identity
  to dispatch a different batch. The planned decision also persists before
  this reservation.
- `full`: uses deterministic 10%, 50%, or 100% cohorts. Non-cohort legacy slots
  remain legacy at 10% and 50%; 100% uses only the adaptive cursor and proposal.

Canary requires an explicit `canary` or `full` approval plus at least 21 durable
shadow dispatch decisions spanning seven days. Full mode requires explicit
`full` approval plus at least 3 durable canary dispatch decisions spanning
24 hours before the 10% cohort. The 50% cohort then requires at least three 10%
decisions spanning 24 hours, and 100% requires the same 50% window. These
windows are measured from the first to the last qualifying comparison, so an
old burst cannot age into eligibility. These time-and-cycle gates prevent
accidental stage skipping; they do not replace
maintainer review of yield, cost, fairness, and incidents. Granting the approval
value also records that the maintainer checked the separate #1102 quota/circuit
and #1088 self-feedback evidence required by the rollout plan.

## Offline replay

Do not activate production to prove allocation behavior. Save or construct a
sanitized `adaptive-hot-review-replay-input/v1` document containing repository
slugs, an exported adaptive snapshot, queue/token/circuit facts, policy, and
cursors. Then run:

```bash
pnpm run build:repair
node scripts/evaluate-hot-allocation.mjs path/to/replay.json
```

`test/fixtures/adaptive-hot-allocation/replay.json` is the canonical example.
The output includes the complete deterministic allocation decision and, when
an expected decision is supplied, an allocation comparison. The command does
not call GitHub, the Worker, the queue, or Actions.

For a disconnected end-to-end development proof, use the fixture-only
[Docker/Crabbox harness](proof/adaptive-hot-review/README.md). It combines this
replay and the focused control-plane tests with a disposable local Wrangler
Worker and SQLite Durable Object restart. It refuses an unrecorded checkout
head and does not activate or contact production.

## Rollout and rollback

Shipping this code does not authorize deployment or activation. After the
Worker and workflow revisions are both reviewed and deployed compatibly, the
operational sequence is:

1. leave `mode=legacy` and the kill switch on; verify signed observation
   storage and no change to dispatch cadence or admission;
2. set `mode=shadow` and deliberately turn the kill switch off; observe at
   least seven days and 21 dispatched comparison cycles for the exact current
   policy version. Throttled, unavailable, zero-capacity, zero-demand, and
   active cycles that dispatch no adaptive allocation do not count;
3. after maintainer approval, use a three-to-five repository canary for at
   least 24 hours and three cycles;
4. after separate full approval, advance deterministic cohorts through 10%,
   50%, and 100%, pausing at each boundary for adjudication.

Advance only when review admission and execution error rates do not regress,
credential or scheduled throttling does not increase, no repository breaches
the 24-hour fairness objective, and adaptive offer volume stays within token and
queue bounds. The planned quantitative bar is at least 30% fewer full hydrations
per source-novel scheduled item, at least 50% fewer hot `scheduled_rate` sheds,
no GitHub-throttle or circuit-opening increase at comparable organic demand, no
more than 10% p95 source-novel latency regression, and at least 95% of
continuously due repositories served within the fairness window. Normal weekly
coverage, exact/organic latency, and same-source self-feedback must not regress.

Meaningful-review yield remains observational in v1 and must not suppress the
first fairness allocation. Canonical review outcomes can be compared with the
aggregate execution counts, but maintainers must define which close, keep-open,
finding, repair, or state-transition outcomes count before using yield in a
later policy. The implementation deliberately does not guess that product
definition.

Rollback is one variable change: set
`CLAWSWEEPER_ADAPTIVE_HOT_KILL_SWITCH=1`. The next fanout immediately uses the
legacy selection and legacy cursor, even if the requested mode remains
`canary` or `full`. It does not clear queues, rewrite existing leases, erase
observations, or reset adaptive cursors. Roll back for malformed/stale control
data, decision or cursor write failures, queue/token accounting disagreement,
fairness breach, unexplained GitHub request growth, higher retry/error rate, or
worse meaningful-review yield. Schedule, admission, and queue changes require a
separate reviewed decision.
