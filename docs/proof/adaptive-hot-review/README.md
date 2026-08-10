# Adaptive scheduled hot-review proof

This fixture-only proof exercises the complete adaptive hot-review package
without contacting a production Worker, queue, GitHub repository, or workflow.
It combines deterministic allocator/control tests and offline replay with a
local Wrangler Worker backed by a disposable SQLite Durable Object directory.

The runtime scenario proves that:

- signed planner observations and planned/dispatched decisions are
  idempotently stored and remain visible after a Worker restart;
- an active cursor reservation does not advance any cursor before commit;
- the reservation survives a restart, commits all three cursors atomically,
  and returns the same receipt when the commit response is retried after a
  second restart; and
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

This is development proof only. It does not deploy the Worker, dispatch a
workflow, activate shadow/canary/full mode, change the 20-minute schedule or
300/hour burst-30 admission contract, or mutate live gates, queues, leases, or
cursors.
