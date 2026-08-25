import assert from "node:assert/strict";
import test from "node:test";

import {
  HermitNotificationHttpError,
  isTransientHermitNotificationError,
  postHermitEndorNotification,
  resolveHermitEndorNotificationUrl,
  resolveHermitNotificationConfig,
  type HermitNotificationConfig,
} from "../../dist/repair/hermit-notification.js";

const config: HermitNotificationConfig = {
  endpoint: "https://hermit.example/api/clawsweeper/endor-remediation/reviewed",
  token: "secret",
  timeoutSeconds: 30,
  retryAttempts: 3,
};

test("Hermit delivery retries transient failures with the same structured event", async () => {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const delays: number[] = [];
  const result = await postHermitEndorNotification({
    config,
    idempotencyKey: "event-key",
    notification: { type: "event", value: 1 },
    retryDelaysMs: [1, 4],
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      if (requests.length === 1) return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify({
          ok: true,
          delivered: true,
          duplicate: true,
          messageId: "discord-message-123",
        }),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(result, { messageId: "discord-message-123", duplicate: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(delays, [1]);
  assert.equal(requests[0]?.url, config.endpoint);
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret");
  assert.equal(requests[0]?.headers.get("idempotency-key"), "event-key");
  assert.equal(requests[0]?.body, requests[1]?.body);
});

test("Hermit delivery does not retry permanent failures or invalid receipts", async () => {
  let permanentCalls = 0;
  await assert.rejects(
    postHermitEndorNotification({
      config,
      idempotencyKey: "event-key",
      notification: { type: "event" },
      sleep: async () => undefined,
      fetcher: async () => {
        permanentCalls += 1;
        return new Response("unauthorized", { status: 401 });
      },
    }),
    /Hermit notification returned 401/,
  );
  assert.equal(permanentCalls, 1);

  await assert.rejects(
    postHermitEndorNotification({
      config: { ...config, retryAttempts: 1 },
      idempotencyKey: "event-key",
      notification: { type: "event" },
      fetcher: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
    /invalid Endor notification receipt/,
  );
});

test("Hermit configuration resolves the fixed Endor route", () => {
  assert.deepEqual(
    resolveHermitNotificationConfig({
      CLAWSWEEPER_HERMIT_URL: "https://hermit.example/some/old/path?unused=1",
      CLAWSWEEPER_HERMIT_TOKEN: " secret ",
      CLAWSWEEPER_HERMIT_TIMEOUT_SECONDS: "45",
      CLAWSWEEPER_HERMIT_RETRY_ATTEMPTS: "4",
    }),
    {
      endpoint: "https://hermit.example/api/clawsweeper/endor-remediation/reviewed",
      token: "secret",
      timeoutSeconds: 45,
      retryAttempts: 4,
    },
  );
  assert.equal(resolveHermitNotificationConfig({}), null);
  assert.equal(
    resolveHermitEndorNotificationUrl("https://hermit.example"),
    "https://hermit.example/api/clawsweeper/endor-remediation/reviewed",
  );
  assert.throws(() => resolveHermitEndorNotificationUrl("file:///tmp/hermit"), /HTTP or HTTPS/);
});

test("Hermit transient classification covers retryable HTTP and network failures", () => {
  assert.equal(
    isTransientHermitNotificationError(new HermitNotificationHttpError(502, "bad")),
    true,
  );
  assert.equal(
    isTransientHermitNotificationError(new HermitNotificationHttpError(409, "bad")),
    false,
  );
  assert.equal(isTransientHermitNotificationError(new Error("read ECONNRESET")), true);
});
