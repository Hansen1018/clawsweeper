import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { commandTokens } from "../../scripts/stop-codex-responses-proxy.mjs";

const stopScript = path.resolve("scripts/stop-codex-responses-proxy.mjs");

test("proxy command tokenizer preserves quoted executable paths and rejects malformed input", () => {
  assert.deepEqual(
    commandTokens('node "C:\\Program Files\\codex-responses-api-proxy\\cli.js" --port 1234'),
    ["node", "C:\\Program Files\\codex-responses-api-proxy\\cli.js", "--port", "1234"],
  );
  assert.deepEqual(commandTokens("node '/tmp/proxy cli.js' --port 1234"), [
    "node",
    "/tmp/proxy cli.js",
    "--port",
    "1234",
  ]);
  assert.deepEqual(commandTokens(`"${String.raw`\!`.repeat(32)}`), []);
});

test("proxy command tokenizer handles adversarial quoted input in linear time", () => {
  const source = [
    `import { commandTokens } from ${JSON.stringify(pathToFileURL(stopScript).href)};`,
    `const input = '"' + (String.fromCharCode(92) + "!").repeat(250_000);`,
    "if (commandTokens(input).length !== 0) process.exit(2);",
  ].join("\n");
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 3_000,
  });
  assert.equal(probe.status, 0, probe.error?.message ?? probe.stderr);
});

test("proxy shutdown verifies the expected process and listener before removing metadata", () => {
  const fixture = proxyFixture({ closeOnShutdown: true });
  try {
    const stopped = spawnSync(process.execPath, [stopScript, fixture.infoPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(fs.existsSync(fixture.hitPath), true);
    assert.equal(fs.existsSync(fixture.infoPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("stale proxy metadata never sends shutdown to an unrelated listener", () => {
  const fixture = serverFixture("unrelated-listener.mjs", { closeOnShutdown: false });
  try {
    fs.writeFileSync(
      fixture.infoPath,
      `${JSON.stringify({ pid: fixture.child.pid, port: fixture.port })}\n`,
    );
    const stopped = spawnSync(process.execPath, [stopScript, fixture.infoPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(fs.existsSync(fixture.hitPath), false);
    assert.equal(fs.existsSync(fixture.infoPath), false);
    assert.equal(processIsAlive(fixture.child.pid!), true);
  } finally {
    fixture.cleanup();
  }
});

test("proxy identity ignores matching text in unrelated process arguments", () => {
  const fixture = serverFixture("unrelated-listener.mjs", {
    args: ["codex-responses-api-proxy"],
    closeOnShutdown: false,
  });
  try {
    const stopped = spawnSync(process.execPath, [stopScript, fixture.infoPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(fs.existsSync(fixture.hitPath), false);
    assert.equal(fs.existsSync(fixture.infoPath), false);
    assert.equal(processIsAlive(fixture.child.pid!), true);
  } finally {
    fixture.cleanup();
  }
});

test("proxy metadata with a mismatched listener fails closed and remains available", () => {
  const proxy = proxyFixture({ closeOnShutdown: false });
  const unrelated = serverFixture("unrelated-listener.mjs", { closeOnShutdown: false });
  try {
    fs.writeFileSync(
      proxy.infoPath,
      `${JSON.stringify({ pid: proxy.child.pid, port: unrelated.port })}\n`,
    );
    const stopped = spawnSync(process.execPath, [stopScript, proxy.infoPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(stopped.status, 0);
    assert.match(stopped.stderr, /does not own listening port/);
    assert.equal(fs.existsSync(unrelated.hitPath), false);
    assert.equal(fs.existsSync(proxy.infoPath), true);
  } finally {
    proxy.cleanup();
    unrelated.cleanup();
  }
});

test("proxy metadata is retained when shutdown does not stop the expected process", () => {
  const fixture = proxyFixture({ closeOnShutdown: false });
  try {
    const stopped = spawnSync(process.execPath, [stopScript, fixture.infoPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(stopped.status, 0);
    assert.match(stopped.stderr, /did not stop after shutdown/);
    assert.equal(fs.existsSync(fixture.hitPath), true);
    assert.equal(fs.existsSync(fixture.infoPath), true);
  } finally {
    fixture.cleanup();
  }
});

test("dead proxy metadata is removed without contacting its stale port", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-proxy-dead-"));
  const infoPath = path.join(root, "responses-proxy.json");
  fs.writeFileSync(infoPath, '{"pid":999999999,"port":1}\n');
  try {
    const stopped = spawnSync(process.execPath, [stopScript, infoPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(fs.existsSync(infoPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function proxyFixture({ closeOnShutdown }: { closeOnShutdown: boolean }) {
  return serverFixture("node_modules/@openai/codex-responses-api-proxy/dist/cli.js", {
    closeOnShutdown,
  });
}

function serverFixture(
  scriptName: string,
  {
    args = [],
    closeOnShutdown,
  }: {
    args?: string[];
    closeOnShutdown: boolean;
  },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-proxy-stop-"));
  const infoPath = path.join(root, "responses-proxy.json");
  const portPath = path.join(root, "port");
  const hitPath = path.join(root, "shutdown-hit");
  const scriptPath = path.join(root, scriptName);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
import http from "node:http";
const server = http.createServer((request, response) => {
  if (request.url !== "/shutdown") {
    response.writeHead(404);
    response.end();
    return;
  }
  fs.writeFileSync(${JSON.stringify(hitPath)}, "hit");
  response.end("ok");
  if (${JSON.stringify(closeOnShutdown)}) {
    server.close();
    setTimeout(() => process.exit(0), 20);
  }
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port));
});
`,
  );
  const child = spawn(process.execPath, [scriptPath, ...args], { stdio: "ignore" });
  waitForFile(portPath);
  const port = Number(fs.readFileSync(portPath, "utf8"));
  fs.writeFileSync(infoPath, `${JSON.stringify({ pid: child.pid, port })}\n`);
  return {
    child,
    hitPath,
    infoPath,
    port,
    cleanup() {
      if (processIsAlive(child.pid!)) child.kill("SIGTERM");
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function waitForFile(filePath: string) {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
