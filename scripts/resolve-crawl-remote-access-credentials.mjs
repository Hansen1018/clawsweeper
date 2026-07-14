#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function resolveCrawlRemoteAccessCredentials(environment) {
  const marker = String(environment.CRAWL_REMOTE_ACCESS_CREDENTIAL_GENERATION ?? "");
  const match = /^v1:(blue|green):[0-9a-f]{64}$/.exec(marker);
  if (!match) {
    throw new Error("crawl-remote Access credential generation marker is invalid");
  }
  const slot = match[1];
  const prefix = `CRAWL_REMOTE_ACCESS_${slot.toUpperCase()}`;
  const clientId = requiredSingleLineValue(
    environment[`${prefix}_CLIENT_ID`],
    `${prefix}_CLIENT_ID`,
  );
  const clientSecret = requiredSingleLineValue(
    environment[`${prefix}_CLIENT_SECRET`],
    `${prefix}_CLIENT_SECRET`,
  );
  return { slot, clientId, clientSecret };
}

function requiredSingleLineValue(value, name) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
  return value;
}

function writeGitHubOutputs(path, credentials) {
  const outputPath = requiredSingleLineValue(path, "GITHUB_OUTPUT");
  appendFileSync(
    outputPath,
    `client_id=${credentials.clientId}\n` + `client_secret=${credentials.clientSecret}\n`,
    "utf8",
  );
}

function main() {
  const credentials = resolveCrawlRemoteAccessCredentials(process.env);
  writeGitHubOutputs(process.env.GITHUB_OUTPUT, credentials);
  console.log(`selected crawl-remote Access ${credentials.slot} credential generation`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
