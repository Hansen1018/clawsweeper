#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";

const serverInfoPath = process.argv[2];
if (!serverInfoPath) {
  throw new Error("usage: stop-codex-responses-proxy.mjs <server-info-path>");
}

let port = null;
try {
  const stat = fs.lstatSync(serverInfoPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw new Error("invalid Codex Responses proxy server-info file");
  }
  const parsed = JSON.parse(fs.readFileSync(serverInfoPath, "utf8"));
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error("invalid Codex Responses proxy port");
  }
  port = parsed.port;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
} finally {
  fs.rmSync(serverInfoPath, { force: true });
}

if (port === null) process.exit(0);

await new Promise((resolve, reject) => {
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
  request.on("error", (error) => {
    if (error?.code === "ECONNREFUSED") resolve();
    else reject(error);
  });
});
