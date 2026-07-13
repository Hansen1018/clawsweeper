#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const DEFAULT_GENERATED_PATHS = [
  "records",
  "jobs",
  "results",
  "assets",
  "notifications",
  "apply-report.json",
  "repair-apply-report.json",
];
const APPROVED_GENERATED_PATHS = new Set([...DEFAULT_GENERATED_PATHS, "ledger"]);

type Args = {
  hydratePaths?: string;
  stateDir?: string;
  worktree?: string;
};

const args = parseArgs(process.argv.slice(2));
const stateRoot = path.resolve(
  args.stateDir ?? process.env.CLAWSWEEPER_STATE_DIR ?? "../clawsweeper-state",
);
const worktreeRoot = path.resolve(args.worktree ?? process.cwd());
const generatedPaths = selectedGeneratedPaths(
  args.hydratePaths ?? process.env.CLAWSWEEPER_HYDRATE_PATHS,
);

if (!existsSync(stateRoot)) {
  throw new Error(`State directory does not exist: ${stateRoot}`);
}

if (!generatedPaths.some((relativePath) => existsSync(path.join(stateRoot, relativePath)))) {
  throw new Error(
    `State directory has no generated paths: ${stateRoot}. Check out the generated state branch first, for example: git -C ${stateRoot} switch state`,
  );
}

for (const relativePath of generatedPaths) {
  const source = path.join(stateRoot, relativePath);
  const destination = path.join(worktreeRoot, relativePath);
  rmSync(destination, { force: true, recursive: true });
  if (!existsSync(source)) continue;
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

console.log(JSON.stringify({ hydrated: generatedPaths, source: stateRoot, target: worktreeRoot }));

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") parsed.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--worktree") parsed.worktree = requiredValue(argv, ++index, arg);
    else if (arg === "--hydrate-paths") parsed.hydratePaths = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function selectedGeneratedPaths(input: string | undefined): string[] {
  if (!input?.trim()) return [...DEFAULT_GENERATED_PATHS];

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of input.split(/\r?\n/)) {
    const candidate = rawPath.trim();
    if (!candidate) continue;
    validateGeneratedPath(candidate);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      selected.push(candidate);
    }
  }
  return selected;
}

function validateGeneratedPath(candidate: string): void {
  if (
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    [...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`Unsafe generated hydration path: ${JSON.stringify(candidate)}`);
  }

  const normalized = candidate.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized !== candidate ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments.some((segment) => segment.startsWith("."))
  ) {
    throw new Error(`Unsafe generated hydration path: ${JSON.stringify(candidate)}`);
  }
  if (!APPROVED_GENERATED_PATHS.has(candidate)) {
    throw new Error(`Unknown generated hydration root: ${JSON.stringify(candidate)}`);
  }
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
