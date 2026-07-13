import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { actionLedgerJson } from "../dist/action-ledger.js";
import { readMutationRecoveries } from "../dist/action-ledger-recovery.js";

test("mutation recovery writers sync content and its directory around the atomic rename", async () => {
  const result = await runInstrumentedWriter("success");

  assert.equal(result.outcome, "success");
  assert.equal(result.targetExists, true);
  assert.deepEqual(result.temporaryEntries, []);
  assert.deepEqual(result.events, [
    "open:root-directory",
    "fsync:root-directory",
    "close:root-directory",
    "open:recovery-parent-directory",
    "fsync:recovery-parent-directory",
    "close:recovery-parent-directory",
    "open:temporary",
    "write:temporary",
    "fsync:temporary",
    "close:temporary",
    "rename",
    "open:directory",
    "fsync:directory",
    "close:directory",
    "cleanup:temporary",
  ]);
});

test("mutation recovery writers do not rename when syncing staged content fails", async () => {
  const result = await runInstrumentedWriter("fail-temporary-fsync");

  assert.equal(result.outcome, "EIO: temporary fsync failed");
  assert.equal(result.targetExists, false);
  assert.deepEqual(result.temporaryEntries, []);
  assert.deepEqual(result.events, [
    "open:root-directory",
    "fsync:root-directory",
    "close:root-directory",
    "open:recovery-parent-directory",
    "fsync:recovery-parent-directory",
    "close:recovery-parent-directory",
    "open:temporary",
    "write:temporary",
    "fsync:temporary",
    "close:temporary",
    "cleanup:temporary",
  ]);
});

test("mutation recovery writers retain the renamed WAL but fail closed when directory sync fails", async () => {
  const result = await runInstrumentedWriter("fail-directory-fsync");

  assert.equal(result.outcome, "EIO: directory fsync failed");
  assert.equal(result.targetExists, true);
  assert.deepEqual(result.temporaryEntries, []);
  assert.deepEqual(result.events, [
    "open:root-directory",
    "fsync:root-directory",
    "close:root-directory",
    "open:recovery-parent-directory",
    "fsync:recovery-parent-directory",
    "close:recovery-parent-directory",
    "open:temporary",
    "write:temporary",
    "fsync:temporary",
    "close:temporary",
    "rename",
    "open:directory",
    "fsync:directory",
    "close:directory",
    "cleanup:temporary",
  ]);
});

test("mutation recovery writers fail before staging when a new family entry is not durable", async () => {
  const result = await runInstrumentedWriter("fail-recovery-parent-directory-fsync");

  assert.equal(result.outcome, "EIO: recovery-parent-directory fsync failed");
  assert.equal(result.targetExists, false);
  assert.deepEqual(result.temporaryEntries, []);
  assert.deepEqual(result.events, [
    "open:root-directory",
    "fsync:root-directory",
    "close:root-directory",
    "open:recovery-parent-directory",
    "fsync:recovery-parent-directory",
    "close:recovery-parent-directory",
  ]);
});

test("mutation recovery writers skip unsupported directory synchronization on Windows", async () => {
  const result = await runInstrumentedWriter("win32");

  assert.equal(result.outcome, "success");
  assert.equal(result.targetExists, true);
  assert.deepEqual(result.temporaryEntries, []);
  assert.deepEqual(result.events, [
    "open:temporary",
    "write:temporary",
    "fsync:temporary",
    "close:temporary",
    "rename",
    "cleanup:temporary",
  ]);
});

test("mutation recovery readers preserve a live writer staging file", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-concurrency-")),
  );
  const readyPath = path.join(root, "writer-ready");
  const releasePath = path.join(root, "writer-release");
  const key = "a".repeat(64);
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "action-ledger-recovery.js"),
  ).href;
  const script = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [root, readyPath, releasePath, key] = process.argv.slice(1);
const originalRenameSync = fs.renameSync;
fs.renameSync = (source, destination) => {
  fs.writeFileSync(readyPath, "ready\\n");
  while (!fs.existsSync(releasePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return originalRenameSync(source, destination);
};
syncBuiltinESMExports();
const { writeMutationRecovery } = await import(${JSON.stringify(moduleUrl)});
writeMutationRecovery(root, "repair", key, { state: "pending" });
`;
  const writer = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, root, readyPath, releasePath, key],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const writerDone = childResult(writer);

  try {
    await waitForPath(readyPath);
    assert.deepEqual(readMutationRecoveries(root, "repair"), []);
    const recoveryDirectory = path.join(root, ".mutation-recovery", "repair");
    assert.equal(
      fs.readdirSync(recoveryDirectory).filter((entry) => entry.endsWith(".tmp")).length,
      1,
    );

    fs.writeFileSync(releasePath, "release\n");
    const result = await writerDone;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const [recovery] = readMutationRecoveries<{ state: string }>(root, "repair");
    assert.equal(recovery?.key, key);
    assert.deepEqual(recovery?.payload, { state: "pending" });
  } finally {
    if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release\n");
    await writerDone;
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("mutation recovery readers preserve live legacy staging files and remove dead writers", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-stale-")),
  );
  const directory = path.join(root, ".mutation-recovery", "repair");
  fs.mkdirSync(directory, { recursive: true });
  const key = "b".repeat(64);
  const staleCurrent = path.join(
    directory,
    `.${key}.2147483647.${"0".repeat(64)}.1.00000000-0000-4000-8000-000000000000.tmp`,
  );
  const liveLegacy = path.join(directory, `.${key}.${process.pid}.1.tmp`);
  const staleLegacy = path.join(directory, `.${key}.2147483647.1.tmp`);
  fs.writeFileSync(staleCurrent, "stale\n");
  fs.writeFileSync(liveLegacy, "live\n");
  fs.writeFileSync(staleLegacy, "stale\n");

  try {
    assert.deepEqual(readMutationRecoveries(root, "repair"), []);
    assert.equal(fs.existsSync(liveLegacy), true);
    assert.equal(fs.existsSync(staleCurrent), false);
    assert.equal(fs.existsSync(staleLegacy), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("mutation recovery readers tolerate a staging file renamed after directory listing", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-rename-")),
  );
  const directory = path.join(root, ".mutation-recovery", "repair");
  fs.mkdirSync(directory, { recursive: true });
  const key = "c".repeat(64);
  const temporary = path.join(directory, `.${key}.${process.pid}.1.tmp`);
  const target = path.join(directory, `${key}.json`);
  const content = `${actionLedgerJson({
    schema: "clawsweeper.action-ledger-mutation-recovery",
    schema_version: 1,
    family: "repair",
    key,
    payload: { state: "pending" },
  })}\n`;
  fs.writeFileSync(temporary, content);
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "action-ledger-recovery.js"),
  ).href;
  const script = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [root, temporary, target, moduleUrl] = process.argv.slice(1);
const originalLstatSync = fs.lstatSync;
let renamed = false;
fs.lstatSync = (filePath, options) => {
  if (!renamed && filePath === temporary) {
    renamed = true;
    fs.renameSync(temporary, target);
  }
  return originalLstatSync(filePath, options);
};
syncBuiltinESMExports();
const { readMutationRecoveries } = await import(moduleUrl);
const first = readMutationRecoveries(root, "repair");
const second = readMutationRecoveries(root, "repair");
process.stdout.write(JSON.stringify({ first, second }));
`;

  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, root, temporary, target, moduleUrl],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = await childResult(child);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.first, []);
    assert.deepEqual(
      parsed.second.map((record: { key: string; payload: unknown }) => ({
        key: record.key,
        payload: record.payload,
      })),
      [{ key, payload: { state: "pending" } }],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

type InstrumentedWriterMode =
  | "success"
  | "fail-temporary-fsync"
  | "fail-directory-fsync"
  | "fail-recovery-parent-directory-fsync"
  | "win32";

type InstrumentedWriterResult = {
  outcome: string;
  events: string[];
  targetExists: boolean;
  temporaryEntries: string[];
};

async function runInstrumentedWriter(
  mode: InstrumentedWriterMode,
): Promise<InstrumentedWriterResult> {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-durability-")),
  );
  const key = "d".repeat(64);
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "action-ledger-recovery.js"),
  ).href;
  const script = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [root, key, moduleUrl, mode] = process.argv.slice(1);
  const directory = path.join(root, ".mutation-recovery", "repair");
  const recoveryParent = path.dirname(directory);
  const target = path.join(directory, \`\${key}.json\`);
  const events = [];
  const descriptorKinds = new Map();
  const directoryKinds = new Map([
    [root, "root-directory"],
    [recoveryParent, "recovery-parent-directory"],
    [directory, "directory"],
  ]);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalFsyncSync = fs.fsyncSync;
const originalCloseSync = fs.closeSync;
const originalRenameSync = fs.renameSync;
const originalRmSync = fs.rmSync;

fs.openSync = (filePath, flags, permissions) => {
  const directoryKind = directoryKinds.get(String(filePath));
  if (directoryKind) {
    const descriptor = originalOpenSync(filePath, flags, permissions);
    descriptorKinds.set(descriptor, directoryKind);
    events.push(\`open:\${directoryKind}\`);
    return descriptor;
  }
  const descriptor = originalOpenSync(filePath, flags, permissions);
  if (String(filePath).endsWith(".tmp")) {
    descriptorKinds.set(descriptor, "temporary");
    events.push("open:temporary");
  }
  return descriptor;
};
fs.writeFileSync = (target, ...args) => {
  if (typeof target === "number" && descriptorKinds.get(target) === "temporary") {
    events.push("write:temporary");
  }
  return originalWriteFileSync(target, ...args);
};
fs.fsyncSync = (descriptor) => {
  const kind = descriptorKinds.get(descriptor);
  if (kind) events.push(\`fsync:\${kind}\`);
  if (mode === \`fail-\${kind}-fsync\`) {
    const error = new Error(\`\${kind} fsync failed\`);
    error.code = "EIO";
    throw error;
  }
  return originalFsyncSync(descriptor);
};
fs.closeSync = (descriptor) => {
  const kind = descriptorKinds.get(descriptor);
  if (kind) events.push(\`close:\${kind}\`);
  descriptorKinds.delete(descriptor);
  return originalCloseSync(descriptor);
};
fs.renameSync = (source, destination) => {
  events.push("rename");
  return originalRenameSync(source, destination);
};
fs.rmSync = (filePath, options) => {
  if (String(filePath).endsWith(".tmp")) events.push("cleanup:temporary");
  return originalRmSync(filePath, options);
};
syncBuiltinESMExports();

if (mode === "win32") {
  const actionLedgerFilesModuleUrl = new URL("./action-ledger-files.js", moduleUrl).href;
  const { processIncarnationIdentitySha256 } = await import(actionLedgerFilesModuleUrl);
  if (!processIncarnationIdentitySha256()) {
    throw new Error("unable to seed process incarnation identity");
  }
  Object.defineProperty(process, "platform", { value: "win32" });
}
const { writeMutationRecovery } = await import(moduleUrl);
let outcome = "success";
try {
  writeMutationRecovery(root, "repair", key, { state: "pending" });
} catch (error) {
  outcome = \`\${error.code ?? "ERROR"}: \${error.message}\`;
}
const temporaryEntries = fs.existsSync(directory)
  ? fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))
  : [];
process.stdout.write(JSON.stringify({
  outcome,
  events,
  targetExists: fs.existsSync(target),
  temporaryEntries,
}));
`;

  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, root, key, moduleUrl, mode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = await childResult(child);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout) as InstrumentedWriterResult;
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

async function waitForPath(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function childResult(
  child: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}
