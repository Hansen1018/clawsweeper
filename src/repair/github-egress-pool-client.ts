import { createHmac } from "node:crypto";

export type GithubEgressPoolPermit = {
  permitId: string;
  epoch: number;
  mode: "normal" | "probe" | "ramp";
  declaredBudget: number;
  expiresAt: string;
};

export type GithubEgressPoolDeferred = {
  granted: false;
  reason: string;
  epoch: number;
  blockedUntil: string | null;
  resetProvenance: "none" | "retry_after" | "rate_limit_reset" | "fallback";
  resetAuthoritative: boolean;
};

export type GithubEgressPoolState = {
  state: "closed" | "open" | "half_open" | "recovering";
  epoch: number;
  blockedUntil: string | null;
  resetProvenance: "none" | "retry_after" | "rate_limit_reset" | "fallback";
  resetAuthoritative: boolean;
};

type ClientOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
};

export class GithubEgressPoolCoordinatorClient {
  private readonly baseUrl: string;
  private readonly webhookSecret: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
    ) {
      throw new Error("GitHub egress pool URL must use HTTPS or loopback HTTP");
    }
    if (!options.webhookSecret) throw new Error("GitHub egress pool webhook secret is required");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.webhookSecret = options.webhookSecret;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async acquire(input: { callerHash: string; declaredBudget: number }) {
    const response = await this.post("acquire", {
      caller_hash: input.callerHash,
      declared_budget: input.declaredBudget,
    });
    if (response.granted !== true) return parseDeferred(response);
    return { granted: true as const, permit: parsePermit(response.permit) };
  }

  async start(input: { permit: GithubEgressPoolPermit; operationIndex: number }) {
    const response = await this.post("start", {
      permit_id: input.permit.permitId,
      epoch: input.permit.epoch,
      operation_index: input.operationIndex,
    });
    if (response.already_completed === true) {
      return {
        granted: false as const,
        reason: "already_completed",
        epoch: positiveInteger(response.epoch, "epoch"),
        blockedUntil: null,
        resetProvenance: "none" as const,
        resetAuthoritative: false,
      };
    }
    if (response.started !== true) return parseDeferred(response);
    return { started: true as const };
  }

  async finish(input: {
    permit: GithubEgressPoolPermit;
    operationIndex: number;
    receiptId: string;
    outcome: "success" | "failure" | "unexecuted_failure";
  }) {
    const response = await this.post("finish", {
      permit_id: input.permit.permitId,
      epoch: input.permit.epoch,
      operation_index: input.operationIndex,
      receipt_id: input.receiptId,
      outcome: input.outcome,
    });
    return parseState(response.state);
  }

  async throttle(input: {
    permit: GithubEgressPoolPermit;
    operationIndex: number;
    receiptId: string;
    status: 403 | 429;
    observedAt: string;
    headers: {
      retryAfterPresent: boolean;
      retryAfterSeconds: number | null;
      resetPresent: boolean;
      resetEpochSeconds: number | null;
    };
  }) {
    const response = await this.post("throttle", {
      permit_id: input.permit.permitId,
      epoch: input.permit.epoch,
      operation_index: input.operationIndex,
      receipt_id: input.receiptId,
      status: input.status,
      observed_at: input.observedAt,
      headers: {
        retry_after_present: input.headers.retryAfterPresent,
        retry_after_seconds: input.headers.retryAfterSeconds,
        rate_limit_reset_present: input.headers.resetPresent,
        rate_limit_reset_epoch_seconds: input.headers.resetEpochSeconds,
      },
    });
    return parseState(response.state);
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
    const response = await this.request(`${this.baseUrl}/internal/github-egress-pool/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`GitHub egress pool ${path} returned invalid JSON (HTTP ${response.status})`);
    }
    const result = objectValue(parsed);
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `GitHub egress pool ${path} failed (HTTP ${response.status}): ${String(result.error || "unknown")}`,
      );
    }
    return result;
  }
}

function parsePermit(value: unknown): GithubEgressPoolPermit {
  const permit = objectValue(value);
  const permitId = stringValue(permit.permit_id, "permit_id");
  const epoch = positiveInteger(permit.epoch, "epoch");
  const declaredBudget = positiveInteger(permit.declared_budget, "declared_budget");
  const mode = String(permit.mode || "");
  const expiresAt = stringValue(permit.expires_at, "expires_at");
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(permitId)) throw new Error("Invalid pool permit id");
  if (!(["normal", "probe", "ramp"] as string[]).includes(mode)) {
    throw new Error("Invalid pool permit mode");
  }
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("Invalid pool permit expiry");
  return {
    permitId,
    epoch,
    mode: mode as GithubEgressPoolPermit["mode"],
    declaredBudget,
    expiresAt,
  };
}

function parseDeferred(value: Record<string, unknown>): GithubEgressPoolDeferred {
  const provenance = String(value.reset_provenance || "none");
  const blockedUntil = value.blocked_until === null ? null : String(value.blocked_until || "");
  if (!(["none", "retry_after", "rate_limit_reset", "fallback"] as string[]).includes(provenance)) {
    throw new Error("Invalid pool reset provenance");
  }
  if (blockedUntil !== null && !Number.isFinite(Date.parse(blockedUntil))) {
    throw new Error("Invalid pool blocked-until value");
  }
  return {
    granted: false,
    reason: stringValue(value.reason, "reason"),
    epoch: positiveInteger(value.epoch, "epoch"),
    blockedUntil,
    resetProvenance: provenance as GithubEgressPoolDeferred["resetProvenance"],
    resetAuthoritative: value.reset_authoritative === true,
  };
}

function parseState(value: unknown): GithubEgressPoolState {
  const state = objectValue(value);
  const name = String(state.state || "");
  const provenance = String(state.reset_provenance || "none");
  const blockedUntil = state.blocked_until === null ? null : String(state.blocked_until || "");
  if (!(["closed", "open", "half_open", "recovering"] as string[]).includes(name)) {
    throw new Error("Invalid pool state");
  }
  if (!(["none", "retry_after", "rate_limit_reset", "fallback"] as string[]).includes(provenance)) {
    throw new Error("Invalid pool reset provenance");
  }
  if (blockedUntil !== null && !Number.isFinite(Date.parse(blockedUntil))) {
    throw new Error("Invalid pool blocked-until value");
  }
  return {
    state: name as GithubEgressPoolState["state"],
    epoch: positiveInteger(state.epoch, "epoch"),
    blockedUntil,
    resetProvenance: provenance as GithubEgressPoolState["resetProvenance"],
    resetAuthoritative: state.reset_authoritative === true,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub egress pool response object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid pool ${name}`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid pool ${name}`);
  return number;
}
