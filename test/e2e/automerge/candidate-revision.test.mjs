import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCandidateIdentityUnchanged,
  candidateDependencyDigest,
  assertCandidateRevision,
  candidateExecutableDigest,
  candidateIdentity,
  candidateRevision,
} from "./candidate-revision.mjs";

test("candidate revision binding accepts only the exact checkout", () => {
  const actual = candidateRevision(process.cwd());
  assert.equal(assertCandidateRevision(process.cwd(), actual), actual);
  assert.throws(
    () => assertCandidateRevision(process.cwd(), "0".repeat(40)),
    /candidate revision mismatch/,
  );
});

test("candidate identity binds the executable dist contents", () => {
  const actual = candidateRevision(process.cwd());
  const identity = candidateIdentity(process.cwd(), actual);
  assert.equal(identity.clawsweeperSha, actual);
  assert.equal(identity.candidateDependencyDigest, candidateDependencyDigest(process.cwd()));
  assert.match(identity.candidateDependencyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(identity.candidateExecutableDigest, candidateExecutableDigest(process.cwd()));
  assert.match(identity.candidateExecutableDigest, /^sha256:[0-9a-f]{64}$/);
  assert.throws(
    () => candidateIdentity(process.cwd(), actual, `sha256:${"0".repeat(64)}`),
    /candidate executable digest mismatch/,
  );
  assert.throws(
    () =>
      candidateIdentity(
        process.cwd(),
        actual,
        identity.candidateExecutableDigest,
        `sha256:${"0".repeat(64)}`,
      ),
    /candidate dependency digest mismatch/,
  );
});

test("candidate identity revalidation fails closed when executable bytes change", () => {
  const actual = candidateRevision(process.cwd());
  const identity = candidateIdentity(process.cwd(), actual);
  assert.deepEqual(assertCandidateIdentityUnchanged(process.cwd(), identity), identity);
  assert.throws(
    () =>
      assertCandidateIdentityUnchanged(process.cwd(), {
        ...identity,
        candidateExecutableDigest: `sha256:${"0".repeat(64)}`,
      }),
    /candidate executable digest changed during scenario/,
  );
  assert.throws(
    () =>
      assertCandidateIdentityUnchanged(process.cwd(), {
        ...identity,
        candidateDependencyDigest: `sha256:${"0".repeat(64)}`,
      }),
    /candidate dependency digest changed during scenario/,
  );
});
