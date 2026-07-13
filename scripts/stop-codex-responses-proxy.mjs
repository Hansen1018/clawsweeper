#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (isMainModule()) {
  await stopProxy(process.argv[2]);
}

async function stopProxy(serverInfoPath) {
  if (!serverInfoPath) {
    throw new Error("usage: stop-codex-responses-proxy.mjs <server-info-path>");
  }

  const serverInfo = readServerInfo(serverInfoPath);
  if (serverInfo === null) process.exit(0);

  if (!processIsAlive(serverInfo.pid)) {
    removeServerInfo(serverInfoPath);
    process.exit(0);
  }

  const command = processCommand(serverInfo.pid);
  if (!isExpectedProxyCommand(command)) {
    console.warn(
      `Ignoring stale Codex Responses proxy metadata for unrelated process ${serverInfo.pid}.`,
    );
    removeServerInfo(serverInfoPath);
    process.exit(0);
  }

  if (!processOwnsListeningPort(serverInfo.pid, serverInfo.port)) {
    if (!processIsAlive(serverInfo.pid)) {
      removeServerInfo(serverInfoPath);
      process.exit(0);
    }
    throw new Error(
      `Codex Responses proxy process ${serverInfo.pid} does not own listening port ${serverInfo.port}`,
    );
  }

  try {
    await requestShutdown(serverInfo.port);
  } catch (error) {
    if (error?.code !== "ECONNREFUSED") throw error;
  }

  await waitForProxyStop(serverInfo);
  removeServerInfo(serverInfoPath);
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href;
}

function readServerInfo(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw new Error("invalid Codex Responses proxy server-info file");
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error("invalid Codex Responses proxy port");
  }
  if (!Number.isSafeInteger(parsed.pid) || parsed.pid < 1) {
    throw new Error("invalid Codex Responses proxy pid");
  }
  return { pid: parsed.pid, port: parsed.port };
}

function removeServerInfo(filePath) {
  fs.rmSync(filePath, { force: true });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return !processIsZombie(pid);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processIsZombie(pid) {
  if (process.platform === "win32") return false;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const stateOffset = stat.lastIndexOf(")") + 2;
      return stateOffset >= 2 && stat[stateOffset] === "Z";
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "state="], {
      encoding: "utf8",
    })
      .trim()
      .startsWith("Z");
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function processCommand(pid) {
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }
  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (error?.status === 1) return "";
    throw error;
  }
}

function isExpectedProxyCommand(command) {
  const tokens = commandTokens(command);
  const executable = commandBasename(tokens[0]);
  if (isProxyExecutable(executable)) return true;
  if (!["node", "node.exe", "nodejs", "nodejs.exe"].includes(executable)) return false;
  const script = tokens[1] ?? "";
  if (isProxyExecutable(commandBasename(script))) return true;
  const normalizedScript = script.replaceAll("\\", "/").toLowerCase();
  return (
    normalizedScript.includes("/@openai/codex-responses-api-proxy/") &&
    /\/(?:dist\/)?(?:cli|index)\.(?:cjs|js|mjs)$/.test(normalizedScript)
  );
}

export function commandTokens(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && character === "\\" && index + 1 < command.length) {
        token += character + command[index + 1];
        index += 1;
        continue;
      }
      token += character;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (quote !== null) return [];
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function commandBasename(value = "") {
  return value.split(/[/\\]/).at(-1)?.toLowerCase() ?? "";
}

function isProxyExecutable(value) {
  return /^codex-responses-api-proxy(?:\.(?:cjs|exe|js|mjs))?$/.test(value);
}

function processOwnsListeningPort(pid, port) {
  if (process.platform === "linux") return linuxProcessOwnsListeningPort(pid, port);
  if (process.platform === "win32") return windowsProcessOwnsListeningPort(pid, port);
  return lsofProcessOwnsListeningPort(pid, port);
}

function linuxProcessOwnsListeningPort(pid, port) {
  let descriptors;
  try {
    descriptors = fs.readdirSync(`/proc/${pid}/fd`);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const socketInodes = new Set();
  for (const descriptor of descriptors) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) socketInodes.add(match[1]);
    } catch (error) {
      if (!["EACCES", "ENOENT"].includes(error?.code)) throw error;
    }
  }
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = fs.readFileSync(table, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      const localAddress = fields[1] ?? "";
      const state = fields[3] ?? "";
      const inode = fields[9] ?? "";
      if (state === "0A" && localAddress.endsWith(`:${expectedPort}`) && socketInodes.has(inode)) {
        return true;
      }
    }
  }
  return false;
}

function windowsProcessOwnsListeningPort(pid, port) {
  const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return output.split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields.length >= 5 &&
      fields[1]?.endsWith(`:${port}`) &&
      fields[3]?.toUpperCase() === "LISTENING" &&
      fields[4] === String(pid)
    );
  });
}

function lsofProcessOwnsListeningPort(pid, port) {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    );
    return output
      .trim()
      .split(/\s+/)
      .some((value) => value === String(pid));
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function requestShutdown(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/shutdown",
        timeout: 2000,
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 200) {
          reject(
            new Error(`Codex Responses proxy shutdown returned HTTP ${response.statusCode ?? 0}`),
          );
          return;
        }
        response.on("end", resolve);
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Codex Responses proxy shutdown timed out")),
    );
    request.on("error", reject);
  });
}

async function waitForProxyStop({ pid, port }) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    if (!processOwnsListeningPort(pid, port)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!processIsAlive(pid)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Codex Responses proxy process ${pid} did not stop after shutdown`);
}
