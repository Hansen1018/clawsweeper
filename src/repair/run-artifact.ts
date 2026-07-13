import type { LooseRecord } from "./json-types.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_PRODUCER_JOBS = new Set([
  "Plan and review cluster",
  "Token-only post-flight mutation",
]);
const PRIOR_RESULT_CONSUMER_JOBS = new Set([
  "Bind immutable execution handoff",
  "Prepare repair artifact without credentials",
  "Replay repair proof without credentials",
  "Report and requeue without target credentials",
  "Publish immutable repair action ledger",
]);

export type ResolvedRunArtifact = {
  id: number;
  name: string;
  producerAttempt: number;
  digest: string;
};

export type ResolveRunArtifactOptions = {
  artifacts: LooseRecord[];
  prefix: string;
  runId: string;
  currentAttempt: number;
  expectedProducerAttempt?: string | number | null;
  maxProducerAttempt?: string | number | null;
  expectedArtifactId?: string | null;
  expectedArtifactDigest?: string | null;
  fallbackPrefixes?: string[];
  requiredPrefixes?: string[];
  allowPriorAttempts?: boolean;
};

export type ResolvedCommitReviewArtifact = {
  sha: string;
  producerAttempt: number;
  ledger: ResolvedRunArtifact;
  report: ResolvedRunArtifact;
};

export function resolveCommitReviewArtifactCohort({
  artifacts,
  commitShas,
  runId,
  currentAttempt,
  allowPriorAttempts = process.env.CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT === "1",
}: {
  artifacts: LooseRecord[];
  commitShas: string[];
  runId: string;
  currentAttempt: number;
  allowPriorAttempts?: boolean;
}): ResolvedCommitReviewArtifact[] {
  const normalizedShas = commitShas.map((sha) => sha.trim());
  const sortedShas = [...normalizedShas].sort();
  if (
    normalizedShas.length === 0 ||
    normalizedShas.some((sha) => !/^[a-f0-9]{40}$/.test(sha)) ||
    new Set(normalizedShas).size !== normalizedShas.length ||
    normalizedShas.some((sha, index) => sha !== sortedShas[index])
  ) {
    throw new Error("commit review artifact SHAs must be canonical, sorted, and unique");
  }
  return normalizedShas.map((sha) => {
    const ledger = resolveRunArtifact({
      artifacts,
      prefix: `action-ledger-commit-review-${sha}`,
      runId,
      currentAttempt,
      allowPriorAttempts,
    });
    const report = resolveRunArtifact({
      artifacts,
      prefix: `commit-review-${sha}`,
      runId,
      currentAttempt,
      allowPriorAttempts,
    });
    if (ledger.producerAttempt !== report.producerAttempt) {
      throw new Error(`commit review report and ledger attempts differ for ${sha}`);
    }
    return {
      sha,
      producerAttempt: ledger.producerAttempt,
      ledger,
      report,
    };
  });
}

export function resolveOptionalRunArtifact(
  options: ResolveRunArtifactOptions,
): ResolvedRunArtifact | null {
  try {
    return resolveRunArtifact(options);
  } catch (error) {
    if (error instanceof RunArtifactNotFoundError) return null;
    throw error;
  }
}

export function allowsPriorResultArtifactCohort({
  jobs,
  currentAttempt,
}: {
  jobs: LooseRecord[];
  currentAttempt: number;
}): boolean {
  if (!Number.isInteger(currentAttempt) || currentAttempt < 1) {
    throw new Error("current workflow attempt is invalid");
  }
  if (jobs.length === 0) throw new Error("current workflow attempt has no jobs");
  for (const job of jobs) {
    if (!job || typeof job.name !== "string" || Number(job.run_attempt) !== currentAttempt) {
      throw new Error("current workflow attempt job provenance is invalid");
    }
  }
  const relevantJobs = jobs.filter(
    (job) => RESULT_PRODUCER_JOBS.has(job.name) || PRIOR_RESULT_CONSUMER_JOBS.has(job.name),
  );
  if (new Set(relevantJobs.map((job) => job.name)).size !== relevantJobs.length) {
    throw new Error("current workflow attempt job selection is ambiguous");
  }
  return (
    currentAttempt > 1 &&
    !relevantJobs.some((job) => RESULT_PRODUCER_JOBS.has(job.name)) &&
    relevantJobs.some((job) => PRIOR_RESULT_CONSUMER_JOBS.has(job.name))
  );
}

export function verifyPriorResultArtifactCohort({
  artifacts,
  provenance,
  repository,
  runId,
  workflowSha,
  currentAttempt,
  producerAttempt,
  resultArtifactId,
  resultArtifactName,
  resultArtifactDigest,
  provenanceArtifactId,
  provenanceArtifactName,
  provenanceArtifactDigest,
}: {
  artifacts: LooseRecord[];
  provenance: LooseRecord;
  repository: string;
  runId: string;
  workflowSha: string;
  currentAttempt: number;
  producerAttempt: number;
  resultArtifactId: string;
  resultArtifactName: string;
  resultArtifactDigest: string;
  provenanceArtifactId: string;
  provenanceArtifactName: string;
  provenanceArtifactDigest: string;
}): void {
  if (
    provenance?.schema_version !== 2 ||
    provenance.workflow_repository !== repository ||
    String(provenance.workflow_run_id) !== runId ||
    parseRequiredPositiveInteger(provenance.workflow_run_attempt, "provenance attempt") !==
      producerAttempt ||
    provenance.workflow_sha !== workflowSha ||
    !exactHex(provenance.authorization_sha256, 64) ||
    !exactHex(provenance.publication_receipt_sha256, 64) ||
    !exactHex(provenance.publication_provenance_sha256, 64)
  ) {
    throw new Error("prior result workflow provenance is invalid");
  }

  verifyExactClaim({
    label: "final_worker",
    prefix: "clawsweeper-repair",
    expectedAttempt: producerAttempt,
    expectedId: resultArtifactId,
    expectedName: resultArtifactName,
    expectedDigest: resultArtifactDigest,
  });
  const provenanceArtifact = resolveRunArtifact({
    artifacts,
    prefix: "clawsweeper-repair-provenance",
    runId,
    currentAttempt,
    expectedProducerAttempt: producerAttempt,
    expectedArtifactId: provenanceArtifactId,
    expectedArtifactDigest: provenanceArtifactDigest,
    allowPriorAttempts: true,
  });
  const provenanceClaim = provenance.artifacts?.provenance;
  if (
    provenanceArtifact.name !== provenanceArtifactName ||
    provenanceClaim?.name !== provenanceArtifact.name ||
    provenanceClaim.id !== null ||
    provenanceClaim.digest !== null ||
    parseRequiredPositiveInteger(
      provenanceClaim.producer_attempt,
      "provenance artifact attempt",
    ) !== producerAttempt
  ) {
    throw new Error("prior result provenance artifact identity is invalid");
  }

  const sourceAttempts = [
    verifyClaim("worker", "clawsweeper-repair-worker"),
    verifyClaim("authorization", "clawsweeper-repair-authorized"),
    verifyClaim("execution", "clawsweeper-repair-execution"),
    verifyClaim("validation", "clawsweeper-repair-validation"),
  ];
  if (new Set(sourceAttempts).size !== 1 || sourceAttempts[0]! > producerAttempt) {
    throw new Error("prior result source artifact cohort mixes producer attempts");
  }
  verifyClaim("pre_close", "clawsweeper-repair-publication-close", producerAttempt);
  verifyClaim("publication", "clawsweeper-repair-publication", producerAttempt);

  function verifyClaim(label: string, prefix: string, expectedAttempt?: number): number {
    const claim = provenance.artifacts?.[label];
    if (!claim || typeof claim !== "object") {
      throw new Error(`prior result ${label} artifact provenance is missing`);
    }
    const attempt = parseRequiredPositiveInteger(
      claim.producer_attempt,
      `${label} producer attempt`,
    );
    if (expectedAttempt !== undefined && attempt !== expectedAttempt) {
      throw new Error(`prior result ${label} artifact attempt is invalid`);
    }
    const artifact = resolveRunArtifact({
      artifacts,
      prefix,
      runId,
      currentAttempt,
      expectedProducerAttempt: attempt,
      expectedArtifactId: String(claim.id ?? ""),
      expectedArtifactDigest: String(claim.digest ?? ""),
      allowPriorAttempts: true,
    });
    if (claim.name !== artifact.name) {
      throw new Error(`prior result ${label} artifact name is invalid`);
    }
    return attempt;
  }

  function verifyExactClaim({
    label,
    prefix,
    expectedAttempt,
    expectedId,
    expectedName,
    expectedDigest,
  }: {
    label: string;
    prefix: string;
    expectedAttempt: number;
    expectedId: string;
    expectedName: string;
    expectedDigest: string;
  }): void {
    const claim = provenance.artifacts?.[label];
    if (
      !claim ||
      claim.name !== `${prefix}-${runId}-${expectedAttempt}` ||
      claim.name !== expectedName ||
      String(claim.id ?? "") !== expectedId ||
      normalizeOptionalDigest(claim.digest) !== normalizeOptionalDigest(expectedDigest) ||
      parseRequiredPositiveInteger(claim.producer_attempt, `${label} producer attempt`) !==
        expectedAttempt
    ) {
      throw new Error(`prior result ${label} artifact provenance is invalid`);
    }
    const artifact = resolveRunArtifact({
      artifacts,
      prefix,
      runId,
      currentAttempt,
      expectedProducerAttempt: expectedAttempt,
      expectedArtifactId: expectedId,
      expectedArtifactDigest: expectedDigest,
      allowPriorAttempts: true,
    });
    if (artifact.name !== claim.name) {
      throw new Error(`prior result ${label} artifact name is invalid`);
    }
  }
}

export function resolveRunArtifact({
  artifacts,
  prefix,
  runId,
  currentAttempt,
  expectedProducerAttempt,
  maxProducerAttempt,
  expectedArtifactId,
  expectedArtifactDigest,
  fallbackPrefixes = [],
  requiredPrefixes = [],
  allowPriorAttempts = process.env.CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT === "1",
}: ResolveRunArtifactOptions): ResolvedRunArtifact {
  const prefixes = [prefix, ...fallbackPrefixes];
  if (
    prefixes.some((candidate) => !candidate || !/^[A-Za-z0-9_.-]+$/.test(candidate)) ||
    requiredPrefixes.some((candidate) => !candidate || !/^[A-Za-z0-9_.-]+$/.test(candidate)) ||
    new Set(prefixes).size !== prefixes.length ||
    new Set(requiredPrefixes).size !== requiredPrefixes.length
  ) {
    throw new Error("artifact prefixes are invalid");
  }
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("workflow run id is invalid");
  }
  if (!Number.isInteger(currentAttempt) || currentAttempt < 1) {
    throw new Error("current workflow attempt is invalid");
  }
  const pinnedProducerAttempt = parseOptionalProducerAttempt(expectedProducerAttempt);
  const maximumProducerAttempt = parseOptionalProducerAttempt(maxProducerAttempt);
  if (pinnedProducerAttempt !== null && pinnedProducerAttempt >= currentAttempt) {
    throw new Error("expected producer attempt must precede the current workflow attempt");
  }
  if (maximumProducerAttempt !== null && maximumProducerAttempt >= currentAttempt) {
    throw new Error("maximum producer attempt must precede the current workflow attempt");
  }
  if (pinnedProducerAttempt !== null && maximumProducerAttempt !== null) {
    throw new Error("expected and maximum producer attempts cannot both be provided");
  }
  if (requiredPrefixes.length > 0 && pinnedProducerAttempt !== null) {
    throw new Error("required artifact prefixes cannot be combined with an exact producer attempt");
  }

  const expectedId = parseOptionalArtifactId(expectedArtifactId);
  const expectedDigest = normalizeOptionalDigest(expectedArtifactDigest);
  if ((expectedId === null) !== (expectedDigest === null)) {
    throw new Error("trusted producer artifact id and digest must be provided together");
  }
  const candidates = artifacts.flatMap((artifact) => {
    const name = String(artifact.name ?? "");
    const parsedNames = prefixes.map((candidate) => parseArtifactName(name, candidate, runId));
    const prefixPriority = parsedNames.findIndex((producerAttempt) => producerAttempt !== null);
    if (prefixPriority < 0) return [];
    const producerAttempt = parsedNames[prefixPriority]!;
    const id = Number(artifact.id);
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      !Number.isInteger(producerAttempt) ||
      producerAttempt > currentAttempt
    ) {
      return [];
    }
    const digest = normalizeOptionalDigest(artifact.digest);
    return [
      {
        id,
        name: String(artifact.name),
        producerAttempt,
        prefixPriority,
        digest,
        expired: artifact.expired === true,
      },
    ];
  });

  if (expectedId !== null) {
    const exact = candidates.filter(
      (artifact) =>
        artifact.id === expectedId &&
        (pinnedProducerAttempt === null || artifact.producerAttempt === pinnedProducerAttempt),
    );
    if (exact.length !== 1) {
      throw new Error("expected producer artifact id is missing or ambiguous");
    }
    return finalizeArtifact(exact[0]!, expectedDigest);
  }

  const cohortProducerAttempt =
    requiredPrefixes.length > 0
      ? resolveArtifactCohortAttempt({
          artifacts,
          primaryCandidates: candidates,
          requiredPrefixes,
          runId,
          currentAttempt,
          maximumProducerAttempt,
          allowPriorAttempts,
        })
      : null;
  const effectiveProducerAttempt = pinnedProducerAttempt ?? cohortProducerAttempt;
  const eligible = candidates.filter(
    (artifact) =>
      !artifact.expired &&
      (effectiveProducerAttempt === null ||
        artifact.producerAttempt === effectiveProducerAttempt) &&
      (maximumProducerAttempt === null || artifact.producerAttempt <= maximumProducerAttempt) &&
      (artifact.producerAttempt === currentAttempt ||
        (allowPriorAttempts && artifact.producerAttempt < currentAttempt)),
  );
  if (eligible.length === 0) {
    throw new RunArtifactNotFoundError(
      allowPriorAttempts
        ? "no trusted current or prior producer artifact matches this workflow run"
        : "current producer attempt did not publish a trusted artifact",
    );
  }
  const producerAttempt = Math.max(...eligible.map((artifact) => artifact.producerAttempt));
  const latest = eligible.filter((artifact) => artifact.producerAttempt === producerAttempt);
  const prefixPriority = Math.min(...latest.map((artifact) => artifact.prefixPriority));
  const preferred = latest.filter((artifact) => artifact.prefixPriority === prefixPriority);
  if (preferred.length !== 1) {
    throw new Error("trusted producer artifact selection is ambiguous");
  }
  return finalizeArtifact(preferred[0]!, expectedDigest);
}

function resolveArtifactCohortAttempt({
  artifacts,
  primaryCandidates,
  requiredPrefixes,
  runId,
  currentAttempt,
  maximumProducerAttempt,
  allowPriorAttempts,
}: {
  artifacts: LooseRecord[];
  primaryCandidates: Array<{
    producerAttempt: number;
    expired: boolean;
    digest: string | null;
  }>;
  requiredPrefixes: string[];
  runId: string;
  currentAttempt: number;
  maximumProducerAttempt: number | null;
  allowPriorAttempts: boolean;
}): number {
  const attempts = [
    ...new Set(
      primaryCandidates
        .filter(
          (artifact) =>
            !artifact.expired &&
            artifact.digest &&
            (maximumProducerAttempt === null ||
              artifact.producerAttempt <= maximumProducerAttempt) &&
            (artifact.producerAttempt === currentAttempt ||
              (allowPriorAttempts && artifact.producerAttempt < currentAttempt)),
        )
        .map((artifact) => artifact.producerAttempt),
    ),
  ].sort((left, right) => right - left);
  for (const producerAttempt of attempts) {
    let complete = true;
    for (const requiredPrefix of requiredPrefixes) {
      const matches = artifacts.filter(
        (artifact) =>
          parseArtifactName(String(artifact.name ?? ""), requiredPrefix, runId) === producerAttempt,
      );
      if (matches.length > 1) {
        throw new Error("trusted producer artifact cohort is ambiguous");
      }
      if (
        matches.length !== 1 ||
        matches[0]!.expired === true ||
        !normalizeOptionalDigest(matches[0]!.digest)
      ) {
        complete = false;
        break;
      }
    }
    if (complete) return producerAttempt;
  }
  throw new RunArtifactNotFoundError(
    "no complete trusted producer artifact cohort matches this workflow run",
  );
}

function finalizeArtifact(
  artifact: {
    id: number;
    name: string;
    producerAttempt: number;
    digest: string | null;
    expired: boolean;
  },
  expectedDigest: string | null,
): ResolvedRunArtifact {
  if (artifact.expired) throw new Error("expected producer artifact has expired");
  if (!artifact.digest) throw new Error("producer artifact is missing a trusted digest");
  if (expectedDigest && artifact.digest !== expectedDigest) {
    throw new Error("producer artifact digest does not match the trusted job output");
  }
  return {
    id: artifact.id,
    name: artifact.name,
    producerAttempt: artifact.producerAttempt,
    digest: artifact.digest,
  };
}

function parseOptionalProducerAttempt(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error("expected producer attempt is invalid");
  const attempt = Number(text);
  if (!Number.isSafeInteger(attempt)) throw new Error("expected producer attempt is invalid");
  return attempt;
}

function parseOptionalArtifactId(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error("expected artifact id is invalid");
  return Number(text);
}

function parseRequiredPositiveInteger(value: unknown, label: string): number {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${label} is invalid`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function normalizeOptionalDigest(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!normalized) return null;
  if (!DIGEST_PATTERN.test(normalized)) throw new Error("artifact digest is invalid");
  return normalized;
}

function exactHex(value: unknown, length: 40 | 64): string | null {
  const text = String(value ?? "");
  return new RegExp(`^[a-f0-9]{${length}}$`).test(text) ? text : null;
}

function parseArtifactName(name: string, prefix: string, runId: string): number | null {
  const literalPrefix = `${prefix}-${runId}-`;
  if (!name.startsWith(literalPrefix)) return null;
  const attempt = name.slice(literalPrefix.length);
  if (!/^[1-9][0-9]*$/.test(attempt)) return null;
  const parsed = Number(attempt);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

class RunArtifactNotFoundError extends Error {
  override name = "RunArtifactNotFoundError";
}
