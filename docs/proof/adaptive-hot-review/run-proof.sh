#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${PROOF_OUTPUT:-.artifacts/adaptive-hot-review}"
actual_head="$(git rev-parse HEAD)"
expected_head="${PROOF_SOURCE_SHA:-${1:-}}"
dirty_status="$(git status --porcelain=v1 --untracked-files=all)"

if [[ -z "$expected_head" ]]; then
  echo "a recorded source head argument is required" >&2
  exit 1
fi
if [[ "$actual_head" != "$expected_head" ]]; then
  echo "proof head mismatch: expected $expected_head, found $actual_head" >&2
  exit 1
fi
if [[ -n "$dirty_status" ]]; then
  echo "proof checkout must be clean; found staged, unstaged, or untracked changes" >&2
  printf '%s\n' "$dirty_status" >&2
  exit 1
fi

mkdir -p "$output_dir"
printf '%s\n' "$actual_head" >"${output_dir}/source-head.txt"

echo "CRABBOX_PHASE:install"
pnpm install --frozen-lockfile >"${output_dir}/install.log" 2>&1

echo "CRABBOX_PHASE:build"
pnpm run build:all >"${output_dir}/build.log" 2>&1

echo "CRABBOX_PHASE:focused-tests"
{
  node --test \
    test/repair/adaptive-hot-allocation.test.ts \
    test/repair/adaptive-hot-control-plane.test.ts \
    test/repair/adaptive-hot-runtime.test.ts \
    test/repair/scheduled-review-enqueue.test.ts \
    test/repair/target-fanout.test.ts
  node --test \
    --test-name-pattern='active adaptive cursor reservation|adaptive cursor receipts cover a full day|signed adaptive hot-review telemetry routes|only a fenced scheduled lease completion records adaptive execution outcomes' \
    test/dashboard-worker.test.ts
  node --test \
    --test-name-pattern='adaptive|hot fleet fanout|target fanout' \
    test/sweep-workflow.test.ts
} >"${output_dir}/focused-tests.tap" 2>&1

echo "CRABBOX_PHASE:offline-replay"
node scripts/evaluate-hot-allocation.mjs \
  test/fixtures/adaptive-hot-allocation/replay.json \
  >"${output_dir}/offline-replay.json"

echo "CRABBOX_PHASE:worker-do-proof"
PROOF_OUTPUT="$output_dir" \
PROOF_SOURCE_SHA="$actual_head" \
  node docs/proof/adaptive-hot-review/run-proof.mjs \
  | tee "${output_dir}/proof-output.txt"

test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/runtime-transcript.md"
test -s "${output_dir}/offline-replay.json"

echo "CRABBOX_PHASE:complete"
