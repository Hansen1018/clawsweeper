import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "../dist/codex-output-capture.js";

test("Codex output redaction spans stream chunk boundaries before persistence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-redaction-"));
  const outputPath = path.join(root, "codex.jsonl");
  const secret = "runtime-token-123456";
  const capture = openCodexOutputCapture(outputPath, {
    redactValues: [secret],
    tailBytes: 1024,
  });

  try {
    appendCodexOutputCapture(capture, Buffer.from(`before ${secret.slice(0, 9)}`));
    appendCodexOutputCapture(capture, Buffer.from(`${secret.slice(9)} after\n`));
    closeCodexOutputCapture(capture);

    assert.equal(fs.readFileSync(outputPath, "utf8"), "before [REDACTED] after\n");
    assert.equal(codexOutputTail(capture), "before [REDACTED] after\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex output redaction prefers the longest value and flushes partial suffixes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-redaction-overlap-"));
  const outputPath = path.join(root, "codex.log");
  const capture = openCodexOutputCapture(outputPath, {
    redactValues: ["secret-value", "secret"],
    tailBytes: 1024,
  });

  try {
    appendCodexOutputCapture(capture, Buffer.from("secret-value then sec"));
    appendCodexOutputCapture(capture, Buffer.from("ret and harmless-sec"));
    closeCodexOutputCapture(capture);

    assert.equal(
      fs.readFileSync(outputPath, "utf8"),
      "[REDACTED] then [REDACTED] and harmless-sec",
    );
    assert.equal(codexOutputTail(capture), "[REDACTED] then [REDACTED] and harmless-sec");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
