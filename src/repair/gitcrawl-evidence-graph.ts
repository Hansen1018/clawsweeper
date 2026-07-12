import {
  GITCRAWL_DATASETS,
  GITCRAWL_PACKET_VERSION,
  GITCRAWL_PACKET_VERSION_V1,
  GITCRAWL_QUERY_COVERAGE,
  GITCRAWL_QUERY_VERSION,
  type GitcrawlCoverageRow,
  type GitcrawlDataset,
  type GitcrawlEvidenceClaim,
  type GitcrawlProvider,
  assertSha256,
  assertSnapshotId,
  canonicalJson,
  compareCanonicalText,
  parseRfc3339Timestamp,
  sha256Canonical,
  verifyGitcrawlEvidenceClaim,
} from "./gitcrawl-evidence-contract.js";
import {
  assertGitcrawlThreadSafetyProjectionMatches,
  type GitcrawlThreadSafetyProjection,
} from "./gitcrawl-evidence-policy.js";

export const DEFAULT_EVIDENCE_PACKET_MAX_CLAIMS = 64;
export const DEFAULT_EVIDENCE_PACKET_MAX_NODES = 64;
export const DEFAULT_EVIDENCE_PACKET_MAX_EDGES = 128;
export const DEFAULT_EVIDENCE_PACKET_MAX_BYTES = 64 * 1024;

export type GitcrawlEvidenceNode = {
  id: string;
  kind: "cluster" | "issue" | "pull_request" | "file" | "dataset" | "unknown";
  label: string;
};

export type GitcrawlEvidenceEdge = {
  from: string;
  predicate: string;
  to: string;
  claim_sha256: string;
};

type GitcrawlEvidencePacketBase = {
  provider: GitcrawlProvider;
  repository: string;
  snapshot_id: string;
  parity_snapshot_id?: string;
  query_version: typeof GITCRAWL_QUERY_VERSION;
  generated_at: string;
  required_coverage: GitcrawlDataset[];
  coverage: GitcrawlCoverageRow[];
  claims: GitcrawlEvidenceClaim[];
  graph: {
    nodes: GitcrawlEvidenceNode[];
    edges: GitcrawlEvidenceEdge[];
  };
};

export type GitcrawlEvidencePacketV1 = GitcrawlEvidencePacketBase & {
  version: typeof GITCRAWL_PACKET_VERSION_V1;
  totals: {
    claims: number;
    nodes: number;
    edges: number;
  };
  omitted: {
    claims: number;
    nodes: number;
    edges: number;
  };
  sha256: string;
};

export type GitcrawlEvidencePacketV2 = GitcrawlEvidencePacketBase & {
  version: typeof GITCRAWL_PACKET_VERSION;
  included: {
    claims: number;
    nodes: number;
    edges: number;
  };
  sha256: string;
};

export type GitcrawlEvidencePacket = GitcrawlEvidencePacketV1 | GitcrawlEvidencePacketV2;

export function buildGitcrawlEvidencePacket(input: {
  provider: GitcrawlProvider;
  repository: string;
  snapshotId: string;
  paritySnapshotId?: string;
  coverage: GitcrawlCoverageRow[];
  requiredCoverage?: GitcrawlDataset[];
  claims: GitcrawlEvidenceClaim[];
  generatedAt?: string;
  maxClaims?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxBytes?: number;
}): GitcrawlEvidencePacketV2 {
  const limits = {
    claims: boundedLimit(input.maxClaims, DEFAULT_EVIDENCE_PACKET_MAX_CLAIMS),
    nodes: boundedLimit(input.maxNodes, DEFAULT_EVIDENCE_PACKET_MAX_NODES),
    edges: boundedLimit(input.maxEdges, DEFAULT_EVIDENCE_PACKET_MAX_EDGES),
    bytes: boundedLimit(input.maxBytes, DEFAULT_EVIDENCE_PACKET_MAX_BYTES),
  };
  validatePacketBindings({
    provider: input.provider,
    snapshotId: input.snapshotId,
    ...(input.paritySnapshotId === undefined ? {} : { paritySnapshotId: input.paritySnapshotId }),
    coverage: input.coverage,
    requiredCoverage: input.requiredCoverage ?? [...GITCRAWL_DATASETS],
    claims: input.claims,
  });
  const sortedClaims = [...input.claims].sort((left, right) => {
    const priority = claimPriority(left) - claimPriority(right);
    if (priority !== 0) return priority;
    return compareCanonicalText(
      `${left.subject}:${left.query.name}:${left.sha256}`,
      `${right.subject}:${right.query.name}:${right.sha256}`,
    );
  });
  let claimLimit = Math.min(sortedClaims.length, limits.claims);
  for (;;) {
    const claims = sortedClaims.slice(0, claimLimit);
    const graph = buildGraph(claims, limits.nodes, limits.edges);
    const unsigned = {
      version: GITCRAWL_PACKET_VERSION,
      provider: input.provider,
      repository: input.repository,
      snapshot_id: input.snapshotId,
      ...(input.paritySnapshotId === undefined
        ? {}
        : { parity_snapshot_id: input.paritySnapshotId }),
      query_version: GITCRAWL_QUERY_VERSION,
      generated_at: input.generatedAt ?? new Date().toISOString(),
      required_coverage: [...(input.requiredCoverage ?? GITCRAWL_DATASETS)].sort(
        compareCanonicalText,
      ),
      coverage: [...input.coverage].sort((left, right) =>
        compareCanonicalText(left.dataset, right.dataset),
      ),
      claims,
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
      },
      included: {
        claims: claims.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
      },
    } satisfies Omit<GitcrawlEvidencePacketV2, "sha256">;
    const packet = {
      ...unsigned,
      sha256: sha256Canonical(unsigned),
    };
    if (renderedPacketBytes(packet) <= limits.bytes) return packet;
    if (claimLimit === 0) {
      throw new Error(`Gitcrawl evidence packet metadata exceeds ${limits.bytes} bytes`);
    }
    claimLimit -= 1;
  }
}

export function verifyGitcrawlEvidencePacket(
  packet: GitcrawlEvidencePacket,
  maxBytes = DEFAULT_EVIDENCE_PACKET_MAX_BYTES,
): void {
  assertSha256(packet.sha256, "packet sha256");
  const packetVersion = (packet as unknown as { version?: unknown }).version;
  if (packetVersion !== GITCRAWL_PACKET_VERSION && packetVersion !== GITCRAWL_PACKET_VERSION_V1) {
    throw new Error(`unsupported Gitcrawl packet version: ${String(packetVersion)}`);
  }
  const rawPacket = packet as unknown as Record<string, unknown>;
  if (packet.version === GITCRAWL_PACKET_VERSION) {
    if (!("included" in rawPacket) || "totals" in rawPacket || "omitted" in rawPacket) {
      throw new Error("Gitcrawl v2 evidence packet has incompatible count metadata");
    }
  } else if ("included" in rawPacket) {
    throw new Error("Gitcrawl v1 evidence packet has incompatible count metadata");
  }
  if (packet.query_version !== GITCRAWL_QUERY_VERSION) {
    throw new Error(`unsupported Gitcrawl packet query version: ${packet.query_version}`);
  }
  assertPacketCardinality(packet);
  validatePacketBindings({
    provider: packet.provider,
    snapshotId: packet.snapshot_id,
    ...(packet.parity_snapshot_id === undefined
      ? {}
      : { paritySnapshotId: packet.parity_snapshot_id }),
    coverage: packet.coverage,
    requiredCoverage: packet.required_coverage,
    claims: packet.claims,
  });
  const { sha256: _sha256, ...unsigned } = packet;
  if (sha256Canonical(unsigned) !== packet.sha256) {
    throw new Error("Gitcrawl evidence packet digest mismatch");
  }
  if (renderedPacketBytes(packet) > maxBytes) {
    throw new Error(`Gitcrawl evidence packet exceeds ${maxBytes} bytes`);
  }
  const reconstructed = buildGraph(
    packet.claims,
    packet.graph.nodes.length,
    packet.graph.edges.length,
  );
  if (
    canonicalJson(packet.graph.nodes) !== canonicalJson(reconstructed.nodes) ||
    canonicalJson(packet.graph.edges) !== canonicalJson(reconstructed.edges)
  ) {
    throw new Error("Gitcrawl evidence packet graph does not match its verified claims");
  }
  if (packet.version === GITCRAWL_PACKET_VERSION_V1) {
    verifyLegacyPacketCounts(packet, reconstructed);
  } else {
    verifyIncludedPacketCounts(packet);
  }
}

export function verifyEmbeddedGitcrawlEvidencePacket(
  markdown: string,
  expectedRepository?: string,
  required = false,
): GitcrawlEvidencePacket | undefined {
  const heading = "## Gitcrawl Evidence Packet";
  const headings = [...markdown.matchAll(/^## Gitcrawl Evidence Packet$/gm)];
  if (headings.length === 0) {
    if (required) throw new Error("job is missing its required Gitcrawl evidence packet");
    return undefined;
  }
  if (headings.length !== 1) {
    throw new Error("job contains multiple Gitcrawl evidence packets");
  }
  const sectionStart = headings[0]!.index!;
  const afterHeading = sectionStart + heading.length;
  const nextHeading = markdown.slice(afterHeading).search(/^## /m);
  const section =
    nextHeading === -1
      ? markdown.slice(sectionStart)
      : markdown.slice(sectionStart, afterHeading + nextHeading);
  const match = section.match(
    /^## Gitcrawl Evidence Packet\n\n(?:- [^\n]*\n)+\n<details>\n<summary>Bounded digest-bound Gitcrawl evidence<\/summary>\n\n```json\n([\s\S]*?)\n```\n\n<\/details>\n*$/,
  );
  if (!match?.[1]) {
    throw new Error("job contains a malformed Gitcrawl evidence packet");
  }
  if (Buffer.byteLength(match[1], "utf8") > DEFAULT_EVIDENCE_PACKET_MAX_BYTES) {
    throw new Error(
      `job contains a Gitcrawl evidence packet exceeding ${DEFAULT_EVIDENCE_PACKET_MAX_BYTES} bytes`,
    );
  }
  let packet: unknown;
  try {
    packet = JSON.parse(match[1]);
  } catch {
    throw new Error("job contains malformed Gitcrawl evidence JSON");
  }
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    throw new Error("job contains malformed Gitcrawl evidence JSON");
  }
  const typed = packet as GitcrawlEvidencePacket;
  verifyGitcrawlEvidencePacket(typed);
  if (expectedRepository !== undefined && typed.repository !== expectedRepository) {
    throw new Error(
      `Gitcrawl evidence packet repository ${typed.repository} does not match job repository ${expectedRepository}`,
    );
  }
  return typed;
}

export function verifyGitcrawlEvidenceJobTargets(
  packet: GitcrawlEvidencePacket,
  frontmatter: {
    repo?: unknown;
    canonical?: unknown;
    candidates?: unknown;
    cluster_refs?: unknown;
  },
): void {
  const repository = String(frontmatter.repo ?? "").trim();
  if (!repository || packet.repository !== repository) {
    throw new Error("Gitcrawl evidence job target repository is not bound to the packet");
  }
  const expected = expectedJobTargets(packet);
  for (const [field, values, expectedSubjects] of [
    ["canonical", frontmatter.canonical, expected.canonical],
    ["candidates", frontmatter.candidates, expected.candidates],
    ["cluster_refs", frontmatter.cluster_refs, expected.clusterRefs],
  ] as const) {
    if (!Array.isArray(values)) {
      throw new Error(`Gitcrawl evidence job ${field} must be a list`);
    }
    const actualSubjects = new Set<string>();
    for (const value of values) {
      const subject = targetSubject(repository, value, expectedSubjects);
      if (actualSubjects.has(subject)) {
        throw new Error(`Gitcrawl evidence job ${field} repeats a packet target`);
      }
      actualSubjects.add(subject);
    }
    if (
      canonicalJson([...actualSubjects].sort(compareCanonicalText)) !==
      canonicalJson([...expectedSubjects].sort(compareCanonicalText))
    ) {
      throw new Error(`Gitcrawl evidence job ${field} does not exactly match packet targets`);
    }
  }
}

export function renderGitcrawlEvidencePacket(packet: GitcrawlEvidencePacket): string[] {
  verifyGitcrawlEvidencePacket(packet);
  const serialized = JSON.stringify(packet, null, 2);
  const claimSummary =
    packet.version === GITCRAWL_PACKET_VERSION_V1
      ? `${packet.claims.length} included, ${packet.omitted.claims} declared omitted (legacy)`
      : `${packet.included.claims} included`;
  return [
    "## Gitcrawl Evidence Packet",
    "",
    `- provider: ${packet.provider}`,
    `- snapshot: \`${packet.snapshot_id}\``,
    ...(packet.parity_snapshot_id === undefined
      ? []
      : [`- parity snapshot: \`${packet.parity_snapshot_id}\``]),
    `- packet version: \`${packet.version}\``,
    `- query version: \`${packet.query_version}\``,
    `- packet sha256: \`${packet.sha256}\``,
    `- claims: ${claimSummary}`,
    `- graph: ${packet.graph.nodes.length} nodes, ${packet.graph.edges.length} edges`,
    "",
    "<details>",
    "<summary>Bounded digest-bound Gitcrawl evidence</summary>",
    "",
    "```json",
    serialized,
    "```",
    "",
    "</details>",
    "",
  ];
}

function verifyIncludedPacketCounts(packet: GitcrawlEvidencePacketV2): void {
  assertNonnegativePacketCounts([
    ["included claims", packet.included?.claims],
    ["included nodes", packet.included?.nodes],
    ["included edges", packet.included?.edges],
  ]);
  if (
    packet.included.claims !== packet.claims.length ||
    packet.included.nodes !== packet.graph.nodes.length ||
    packet.included.edges !== packet.graph.edges.length
  ) {
    throw new Error("Gitcrawl evidence packet included counts do not match its bounded data");
  }
}

function verifyLegacyPacketCounts(
  packet: GitcrawlEvidencePacketV1,
  reconstructed: ReturnType<typeof buildGraph>,
): void {
  assertNonnegativePacketCounts([
    ["total claims", packet.totals?.claims],
    ["total nodes", packet.totals?.nodes],
    ["total edges", packet.totals?.edges],
    ["omitted claims", packet.omitted?.claims],
    ["omitted nodes", packet.omitted?.nodes],
    ["omitted edges", packet.omitted?.edges],
  ]);
  if (
    packet.totals.claims !== packet.claims.length + packet.omitted.claims ||
    packet.totals.nodes < reconstructed.totalNodes ||
    packet.totals.edges < reconstructed.totalEdges ||
    packet.omitted.nodes !== packet.totals.nodes - packet.graph.nodes.length ||
    packet.omitted.edges !== packet.totals.edges - packet.graph.edges.length ||
    (packet.omitted.claims === 0 &&
      (packet.totals.nodes !== reconstructed.totalNodes ||
        packet.totals.edges !== reconstructed.totalEdges))
  ) {
    throw new Error("Gitcrawl v1 evidence packet declared totals or omissions do not match");
  }
}

function assertNonnegativePacketCounts(
  entries: readonly (readonly [label: string, value: unknown])[],
): void {
  for (const [label, value] of entries) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`Gitcrawl evidence packet ${label} must be a nonnegative safe integer`);
    }
  }
}

function expectedJobTargets(packet: GitcrawlEvidencePacket): {
  canonical: Set<string>;
  candidates: Set<string>;
  clusterRefs: Set<string>;
} {
  const memberClaims = packet.claims.filter(
    (claim) => claim.query.name === "gitcrawl.clusters.members",
  );
  if (memberClaims.length > 0) return expectedClusterJobTargets(packet, memberClaims);

  const searchClaims = lowSignalClaimsBySubject(
    packet,
    packet.claims.filter((claim) => claim.query.name === "gitcrawl.threads.search"),
  );
  const reviewClaims = lowSignalClaimsBySubject(
    packet,
    packet.claims.filter((claim) => claim.query.name === "gitcrawl.pull_requests.review_context"),
  );
  const searchSubjects = new Set(searchClaims.keys());
  const reviewSubjects = new Set(reviewClaims.keys());
  const candidates = new Set([...searchSubjects, ...reviewSubjects]);
  if (candidates.size === 0) {
    throw new Error("Gitcrawl evidence packet has no actionable job targets");
  }
  for (const subject of candidates) {
    if (!searchSubjects.has(subject) || !reviewSubjects.has(subject)) {
      throw new Error("Gitcrawl low-signal target is missing search or review evidence");
    }
    const searchProjection = lowSignalSafetyProjection(searchClaims.get(subject)!, "search");
    const reviewProjection = lowSignalSafetyProjection(reviewClaims.get(subject)!, "review");
    assertGitcrawlThreadSafetyProjectionMatches(searchProjection, reviewProjection);
  }
  return {
    canonical: new Set(),
    candidates,
    clusterRefs: new Set(candidates),
  };
}

function expectedClusterJobTargets(
  packet: GitcrawlEvidencePacket,
  memberClaims: GitcrawlEvidenceClaim[],
): {
  canonical: Set<string>;
  candidates: Set<string>;
  clusterRefs: Set<string>;
} {
  const members = memberClaims.map((claim) => clusterMemberTarget(packet, claim));
  const clusterRefs = new Set(members.map((member) => member.subject));
  if (clusterRefs.size !== members.length) {
    throw new Error("Gitcrawl cluster evidence repeats a member target");
  }
  const clusterSubjects = new Set(members.map((member) => member.clusterSubject));
  if (clusterSubjects.size !== 1) {
    throw new Error("Gitcrawl cluster evidence mixes cluster memberships");
  }
  const memberCounts = new Set(members.map((member) => member.memberCount));
  if (memberCounts.size !== 1 || [...memberCounts][0] !== members.length) {
    throw new Error("Gitcrawl cluster evidence member count does not match member claims");
  }
  const clusterSubject = [...clusterSubjects][0]!;
  const clusterId = clusterIdFromSubject(packet.repository, clusterSubject);
  const clusterClaims = packet.claims.filter(
    (claim) => claim.query.name === "gitcrawl.clusters.list" && claim.subject === clusterSubject,
  );
  if (clusterClaims.length > 1) {
    throw new Error("Gitcrawl cluster evidence repeats its cluster declaration");
  }
  const declaredRepresentative =
    clusterClaims.length === 0
      ? undefined
      : clusterRepresentativeSubject(packet.repository, clusterClaims[0]!);
  if (clusterClaims.length === 1) {
    const data = recordData(clusterClaims[0]!, "cluster declaration");
    if (data.id !== clusterId) {
      throw new Error("Gitcrawl cluster declaration id does not match its membership subject");
    }
    const memberCount = data.memberCount;
    if (!Number.isSafeInteger(memberCount) || memberCount !== members.length) {
      throw new Error("Gitcrawl cluster evidence member count does not match member claims");
    }
  }
  const roleTargets = members.filter(
    (member) => member.role === "canonical" || member.role === "representative",
  );
  if (roleTargets.length !== 1) {
    throw new Error("Gitcrawl cluster evidence requires exactly one canonical member role");
  }
  const canonicalSubject = declaredRepresentative ?? roleTargets[0]!.subject;
  if (canonicalSubject !== roleTargets[0]!.subject || !clusterRefs.has(canonicalSubject)) {
    throw new Error("Gitcrawl cluster representative does not match its canonical member role");
  }
  return {
    canonical: new Set([canonicalSubject]),
    candidates: new Set(
      members.filter((member) => member.state === "open").map((member) => member.subject),
    ),
    clusterRefs,
  };
}

function clusterMemberTarget(
  packet: GitcrawlEvidencePacket,
  claim: GitcrawlEvidenceClaim,
): {
  subject: string;
  clusterSubject: string;
  memberCount: number;
  role: string;
  state: string;
} {
  const data = recordData(claim, "cluster member");
  const number = data.number;
  const kind = data.kind;
  const state = data.state;
  const role = data.role;
  const memberCount = data.clusterMemberCount;
  if (!Number.isSafeInteger(number) || Number(number) <= 0) {
    throw new Error("Gitcrawl cluster member claim has an invalid number");
  }
  if (kind !== "issue" && kind !== "pull_request") {
    throw new Error("Gitcrawl cluster member claim has an invalid kind");
  }
  if (state !== "open" && state !== "closed") {
    throw new Error("Gitcrawl cluster member claim has an invalid state");
  }
  if (role !== "canonical" && role !== "representative" && role !== "member") {
    throw new Error("Gitcrawl cluster member claim has an invalid role");
  }
  if (!Number.isSafeInteger(memberCount) || Number(memberCount) < 1) {
    throw new Error("Gitcrawl cluster member claim has an invalid declared count");
  }
  const subject = `${packet.repository}#${kind === "pull_request" ? "pull" : "issue"}:${number}`;
  if (claim.subject !== subject) {
    throw new Error("Gitcrawl cluster member claim subject does not match its data");
  }
  const memberships = claim.relations.filter((relation) => relation.predicate === "member_of");
  if (
    memberships.length !== 1 ||
    !memberships[0]!.target.startsWith(`${packet.repository}#cluster:`)
  ) {
    throw new Error("Gitcrawl cluster member claim has an invalid cluster role");
  }
  return {
    subject,
    clusterSubject: memberships[0]!.target,
    memberCount: Number(memberCount),
    role,
    state,
  };
}

function clusterRepresentativeSubject(
  repository: string,
  claim: GitcrawlEvidenceClaim,
): string | undefined {
  const representative = recordData(claim, "cluster declaration").representative;
  if (
    typeof representative !== "object" ||
    representative === null ||
    Array.isArray(representative)
  ) {
    throw new Error("Gitcrawl cluster declaration has an invalid representative");
  }
  const number = (representative as Record<string, unknown>).number;
  const kind = (representative as Record<string, unknown>).kind;
  if (number === null) return undefined;
  if (!Number.isSafeInteger(number) || Number(number) <= 0) {
    throw new Error("Gitcrawl cluster declaration has an invalid representative number");
  }
  if (kind !== "issue" && kind !== "pull_request") {
    throw new Error("Gitcrawl cluster declaration has an invalid representative kind");
  }
  return `${repository}#${kind === "pull_request" ? "pull" : "issue"}:${number}`;
}

function clusterIdFromSubject(repository: string, subject: string): number {
  const match = new RegExp(`^${escapeRegex(repository)}#cluster:([1-9]\\d*)$`).exec(subject);
  const clusterId = Number(match?.[1]);
  if (!Number.isSafeInteger(clusterId) || clusterId <= 0) {
    throw new Error("Gitcrawl cluster evidence has an invalid membership subject");
  }
  return clusterId;
}

function lowSignalClaimsBySubject(
  packet: GitcrawlEvidencePacket,
  claims: GitcrawlEvidenceClaim[],
): Map<string, GitcrawlEvidenceClaim> {
  const subjects = new Map<string, GitcrawlEvidenceClaim>();
  for (const claim of claims) {
    if (rootThreadSubject(packet.repository, claim.subject) === undefined) {
      if (supplementalReviewFileClaim(packet.repository, claim)) continue;
      throw new Error("Gitcrawl low-signal claim is outside the packet repository");
    }
    const data = recordData(claim, "low-signal target");
    let number: unknown;
    let kind: unknown;
    if (claim.query.name === "gitcrawl.threads.search") {
      number = data.number;
      kind = data.kind;
    } else if (claim.query.name === "gitcrawl.pull_requests.review_context") {
      const thread = data.thread;
      if (typeof thread !== "object" || thread === null || Array.isArray(thread)) {
        throw new Error("Gitcrawl low-signal review claim has malformed thread data");
      }
      number = (thread as Record<string, unknown>).number;
      kind = (thread as Record<string, unknown>).kind;
    } else {
      throw new Error("Gitcrawl low-signal target has an unsupported query claim");
    }
    if (!Number.isSafeInteger(number) || Number(number) <= 0 || kind !== "pull_request") {
      throw new Error("Gitcrawl low-signal claim has an invalid pull request payload");
    }
    const subject = `${packet.repository}#pull:${number}`;
    if (claim.subject !== subject) {
      throw new Error("Gitcrawl low-signal claim payload does not match its subject");
    }
    if (subjects.has(subject)) {
      throw new Error(`Gitcrawl low-signal target repeats its ${claim.query.name} claim`);
    }
    subjects.set(subject, claim);
  }
  return subjects;
}

function supplementalReviewFileClaim(repository: string, claim: GitcrawlEvidenceClaim): boolean {
  if (claim.query.name !== "gitcrawl.pull_requests.review_context") return false;
  const match = new RegExp(`^${escapeRegex(repository)}#pull:([1-9]\\d*)@file:[0-9]+:`).exec(
    claim.subject,
  );
  if (!match?.[1]) return false;
  const target = `${repository}#pull:${match[1]}`;
  return (
    claim.relations.length === 1 &&
    claim.relations[0]?.predicate === "evidence_for" &&
    claim.relations[0].target === target
  );
}

function lowSignalSafetyProjection(
  claim: GitcrawlEvidenceClaim,
  label: "search" | "review",
): GitcrawlThreadSafetyProjection {
  const claimData = recordData(claim, `low-signal ${label}`);
  const data =
    label === "search" ? claimData : recordValue(claimData.thread, "low-signal review thread");
  const policySignals = recordValue(data.policySignals, `low-signal ${label} policy signals`);
  for (const field of ["blankTemplate", "issueReference", "concreteFix", "thirdPartyCapability"]) {
    if (typeof policySignals[field] !== "boolean") {
      throw new Error(`Gitcrawl low-signal ${label} claim has incomplete safety metadata`);
    }
  }
  if (
    typeof data.title !== "string" ||
    typeof data.body !== "string" ||
    typeof data.authorLogin !== "string" ||
    !data.authorLogin.trim() ||
    typeof data.authorType !== "string" ||
    !data.authorType.trim() ||
    typeof data.authorAssociation !== "string" ||
    !data.authorAssociation.trim() ||
    !Array.isArray(data.labels) ||
    !Array.isArray(data.assignees) ||
    typeof data.securitySensitive !== "boolean" ||
    data.securityMetadataComplete !== true ||
    typeof data.securityProjectionSha256 !== "string"
  ) {
    throw new Error(`Gitcrawl low-signal ${label} claim has incomplete safety metadata`);
  }
  assertSha256(
    data.securityProjectionSha256,
    `Gitcrawl low-signal ${label} security projection sha256`,
  );
  return {
    title: data.title,
    body: data.body,
    authorLogin: data.authorLogin,
    authorType: data.authorType,
    authorAssociation: data.authorAssociation,
    labels: data.labels,
    assignees: data.assignees,
    securitySensitive: data.securitySensitive,
    securityMetadataComplete: true,
    securityProjectionSha256: data.securityProjectionSha256,
    policySignals: policySignals as GitcrawlThreadSafetyProjection["policySignals"],
  };
}

function recordData(claim: GitcrawlEvidenceClaim, label: string): Record<string, unknown> {
  return recordValue(claim.data, label);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Gitcrawl ${label} claim has malformed data`);
  }
  return value as Record<string, unknown>;
}

function rootThreadSubject(repository: string, subject: string): string | undefined {
  const prefix = `${repository}#`;
  if (!subject.startsWith(prefix)) return undefined;
  return /^(?:issue|pull):[1-9]\d*$/.test(subject.slice(prefix.length)) ? subject : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetSubject(repository: string, value: unknown, expectedSubjects: Set<string>): string {
  const ref = String(value ?? "").trim();
  const shorthand = /^#?(\d+)$/.exec(ref);
  if (shorthand?.[1]) {
    const suffix = `:${shorthand[1]}`;
    const matches = [...expectedSubjects].filter((subject) => subject.endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error("Gitcrawl evidence job target has no unambiguous packet role");
    }
    return matches[0]!;
  }
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error("Gitcrawl evidence job target is malformed");
  }
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  ) {
    throw new Error("Gitcrawl evidence job target is malformed");
  }
  const targetRepository = `${match[1]}/${match[2]}`;
  if (targetRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Gitcrawl evidence job target is outside the packet repository");
  }
  return `${repository}#${match[3] === "pull" ? "pull" : "issue"}:${match[4]}`;
}

function renderedPacketBytes(packet: GitcrawlEvidencePacket): number {
  return Buffer.byteLength(JSON.stringify(packet, null, 2), "utf8");
}

function buildGraph(
  claims: GitcrawlEvidenceClaim[],
  maxNodes: number,
  maxEdges: number,
): {
  nodes: GitcrawlEvidenceNode[];
  edges: GitcrawlEvidenceEdge[];
  omittedNodes: number;
  omittedEdges: number;
  totalNodes: number;
  totalEdges: number;
} {
  const allNodes = new Map<string, GitcrawlEvidenceNode>();
  const allEdges: GitcrawlEvidenceEdge[] = [];
  for (const claim of claims) {
    addNode(allNodes, claim.subject);
    for (const relation of claim.relations) {
      addNode(allNodes, relation.target);
      allEdges.push({
        from: claim.subject,
        predicate: relation.predicate,
        to: relation.target,
        claim_sha256: claim.sha256,
      });
    }
  }
  const sortedNodes = [...allNodes.values()].sort((left, right) =>
    compareCanonicalText(left.id, right.id),
  );
  const nodes = sortedNodes.slice(0, maxNodes);
  const includedNodeIds = new Set(nodes.map((node) => node.id));
  const sortedEdges = allEdges
    .filter((edge) => includedNodeIds.has(edge.from) && includedNodeIds.has(edge.to))
    .sort((left, right) =>
      compareCanonicalText(
        `${left.from}:${left.predicate}:${left.to}:${left.claim_sha256}`,
        `${right.from}:${right.predicate}:${right.to}:${right.claim_sha256}`,
      ),
    );
  const edges = sortedEdges.slice(0, maxEdges);
  return {
    nodes,
    edges,
    omittedNodes: Math.max(0, sortedNodes.length - maxNodes),
    omittedEdges: Math.max(0, allEdges.length - edges.length),
    totalNodes: sortedNodes.length,
    totalEdges: allEdges.length,
  };
}

function addNode(target: Map<string, GitcrawlEvidenceNode>, id: string): void {
  if (target.has(id)) return;
  target.set(id, {
    id,
    kind: nodeKind(id),
    label: id.length > 160 ? `${id.slice(0, 157)}...` : id,
  });
}

function nodeKind(id: string): GitcrawlEvidenceNode["kind"] {
  if (id.includes("#cluster:")) return "cluster";
  if (id.includes("#dataset:")) return "dataset";
  if (id.includes("@file:")) return "file";
  if (id.includes("/pull/") || id.includes("#pull:")) return "pull_request";
  if (id.includes("/issues/") || id.includes("#issue:")) return "issue";
  return "unknown";
}

function claimPriority(claim: GitcrawlEvidenceClaim): number {
  return claim.relations.length === 0 ? 0 : 1;
}

function validatePacketBindings(input: {
  provider: GitcrawlProvider;
  snapshotId: string;
  paritySnapshotId?: string;
  coverage: GitcrawlCoverageRow[];
  requiredCoverage: GitcrawlDataset[];
  claims: GitcrawlEvidenceClaim[];
}): void {
  if (!["local", "cloud", "parity"].includes(input.provider)) {
    throw new Error(`Gitcrawl evidence packet has unknown provider ${input.provider}`);
  }
  assertSnapshotId(input.snapshotId);
  if (input.provider === "parity") {
    if (input.paritySnapshotId === undefined) {
      throw new Error("Gitcrawl parity evidence packet is missing its local snapshot");
    }
    assertSnapshotId(input.paritySnapshotId);
  } else if (input.paritySnapshotId !== undefined) {
    throw new Error("Gitcrawl non-parity evidence packet has a parity snapshot");
  }
  for (const claim of input.claims) {
    verifyGitcrawlEvidenceClaim(claim);
    if (
      claim.provider !== input.provider ||
      claim.snapshot_id !== input.snapshotId ||
      claim.parity_snapshot_id !== input.paritySnapshotId
    ) {
      throw new Error(`Gitcrawl evidence packet mixes claim bindings for ${claim.subject}`);
    }
  }
  const datasets = new Set<string>();
  const required = new Set(input.requiredCoverage);
  if (required.size === 0 || required.size !== input.requiredCoverage.length) {
    throw new Error("Gitcrawl evidence packet required coverage is empty or duplicated");
  }
  for (const dataset of required) {
    if (!GITCRAWL_DATASETS.includes(dataset)) {
      throw new Error(`Gitcrawl evidence packet requires unknown coverage ${dataset}`);
    }
  }
  for (const dataset of requiredCoverageForClaims(input.claims)) {
    if (!required.has(dataset)) {
      throw new Error(`Gitcrawl evidence packet omits required claim coverage ${dataset}`);
    }
  }
  let generation = "";
  for (const row of input.coverage) {
    assertPersistedCoverageRow(row);
    if (datasets.has(row.dataset)) {
      throw new Error(`Gitcrawl evidence packet repeats coverage for ${row.dataset}`);
    }
    datasets.add(row.dataset);
    if (required.has(row.dataset) && (!row.complete || row.covered_count !== row.eligible_count)) {
      throw new Error(`Gitcrawl evidence packet has incomplete coverage for ${row.dataset}`);
    }
    if (row.complete && row.covered_count !== row.eligible_count) {
      throw new Error(`Gitcrawl evidence packet has invalid complete coverage for ${row.dataset}`);
    }
    if (!row.dataset_generated_at) {
      throw new Error(`Gitcrawl evidence packet coverage ${row.dataset} has no generation`);
    }
    generation ||= row.dataset_generated_at;
    if (row.dataset_generated_at !== generation) {
      throw new Error("Gitcrawl evidence packet mixes coverage generations");
    }
  }
  if (input.coverage.length === 0) {
    throw new Error("Gitcrawl evidence packet has no coverage");
  }
  for (const dataset of GITCRAWL_DATASETS) {
    if (!datasets.has(dataset)) {
      throw new Error(`Gitcrawl evidence packet is missing coverage for ${dataset}`);
    }
  }
}

function assertPersistedCoverageRow(row: GitcrawlCoverageRow): void {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Gitcrawl evidence packet contains malformed coverage");
  }
  if (!GITCRAWL_DATASETS.includes(row.dataset)) {
    throw new Error(`Gitcrawl evidence packet contains unknown coverage ${String(row.dataset)}`);
  }
  for (const field of ["row_count", "eligible_count", "covered_count"] as const) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
      throw new Error(
        `Gitcrawl evidence packet coverage ${row.dataset} ${field} must be a nonnegative safe integer`,
      );
    }
  }
  if (row.covered_count > row.eligible_count) {
    throw new Error(`Gitcrawl evidence packet coverage ${row.dataset} exceeds eligible rows`);
  }
  if (typeof row.complete !== "boolean") {
    throw new Error(`Gitcrawl evidence packet coverage ${row.dataset} complete must be boolean`);
  }
  if (typeof row.max_source_at !== "string") {
    throw new Error(
      `Gitcrawl evidence packet coverage ${row.dataset} max_source_at must be string`,
    );
  }
  if (row.max_source_at) {
    parseRfc3339Timestamp(
      row.max_source_at,
      `Gitcrawl evidence packet coverage ${row.dataset} max_source_at`,
    );
  }
  if (typeof row.dataset_generated_at !== "string" || !row.dataset_generated_at) {
    throw new Error(
      `Gitcrawl evidence packet coverage ${row.dataset} dataset_generated_at must be a timestamp`,
    );
  }
  parseRfc3339Timestamp(
    row.dataset_generated_at,
    `Gitcrawl evidence packet coverage ${row.dataset} dataset_generated_at`,
  );
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > fallback) {
    throw new Error(`Gitcrawl evidence packet limit must be an integer from 1 to ${fallback}`);
  }
  return resolved;
}

function assertPacketCardinality(packet: GitcrawlEvidencePacket): void {
  if (!Array.isArray(packet.claims) || packet.claims.length > DEFAULT_EVIDENCE_PACKET_MAX_CLAIMS) {
    throw new Error(
      `Gitcrawl evidence packet includes more than ${DEFAULT_EVIDENCE_PACKET_MAX_CLAIMS} claims`,
    );
  }
  if (
    typeof packet.graph !== "object" ||
    packet.graph === null ||
    !Array.isArray(packet.graph.nodes) ||
    packet.graph.nodes.length > DEFAULT_EVIDENCE_PACKET_MAX_NODES
  ) {
    throw new Error(
      `Gitcrawl evidence packet includes more than ${DEFAULT_EVIDENCE_PACKET_MAX_NODES} nodes`,
    );
  }
  if (
    !Array.isArray(packet.graph.edges) ||
    packet.graph.edges.length > DEFAULT_EVIDENCE_PACKET_MAX_EDGES
  ) {
    throw new Error(
      `Gitcrawl evidence packet includes more than ${DEFAULT_EVIDENCE_PACKET_MAX_EDGES} edges`,
    );
  }
}

function requiredCoverageForClaims(claims: GitcrawlEvidenceClaim[]): Set<GitcrawlDataset> {
  const required = new Set<GitcrawlDataset>();
  for (const claim of claims) {
    for (const dataset of GITCRAWL_QUERY_COVERAGE[claim.query.name] ?? []) {
      required.add(dataset);
    }
  }
  return required;
}
