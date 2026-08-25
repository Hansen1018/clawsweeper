import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  materializeCodexSource,
  materializeRequestedReviewSource,
  requestedCodexRevision,
} from "../dist/review-source-checkout.js";

const CODEX_REVISION = "f1087ff151b06e781ecb086068d45fcc62d02da3";
const OTHER_REVISION = "0123456789abcdef0123456789abcdef01234567";
const ACTUAL_REVIEW_REQUEST = `The reviewer itself must obtain or clone openai/codex, check out exact commit ${CODEX_REVISION}, and personally inspect codex-rs/core/src/tasks/mod.rs.`;

test("pinned Codex source request accepts only the closed maintainer grammar", () => {
  for (const additionalPrompt of [
    ACTUAL_REVIEW_REQUEST,
    `Inspect openai/codex at exact commit ${CODEX_REVISION}.`,
    `Inspect \`openai/codex\` at exact commit \`${CODEX_REVISION}\`.`,
    `Inspect \`openai/codex\` at exact commit \`<${CODEX_REVISION}>\`.`,
    `Inspect openai/codex@${CODEX_REVISION}.`,
    `Inspect \`openai/codex@${CODEX_REVISION}\`.`,
    `Inspect https://github.com/openai/codex/commit/${CODEX_REVISION}.`,
    `Inspect <https://github.com/openai/codex/commit/${CODEX_REVISION}>.`,
    `Inspect https://github.com/openai/codex/commit/${CODEX_REVISION}#diff-source.`,
    `Inspect https://github.com/openai/codex/tree/${CODEX_REVISION}/codex-rs/core/src/tasks.`,
    `Inspect https://github.com/openai/codex/blob/${CODEX_REVISION}/codex-rs/core/src/tasks/mod.rs.`,
  ]) {
    assert.equal(
      requestedCodexRevision({ targetRepo: "openclaw/openclaw", additionalPrompt }),
      CODEX_REVISION,
    );
  }

  assert.equal(
    requestedCodexRevision({
      targetRepo: "openclaw/openclaw",
      additionalPrompt: "Inspect openai/codex as background.",
    }),
    null,
  );
  assert.equal(
    requestedCodexRevision({
      targetRepo: "openclaw/clawsweeper",
      additionalPrompt: ACTUAL_REVIEW_REQUEST,
    }),
    null,
  );
});

test("malformed explicit Codex pins fail closed", () => {
  for (const additionalPrompt of [
    "Inspect openai/codex at exact commit deadbeef.",
    "Inspect openai/codex at exact commit.",
    "Inspect openai/codex@deadbeef.",
    "Inspect openai/codex@.",
    "Inspect https://github.com/openai/codex/commit/deadbeef.",
    "Inspect https://github.com/openai/codex/tree/.",
  ]) {
    assert.throws(
      () => requestedCodexRevision({ targetRepo: "openclaw/openclaw", additionalPrompt }),
      /must name one exact 40-character commit SHA/,
    );
  }
});

test("multiple explicit Codex pins fail closed", () => {
  for (const additionalPrompt of [
    `Inspect openai/codex at exact commit ${CODEX_REVISION}, then openai/codex@${OTHER_REVISION}.`,
    `Compare https://github.com/openai/codex/commit/${CODEX_REVISION} with https://github.com/openai/codex/tree/${OTHER_REVISION}.`,
    `Inspect openai/codex@${CODEX_REVISION} and openai/codex@${CODEX_REVISION}.`,
  ]) {
    assert.throws(
      () => requestedCodexRevision({ targetRepo: "openclaw/openclaw", additionalPrompt }),
      /must contain exactly one explicit pin/,
    );
  }
});

test("materializer creates a clean exact sibling checkout for the review worker", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-source-"));
  const source = join(root, "source");
  const target = join(root, "openclaw");
  try {
    mkdirSync(source);
    mkdirSync(target);
    assert.throws(
      () =>
        materializeCodexSource({
          targetDir: target,
          revision: "A".repeat(40),
          sourceUrl: source,
        }),
      /exact lowercase 40-character SHA/,
    );
    git(source, "init", "--quiet");
    git(source, "config", "user.email", "clawsweeper@example.com");
    git(source, "config", "user.name", "ClawSweeper Test");
    git(source, "config", "commit.gpgsign", "false");
    writeFileSync(join(source, "AGENTS.md"), "# Codex instructions\n");
    mkdirSync(join(source, "codex-rs", "core", "src"), { recursive: true });
    writeFileSync(join(source, "codex-rs", "core", "src", "lib.rs"), "pub mod tasks;\n");
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "fixture");
    const revision = git(source, "rev-parse", "HEAD").trim();

    const first = materializeCodexSource({ targetDir: target, revision, sourceUrl: source });
    assert.equal(first.destination, join(root, "codex"));
    assert.equal(first.reused, false);
    assert.equal(git(first.destination, "rev-parse", "HEAD").trim(), revision);
    assert.equal(git(first.destination, "status", "--porcelain"), "");
    assert.equal(
      readFileSync(join(first.destination, "codex-rs", "core", "src", "lib.rs"), "utf8"),
      "pub mod tasks;\n",
    );

    const second = materializeCodexSource({ targetDir: target, revision, sourceUrl: source });
    assert.equal(second.reused, true);
    const offlineReuse = materializeCodexSource({
      targetDir: target,
      revision,
      sourceUrl: source,
      allowFetch: false,
    });
    assert.equal(offlineReuse.reused, true);

    const trackedFile = join(first.destination, "codex-rs", "core", "src", "lib.rs");
    git(first.destination, "update-index", "--assume-unchanged", "codex-rs/core/src/lib.rs");
    writeFileSync(trackedFile, "tampered bytes hidden from git status\n");
    assert.equal(git(first.destination, "status", "--porcelain"), "");
    assert.throws(
      () => materializeCodexSource({ targetDir: target, revision, sourceUrl: source }),
      /unsafe index visibility flags/,
    );

    const reviewTree = join(root, "review-trees", "129092");
    mkdirSync(reviewTree, { recursive: true });
    rmSync(first.destination, { force: true, recursive: true });
    const actingReviewer = materializeRequestedReviewSource({
      targetRepo: "openclaw/openclaw",
      targetDir: reviewTree,
      additionalPrompt: `Inspect openai/codex at exact commit ${revision}.`,
      sourceUrl: source,
    });
    assert.equal(actingReviewer?.destination, join(root, "review-trees", "codex"));
    assert.equal(git(actingReviewer?.destination ?? "", "rev-parse", "HEAD").trim(), revision);

    rmSync(actingReviewer?.destination ?? "", { force: true, recursive: true });
    assert.throws(
      () =>
        materializeRequestedReviewSource({
          targetRepo: "openclaw/openclaw",
          targetDir: reviewTree,
          additionalPrompt: `Inspect openai/codex at exact commit ${revision}.`,
          sourceUrl: source,
          allowFetch: false,
        }),
      /Offline review requires a pre-provisioned exact Codex sibling checkout/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the common review runtime materializes requested source in the acting checkout", () => {
  const source = readFileSync("src/clawsweeper-review-command-workflow.ts", "utf8");
  const materialize = source.indexOf("materializeRequestedReviewSource({");
  const runCodex = source.indexOf("decision = runCodex({", materialize);
  assert.ok(materialize > 0, "runtime materializer call");
  assert.ok(runCodex > materialize, "materializer precedes Codex in the common review runtime");
  assert.match(source.slice(materialize, runCodex), /allowFetch: !localRange/);
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
