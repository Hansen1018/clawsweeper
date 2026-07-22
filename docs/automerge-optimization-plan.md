# Automerge Reliability Improvement Plan

## Purpose

Make ClawSweeper automerge predictable, recoverable, and safe by moving from
production-discovered failures to local, replayable evidence. This plan is a
sequence: do not treat an apparent workflow success as proof that an automerge
attempt reached a safe product terminal state.

## Scope and safety boundary

- All early validation uses fixed revisions, local bare Git remotes, and a
  fail-closed GitHub simulator.
- It never writes GitHub comments, labels, branches, merges, or closes items.
- It does not change production automerge behavior during the stable-red
  phase. Production fixes begin only after a reproducer is accepted.
- Local tests must use explicit process, tree, and state oracles rather than
  treating a command exit code as the complete result.

## Phases

### 1. Establish stable red evidence

Build a proof-producing E2E harness around production artifacts. Each proof
binds the candidate revision and executable/dependency digests, fixture digest,
event sequence, fault point, phase, product outcome, Git tree state, and child
process observation.

The gate has two deliberate modes:

- `candidate`: a known product violation is red and exits non-zero.
- `reproducer`: the same exact fingerprint is a confirmed historical
  reproducer and exits zero.

The initial evidence set includes OpenClaw runtime incidents, state-publication
tree-loss cases, immutable canonical paths, duplicate delivery/replay,
replacement runs, modeled crashes, and mutation-sensitive head/base/check/
review/permission/label drift.

Stable red requires deterministic inputs and scheduling, the same phase and
normalized fingerprint on every run, no timeout/network/race substitute
failure, ten of ten fast repetitions, and three of three real OpenClaw
repetitions. A model-only result is evidence, not a release-candidate pass.

### 2. Repair one proved invariant at a time

For each accepted red proof, make the narrowest production change that restores
the violated invariant. Preserve the reproducer, add the green counterpart,
and require candidate mode to pass without weakening the oracle. Do not hide a
failure with retries, larger timeouts, skips, or a broader fixture.

### 3. Validate the GitHub contract minimally

After local evidence is green, validate only the platform-specific contract
that cannot be modeled locally: Actions delivery and cancellation behavior,
GitHub permission/ruleset combinations, merge-queue semantics, and API
eventual consistency. Keep the validation proposal-only until its scope is
explicitly authorized.

### 4. Refactor toward durable state ownership

Move the automerge path toward explicit durable intent, attempt, outcome, and
publication records. Reconciliation must be idempotent: repeated commands,
deliveries, and restarts may observe or finish an existing fact but must not
create a second logical merge, comment, or publication.

Split responsibilities into small modules:

- admission and immutable job intent;
- exact-head/readiness verdicts;
- execution and containment;
- durable result/outcome recording;
- reconciliation and router recovery;
- state-tree publication with CAS/tree-preservation checks;
- proof and operational reporting.

The state repository remains the durable status surface. A missing, stale, or
conflicting fact blocks mutation rather than selecting a best-effort path.

## Required invariants

- Exact head/base, checks, review, permission, and protected-label facts are
  revalidated immediately before a merge mutation.
- A workflow's successful process exit cannot override leaked descendants or a
  blocked product state.
- State publication preserves concurrent siblings, merge parents, and existing
  immutable entries; a conflicting canonical path fails closed.
- A crash after durable intent is recoverable without duplicate work; a crash
  after merge records one outcome without a second merge.
- Candidate, fixture, dependency, and proof identity drift are harness errors.

## Exit criteria

The stable-red phase is complete only when all required incident and topology
scenarios have deterministic proofs, fast and real repetition inventories are
complete, controls pass, the full local gate has a measured hot-cache budget,
and no local test touches live GitHub state. The handoff is a failure inventory
and replayable proof bundle, not a production fix.

## Current status

The harness has confirmed the git-hooks runtime incident and both historical
state-publication P1 tree-loss fingerprints. The canonical immutable-path
control and deterministic recovery/drift models are stable. The process-leak
fixture currently fails closed before the historical leak oracle because the
pinned target's default `check:changed` ratchet exits non-zero; its historical
workflow context must be reconstructed without bypassing that check. Flow
repeat inventory also needs a stable fixture-digest representation that does
not include per-run temporary Git metadata.
