import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  allowsPriorResultArtifactCohort,
  resolveCommitReviewArtifactCohort,
  resolveOptionalRunArtifact,
  resolveRunArtifact,
  verifyPriorResultArtifactCohort,
} from "../../dist/repair/run-artifact.js";

const digest1 = "1".repeat(64);
const digest2 = "2".repeat(64);

test("reruns select the latest trusted producer attempt instead of the consumer attempt", () => {
  assert.deepEqual(
    resolveRunArtifact({
      artifacts: [
        artifact(101, 1, digest1),
        artifact(102, 2, digest2),
        artifact(103, 4, "3".repeat(64)),
      ],
      prefix: "clawsweeper-repair-execution",
      runId: "9001",
      currentAttempt: 3,
      allowPriorAttempts: true,
    }),
    {
      id: 102,
      name: "clawsweeper-repair-execution-9001-2",
      producerAttempt: 2,
      digest: digest2,
    },
  );
});

test("optional artifact resolution distinguishes absence from ambiguity", () => {
  assert.equal(
    resolveOptionalRunArtifact({
      artifacts: [],
      prefix: "clawsweeper-repair",
      runId: "9001",
      currentAttempt: 2,
      allowPriorAttempts: false,
    }),
    null,
  );
  assert.throws(
    () =>
      resolveOptionalRunArtifact({
        artifacts: [
          artifact(101, 2, digest1, "clawsweeper-repair"),
          artifact(102, 2, digest2, "clawsweeper-repair"),
        ],
        prefix: "clawsweeper-repair",
        runId: "9001",
        currentAttempt: 2,
        allowPriorAttempts: false,
      }),
    /selection is ambiguous/,
  );
});

test("prior result reuse policy excludes deduplicated and producer reruns", () => {
  assert.equal(
    allowsPriorResultArtifactCohort({
      jobs: [
        workflowJob("Deduplicate command dispatch receipt", 2),
        workflowJob("Plan and review cluster", 2),
      ],
      currentAttempt: 2,
    }),
    false,
  );
  assert.equal(
    allowsPriorResultArtifactCohort({
      jobs: [workflowJob("Publish immutable repair action ledger", 2)],
      currentAttempt: 2,
    }),
    true,
  );
  assert.equal(
    allowsPriorResultArtifactCohort({
      jobs: [workflowJob("Token-only post-flight mutation", 2)],
      currentAttempt: 2,
    }),
    false,
  );
  assert.throws(
    () =>
      allowsPriorResultArtifactCohort({
        jobs: [
          workflowJob("Publish immutable repair action ledger", 2),
          workflowJob("Publish immutable repair action ledger", 2),
        ],
        currentAttempt: 2,
      }),
    /selection is ambiguous/,
  );
});

test("prior result publication resolves only one complete final provenance cohort", () => {
  assert.deepEqual(
    resolveOptionalRunArtifact({
      artifacts: [
        artifact(101, 1, digest1, "clawsweeper-repair"),
        artifact(102, 1, digest1, "clawsweeper-repair-provenance"),
        artifact(201, 2, digest2, "clawsweeper-repair"),
      ],
      prefix: "clawsweeper-repair",
      requiredPrefixes: ["clawsweeper-repair-provenance"],
      runId: "9001",
      currentAttempt: 3,
      maxProducerAttempt: 2,
      allowPriorAttempts: true,
    }),
    {
      id: 101,
      name: "clawsweeper-repair-9001-1",
      producerAttempt: 1,
      digest: digest1,
    },
  );
  assert.equal(
    resolveOptionalRunArtifact({
      artifacts: [
        artifact(201, 1, digest1, "clawsweeper-repair"),
        artifact(202, 2, digest2, "clawsweeper-repair-provenance"),
      ],
      prefix: "clawsweeper-repair",
      requiredPrefixes: ["clawsweeper-repair-provenance"],
      runId: "9001",
      currentAttempt: 3,
      maxProducerAttempt: 2,
      allowPriorAttempts: true,
    }),
    null,
  );
});

test("prior result provenance verifies one exact source cohort", () => {
  const fixture = priorResultCohortFixture();
  assert.doesNotThrow(() => verifyPriorResultArtifactCohort(fixture));

  const mixed = priorResultCohortFixture();
  mixed.artifacts.push(artifact(105, 2, digest2, "clawsweeper-repair-validation"));
  mixed.provenance.artifacts.validation = {
    name: "clawsweeper-repair-validation-9001-2",
    id: "105",
    digest: `sha256:${digest2}`,
    producer_attempt: "2",
  };
  assert.throws(() => verifyPriorResultArtifactCohort(mixed), /mixes producer attempts/);
});

test("commit review reruns select one complete report and ledger pair per SHA", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  assert.deepEqual(
    resolveCommitReviewArtifactCohort({
      artifacts: [
        artifact(101, 1, digest1, `action-ledger-commit-review-${sha1}`),
        artifact(102, 1, digest1, `commit-review-${sha1}`),
        artifact(201, 2, digest2, `action-ledger-commit-review-${sha1}`),
        artifact(202, 2, digest2, `commit-review-${sha1}`),
        artifact(301, 1, digest1, `action-ledger-commit-review-${sha2}`),
        artifact(302, 1, digest1, `commit-review-${sha2}`),
      ],
      commitShas: [sha1, sha2],
      runId: "9001",
      currentAttempt: 2,
      allowPriorAttempts: true,
    }).map((entry) => ({
      sha: entry.sha,
      producerAttempt: entry.producerAttempt,
      ledgerId: entry.ledger.id,
      reportId: entry.report.id,
    })),
    [
      { sha: sha1, producerAttempt: 2, ledgerId: 201, reportId: 202 },
      { sha: sha2, producerAttempt: 1, ledgerId: 301, reportId: 302 },
    ],
  );
});

test("commit review reruns reject mixed report and ledger attempts", () => {
  const sha = "a".repeat(40);
  assert.throws(
    () =>
      resolveCommitReviewArtifactCohort({
        artifacts: [
          artifact(101, 1, digest1, `action-ledger-commit-review-${sha}`),
          artifact(102, 1, digest1, `commit-review-${sha}`),
          artifact(201, 2, digest2, `action-ledger-commit-review-${sha}`),
        ],
        commitShas: [sha],
        runId: "9001",
        currentAttempt: 2,
        allowPriorAttempts: true,
      }),
    /report and ledger attempts differ/,
  );
  assert.throws(
    () =>
      resolveCommitReviewArtifactCohort({
        artifacts: [],
        commitShas: ["b".repeat(40), "a".repeat(40)],
        runId: "9001",
        currentAttempt: 2,
        allowPriorAttempts: true,
      }),
    /canonical, sorted, and unique/,
  );
});

test("commit review cohort CLI writes exact artifact ids and the selected cohort", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-artifact-cohort-"));
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  try {
    const shasFile = path.join(root, "shas.txt");
    const cohortFile = path.join(root, "cohort.json");
    const outputFile = path.join(root, "github-output.txt");
    const responseFile = path.join(root, "artifacts.json");
    const ghPath = path.join(root, "gh");
    fs.writeFileSync(shasFile, `${sha1}\n${sha2}\n`);
    fs.writeFileSync(
      responseFile,
      JSON.stringify([
        {
          artifacts: [
            artifact(201, 2, digest2, `action-ledger-commit-review-${sha1}`),
            artifact(202, 2, digest2, `commit-review-${sha1}`),
            artifact(301, 1, digest1, `action-ledger-commit-review-${sha2}`),
            artifact(302, 1, digest1, `commit-review-${sha2}`),
          ],
        },
      ]),
    );
    fs.writeFileSync(ghPath, '#!/bin/sh\ncat "$GH_ARTIFACT_RESPONSE"\n');
    fs.chmodSync(ghPath, 0o755);

    execFileSync(
      process.execPath,
      [
        "dist/repair/resolve-run-artifact.js",
        "--repository",
        "openclaw/clawsweeper",
        "--run-id",
        "9001",
        "--current-attempt",
        "2",
        "--commit-shas-file",
        shasFile,
        "--cohort-file",
        cohortFile,
      ],
      {
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
          GH_ARTIFACT_RESPONSE: responseFile,
          GITHUB_OUTPUT: outputFile,
          CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT: "1",
        },
      },
    );

    assert.equal(
      fs.readFileSync(outputFile, "utf8"),
      "ledger_artifact_ids=201,301\nreport_artifact_ids=202,302\n",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(cohortFile, "utf8")).map(
        (entry: {
          sha: string;
          producerAttempt: number;
          ledger: { id: number };
          report: { id: number };
        }) => ({
          sha: entry.sha,
          producerAttempt: entry.producerAttempt,
          ledgerId: entry.ledger.id,
          reportId: entry.report.id,
        }),
      ),
      [
        { sha: sha1, producerAttempt: 2, ledgerId: 201, reportId: 202 },
        { sha: sha2, producerAttempt: 1, ledgerId: 301, reportId: 302 },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rerun of the producer cannot fall back to an older artifact", () => {
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1), artifact(102, 2, digest2)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
      }),
    /current producer attempt did not publish/,
  );
  assert.equal(
    resolveRunArtifact({
      artifacts: [
        artifact(101, 1, digest1),
        artifact(102, 2, digest2),
        artifact(103, 3, "3".repeat(64)),
      ],
      prefix: "clawsweeper-repair-execution",
      runId: "9001",
      currentAttempt: 3,
    }).id,
    103,
  );
});

test("trusted producer outputs pin an exact artifact id and digest", () => {
  assert.equal(
    resolveRunArtifact({
      artifacts: [artifact(101, 1, digest1), artifact(102, 2, digest2)],
      prefix: "clawsweeper-repair-execution",
      runId: "9001",
      currentAttempt: 3,
      expectedArtifactId: "101",
      expectedArtifactDigest: `sha256:${digest1}`,
    }).id,
    101,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        expectedArtifactId: "101",
        expectedArtifactDigest: digest2,
      }),
    /digest does not match/,
  );
});

test("checkpoint recovery selects the newest attempt across artifact prefixes", () => {
  assert.deepEqual(
    resolveRunArtifact({
      artifacts: [
        artifact(101, 1, digest1, "clawsweeper-repair-publication"),
        artifact(102, 2, digest2, "clawsweeper-repair-publication-close"),
      ],
      prefix: "clawsweeper-repair-publication",
      fallbackPrefixes: ["clawsweeper-repair-publication-close"],
      runId: "9001",
      currentAttempt: 3,
      allowPriorAttempts: true,
    }),
    {
      id: 102,
      name: "clawsweeper-repair-publication-close-9001-2",
      producerAttempt: 2,
      digest: digest2,
    },
  );
  assert.equal(
    resolveRunArtifact({
      artifacts: [
        artifact(103, 2, digest1, "clawsweeper-repair-publication"),
        artifact(104, 2, digest2, "clawsweeper-repair-publication-close"),
      ],
      prefix: "clawsweeper-repair-publication",
      fallbackPrefixes: ["clawsweeper-repair-publication-close"],
      runId: "9001",
      currentAttempt: 3,
      allowPriorAttempts: true,
    }).id,
    103,
  );
});

test("checkpoint recovery pins related artifacts to the publication producer attempt", () => {
  assert.deepEqual(
    resolveRunArtifact({
      artifacts: [artifact(101, 1, digest1), artifact(102, 2, digest2)],
      prefix: "clawsweeper-repair-execution",
      runId: "9001",
      currentAttempt: 3,
      expectedProducerAttempt: "1",
      allowPriorAttempts: true,
    }),
    {
      id: 101,
      name: "clawsweeper-repair-execution-9001-1",
      producerAttempt: 1,
      digest: digest1,
    },
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        expectedProducerAttempt: "2",
        allowPriorAttempts: true,
      }),
    /no trusted current or prior producer artifact/,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        expectedProducerAttempt: "3",
        allowPriorAttempts: true,
      }),
    /must precede the current workflow attempt/,
  );
});

test("checkpoint recovery follows the newest complete proof cohort across chained reruns", () => {
  assert.deepEqual(
    resolveRunArtifact({
      artifacts: [
        artifact(101, 1, digest1, "clawsweeper-repair-worker"),
        artifact(102, 1, digest1, "clawsweeper-repair-authorized"),
        artifact(103, 1, digest1, "clawsweeper-repair-execution"),
        artifact(104, 1, digest1, "clawsweeper-repair-validation"),
        artifact(201, 2, digest2, "clawsweeper-repair-worker"),
      ],
      prefix: "clawsweeper-repair-worker",
      requiredPrefixes: [
        "clawsweeper-repair-authorized",
        "clawsweeper-repair-execution",
        "clawsweeper-repair-validation",
      ],
      runId: "9001",
      currentAttempt: 3,
      maxProducerAttempt: "2",
      allowPriorAttempts: true,
    }),
    {
      id: 101,
      name: "clawsweeper-repair-worker-9001-1",
      producerAttempt: 1,
      digest: digest1,
    },
  );
});

test("artifact resolution rejects expired, ambiguous, and untrusted candidates", () => {
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [{ ...artifact(101, 1, digest1), expired: true }],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        expectedArtifactId: "101",
        expectedArtifactDigest: digest1,
      }),
    /expired/,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 2, digest1), artifact(102, 2, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        allowPriorAttempts: true,
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [{ ...artifact(101, 1, digest1), digest: null }],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 1,
      }),
    /missing a trusted digest/,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 1,
        expectedArtifactId: "101",
      }),
    /id and digest must be provided together/,
  );
});

test("artifact names treat target prefixes as bounded literals", () => {
  assert.equal(
    resolveRunArtifact({
      artifacts: [artifact(101, 1, digest1, "repair.prefix")],
      prefix: "repair.prefix",
      runId: "9001",
      currentAttempt: 1,
    }).id,
    101,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1, "repairXprefix")],
        prefix: "repair.prefix",
        runId: "9001",
        currentAttempt: 1,
      }),
    /current producer attempt did not publish/,
  );
});

test("repair workflow resolves producer artifacts by trusted id across rerun attempts", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const downloadBlocks = [
    ...workflow.matchAll(
      /uses: actions\/download-artifact@v8\n\s+with:\n([\s\S]*?)(?=\n\s{6}- (?:name|uses):|\n\n)/g,
    ),
  ];
  assert.equal(downloadBlocks.length, 19);
  const collectorDownloads = downloadBlocks.filter((block) =>
    block[1]!.includes("action_ledger_artifact_id"),
  );
  assert.equal(collectorDownloads.length, 3);
  for (const collectorDownload of collectorDownloads) {
    assert.match(collectorDownload[1]!, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(collectorDownload[1]!, /run-id: \$\{\{ github\.run_id \}\}/);
    assert.doesNotMatch(collectorDownload[1]!, /merge-multiple: true/);
  }
  assert.equal(downloadBlocks.filter((block) => block[1]!.includes("artifact-ids:")).length, 19);
  const resolvedArtifactDownloads = downloadBlocks.filter(
    (block) => block[1]!.includes("steps.") && block[1]!.includes(".outputs.artifact_id"),
  );
  assert.equal(resolvedArtifactDownloads.length, 16);
  for (const block of resolvedArtifactDownloads) {
    assert.match(block[1]!, /artifact-ids: \$\{\{ steps\.[^.]+\.outputs\.artifact_id \}\}/);
    assert.match(block[1]!, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(block[1]!, /run-id: \$\{\{ github\.run_id \}\}/);
    assert.doesNotMatch(block[1]!, /name:|github\.run_attempt/);
  }
  assert.equal(
    [...workflow.matchAll(/pnpm run repair:resolve-run-artifact/g)].length,
    resolvedArtifactDownloads.length,
  );
  assert.doesNotMatch(workflow, /pattern: clawsweeper-repair-action-ledger-\*/);
  assert.match(
    workflow,
    /action_ledger_artifact_id: \$\{\{ steps\.upload_action_ledger\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    workflow,
    /Resolve planning action ledger context[\s\S]*--expected-artifact-digest "\$\{\{ needs\.cluster\.outputs\.action_ledger_artifact_digest \}\}"/,
  );
  for (const prefix of [
    "clawsweeper-repair-worker",
    "clawsweeper-repair-authorized",
    "clawsweeper-repair-execution",
    "clawsweeper-repair-validation",
    "clawsweeper-repair-publication",
  ]) {
    assert.match(workflow, new RegExp(`--prefix ${prefix}`));
  }
  assert.match(
    workflow,
    /artifact_id: \$\{\{ steps\.prior_authorized_artifact\.outputs\.artifact_id \|\| steps\.upload\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    workflow,
    /artifact_id: \$\{\{ needs\.authorize\.outputs\.recovery_execution_artifact_id \|\| steps\.upload_execution\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    workflow,
    /artifact_id: \$\{\{ needs\.authorize\.outputs\.recovery_validation_artifact_id \|\| steps\.upload\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    workflow,
    /worker_artifact_id: \$\{\{ steps\.prior_worker_artifact\.outputs\.artifact_id \|\| needs\.cluster\.outputs\.worker_artifact_id \}\}/,
  );
  assert.match(
    workflow,
    /worker_artifact_digest: \$\{\{ steps\.prior_worker_artifact\.outputs\.artifact_digest \|\| needs\.cluster\.outputs\.worker_artifact_digest \}\}/,
  );
  assert.match(
    workflow,
    /cluster:[\s\S]*?producer_attempt: \$\{\{ steps\.producer_attempt\.outputs\.value \}\}/,
  );
  assert.match(
    workflow,
    /authorize:[\s\S]*?producer_attempt: \$\{\{ steps\.restore_authorization\.outputs\.checkpoint_producer_attempt \|\| steps\.producer_attempt\.outputs\.value \}\}/,
  );
  assert.equal(
    [
      ...workflow.matchAll(
        /producer_attempt: \$\{\{ needs\.authorize\.outputs\.checkpoint_recovered == '1' && needs\.authorize\.outputs\.producer_attempt \|\| steps\.producer_attempt\.outputs\.value \}\}/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...workflow.matchAll(
        /CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT: \$\{\{ needs\.[^.]+\.outputs\.producer_attempt != '' && needs\.[^.]+\.outputs\.producer_attempt != github\.run_attempt && '1' \|\| '0' \}\}/g,
      ),
    ].length,
    6,
  );
  assert.match(
    workflow,
    /Seal immutable source job provenance[\s\S]*?Upload worker transfer artifacts[\s\S]*?steps\.seal_source_job\.outcome == 'success'[\s\S]*?if-no-files-found: error[\s\S]*?retention-days: 90/,
  );
  assert.match(
    workflow,
    /Resolve prior durable publication checkpoint[\s\S]*?--prefix clawsweeper-repair-publication[\s\S]*?--fallback-prefix clawsweeper-repair-publication-close[\s\S]*?Download prior durable publication checkpoint[\s\S]*?Publish exact independently validated repair/,
  );
  assert.match(
    workflow,
    /Resolve prior publication checkpoint for authorization recovery[\s\S]*?Resolve prior checkpoint worker artifact[\s\S]*?Resolve prior checkpoint authorization[\s\S]*?Resolve prior checkpoint execution handoff[\s\S]*?Restore checkpoint authorization before live source intake[\s\S]*?Authorize exact job and run/,
  );
  assert.equal(
    [
      ...workflow.matchAll(
        /--expected-producer-attempt "\$\{\{ steps\.prior_worker_artifact\.outputs\.producer_attempt \}\}"/g,
      ),
    ].length,
    3,
  );
  assert.match(
    workflow,
    /Resolve prior checkpoint worker artifact[\s\S]*?--max-producer-attempt "\$\{\{ steps\.authorization_publication_artifact\.outputs\.producer_attempt \}\}"[\s\S]*?--required-prefixes "clawsweeper-repair-authorized,clawsweeper-repair-execution,clawsweeper-repair-validation"/,
  );
});

function artifact(
  id: number,
  attempt: number,
  digest: string,
  prefix = "clawsweeper-repair-execution",
) {
  return {
    id,
    name: `${prefix}-9001-${attempt}`,
    digest: `sha256:${digest}`,
    expired: false,
  };
}

function workflowJob(name: string, attempt: number) {
  return { name, run_attempt: attempt };
}

function priorResultCohortFixture() {
  const artifacts = [
    artifact(101, 1, digest1, "clawsweeper-repair-worker"),
    artifact(102, 1, digest1, "clawsweeper-repair-authorized"),
    artifact(103, 1, digest1, "clawsweeper-repair-execution"),
    artifact(104, 1, digest1, "clawsweeper-repair-validation"),
    artifact(201, 2, digest2, "clawsweeper-repair-publication-close"),
    artifact(202, 2, digest2, "clawsweeper-repair-publication"),
    artifact(203, 2, digest2, "clawsweeper-repair"),
    artifact(204, 2, digest2, "clawsweeper-repair-provenance"),
  ];
  return {
    artifacts,
    provenance: {
      schema_version: 2,
      workflow_repository: "openclaw/clawsweeper",
      workflow_run_id: "9001",
      workflow_run_attempt: "2",
      workflow_sha: "a".repeat(40),
      authorization_sha256: "b".repeat(64),
      publication_receipt_sha256: "c".repeat(64),
      publication_provenance_sha256: "d".repeat(64),
      artifacts: {
        worker: artifactClaim(101, 1, digest1, "clawsweeper-repair-worker"),
        authorization: artifactClaim(102, 1, digest1, "clawsweeper-repair-authorized"),
        execution: artifactClaim(103, 1, digest1, "clawsweeper-repair-execution"),
        validation: artifactClaim(104, 1, digest1, "clawsweeper-repair-validation"),
        pre_close: artifactClaim(201, 2, digest2, "clawsweeper-repair-publication-close"),
        publication: artifactClaim(202, 2, digest2, "clawsweeper-repair-publication"),
        final_worker: artifactClaim(203, 2, digest2, "clawsweeper-repair"),
        provenance: {
          name: "clawsweeper-repair-provenance-9001-2",
          id: null,
          digest: null,
          producer_attempt: "2",
        },
      },
    },
    repository: "openclaw/clawsweeper",
    runId: "9001",
    workflowSha: "a".repeat(40),
    currentAttempt: 3,
    producerAttempt: 2,
    resultArtifactId: "203",
    resultArtifactName: "clawsweeper-repair-9001-2",
    resultArtifactDigest: digest2,
    provenanceArtifactId: "204",
    provenanceArtifactName: "clawsweeper-repair-provenance-9001-2",
    provenanceArtifactDigest: digest2,
  };
}

function artifactClaim(id: number, attempt: number, digest: string, prefix: string) {
  return {
    name: `${prefix}-9001-${attempt}`,
    id: String(id),
    digest: `sha256:${digest}`,
    producer_attempt: String(attempt),
  };
}
