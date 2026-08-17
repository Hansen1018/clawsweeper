import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentRunner,
  codexAgentArgs,
  runAgentCheckoutInspection,
  runAgentProcess,
} from "../dist/agent-runner.js";

function writeFakeOpenClawCheckoutInspector(binary: string): void {
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = fs.readFileSync(process.argv[process.argv.indexOf("--message-file") + 1], "utf8");
const relativePath = JSON.parse(prompt.match(/^Path: (.+)$/m)[1]);
const lineNumber = Number(prompt.match(/^Return exactly line (\\d+)/m)[1]);
const challenged = fs.readFileSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR, relativePath), "utf8").split(/\\r?\\n/)[lineNumber - 1].trim();
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
const sessionFile = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions", sessionId + ".jsonl");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (process.env.OPENCLAW_TEST_NO_RECEIPT !== "1") {
  const toolCallId = "read-checkout";
  const readPath = process.env.OPENCLAW_TEST_DIFFERENT_PATH === "1" ? "different.txt" : relativePath;
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: readPath } }] } },
    { type: "message", message: { role: "toolResult", toolCallId, toolName: "read", isError: false, content: [{ type: "text", text: challenged }] } },
  ];
  fs.writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
}
process.stdout.write(JSON.stringify({
  payloads: [{ text: challenged }],
  meta: { stopReason: "stop" },
}));
`,
  );
  chmodSync(binary, 0o755);
}

function populateSyntheticTrackedIndex(
  root: string,
  { count, pathPadding = "" }: { count: number; pathPadding?: string },
): string {
  const trackedPath = join(root, "tracked.txt");
  writeFileSync(trackedPath, "tracked checkout content for a large repository\n");
  const blob = execFileSync("git", ["hash-object", "-w", "tracked.txt"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const indexEntries = [
    `100644 ${blob}\ttracked.txt\0`,
    ...Array.from(
      { length: count },
      (_, index) =>
        `100644 ${blob}\tbulk/${String(index).padStart(5, "0")}-${pathPadding}tracked-checkout-challenge-candidate.txt\0`,
    ),
  ].join("");
  execFileSync("git", ["update-index", "-z", "--index-info"], {
    cwd: root,
    input: indexEntries,
  });
  return trackedPath;
}

test("agent runner defaults to Codex and fails closed on unknown values", () => {
  assert.equal(agentRunner({}), "codex");
  assert.equal(agentRunner({ CLAWSWEEPER_RUNNER: "codex" }), "codex");
  assert.equal(agentRunner({ CLAWSWEEPER_RUNNER: "openclaw" }), "openclaw");
  assert.throws(
    () => agentRunner({ CLAWSWEEPER_RUNNER: "claude" }),
    /Invalid CLAWSWEEPER_RUNNER.*codex.*openclaw/,
  );
});

test("agent runner preserves review-style Codex argument composition", () => {
  assert.deepEqual(
    codexAgentArgs({
      label: "review-42",
      prompt: "review",
      model: "gpt-public",
      reasoningEffort: "high",
      cwd: "/tmp",
      env: {},
      timeoutMs: 1_000,
      codexExtraArgs: [
        "-c",
        'forced_login_method="api"',
        "-c",
        'approval_policy="never"',
        "-C",
        "/target",
        "--output-schema",
        "/schema.json",
        "--output-last-message",
        "/answer.json",
        "--json",
        "-",
      ],
    }),
    [
      "exec",
      "--model",
      "gpt-public",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'forced_login_method="api"',
      "-c",
      'approval_policy="never"',
      "-C",
      "/target",
      "--output-schema",
      "/schema.json",
      "--output-last-message",
      "/answer.json",
      "--json",
      "-",
    ],
  );
});

test("agent runner preserves ordered repair-worker Codex arguments", () => {
  const ordered = [
    "--cd",
    "/target",
    "--model",
    "gpt-public",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    'model_reasoning_effort="high"',
    "--json",
    "-",
  ];
  assert.deepEqual(
    codexAgentArgs({
      label: "repair",
      prompt: "repair",
      model: "gpt-public",
      reasoningEffort: "high",
      cwd: "/target",
      env: {},
      timeoutMs: 1_000,
      codexExtraArgs: ordered,
    }),
    ["exec", ...ordered],
  );
});

test("runAgentProcess delegates the default path to Codex with unchanged argv and stdin", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-test-"));
  const binary = join(root, "fake-codex");
  const argsPath = join(root, "args.json");
  const promptPath = join(root, "prompt.txt");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.AGENT_RUNNER_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.AGENT_RUNNER_PROMPT_PATH, fs.readFileSync(0, "utf8"));
process.stdout.write("ok");
`,
  );
  chmodSync(binary, 0o755);
  try {
    const result = runAgentProcess({
      label: "default-codex",
      prompt: "prompt over stdin",
      model: "internal",
      reasoningEffort: "low",
      cwd: root,
      env: {
        ...process.env,
        CODEX_BIN: binary,
        AGENT_RUNNER_ARGS_PATH: argsPath,
        AGENT_RUNNER_PROMPT_PATH: promptPath,
      },
      timeoutMs: 10_000,
      codexExtraArgs: ["--sandbox", "read-only", "-"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
      "exec",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "read-only",
      "-",
    ]);
    assert.equal(readFileSync(promptPath, "utf8"), "prompt over stdin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw runner requires a provider/model override", () => {
  assert.throws(
    () =>
      runAgentProcess({
        label: "missing-model",
        prompt: "prompt",
        model: "internal",
        cwd: process.cwd(),
        env: { CLAWSWEEPER_RUNNER: "openclaw" },
        timeoutMs: 1_000,
      }),
    /CLAWSWEEPER_OPENCLAW_MODEL is required/,
  );
});

test("OpenClaw checkout inspection attests the exact tracked path without checkout writes", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-test-"));
  const binary = join(root, "fake-openclaw");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const trackedPath = join(root, "tracked.txt");
  writeFileSync(trackedPath, "first line\ntracked checkout content\nlast line\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "tracked text",
    ],
    { cwd: root },
  );
  writeFakeOpenClawCheckoutInspector(binary);
  const baseEnv = {
    ...process.env,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
    CLAWSWEEPER_OPENCLAW_BIN: binary,
  };
  try {
    chmodSync(trackedPath, 0o444);
    chmodSync(root, 0o555);
    const verified = runAgentCheckoutInspection({ cwd: root, env: baseEnv, timeoutMs: 10_000 });
    assert.equal(verified.status, 0, verified.error?.message);

    const wrongPath = runAgentCheckoutInspection({
      cwd: root,
      env: { ...baseEnv, OPENCLAW_TEST_DIFFERENT_PATH: "1" },
      timeoutMs: 10_000,
    });
    assert.equal(wrongPath.status, 1);
    assert.match(wrongPath.error?.message ?? "", /exact challenged path/);

    const missingReceipt = runAgentCheckoutInspection({
      cwd: root,
      env: { ...baseEnv, OPENCLAW_TEST_NO_RECEIPT: "1" },
      timeoutMs: 10_000,
    });
    assert.equal(missingReceipt.status, 1);
    assert.match(missingReceipt.error?.message ?? "", /exact challenged path/);
  } finally {
    chmodSync(root, 0o755);
    chmodSync(trackedPath, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw checkout inspection supports an OpenClaw-sized tracked index", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-large-index-test-"));
  const binary = join(root, "fake-openclaw");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const trackedPath = populateSyntheticTrackedIndex(root, { count: 30_000 });
  writeFakeOpenClawCheckoutInspector(binary);
  const env = {
    ...process.env,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
    CLAWSWEEPER_OPENCLAW_BIN: binary,
  };
  try {
    const listingBytes = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    }).byteLength;
    assert.ok(listingBytes >= 2_878_984, `expected an OpenClaw-sized listing, got ${listingBytes}`);

    chmodSync(trackedPath, 0o444);
    chmodSync(root, 0o555);
    const result = runAgentCheckoutInspection({ cwd: root, env, timeoutMs: 10_000 });
    assert.equal(result.status, 0, result.error?.message);
  } finally {
    chmodSync(root, 0o755);
    chmodSync(trackedPath, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw checkout inspection fails closed when the tracked index exceeds its bound", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-bounded-index-test-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  populateSyntheticTrackedIndex(root, { count: 10_000, pathPadding: "x".repeat(800) });
  try {
    const listingBytes = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    }).byteLength;
    assert.ok(listingBytes > 8 * 1024 * 1024, `expected listing >8 MiB, got ${listingBytes}`);

    const result = runAgentCheckoutInspection({
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_RUNNER: "openclaw",
        CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
        CLAWSWEEPER_OPENCLAW_BIN: join(root, "must-not-run"),
      },
      timeoutMs: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.error?.message ?? "", /tracked-file index exceeded the 8 MiB limit/);
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ENOBUFS");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw checkout inspection reports challenge setup failures", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-missing-test-"));
  const env = {
    ...process.env,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
  };
  try {
    const notRepository = runAgentCheckoutInspection({ cwd: root, env, timeoutMs: 10_000 });
    assert.equal(notRepository.status, 128);
    assert.equal(notRepository.error, undefined);
    assert.match(notRepository.stderr, /not a git repository/);

    const result = runAgentCheckoutInspection({
      cwd: join(root, "missing"),
      env,
      timeoutMs: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.error?.message ?? "", /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
