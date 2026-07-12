import { canonicalJson } from "./gitcrawl-evidence-contract.js";

export type GitcrawlThreadPolicySignals = {
  blankTemplate: boolean;
  issueReference: boolean;
  concreteFix: boolean;
  thirdPartyCapability: boolean;
};

export type GitcrawlThreadSafetyProjection = {
  title: string;
  body: string;
  authorLogin?: string;
  authorType: string;
  authorAssociation?: string;
  labels?: unknown[];
  assignees?: unknown[];
  securitySensitive: boolean;
  securityMetadataComplete: boolean;
  securityProjectionSha256: string;
  policySignals: GitcrawlThreadPolicySignals;
};

export function deriveGitcrawlThreadPolicySignals(
  title: string,
  body: string,
): GitcrawlThreadPolicySignals {
  const text = `${title}\n${body}`;
  return {
    blankTemplate: blankTemplateSignal(body),
    issueReference: /#\d+\b/.test(text),
    concreteFix: /\b(fixes|fixes?|root cause|repro|regression|bug|problem)\b/i.test(text),
    thirdPartyCapability: /\b(new|add|feat).*(plugin|provider|channel|skill|tool|app)\b/i.test(
      text,
    ),
  };
}

export function assertGitcrawlThreadSafetyProjectionMatches(
  search: GitcrawlThreadSafetyProjection,
  review: GitcrawlThreadSafetyProjection,
): void {
  if (canonicalJson(safetyProjection(search)) !== canonicalJson(safetyProjection(review))) {
    throw new Error("Gitcrawl search and review safety projections diverge");
  }
}

function safetyProjection(thread: GitcrawlThreadSafetyProjection): Record<string, unknown> {
  return {
    title: thread.title,
    body: thread.body,
    author_login: thread.authorLogin ?? null,
    author_type: thread.authorType,
    author_association: thread.authorAssociation ?? null,
    labels: thread.labels ?? null,
    assignees: thread.assignees ?? null,
    security_sensitive: thread.securitySensitive,
    security_metadata_complete: thread.securityMetadataComplete,
    security_projection_sha256: thread.securityProjectionSha256,
    policy_signals: thread.policySignals,
  };
}

function blankTemplateSignal(body: string): boolean {
  const fields = [
    "Describe the problem and fix in 2-5 bullets",
    "Describe the problem and fix",
    "Problem",
    "Why it matters",
    "Fix",
  ];
  const answers: string[] = [];
  let active = false;
  let substantiveOutsideTemplate = false;
  const withoutComments = stripGitcrawlHtmlComments(body);
  for (const line of withoutComments.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?([^:]+):\s*(.*)$/.exec(line);
    const label = match?.[1]?.trim().replace(/[–—]/g, "-");
    const bareLabel = line
      .trim()
      .replace(/^[-*]\s*/, "")
      .replace(/[–—]/g, "-");
    const templateLabel = label ?? bareLabel;
    if (fields.some((field) => field.toLowerCase() === templateLabel.toLowerCase())) {
      active = true;
      answers.push(match?.[2]?.trim() ?? "");
      continue;
    }
    if (!active && !templatePreambleLineIsBlank(line)) {
      substantiveOutsideTemplate = true;
      continue;
    }
    if (active && !/^\s*[-*_]?\s*$/.test(line)) {
      answers[answers.length - 1] = `${answers.at(-1) ?? ""}\n${line.trim()}`.trim();
    }
  }
  return (
    !substantiveOutsideTemplate &&
    answers.length >= 2 &&
    answers.every((answer) => templateAnswerIsBlank(answer))
  );
}

function templatePreambleLineIsBlank(line: string): boolean {
  if (/^\s*[-*_]?\s*$/.test(line)) return true;
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase();
  return (
    heading !== undefined &&
    [
      "description",
      "pull request description",
      "summary",
      "change summary",
      "problem and fix",
    ].includes(heading)
  );
}

function templateAnswerIsBlank(answer: string): boolean {
  const normalized = stripGitcrawlHtmlComments(answer)
    .replace(/^[-*_`\s]+|[-*_`\s]+$/g, "")
    .trim()
    .toLowerCase();
  return (
    normalized === "" ||
    normalized === "n/a" ||
    normalized === "none" ||
    normalized === "no response"
  );
}

export function stripGitcrawlHtmlComments(value: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const commentStart = value.indexOf("<!--", cursor);
    if (commentStart === -1) {
      chunks.push(value.slice(cursor));
      break;
    }
    chunks.push(value.slice(cursor, commentStart), "\n");
    const commentEnd = value.indexOf("-->", commentStart + 4);
    if (commentEnd === -1) break;
    cursor = commentEnd + 3;
  }
  return chunks.join("");
}
