import { spawn } from "node:child_process";

import type { ExactReviewBatchMember } from "./exact-review-batch-publisher.js";
import { internalQueueRequestHeaders } from "./exact-review-command-queue.js";
import type { StateWriterTelemetryObserver } from "./state-writer-telemetry-recorder.js";

export function exactReviewBatchStateWriterProgressReporter(input: {
  queueUrl: string;
  webhookSecret: string;
  batchId: string;
  leaseOwner: string;
  items: readonly ExactReviewBatchMember[];
}): StateWriterTelemetryObserver | undefined {
  if (!input.queueUrl.startsWith("https://") || !input.webhookSecret || !input.items.length) {
    return undefined;
  }
  return {
    progress(progress) {
      try {
        const body = JSON.stringify({
          batch_id: input.batchId,
          lease_owner: input.leaseOwner,
          items: input.items.map((item) => ({
            item_key: item.itemKey,
            revision: item.revision,
            claim_generation: item.claimGeneration,
          })),
          state_writer_progress: progress,
        });
        const path = "/internal/exact-review/publication-batches/heartbeat";
        const headers = internalQueueRequestHeaders({
          secret: input.webhookSecret,
          method: "POST",
          path,
          body,
        });
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const [url, headers, body] = process.argv.slice(1);
             const controller = new AbortController();
             setTimeout(() => controller.abort(), 4000).unref();
             fetch(url, { method: "POST", headers: JSON.parse(headers),
               body, signal: controller.signal }).catch(() => {});`,
            `${input.queueUrl.replace(/\/$/, "")}${path}`,
            JSON.stringify(headers),
            body,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.on("error", () => {});
        child.unref();
      } catch {
        // Progress must never alter publication behavior.
      }
    },
  };
}
