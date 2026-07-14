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
  if (row.complete && row.eligible_count > row.row_count) {
    throw new Error(
      `Gitcrawl evidence packet coverage ${row.dataset} has more eligible rows than total rows`,
    );
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
