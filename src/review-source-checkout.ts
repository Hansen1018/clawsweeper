import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const OPENCLAW_REPO = "openclaw/openclaw";
const CODEX_URL = "https://github.com/openai/codex.git";
const SHA_PATTERN = "[0-9a-fA-F]{40}";
const LOCAL_PIN_LEAD =
  /^`?\s*(?:[,;:]\s*)?(?:at\s+|(?:and\s+)?(?:check\s+out|checkout)\s+)(?:the\s+)?exact\s+commit\b/i;
const LOCAL_PIN = new RegExp(
  `${LOCAL_PIN_LEAD.source}\\s+(?:(${SHA_PATTERN})|\\\`(${SHA_PATTERN})\\\`|<(${SHA_PATTERN})>|\\\`<(${SHA_PATTERN})>\\\`)(?=$|[\\s.,;:!?)}\\]\\\`])`,
  "i",
);

export function requestedCodexRevision({
  targetRepo,
  additionalPrompt,
}: {
  targetRepo: string;
  additionalPrompt: string;
}): string | null {
  if (targetRepo.trim().toLowerCase() !== OPENCLAW_REPO) return null;

  const prompt = additionalPrompt.trim();
  const pins: string[] = [];
  let malformedExplicitPin = false;
  const recordPin = (token: string | undefined): void => {
    if (!token || !new RegExp(`^${SHA_PATTERN}$`).test(token)) {
      malformedExplicitPin = true;
      return;
    }
    pins.push(token.toLowerCase());
  };

  const urlLead = /https:\/\/github\.com\/openai\/codex\/(?:blob|commit|tree)\//gi;
  for (const lead of prompt.matchAll(urlLead)) {
    const suffix = prompt.slice(lead.index + lead[0].length);
    recordPin(new RegExp(`^(${SHA_PATTERN})(?=$|[/#>\\s.,;:!?)}\\]\\\`])`, "i").exec(suffix)?.[1]);
  }

  const repoAtLead = /\bopenai\/codex@/gi;
  for (const lead of prompt.matchAll(repoAtLead)) {
    const suffix = prompt.slice(lead.index + lead[0].length);
    recordPin(new RegExp(`^(${SHA_PATTERN})(?=$|[\\s.,;:!?)}\\]\\\`])`, "i").exec(suffix)?.[1]);
  }

  const literalRepo = /\bopenai\/codex\b/gi;
  for (const reference of prompt.matchAll(literalRepo)) {
    const suffix = prompt.slice(reference.index + reference[0].length);
    if (suffix.startsWith("@") || /^\/(?:blob|commit|tree)\//i.test(suffix)) continue;
    if (LOCAL_PIN_LEAD.test(suffix)) {
      const localPin = LOCAL_PIN.exec(suffix);
      recordPin(localPin?.slice(1).find(Boolean));
    }
  }

  if (malformedExplicitPin) {
    throw new Error("An openai/codex source request must name one exact 40-character commit SHA.");
  }
  if (pins.length === 0) return null;
  if (pins.length !== 1) {
    throw new Error("An openai/codex source request must contain exactly one explicit pin.");
  }
  return pins[0] ?? null;
}
export function materializeRequestedReviewSource(options: {
  targetRepo: string;
  targetDir: string;
  additionalPrompt: string;
  sourceUrl?: string;
  allowFetch?: boolean;
}): MaterializedReviewSource | null {
  const revision = requestedCodexRevision(options);
  if (!revision) return null;
  return materializeCodexSource({
    targetDir: options.targetDir,
    revision,
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    ...(options.allowFetch === undefined ? {} : { allowFetch: options.allowFetch }),
  });
}

export function materializeCodexSource({
  targetDir,
  revision,
  sourceUrl = CODEX_URL,
  allowFetch = true,
  runGit = defaultRunGit,
}: {
  targetDir: string;
  revision: string;
  sourceUrl?: string;
  allowFetch?: boolean;
  runGit?: (args: string[], cwd: string) => string;
}): MaterializedReviewSource {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Codex source revision must be an exact lowercase 40-character SHA.");
  }
  const target = resolve(targetDir);
  if (!existsSync(target) || !lstatSync(target).isDirectory()) {
    throw new Error(`Target checkout does not exist: ${target}`);
  }
  const parent = dirname(target);
  const destination = join(parent, "codex");
  if (resolve(destination) === target || basename(target) === "codex") {
    throw new Error("The target checkout cannot occupy the reserved Codex sibling path.");
  }
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) {
      throw new Error("Existing Codex sibling checkout must not be a symbolic link.");
    }
    const head = runGit(["rev-parse", "HEAD"], destination).trim().toLowerCase();
    const indexFlags = runGit(["ls-files", "-v", "-z"], destination)
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry[0]);
    if (indexFlags.some((flag) => flag !== "H")) {
      throw new Error("Existing Codex sibling checkout has unsafe index visibility flags.");
    }
    const status = runGit(
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
      destination,
    ).trim();
    if (head !== revision || status) {
      throw new Error(`Existing Codex sibling checkout does not match ${revision}.`);
    }
    assertCodexCheckout(destination);
    return { destination, reused: true, revision };
  }

  if (!allowFetch) {
    throw new Error(
      `Offline review requires a pre-provisioned exact Codex sibling checkout at ${destination}.`,
    );
  }

  const staging = mkdtempSync(join(parent, ".codex-source-"));
  try {
    runGit(["init", "--quiet"], staging);
    runGit(["remote", "add", "origin", sourceUrl], staging);
    runGit(["fetch", "--quiet", "--depth=1", "--no-tags", "origin", revision], staging);
    runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], staging);
    const head = runGit(["rev-parse", "HEAD"], staging).trim().toLowerCase();
    if (head !== revision) {
      throw new Error(`Codex checkout resolved ${head || "no HEAD"}, expected ${revision}.`);
    }
    if (runGit(["status", "--porcelain"], staging).trim()) {
      throw new Error("Codex source checkout is not clean after materialization.");
    }
    assertCodexCheckout(staging);
    renameSync(staging, destination);
    return { destination, reused: false, revision };
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

type MaterializedReviewSource = {
  destination: string;
  reused: boolean;
  revision: string;
};

function assertCodexCheckout(directory: string): void {
  const agentsPath = join(directory, "AGENTS.md");
  if (!existsSync(agentsPath) || !lstatSync(agentsPath).isFile()) {
    throw new Error("Pinned Codex source checkout is missing its root AGENTS.md.");
  }
  if (!readFileSync(agentsPath, "utf8").trim()) {
    throw new Error("Pinned Codex root AGENTS.md is empty.");
  }
}

function defaultRunGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed (${result.status ?? "unknown"}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}
