# Repository Actions pool coordinator real-boundary proof

## Claim

The default-disabled Phase 1 coordinator fences publication egress for one
repository Actions credential pool. The first authoritative throttle advances
the shared epoch, prevents every acquired-but-unstarted sibling from reaching
GitHub, preserves the bounded started remainder, survives a Worker restart,
admits one reset probe, and restores capacity through deterministic `1, 2, 4,
8` recovery waves. Target-App work and the disabled rollback path remain
independent.

## Exercised surface

- The production signed coordinator client and internal Worker routes
- A real Wrangler/workerd Worker and SQLite-backed Durable Object
- Eight sibling permits with three started operations and five stale-epoch
  rejections after the first 403
- An ambiguous retry of one stale-epoch rejection without a second avoided-count
- A committed start replayed after an interleaved throttle, which must be
  rejected against the new epoch
- An actual GitHub CLI binary over loopback TLS for every operation counted as
  external work
- Authoritative `Retry-After` and `X-RateLimit-Reset` propagation, safe fallback
  for numeric deadlines outside the credibility horizon, restart persistence,
  one half-open probe, and `1 -> 2 -> 4 -> 8` recovery
- Loss of both signed throttle acknowledgements after a real on-wire throttle;
  the runner must preserve its original bytes and append one bounded local
  fallback so lifecycle release keeps untouched siblings unattempted
- The production publication runner with Phase 0 header detail, pre-wire
  deferral, per-member attempt receipt, target-App bypass, and default-disabled
  rollback
- A real `gh run download` artifact request whose first loopback 403 opens the
  repository pool and whose next sibling is rejected before any artifact API
  request
- The terminal item-state confirmation on the repository credential, including
  header-only throttle classification and a sibling rejected before its issue
  read
- A real wrapper and child-process boundary where `SIGTERM` reaches the active
  GitHub CLI child before the wrapper exits
- Sanitized public observability and privacy sentinels

## Run

From the repository root on Node 24 or later:

```bash
docs/proof/github-egress-pool-coordinator/run-proof.sh
```

The script uses pinned Wrangler 4.107.0 and a disposable self-signed loopback
certificate. If `gh` is unavailable, it downloads GitHub CLI 2.88.1 and
verifies the Linux AMD64 archive checksum before extraction. It uses synthetic
credentials and loopback application endpoints only; it does not call GitHub,
mutate production, dispatch workflows, or change queues, gates, schedules,
deployments, or credentials.

## Required result

- The first throttle opens epoch 2 with two already-started sibling operations.
- Five acquired siblings are rejected before their `gh` command starts; the
  loopback server observes only the three started operations.
- Replaying one rejected `start` returns the original rejection without
  incrementing the avoided-operation counter again.
- The two non-throttled started operations finish after open and are counted as
  the bounded remainder.
- Worker restart preserves epoch, deadline, reset provenance, counters, and
  telemetry completeness.
- Exactly one of eight reset contenders receives the probe permit.
- A successful probe enters recovery; successful waves of 1, 2, 4, and 8 close
  the pool without restoring capacity in one step. Each ramp level is a fixed
  cohort; the final level cannot replenish after a success or close until the
  whole cohort settles, and an expired acquired or started recovery permit
  reopens rather than admitting a replacement.
- A later runner-observed 403 with numeric reset values beyond the credibility
  horizon opens persisted fallback and defers the next runner without another
  loopback request. The first member has an atomic attempted receipt; the
  deferred member does not.
- A runner-observed 403 whose two coordinator acknowledgements both receive
  synthetic 503s appends one non-authoritative five-minute local fallback while
  preserving the attempted member and original command result.
- A real artifact download can be the first throttled repository operation; its
  next sibling exits through the coordinator deferral without reaching the
  loopback artifact endpoint.
- A real terminal item-state read with generic forbidden stderr is classified
  from bounded response headers, opens the pool, and prevents the next terminal
  confirmation from reaching the loopback issue endpoint.
- Target-App and disabled rollback calls still reach their independent loopback
  path while repository Actions is open; disabled rollback records the durable
  attempt before the wire call.
- Failure to create an invocation-private throttle-header sink releases the
  started permit as unexecuted and defers without reaching GitHub.
- Terminating the production runner forwards termination to its active `gh`
  child; the focused real-process regression observes the child receipt and a
  nonzero wrapper exit.
- Public JSON contains no raw pool, repository, item, URL, request, token, or
  ETag sentinel.

## Artifacts and limits

Evidence is written to `.artifacts/github-egress-pool-coordinator-proof/`:
`proof-summary.json`, sanitized public state, focused-test output, build/install
logs, and a secret-redacted Wrangler log. Generated artifacts are not committed.

The coordinator fences one external `gh` invocation per permit. GitHub CLI
artifact downloads can contain opaque internal HTTP requests, so Phase 0
remains the exact wire denominator. Deterministic tests, rather than this live
clock proof, cover headerless fallback jitter, expired permits, throttled
probe/ramp recovery, completed non-throttled command failures, unexecuted
command failures, attempted-false durable queue accounting, and other-pool
state isolation.
