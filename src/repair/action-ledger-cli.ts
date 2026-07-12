#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { importActionEventShards } from "../action-ledger-runtime.js";
import {
  finalizeCommandActionLedgerManifest,
  parseCommandActionLedgerManifest,
  serializeCommandActionLedgerManifest,
} from "./command-action-ledger-manifest.js";
import { repoRoot } from "./paths.js";
import {
  createProofActionLedgerArtifact,
  publishProofActionLedgerArtifact,
  type ProofActionLedgerArtifactManifest,
} from "./proof-action-ledger.js";

const rawArgv = process.argv.slice(2);
const [command, ...argv] = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
const args = parseArgs(argv);

if (command === "finalize") {
  const lane = requiredArg(args.lane, "--lane");
  const manifest = await finalizeCommandActionLedgerManifest(lane, {
    allowEmpty: args.allowEmpty === true,
  });
  if (manifest) process.stdout.write(serializeCommandActionLedgerManifest(manifest));
} else if (command === "publish") {
  const lane = requiredArg(args.lane, "--lane");
  const manifestPath = path.resolve(requiredArg(args.manifest, "--manifest"));
  const manifest = parseCommandActionLedgerManifest(fs.readFileSync(manifestPath, "utf8"), lane);
  const sourceRoot = path.resolve(args.sourceRoot ?? actionLedgerOutputRoot());
  const stateRoot = path.resolve(args.stateRoot ?? repoRoot());
  console.log(
    JSON.stringify(
      importActionEventShards(sourceRoot, stateRoot, {
        expectedProducer: {
          repository: manifest.repository,
          sha: manifest.sha,
          workflow: manifest.workflow,
          job: manifest.job,
          runId: manifest.run_id,
          runAttempt: manifest.run_attempt,
        },
        expectedEventPaths: manifest.event_paths,
      }),
      null,
      2,
    ),
  );
} else if (command === "create-proof") {
  const manifest = await createProofActionLedgerArtifact({
    root: requiredPath(args.root, "--root"),
    receiptPath: requiredPath(args.receipt, "--receipt"),
    expectedAuthorizationSha256: requiredArg(args.authorizationSha256, "--authorization-sha256"),
    expectedReceiptSha256: requiredArg(args.receiptSha256, "--receipt-sha256"),
    dispatchKey: args.dispatchKey ?? null,
    ledgerRoot: actionLedgerRoot(),
    outputRoot: actionLedgerOutputRoot(),
  });
  const manifestPath = requiredPath(args.manifest, "--manifest");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ manifest: manifestPath, paths: manifest.paths }, null, 2));
} else if (command === "publish-proof") {
  const manifestPath = requiredPath(args.manifest, "--manifest");
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as ProofActionLedgerArtifactManifest;
  console.log(
    JSON.stringify(
      publishProofActionLedgerArtifact({
        root: requiredPath(args.root, "--root"),
        receiptPath: requiredPath(args.receipt, "--receipt"),
        expectedAuthorizationSha256: requiredArg(
          args.authorizationSha256,
          "--authorization-sha256",
        ),
        expectedReceiptSha256: requiredArg(args.receiptSha256, "--receipt-sha256"),
        dispatchKey: args.dispatchKey ?? null,
        sourceRoot: path.resolve(args.sourceRoot ?? actionLedgerOutputRoot()),
        stateRoot: path.resolve(args.stateRoot ?? repoRoot()),
        manifest,
      }),
      null,
      2,
    ),
  );
} else {
  throw new Error(
    "usage: action-ledger-cli.ts <finalize|publish|create-proof|publish-proof> [--allow-empty] [options]",
  );
}

function actionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function actionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    path.join(actionLedgerRoot(), ".clawsweeper-repair", "action-ledger-state")
  );
}

function parseArgs(argv: readonly string[]) {
  const parsed: {
    lane?: string;
    allowEmpty?: boolean;
    sourceRoot?: string;
    stateRoot?: string;
    root?: string;
    receipt?: string;
    authorizationSha256?: string;
    receiptSha256?: string;
    dispatchKey?: string;
    manifest?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--lane") parsed.lane = requiredValue(argv, ++index, arg);
    else if (arg === "--manifest") parsed.manifest = requiredValue(argv, ++index, arg);
    else if (arg === "--source-root") parsed.sourceRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--allow-empty") parsed.allowEmpty = true;
    else if (arg === "--root") parsed.root = requiredValue(argv, ++index, arg);
    else if (arg === "--receipt") parsed.receipt = requiredValue(argv, ++index, arg);
    else if (arg === "--authorization-sha256")
      parsed.authorizationSha256 = requiredValue(argv, ++index, arg);
    else if (arg === "--receipt-sha256") parsed.receiptSha256 = requiredValue(argv, ++index, arg);
    else if (arg === "--dispatch-key") parsed.dispatchKey = optionalValue(argv, ++index, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredArg(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function requiredPath(value: string | undefined, flag: string): string {
  return path.resolve(requiredArg(value, flag));
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function optionalValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
