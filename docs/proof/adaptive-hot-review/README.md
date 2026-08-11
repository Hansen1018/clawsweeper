# Adaptive scheduled hot-review proof

This fixture-only proof exercises the complete adaptive hot-review package
without contacting a production Worker, queue, GitHub repository, or workflow.
It combines deterministic allocator/control tests and offline replay with a
local Wrangler Worker backed by a disposable SQLite Durable Object directory.
The runtime pins Wrangler `4.107.0`, matching the repository dashboard scripts.

The runtime scenario proves that:

- signed planner observations and planned/dispatched decisions are
  idempotently stored and remain visible after a Worker restart;
- an active cursor reservation does not advance any cursor before commit;
- the reservation survives a restart, commits all three cursors atomically,
  and returns the same receipt when the commit response is retried after a
  second restart;
- a separate failed-dispatch reservation aborts without moving cursors and a
  replacement reservation can be acquired immediately; and
- the actual built `target-fanout` command crosses a loopback-only TLS proxy to
  the local Worker, aborts after a deterministic zero-dispatch fault, then
  recovers by recording two synthetic dispatches and committing its batch; and
- three injected shadow comparison-commit failures cannot fence the
  authoritative legacy cursor, and the next cycle selects the next repository;
- malformed inactive adaptive controls cannot defeat kill-switch rollback to
  legacy dispatch and cursor persistence; and
- the bounded public snapshot contains neither the synthetic signing secret
  nor local persistence paths.

Run it from an exact committed checkout in Docker-backed Crabbox:

```bash
proof_head="$(git rev-parse HEAD)"
crabbox run \
  --provider local-container \
  --local-container-image mcr.microsoft.com/playwright:v1.60.0-noble \
  --no-hydrate \
  --timing-json \
  --script docs/proof/adaptive-hot-review/run-proof.sh \
  -- "$proof_head"
```

The script writes logs, deterministic replay output, a machine-readable
`proof-summary.json`, and `runtime-transcript.md` under
`.artifacts/adaptive-hot-review`. It refuses to run when the recorded head
argument does not match the checkout head or when the checkout has staged,
unstaged, or untracked changes.

The command proof replaces `gh` with a fixture executable and uses only
sanitized `example/*` repositories. It records the exact dispatch arguments but
does not contact GitHub.

This is development proof only. It does not deploy the Worker, dispatch a live
workflow, activate production shadow/canary/full mode, change the 20-minute schedule or
300/hour burst-30 admission contract, or mutate live gates, queues, leases, or
cursors.
