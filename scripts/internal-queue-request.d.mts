export const INTERNAL_QUEUE_PROTOCOL_VERSION: "1";
export const INTERNAL_QUEUE_REQUEST_TIMEOUT_MS: 8000;

export function internalQueueRequestHeaders(options: {
  secret: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  body: string;
  timestampSeconds?: number;
}): Record<string, string>;

export function signedInternalQueueRequest(options: {
  baseUrl: string;
  path: string;
  secret: string;
  body?: string;
  method?: "GET" | "POST" | "PUT";
  timeoutMs?: number;
  timestampSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<Response>;
