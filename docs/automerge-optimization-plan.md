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

This is a handoff record. The stable-red phase is **not complete** and no
production Automerge behavior has been changed.

### Completed and evidence-backed

- The CLI supports explicit flow, publication, model, and runtime scenario
  selection; candidate and reproducer exit semantics are distinct and
  fail-closed.
- Proof summaries bind the candidate `HEAD`, production `dist/` digest,
  dependency digest, fixture identity, event/fault sequence, terminal state,
  and child-process observation. Candidate identity is rechecked after every
  scenario.
- The real OpenClaw git-hooks incident is confirmed against pinned revisions:
  `openclaw.unsafe-core-hookspath` at `target-setup-git-safety`.
- Both historical publication P1 cases are confirmed 10/10 against
  `5c28770b`: `state-publication.concurrent-sibling-lost` and
  `state-publication.merge-tree-entry-lost` at `state-publication-rebuild`.
- The immutable canonical-path conflict is safe 10/10: different bytes are
  blocked and the original remote tree entry is preserved.
- Pending-run replacement, duplicate command replay, both crash models, and
  all modeled mutation-sensitive drift cases are deterministic 10/10. They
  intentionally remain `evidence-only`, not a candidate-release pass.
- Focused proof/candidate/gate/model tests (23), syntax checks, formatting, and
  diff checks passed on Node 24.

### Incomplete or explicitly blocked

- The real process-leak case is **not confirmed**. With the pinned target tree,
  the real `pnpm check:changed` exits at the max-lines ratchet before the
  historical "exit 0 with four descendants" oracle. Its proof is correctly a
  `harness-error`; do not skip the ratchet or relabel this as confirmed.
- The flow 10/10 run completed but its inventory is `unstable`: flow fixture
  digests currently include per-run temporary Git metadata. Fix the flow
  fixture-digest contract before accepting repetition evidence; do not simply
  remove fixture identity from the stability signature.
- The full Node 24 `pnpm run check` was started in the shared workspace while
  other independent checks were also active. Re-run it in a quiet workspace and
  record the complete result before declaring the phase ready for repair.

### Next owner checklist

1. Reconstruct the historical process-leak workflow context from read-only
   evidence and explain the ratchet discrepancy while retaining real setup and
   `check:changed`; then require 3/3 warmup/final fingerprint agreement.
2. Make the flow fixture digest represent stable fixture content rather than
   generated commit metadata, add a focused regression test, and rerun flow
   10/10. A stable signature must still bind the actual fixture inputs.
3. Preserve the existing publication/model inventories, then compose a gate
   inventory by fixed candidate revision rather than pretending one candidate
   covers incompatible historical revisions.
4. Run the complete Node 24 check in isolation. Do not repair unrelated apply
   tests as part of this E2E-only phase.
5. Only after every stable-red exit criterion has evidence may the next PR
   begin a narrow production repair; retain every red reproducer as its oracle.

Useful local proof roots from the latest run are `/tmp/clawsweeper-e2e-closeout-*`.
They are disposable evidence, not repository fixtures; regenerate them rather
than relying on their lifetime.
