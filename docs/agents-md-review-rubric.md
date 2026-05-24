# AGENTS.md review rubric

ClawSweeper review prompts should treat a target repository's `AGENTS.md` as
repository policy to evaluate against, not simply as instructions for the review
agent to follow.

## Desired behavior

When `AGENTS.md` exists in the checked-out target repository, reviews should:

- read it before judging the item, PR, or commit;
- use it as repo-local engineering and contribution policy;
- compare the proposed change, implementation path, validation, and automation
  recommendation against the applicable policy;
- call out concrete policy conflicts as review findings, risks, solution-fit
  problems, or evidence depending on the review surface.

## PR reviews

For pull requests, an `AGENTS.md` conflict should become a `reviewFindings` entry
when it is concrete, introduced by the PR, and actionable for the author. The
finding should cite the changed file and explain the relevant policy conflict.

Examples:

- a provider-routing change violates required validation guidance from
  `AGENTS.md`;
- a docs change ignores repo-specific docs-linking rules and would create broken
  published docs;
- a test strategy conflicts with required real-behavior or integration coverage
  for the touched surface.

If the conflict is not a discrete patch defect, use `risks`, `bestSolution`,
`solutionAssessment`, or `workReason` instead.

## Issue reviews

For issues, `AGENTS.md` should shape the close/keep-open decision. A requested
fix path that conflicts with repo policy should be redirected through
`solutionAssessment`, `bestSolution`, and `workReason` rather than forced into a
PR-style finding.

## Commit reviews

For commit reviews, an `AGENTS.md` conflict should be reported as a finding only
when it creates a concrete maintainer-relevant risk such as a bug, regression,
security issue, compatibility issue, supply-chain issue, or policy violation
with a plausible failure mode.

## Non-goals

- Do not treat `AGENTS.md` as higher priority than ClawSweeper's review prompt
  or system/developer instructions.
- Do not report style preferences or vague policy disagreements as findings.
- Do not add `clawsweeper.md` behavior as part of this change.
