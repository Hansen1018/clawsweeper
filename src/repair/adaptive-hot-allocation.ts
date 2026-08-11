export const ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION = "adaptive-hot-allocation-decision/v1";

export type AdaptiveHotAllocationReason =
  | "overdue_fairness"
  | "source_novelty"
  | "unknown_probe"
  | "ordinary_demand"
  | "residual_expansion"
  | "observation_fallback";

export type AdaptiveHotObservationStatus =
  | "fresh"
  | "missing"
  | "stale"
  | "malformed"
  | "unavailable";

export type AdaptiveHotAllocationStatus =
  | "allocated"
  | "observation_fallback"
  | "scheduled_throttle"
  | "queue_unavailable"
  | "no_capacity"
  | "no_eligible_demand";

export interface AdaptiveHotAllocationPolicy {
  policyVersion: string;
  fairnessObjectiveMs: number;
  observationMaxAgeMs: number;
  overOfferNumerator: number;
  overOfferDenominator: number;
  maxOfferBudget: number;
  maxRepositories: number;
  unknownProbeLimit: number;
  unavailableObservationFallbackLimit: number;
  repositoryShareNumerator: number;
  repositoryShareDenominator: number;
  maxRepositoryCandidates: number;
}

// These values are shadow-evaluation defaults, not activated production policy.
export const ADAPTIVE_HOT_V1_SHADOW_POLICY: Readonly<AdaptiveHotAllocationPolicy> = Object.freeze({
  policyVersion: "adaptive-hot-v1-shadow",
  fairnessObjectiveMs: 24 * 60 * 60 * 1_000,
  observationMaxAgeMs: 6 * 60 * 60 * 1_000,
  overOfferNumerator: 3,
  overOfferDenominator: 2,
  maxOfferBudget: 30,
  maxRepositories: 20,
  unknownProbeLimit: 2,
  unavailableObservationFallbackLimit: 5,
  repositoryShareNumerator: 1,
  repositoryShareDenominator: 4,
  maxRepositoryCandidates: 10,
});

export interface AdaptiveHotRepositoryObservation {
  observedAtMs: number;
  eligibleDue: number;
  sourceNovelDue: number;
  oldestDueAtMs: number | null;
  oldestUnservedAtMs: number | null;
  lastAdmittedAtMs: number | null;
  reviewRuntimeMs?: number | null;
}

export interface AdaptiveHotRepositoryInput {
  targetRepo: string;
  observation?: AdaptiveHotRepositoryObservation | null;
  credentialBlocked?: boolean;
  priorityTier?: number;
}

export interface AdaptiveHotAllocationInput {
  nowMs: number;
  cursor: number;
  probeCursor?: number;
  queueCapabilityAvailable: boolean;
  availableCandidateCapacity: number;
  globalTokenBalance: number;
  hotTokenBalance: number;
  scheduledAdmissionThrottled: boolean;
  repositoryObservationsAvailable: boolean;
  repositories: readonly AdaptiveHotRepositoryInput[];
  policy?: Partial<AdaptiveHotAllocationPolicy>;
}

export interface AdaptiveHotRepositoryAllocation {
  targetRepo: string;
  candidateCapacity: number;
  initialReason: AdaptiveHotAllocationReason;
  observationStatus: AdaptiveHotObservationStatus;
}

export interface AdaptiveHotAllocationStep {
  sequence: number;
  targetRepo: string;
  reason: AdaptiveHotAllocationReason;
  candidateNumber: number;
}

export interface AdaptiveHotAllocationDecision {
  schemaVersion: typeof ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION;
  policyVersion: string;
  status: AdaptiveHotAllocationStatus;
  serviceCapacity: number;
  offerBudget: number;
  perRepositoryLimit: number;
  repositoryLimit: number;
  repositoriesConsidered: number;
  credentialBlockedRepositories: number;
  unknownProbeCount: number;
  allocations: AdaptiveHotRepositoryAllocation[];
  allocationTrace: AdaptiveHotAllocationStep[];
  unusedOfferBudget: number;
  inputCursor: number;
  nextCursor: number;
  cursorAdvanced: boolean;
  inputProbeCursor: number;
  nextProbeCursor: number;
  probeCursorAdvanced: boolean;
}

interface NormalizedObservation {
  eligibleDue: number;
  sourceNovelDue: number;
  oldestDueAtMs: number | null;
  oldestUnservedAtMs: number | null;
  lastAdmittedAtMs: number | null;
}

interface NormalizedRepository {
  targetRepo: string;
  key: string;
  cursorRank: number;
  priorityTier: number;
  credentialBlocked: boolean;
  observationStatus: Exclude<AdaptiveHotObservationStatus, "unavailable">;
  observation: NormalizedObservation | null;
}

interface MutableAllocation {
  repository: NormalizedRepository;
  candidateCapacity: number;
  initialReason: AdaptiveHotAllocationReason;
}

export function allocateAdaptiveHotReviewCapacity(
  input: AdaptiveHotAllocationInput,
): AdaptiveHotAllocationDecision {
  const policy = resolvePolicy(input.policy);
  const nowMs = safeNonNegativeInteger(input.nowMs, "nowMs");
  const availableCandidateCapacity = wholeNonNegativeNumber(
    input.availableCandidateCapacity,
    "availableCandidateCapacity",
  );
  const globalTokenBalance = wholeNonNegativeNumber(input.globalTokenBalance, "globalTokenBalance");
  const hotTokenBalance = wholeNonNegativeNumber(input.hotTokenBalance, "hotTokenBalance");
  const serviceCapacity = input.queueCapabilityAvailable
    ? Math.min(availableCandidateCapacity, globalTokenBalance, hotTokenBalance)
    : 0;
  const sortedRepositories = normalizeRepositories(input.repositories, nowMs, policy);
  const inputCursor = normalizedCursor(input.cursor, sortedRepositories.length);
  const inputProbeCursor = normalizedCursor(
    input.probeCursor ?? input.cursor,
    sortedRepositories.length,
  );
  const repositories = withCursorRanks(sortedRepositories, inputCursor);
  const credentialBlockedRepositories = repositories.filter(
    (repository) => repository.credentialBlocked,
  ).length;

  if (!input.queueCapabilityAvailable) {
    return emptyDecision({
      policy,
      status: "queue_unavailable",
      serviceCapacity: 0,
      repositories,
      inputCursor,
      inputProbeCursor,
      credentialBlockedRepositories,
    });
  }
  if (input.scheduledAdmissionThrottled) {
    return emptyDecision({
      policy,
      status: "scheduled_throttle",
      serviceCapacity,
      repositories,
      inputCursor,
      inputProbeCursor,
      credentialBlockedRepositories,
    });
  }
  if (serviceCapacity === 0) {
    return emptyDecision({
      policy,
      status: "no_capacity",
      serviceCapacity,
      repositories,
      inputCursor,
      inputProbeCursor,
      credentialBlockedRepositories,
    });
  }

  const offerBudget = Math.min(
    policy.maxOfferBudget,
    Math.ceil((serviceCapacity * policy.overOfferNumerator) / policy.overOfferDenominator),
  );
  const repositoryLimit = Math.min(policy.maxRepositories, offerBudget);
  // One candidate is the indivisible service unit. Below a four-candidate cycle,
  // it necessarily takes precedence over a literal 25-percent share.
  const perRepositoryLimit = Math.min(
    policy.maxRepositoryCandidates,
    Math.max(
      1,
      Math.floor(
        (offerBudget * policy.repositoryShareNumerator) / policy.repositoryShareDenominator,
      ),
    ),
  );

  if (!input.repositoryObservationsAvailable) {
    return observationFallbackDecision({
      policy,
      repositories,
      serviceCapacity,
      offerBudget,
      repositoryLimit,
      perRepositoryLimit,
      inputCursor,
      inputProbeCursor,
      credentialBlockedRepositories,
    });
  }

  const allocations = new Map<string, MutableAllocation>();
  const allocationOrder: string[] = [];
  const allocationTrace: AdaptiveHotAllocationStep[] = [];
  const initialCategory = new Map<string, AdaptiveHotAllocationReason>();

  const assign = (
    repository: NormalizedRepository,
    reason: AdaptiveHotAllocationReason,
  ): boolean => {
    if (allocationTrace.length >= offerBudget) return false;
    const existing = allocations.get(repository.key);
    if (!existing && allocations.size >= repositoryLimit) return false;
    const demandLimit = repository.observation?.eligibleDue ?? 1;
    const current = existing?.candidateCapacity ?? 0;
    if (current >= Math.min(demandLimit, perRepositoryLimit)) return false;
    if (existing) {
      existing.candidateCapacity += 1;
    } else {
      allocations.set(repository.key, {
        repository,
        candidateCapacity: 1,
        initialReason: reason,
      });
      allocationOrder.push(repository.key);
      initialCategory.set(repository.key, reason);
    }
    allocationTrace.push({
      sequence: allocationTrace.length + 1,
      targetRepo: repository.targetRepo,
      reason,
      candidateNumber: current + 1,
    });
    return true;
  };

  const freshDemand = repositories.filter(
    (repository) =>
      !repository.credentialBlocked &&
      repository.observationStatus === "fresh" &&
      (repository.observation?.eligibleDue ?? 0) > 0,
  );
  const overdue = freshDemand
    .filter((repository) => isOverdue(repository, nowMs, policy.fairnessObjectiveMs))
    .sort(compareOverdue);
  const overdueKeys = new Set(overdue.map((repository) => repository.key));
  const novel = freshDemand
    .filter(
      (repository) =>
        !overdueKeys.has(repository.key) && (repository.observation?.sourceNovelDue ?? 0) > 0,
    )
    .sort(compareNovel);
  const novelKeys = new Set(novel.map((repository) => repository.key));
  const ordinary = freshDemand
    .filter((repository) => !overdueKeys.has(repository.key) && !novelKeys.has(repository.key))
    .sort(compareOrdinary);
  const ordinaryReservation = ordinary.length > 0 ? 1 : 0;
  const canAssignPriority = () =>
    allocationTrace.length < offerBudget - ordinaryReservation &&
    allocations.size < repositoryLimit - ordinaryReservation;

  for (const repository of overdue) {
    if (!canAssignPriority()) break;
    if (!assign(repository, "overdue_fairness")) break;
  }
  for (const repository of novel) {
    if (!canAssignPriority()) break;
    if (!assign(repository, "source_novelty")) break;
  }

  let nextProbeCursor = inputProbeCursor;
  const probeSlots = Math.max(
    0,
    Math.min(
      policy.unknownProbeLimit,
      repositoryLimit - allocations.size - ordinaryReservation,
      offerBudget - allocationTrace.length - ordinaryReservation,
    ),
  );
  if (probeSlots > 0) {
    const probes = selectByCursor(
      repositories,
      (repository) => !repository.credentialBlocked && repository.observationStatus !== "fresh",
      probeSlots,
      inputProbeCursor,
    );
    for (const repository of probes.repositories) assign(repository, "unknown_probe");
    if (probes.repositories.length > 0) nextProbeCursor = probes.nextCursor;
  }

  for (const repository of ordinary) {
    if (!assign(repository, "ordinary_demand")) break;
  }

  const residualOrder = allocationOrder
    .map((key) => allocations.get(key)?.repository)
    .filter((repository): repository is NormalizedRepository => repository != null)
    .filter((repository) => initialCategory.get(repository.key) !== "unknown_probe");
  while (allocationTrace.length < offerBudget) {
    let assigned = false;
    for (const repository of residualOrder) {
      if (assign(repository, "residual_expansion")) assigned = true;
      if (allocationTrace.length >= offerBudget) break;
    }
    if (!assigned) break;
  }

  const ordinaryProgressKeys = allocationOrder.filter(
    (key) => initialCategory.get(key) === "ordinary_demand",
  );
  const priorityProgressKeys = allocationOrder.filter((key) => {
    const category = initialCategory.get(key);
    return category === "overdue_fairness" || category === "source_novelty";
  });
  const cursorProgressKeys =
    ordinaryProgressKeys.length > 0 ? ordinaryProgressKeys : priorityProgressKeys;
  const furthestSelectedCursorRank = cursorProgressKeys.reduce((furthest, key) => {
    return Math.max(furthest, allocations.get(key)?.repository.cursorRank ?? -1);
  }, -1);
  const nextCursor =
    furthestSelectedCursorRank < 0 || repositories.length === 0
      ? inputCursor
      : (inputCursor + furthestSelectedCursorRank + 1) % repositories.length;

  return finishDecision({
    policy,
    status: allocations.size > 0 ? "allocated" : "no_eligible_demand",
    serviceCapacity,
    offerBudget,
    repositoryLimit,
    perRepositoryLimit,
    repositories,
    credentialBlockedRepositories,
    allocations,
    allocationOrder,
    allocationTrace,
    inputCursor,
    nextCursor,
    inputProbeCursor,
    nextProbeCursor,
  });
}

function observationFallbackDecision(options: {
  policy: AdaptiveHotAllocationPolicy;
  repositories: readonly NormalizedRepository[];
  serviceCapacity: number;
  offerBudget: number;
  repositoryLimit: number;
  perRepositoryLimit: number;
  inputCursor: number;
  inputProbeCursor: number;
  credentialBlockedRepositories: number;
}): AdaptiveHotAllocationDecision {
  const selection = selectByCursor(
    options.repositories,
    (repository) => !repository.credentialBlocked,
    Math.min(
      options.policy.unavailableObservationFallbackLimit,
      options.repositoryLimit,
      options.offerBudget,
    ),
    options.inputCursor,
  );
  const allocations = selection.repositories.map((repository) => ({
    targetRepo: repository.targetRepo,
    candidateCapacity: 1,
    initialReason: "observation_fallback" as const,
    observationStatus: "unavailable" as const,
  }));
  const allocationTrace = selection.repositories.map((repository, index) => ({
    sequence: index + 1,
    targetRepo: repository.targetRepo,
    reason: "observation_fallback" as const,
    candidateNumber: 1,
  }));
  const nextCursor = selection.repositories.length > 0 ? selection.nextCursor : options.inputCursor;
  return {
    schemaVersion: ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION,
    policyVersion: options.policy.policyVersion,
    status: allocations.length > 0 ? "observation_fallback" : "no_eligible_demand",
    serviceCapacity: options.serviceCapacity,
    offerBudget: options.offerBudget,
    perRepositoryLimit: options.perRepositoryLimit,
    repositoryLimit: options.repositoryLimit,
    repositoriesConsidered: options.repositories.length,
    credentialBlockedRepositories: options.credentialBlockedRepositories,
    unknownProbeCount: 0,
    allocations,
    allocationTrace,
    unusedOfferBudget: options.offerBudget - allocationTrace.length,
    inputCursor: options.inputCursor,
    nextCursor,
    cursorAdvanced: nextCursor !== options.inputCursor,
    inputProbeCursor: options.inputProbeCursor,
    nextProbeCursor: options.inputProbeCursor,
    probeCursorAdvanced: false,
  };
}

function finishDecision(options: {
  policy: AdaptiveHotAllocationPolicy;
  status: AdaptiveHotAllocationStatus;
  serviceCapacity: number;
  offerBudget: number;
  repositoryLimit: number;
  perRepositoryLimit: number;
  repositories: readonly NormalizedRepository[];
  credentialBlockedRepositories: number;
  allocations: ReadonlyMap<string, MutableAllocation>;
  allocationOrder: readonly string[];
  allocationTrace: AdaptiveHotAllocationStep[];
  inputCursor: number;
  nextCursor: number;
  inputProbeCursor: number;
  nextProbeCursor: number;
}): AdaptiveHotAllocationDecision {
  const allocations = options.allocationOrder.flatMap((key) => {
    const allocation = options.allocations.get(key);
    if (!allocation) return [];
    return [
      {
        targetRepo: allocation.repository.targetRepo,
        candidateCapacity: allocation.candidateCapacity,
        initialReason: allocation.initialReason,
        observationStatus: allocation.repository.observationStatus,
      },
    ];
  });
  return {
    schemaVersion: ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION,
    policyVersion: options.policy.policyVersion,
    status: options.status,
    serviceCapacity: options.serviceCapacity,
    offerBudget: options.offerBudget,
    perRepositoryLimit: options.perRepositoryLimit,
    repositoryLimit: options.repositoryLimit,
    repositoriesConsidered: options.repositories.length,
    credentialBlockedRepositories: options.credentialBlockedRepositories,
    unknownProbeCount: allocations.filter(
      (allocation) => allocation.initialReason === "unknown_probe",
    ).length,
    allocations,
    allocationTrace: options.allocationTrace,
    unusedOfferBudget: options.offerBudget - options.allocationTrace.length,
    inputCursor: options.inputCursor,
    nextCursor: options.nextCursor,
    cursorAdvanced: options.nextCursor !== options.inputCursor,
    inputProbeCursor: options.inputProbeCursor,
    nextProbeCursor: options.nextProbeCursor,
    probeCursorAdvanced: options.nextProbeCursor !== options.inputProbeCursor,
  };
}

function emptyDecision(options: {
  policy: AdaptiveHotAllocationPolicy;
  status: AdaptiveHotAllocationStatus;
  serviceCapacity: number;
  repositories: readonly NormalizedRepository[];
  inputCursor: number;
  inputProbeCursor: number;
  credentialBlockedRepositories: number;
}): AdaptiveHotAllocationDecision {
  return {
    schemaVersion: ADAPTIVE_HOT_ALLOCATION_SCHEMA_VERSION,
    policyVersion: options.policy.policyVersion,
    status: options.status,
    serviceCapacity: options.serviceCapacity,
    offerBudget: 0,
    perRepositoryLimit: 0,
    repositoryLimit: 0,
    repositoriesConsidered: options.repositories.length,
    credentialBlockedRepositories: options.credentialBlockedRepositories,
    unknownProbeCount: 0,
    allocations: [],
    allocationTrace: [],
    unusedOfferBudget: 0,
    inputCursor: options.inputCursor,
    nextCursor: options.inputCursor,
    cursorAdvanced: false,
    inputProbeCursor: options.inputProbeCursor,
    nextProbeCursor: options.inputProbeCursor,
    probeCursorAdvanced: false,
  };
}

function normalizeRepositories(
  inputs: readonly AdaptiveHotRepositoryInput[],
  nowMs: number,
  policy: AdaptiveHotAllocationPolicy,
): NormalizedRepository[] {
  const seen = new Set<string>();
  return inputs
    .map((input, index) => {
      const targetRepo = input.targetRepo.trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(targetRepo)) {
        throw new Error(`repositories[${index}].targetRepo must be an owner/repository slug`);
      }
      const key = targetRepo.toLowerCase();
      if (seen.has(key)) throw new Error(`duplicate repository: ${targetRepo}`);
      seen.add(key);
      const normalized = normalizeObservation(input.observation, nowMs, policy.observationMaxAgeMs);
      return {
        targetRepo,
        key,
        cursorRank: 0,
        priorityTier: optionalNonNegativeInteger(
          input.priorityTier,
          `repositories[${index}].priorityTier`,
        ),
        credentialBlocked: input.credentialBlocked === true,
        observationStatus: normalized.status,
        observation: normalized.observation,
      };
    })
    .sort(compareRepositoryName);
}

function normalizeObservation(
  observation: AdaptiveHotRepositoryObservation | null | undefined,
  nowMs: number,
  observationMaxAgeMs: number,
): {
  status: Exclude<AdaptiveHotObservationStatus, "unavailable">;
  observation: NormalizedObservation | null;
} {
  if (observation == null) return { status: "missing", observation: null };
  try {
    const observedAtMs = observedTimestamp(observation.observedAtMs, nowMs, "observedAtMs");
    const eligibleDue = strictNonNegativeInteger(observation.eligibleDue, "eligibleDue");
    const sourceNovelDue = strictNonNegativeInteger(observation.sourceNovelDue, "sourceNovelDue");
    if (sourceNovelDue > eligibleDue) throw new Error("sourceNovelDue exceeds eligibleDue");
    const normalized: NormalizedObservation = {
      eligibleDue,
      sourceNovelDue,
      oldestDueAtMs: optionalObservedTimestamp(observation.oldestDueAtMs, nowMs, "oldestDueAtMs"),
      oldestUnservedAtMs: optionalObservedTimestamp(
        observation.oldestUnservedAtMs,
        nowMs,
        "oldestUnservedAtMs",
      ),
      lastAdmittedAtMs: optionalObservedTimestamp(
        observation.lastAdmittedAtMs,
        nowMs,
        "lastAdmittedAtMs",
      ),
    };
    if (observation.reviewRuntimeMs != null) {
      strictNonNegativeInteger(observation.reviewRuntimeMs, "reviewRuntimeMs");
    }
    if (nowMs - observedAtMs > observationMaxAgeMs) {
      return { status: "stale", observation: null };
    }
    return { status: "fresh", observation: normalized };
  } catch {
    return { status: "malformed", observation: null };
  }
}

function isOverdue(
  repository: NormalizedRepository,
  nowMs: number,
  fairnessObjectiveMs: number,
): boolean {
  const oldestUnservedAtMs = repository.observation?.oldestUnservedAtMs;
  return oldestUnservedAtMs != null && oldestUnservedAtMs <= nowMs - fairnessObjectiveMs;
}

function compareOverdue(left: NormalizedRepository, right: NormalizedRepository): number {
  return (
    compareNullableTimestamp(
      left.observation?.oldestUnservedAtMs ?? null,
      right.observation?.oldestUnservedAtMs ?? null,
      false,
    ) || comparePriorityAndName(left, right)
  );
}

function compareNovel(left: NormalizedRepository, right: NormalizedRepository): number {
  return (
    compareNullableTimestamp(
      left.observation?.oldestDueAtMs ?? null,
      right.observation?.oldestDueAtMs ?? null,
      true,
    ) || comparePriorityAndName(left, right)
  );
}

function compareOrdinary(left: NormalizedRepository, right: NormalizedRepository): number {
  return (
    compareNullableTimestamp(
      left.observation?.oldestDueAtMs ?? null,
      right.observation?.oldestDueAtMs ?? null,
      true,
    ) ||
    compareNullableTimestamp(
      left.observation?.lastAdmittedAtMs ?? null,
      right.observation?.lastAdmittedAtMs ?? null,
      false,
    ) ||
    comparePriorityAndName(left, right)
  );
}

function comparePriorityAndName(left: NormalizedRepository, right: NormalizedRepository): number {
  return (
    right.priorityTier - left.priorityTier ||
    left.cursorRank - right.cursorRank ||
    compareRepositoryName(left, right)
  );
}

function compareRepositoryName(left: NormalizedRepository, right: NormalizedRepository): number {
  return left.key.localeCompare(right.key) || left.targetRepo.localeCompare(right.targetRepo);
}

function compareNullableTimestamp(
  left: number | null,
  right: number | null,
  nullsLast: boolean,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return nullsLast ? 1 : -1;
  if (right == null) return nullsLast ? -1 : 1;
  return left - right;
}

function selectByCursor(
  repositories: readonly NormalizedRepository[],
  predicate: (repository: NormalizedRepository) => boolean,
  limit: number,
  cursor: number,
): { repositories: NormalizedRepository[]; nextCursor: number } {
  if (repositories.length === 0 || limit <= 0) {
    return { repositories: [], nextCursor: cursor };
  }
  const selected: NormalizedRepository[] = [];
  let visited = 0;
  while (visited < repositories.length && selected.length < limit) {
    const repository = repositories[(cursor + visited) % repositories.length];
    visited += 1;
    if (repository && predicate(repository)) selected.push(repository);
  }
  return {
    repositories: selected,
    nextCursor: selected.length > 0 ? (cursor + visited) % repositories.length : cursor,
  };
}

function withCursorRanks(
  repositories: readonly NormalizedRepository[],
  cursor: number,
): NormalizedRepository[] {
  if (repositories.length === 0) return [];
  return repositories.map((repository, index) => ({
    ...repository,
    cursorRank: (index - cursor + repositories.length) % repositories.length,
  }));
}

function resolvePolicy(
  overrides: Partial<AdaptiveHotAllocationPolicy> | undefined,
): AdaptiveHotAllocationPolicy {
  const policy: AdaptiveHotAllocationPolicy = {
    policyVersion: overrides?.policyVersion ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.policyVersion,
    fairnessObjectiveMs:
      overrides?.fairnessObjectiveMs ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.fairnessObjectiveMs,
    observationMaxAgeMs:
      overrides?.observationMaxAgeMs ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.observationMaxAgeMs,
    overOfferNumerator:
      overrides?.overOfferNumerator ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.overOfferNumerator,
    overOfferDenominator:
      overrides?.overOfferDenominator ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.overOfferDenominator,
    maxOfferBudget: overrides?.maxOfferBudget ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.maxOfferBudget,
    maxRepositories: overrides?.maxRepositories ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.maxRepositories,
    unknownProbeLimit:
      overrides?.unknownProbeLimit ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.unknownProbeLimit,
    unavailableObservationFallbackLimit:
      overrides?.unavailableObservationFallbackLimit ??
      ADAPTIVE_HOT_V1_SHADOW_POLICY.unavailableObservationFallbackLimit,
    repositoryShareNumerator:
      overrides?.repositoryShareNumerator ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.repositoryShareNumerator,
    repositoryShareDenominator:
      overrides?.repositoryShareDenominator ??
      ADAPTIVE_HOT_V1_SHADOW_POLICY.repositoryShareDenominator,
    maxRepositoryCandidates:
      overrides?.maxRepositoryCandidates ?? ADAPTIVE_HOT_V1_SHADOW_POLICY.maxRepositoryCandidates,
  };
  if (!policy.policyVersion.trim()) throw new Error("policyVersion must not be empty");
  for (const [name, value] of Object.entries(policy).filter(([name]) => name !== "policyVersion")) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (policy.repositoryShareNumerator > policy.repositoryShareDenominator) {
    throw new Error("repository share must not exceed one whole cycle");
  }
  return policy;
}

function normalizedCursor(value: number, length: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("cursor must be a safe integer");
  if (length === 0) return 0;
  return ((value % length) + length) % length;
}

function wholeNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a non-negative finite safe number`);
  }
  return Math.floor(value);
}

function strictNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: number | undefined, label: string): number {
  return value == null ? 0 : strictNonNegativeInteger(value, label);
}

function safeNonNegativeInteger(value: number, label: string): number {
  return strictNonNegativeInteger(value, label);
}

function observedTimestamp(value: number, nowMs: number, label: string): number {
  const timestamp = strictNonNegativeInteger(value, label);
  if (timestamp > nowMs) throw new Error(`${label} must not be in the future`);
  return timestamp;
}

function optionalObservedTimestamp(
  value: number | null,
  nowMs: number,
  label: string,
): number | null {
  return value == null ? null : observedTimestamp(value, nowMs, label);
}
