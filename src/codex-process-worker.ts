import { readFileSync, writeFileSync } from "node:fs";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
  redactCodexText,
} from "./codex-output-capture.js";
import { spawnCodex, terminateCodexProcessTree } from "./codex-spawn.js";

interface WorkerOptions {
  args: string[];
  command: string;
  timeoutMs: number;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  tailBytes: number;
  maxOutputFileBytes: number;
}

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerOptions;
const input = await readWorkerInput();
const stdout = openCodexOutputCapture(options.stdoutPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
  redactValues: input.redactValues,
});
const stderr = openCodexOutputCapture(options.stderrPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
  redactValues: input.redactValues,
});
process.env.CODEX_BIN = options.command;
const child = spawnCodex(options.args, { cwd: process.cwd(), env: process.env });
let spawnError: Error | undefined;
let timeoutError: Error | undefined;
let terminating = false;
let forceKillTimer: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`Codex process timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  forceKillTimer = terminateCodexProcessTree(child);
}, options.timeoutMs);

child.stdout.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stdout, chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stderr, chunk);
});
child.stdin.on("error", () => {});
child.stdin.end(input.prompt);

child.once("error", (error) => {
  spawnError = error;
});
child.once("close", (status, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  clearTimeout(timeout);
  closeCodexOutputCapture(stdout);
  closeCodexOutputCapture(stderr);
  writeFileSync(
    options.resultPath,
    JSON.stringify({
      status,
      signal,
      ...(timeoutError || spawnError
        ? { error: serializedError(timeoutError ?? spawnError!, input.redactValues) }
        : {}),
      stdout: codexOutputTail(stdout),
      stderr: codexOutputTail(stderr),
    }),
    "utf8",
  );
  process.exit(0);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    if (terminating) return;
    terminating = true;
    process.stdin.unpipe(child.stdin);
    child.stdin.end();
    forceKillTimer = terminateCodexProcessTree(child, signal);
  });
}

function serializedError(
  error: Error,
  redactValues: readonly string[],
): {
  message: string;
  code?: string;
} {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    message: redactCodexText(error.message, redactValues),
    ...(typeof code === "string" ? { code } : {}),
  };
}

async function readWorkerInput(): Promise<{ prompt: string; redactValues: string[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    input?: unknown;
    redactValues?: unknown;
  };
  return {
    prompt: typeof value.input === "string" ? value.input : "",
    redactValues: Array.isArray(value.redactValues)
      ? value.redactValues.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}
