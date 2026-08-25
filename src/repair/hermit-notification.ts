import { isJsonObject } from "./json-types.js";
import { normalizeString, positiveInt, stringOrNull } from "./openclaw-hook.js";

export type HermitNotificationConfig = {
  endpoint: string;
  token: string;
  timeoutSeconds: number;
  retryAttempts: number;
};

export type HermitNotificationResult = {
  messageId: string;
  duplicate: boolean;
};

const ENDOR_NOTIFICATION_PATH = "/api/clawsweeper/endor-remediation/reviewed";
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];

export function resolveHermitNotificationConfig(
  env: NodeJS.ProcessEnv,
): HermitNotificationConfig | null {
  const url = normalizeString(env.CLAWSWEEPER_HERMIT_URL);
  const token = normalizeString(env.CLAWSWEEPER_HERMIT_TOKEN);
  if (!url || !token) return null;
  return {
    endpoint: resolveHermitEndorNotificationUrl(url),
    token,
    timeoutSeconds: positiveInt(env.CLAWSWEEPER_HERMIT_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    retryAttempts: positiveInt(env.CLAWSWEEPER_HERMIT_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS),
  };
}

export function resolveHermitEndorNotificationUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Hermit URL must use HTTP or HTTPS");
  }
  url.pathname = ENDOR_NOTIFICATION_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function postHermitEndorNotification({
  config,
  fetcher,
  notification,
  idempotencyKey,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = delay,
}: {
  config: HermitNotificationConfig;
  fetcher: typeof fetch;
  notification: object;
  idempotencyKey: string;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<HermitNotificationResult> {
  const attempts = Math.max(1, Math.floor(config.retryAttempts));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postHermitEndorNotificationOnce({
        config,
        fetcher,
        notification,
        idempotencyKey,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientHermitNotificationError(error)) {
        throw error;
      }
      await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function postHermitEndorNotificationOnce({
  config,
  fetcher,
  notification,
  idempotencyKey,
}: {
  config: HermitNotificationConfig;
  fetcher: typeof fetch;
  notification: object;
  idempotencyKey: string;
}): Promise<HermitNotificationResult> {
  const response = await fetcher(config.endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(notification),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new HermitNotificationHttpError(response.status, body);
  }
  const parsed = parseHermitNotificationResult(body);
  if (!parsed) {
    throw new Error("Hermit returned an invalid Endor notification receipt");
  }
  return parsed;
}

export class HermitNotificationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Hermit notification returned ${status}: ${body.slice(0, 500)}`);
  }
}

export function isTransientHermitNotificationError(error: unknown): boolean {
  if (error instanceof HermitNotificationHttpError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed)\b/i.test(
    error.message,
  );
}

function parseHermitNotificationResult(body: string): HermitNotificationResult | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isJsonObject(parsed) || parsed.delivered !== true) return null;
    const messageId = stringOrNull(parsed.messageId);
    if (!messageId) return null;
    return { messageId, duplicate: parsed.duplicate === true };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
