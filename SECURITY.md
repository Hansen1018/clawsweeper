# Security Policy

## Reporting

Report suspected vulnerabilities privately through GitHub Security Advisories for
this repository. If GHSA is unavailable to you, email security@openclaw.ai.

Do not open public issues for vulnerabilities or include secrets, private
automation logs, tokens, app private keys, installation credentials, or exploit
details in public reports.

## Scope

In scope:

- ClawSweeper GitHub App token boundaries and workflow permissions
- review, repair, merge, and comment-router automation
- prompt construction, repository profile policy, and generated job validation
- handling of private report data, comments, artifacts, and maintainer state
- dependency or workflow behavior that can mutate target repositories

Out of scope:

- target-repository bugs that do not cross a ClawSweeper boundary
- intentionally authorized maintainer actions performed with expected privilege
- compromise of a trusted maintainer account, local shell, filesystem, or device
- scanner-only findings without a reachable exploit path in supported usage

## Expectations

We prioritize reachable issues that affect repository integrity, privileged
automation, private report data, or safe execution. Include the affected commit,
target workflow, minimal reproduction steps, and sanitized impact details.
