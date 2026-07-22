#!/usr/bin/env node

/**
 * Definition: run the repository-owned ClawSweeper automerge E2E harness.
 * Parameters: --scenario, --candidate-root, --output, and --keep are optional.
 * Outputs: proof summaries under test-results/automerge by default. In
 * candidate mode, a known product violation exits non-zero; in reproducer mode,
 * the same exact fingerprint exits zero.
 * Safety: every GitHub-looking token/API path in this harness is backed by a
 * local fake gh binary and local bare remotes; live GitHub mutation is out of
 * scope for this stable-red phase.
 * Decision: external commands fail closed so newly introduced GitHub dependencies
 * cannot silently turn this into a partial integration test.
 */

import path from "node:path";
import { runFlowScenario } from "../../test/e2e/automerge/flow-scenarios.mjs";
import { writeGateInventory } from "../../test/e2e/automerge/gate-inventory.mjs";
import { runModelScenario } from "../../test/e2e/automerge/model-scenarios.mjs";
import { runPublicationScenario } from "../../test/e2e/automerge/publication-scenarios.mjs";
import { AUTOMERGE_E2E_SCENARIOS } from "../../test/e2e/automerge/run.mjs";
import { runRuntimeScenario } from "../../test/e2e/automerge/runtime-scenarios.mjs";
import {
  SCENARIO_IDS,
  scenarioManifest,
  scenariosForSuite,
} from "../../test/e2e/automerge/scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage:
  node scripts/e2e/automerge.mjs [options]

Description:
  Runs the production automerge planner, executor, publisher, applicator, and
  exact-head comment-router merger against stateful GitHub/Codex simulators and
  a real local Git remote.

Options:
  --scenario <name>       Scenario to run; use all for the legacy flow suite
                          (default: happy-path)
  --suite <name>          flow, publication, model, or quick
  --mode <name>           candidate or reproducer (default: candidate)
  --repeat <count>        Repeat each selected scenario deterministically
  --expect <outcome>      success or setup-identity-failure (default: success)
  --list-scenarios        Print supported scenario names
  --candidate-root <dir>  Built ClawSweeper checkout to validate (default: cwd)
  --openclaw-mirror <dir> Read-only OpenClaw checkout for real runtime fixtures
  --output <dir>          Failure and proof artifact root
  --keep                  Keep the temporary scenario workspace
  -h, --help              Show this help

Outputs:
  <output>/<scenario>/summary.json and one stdout/stderr log per production step.
  Candidate mode exits non-zero for a known product violation. Reproducer mode
  exits zero only when the expected red fingerprint is reproduced exactly.

Examples:
  pnpm e2e:automerge
  pnpm e2e:automerge -- --scenario all --output test-results/automerge
  pnpm e2e:automerge -- --scenario publisher-depth1-concurrent-sibling \
    --candidate-root ../clawsweeper-p1 --mode reproducer
  pnpm e2e:automerge -- --scenario openclaw-110725-git-hooks-path \
    --candidate-root ../clawsweeper-3beb5f0 --openclaw-mirror ../openclaw --mode reproducer
  pnpm e2e:automerge -- --scenario ci-regression-29623139111 \
    --candidate-root ../clawsweeper-ci-regression --expect setup-identity-failure
`);
  process.exit(0);
}

if (args.listScenarios) {
  process.stdout.write(`${SCENARIO_IDS.join("\n")}\n`);
  process.exit(0);
}

try {
  const selected = String(args.scenario ?? "happy-path");
  const mode = String(args.mode ?? "candidate");
  if (!["candidate", "reproducer"].includes(mode)) throw new Error(`unsupported mode: ${mode}`);
  if (args.suite && args.scenario) throw new Error("--suite and --scenario are mutually exclusive");
  const repeat = positiveInteger(args.repeat ?? "1", "--repeat");
  const selectedManifests = args.suite
    ? scenariosForSuite(String(args.suite))
    : selected === "all"
      ? AUTOMERGE_E2E_SCENARIOS.map(scenarioManifest)
      : [scenarioManifest(selected)];
  const manifests =
    mode === "reproducer" && args.suite
      ? selectedManifests.filter(({ expectedFingerprint }) => expectedFingerprint)
      : selectedManifests;
  if (manifests.length === 0) {
    throw new Error("reproducer suites require at least one scenario with an expected fingerprint");
  }
  if (args.expect !== undefined && manifests.some(({ kind }) => kind !== "flow")) {
    throw new Error("--expect is supported only for legacy flow scenarios");
  }
  const candidateRoot = path.resolve(String(args.candidateRoot ?? process.cwd()));
  const outputRoot = path.resolve(
    String(args.output ?? path.join(process.cwd(), "test-results", "automerge")),
  );
  const mirrorInput = args.openclawMirror ?? process.env.CLAWSWEEPER_E2E_OPENCLAW_MIRROR;
  if (manifests.some(({ kind }) => kind === "runtime") && !mirrorInput) {
    throw new Error("runtime scenarios require --openclaw-mirror");
  }
  const results = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const attemptOutputRoot =
      repeat === 1
        ? outputRoot
        : path.join(outputRoot, "attempts", String(attempt).padStart(2, "0"));
    for (const manifest of manifests) {
      const common = {
        candidateRoot,
        outputRoot: attemptOutputRoot,
        scenario: manifest.id,
        mode,
      };
      if (manifest.kind === "publication") {
        results.push(runPublicationScenario({ ...common, keep: Boolean(args.keep) }));
      } else if (manifest.kind === "runtime") {
        results.push(
          runRuntimeScenario({
            ...common,
            openclawMirror: path.resolve(String(mirrorInput)),
            keep: Boolean(args.keep),
          }),
        );
      } else if (manifest.kind === "model") {
        results.push(runModelScenario(common));
      } else {
        results.push(
          runFlowScenario({
            ...common,
            expectedOutcome: String(args.expect ?? manifest.legacyExpectedOutcome ?? "success"),
            keep: Boolean(args.keep),
          }),
        );
      }
    }
  }
  const { inventory, file: inventoryFile } = writeGateInventory({ mode, outputRoot, results });
  process.stdout.write(
    `${JSON.stringify(
      results.length > 1 ? { inventory, inventory_file: inventoryFile, results } : results[0],
      null,
      2,
    )}\n`,
  );
  process.exitCode = inventory.gate_exit_code;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--list-scenarios") out.listScenarios = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--scenario") out.scenario = requiredValue(argv, ++index, arg);
    else if (arg === "--suite") out.suite = requiredValue(argv, ++index, arg);
    else if (arg === "--mode") out.mode = requiredValue(argv, ++index, arg);
    else if (arg === "--repeat") out.repeat = requiredValue(argv, ++index, arg);
    else if (arg === "--expect") out.expect = requiredValue(argv, ++index, arg);
    else if (arg === "--candidate-root") out.candidateRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--openclaw-mirror") {
      out.openclawMirror = requiredValue(argv, ++index, arg);
    } else if (arg === "--output") out.output = requiredValue(argv, ++index, arg);
    else throw new Error(`unknown option: ${arg}; use --help for usage`);
  }
  return out;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
