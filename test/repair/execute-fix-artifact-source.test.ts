import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("no-op automerge repair updates outcome and re-enters router before exit", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const noPlannedBranch = source.match(
    /if \(plannedFixActions\.length === 0\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;

  assert.ok(noPlannedBranch, "expected no planned fix actions branch");
  assert.match(noPlannedBranch, /report\.reason = "no planned fix actions";/);

  const continuationIndex = noPlannedBranch.indexOf(
    "appendAutomergeRepairOutcomeComment(report, resultPath);",
  );
  const writeReportIndex = noPlannedBranch.indexOf("writeReport(report, resultPath);");
  const exitIndex = noPlannedBranch.indexOf("process.exit(0);");

  assert.notEqual(continuationIndex, -1);
  assert.notEqual(writeReportIndex, -1);
  assert.notEqual(exitIndex, -1);
  assert.ok(
    continuationIndex < writeReportIndex && writeReportIndex < exitIndex,
    "no-op repair must update automerge continuation before writing the terminal report and exiting",
  );
});

test("repair source branch writability preflight runs before expensive repair preflights", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const branchPreflightIndex = source.indexOf(
    "const sourceBranchPreflight = preflightRepairSourceBranchWrite(fixArtifact);",
  );
  const checkoutIndex = source.indexOf("ensureTargetCheckout(result.repo, targetDir);");
  const validationIndex = source.indexOf("preflightTargetValidationPlan(");
  const codexPreflightIndex = source.indexOf("const writePreflight = runCodexWritePreflight();");

  assert.notEqual(branchPreflightIndex, -1);
  assert.notEqual(checkoutIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.notEqual(codexPreflightIndex, -1);
  assert.ok(
    branchPreflightIndex < checkoutIndex &&
      checkoutIndex < validationIndex &&
      validationIndex < codexPreflightIndex,
    "live source-branch writability must be resolved before checkout, validation planning, and Codex write preflight",
  );
});

test("merged source replacement skip runs before publishing replacement PRs", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const preparedStart = source.indexOf("function openReplacementPrFromPreparedRepairCheckout(");
  const preparedEnd = source.indexOf("function executeReplacementBranch(", preparedStart);
  assert.notEqual(preparedStart, -1);
  assert.notEqual(preparedEnd, -1);
  const preparedReplacement = source.slice(preparedStart, preparedEnd);
  assert.match(
    preparedReplacement,
    /mergedReplacementSourcePr\(\{ fixArtifact, sourcePr, targetDir \}\)/,
  );
  assert.match(preparedReplacement, /skipMergedSourceReplacementWithoutDiff\(\{/);

  const preparedSkipIndex = preparedReplacement.indexOf("skipMergedSourceReplacementWithoutDiff({");
  const preparedPushIndex = preparedReplacement.indexOf(
    "pushRecoverableBranch({ targetDir, branch });",
  );
  const preparedCreateIndex = preparedReplacement.indexOf('"pr",\n        "create"');
  assert.notEqual(preparedSkipIndex, -1);
  assert.notEqual(preparedPushIndex, -1);
  assert.notEqual(preparedCreateIndex, -1);
  assert.ok(
    preparedSkipIndex < preparedPushIndex && preparedPushIndex < preparedCreateIndex,
    "merged-source no-diff replacement skip must run before branch push and PR creation",
  );

  const helperStart = source.indexOf("function skipMergedSourceReplacementWithoutDiff(");
  const helperEnd = source.indexOf("function labelReplacementPullRequest(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(!mergedSource\) return null;/);
  assert.match(helper, /if \(branchHasBaseDiff\(\{ targetDir, baseBranch \}\)\) return null;/);
  assert.match(
    helper,
    /reason: "source PR already merged and replacement branch has no changes versus base"/,
  );
});

test("superseded source closeout requires replacement proof before gh pr close", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const helperStart = source.indexOf("function closeSupersededSourcePr(");
  assert.notEqual(helperStart, -1);
  const helper = source.slice(helperStart);

  const proofIndex = helper.indexOf("replacementCloseoutProofAllowsClose({");
  const linkIndex = helper.indexOf("linkReplacementSourcePr({");
  const closeIndex = helper.indexOf('"pr", "close"');
  assert.notEqual(proofIndex, -1);
  assert.notEqual(linkIndex, -1);
  assert.notEqual(closeIndex, -1);
  assert.ok(
    proofIndex < closeIndex && linkIndex < closeIndex,
    "source PRs must pass replacement proof checks before gh pr close can run",
  );
});

test("superseded source closeout uses general proof instead of patch-line matching", () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), "prompts/repair/replacement-closeout-proof.md"),
    "utf8",
  );
  assert.match(prompt, /Compare the useful work generally/);
  assert.match(prompt, /Do not require exact patch-line equality/);

  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("function replacementCloseoutProofAllowsClose(");
  const helperEnd = source.indexOf("function linkReplacementSourcePr(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  const sharedProofSource = fs.readFileSync(
    path.join(process.cwd(), "src/supersession-proof.ts"),
    "utf8",
  );

  assert.match(helper, /replacementCloseoutProofPromptPath/);
  assert.match(helper, /compactSupersessionProofView/);
  assert.match(helper, /reviews: sourceView\.reviews/);
  assert.match(helper, /reviewComments: sourceView\.reviewComments/);
  assert.match(sharedProofSource, /export function proofBodyExcerpt/);
  assert.doesNotMatch(helper, /patchSignature/);
});

test("replacement closeout proof uses a read-only Codex sandbox", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("function replacementCloseoutProofAllowsClose(");
  const helperEnd = source.indexOf("function linkReplacementSourcePr(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(source, /const replacementCloseoutProofSandbox = "read-only"/);
  assert.match(helper, /"--sandbox",\s*replacementCloseoutProofSandbox/);
  assert.doesNotMatch(helper, /"--sandbox",\s*codexReviewSandbox/);
});

test("replacement closeout proof accepts written output after nonzero Codex exit", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("function replacementCloseoutProofAllowsClose(");
  const helperEnd = source.indexOf("function linkReplacementSourcePr(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  const statusIndex = helper.indexOf("if (child.status !== 0)");
  const missingOutputIndex = helper.indexOf("if (!fs.existsSync(outputPath))");
  assert.notEqual(statusIndex, -1);
  assert.notEqual(missingOutputIndex, -1);
  const nonzeroStatusBlock = helper.slice(statusIndex, missingOutputIndex);

  assert.match(nonzeroStatusBlock, /fs\.existsSync\(outputPath\)/);
  assert.match(nonzeroStatusBlock, /replacementCloseoutProofDecisionFromOutput\(outputPath\)/);
});

test("replacement closeout proof removes stale output before Codex runs", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("function replacementCloseoutProofAllowsClose(");
  const helperEnd = source.indexOf("function linkReplacementSourcePr(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  const outputPathIndex = helper.indexOf("const outputPath =");
  const spawnIndex = helper.indexOf("spawnCodexSyncWithHeartbeat(");
  const unlinkIndex = helper.indexOf("fs.unlinkSync(outputPath)");

  assert.notEqual(outputPathIndex, -1);
  assert.notEqual(spawnIndex, -1);
  assert.notEqual(unlinkIndex, -1);
  assert.ok(
    outputPathIndex < unlinkIndex && unlinkIndex < spawnIndex,
    "stale replacement proof output must be removed before Codex can fail without writing",
  );
});

test("source PR view hydrates labels comments and files for replacement closeout", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-github.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperStart = source.indexOf("export function fetchSourcePullRequestView(");
  const helperEnd = source.indexOf("export function sourceClosingReferences", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(
    helper,
    /author,state,mergedAt,title,url,body,labels,changedFiles,headRefOid,updatedAt/,
  );
  assert.match(helper, /repos\/\$\{repo\}\/pulls\/\$\{number\}\/files\?per_page=100/);
  assert.match(helper, /repos\/\$\{repo\}\/issues\/\$\{number\}\/comments\?per_page=100/);
  assert.match(helper, /repos\/\$\{repo\}\/pulls\/\$\{number\}\/reviews\?per_page=100/);
  assert.match(helper, /commentsTruncated/);
  assert.match(helper, /reviewsTruncated/);
  assert.match(helper, /filesTruncated/);
});
