import type { JsonValue, LooseRecord } from "./json-types.js";

export type CrabboxPrLeasePlatform = "linux" | "mac" | "windows";
export type CrabboxPrLeaseAction = "lease" | "status" | "stop" | "reset-vnc";

export type CrabboxPrLeaseCommand = {
  action: CrabboxPrLeaseAction;
  platform: CrabboxPrLeasePlatform;
  ttlMinutes: number;
};

export const CRABBOX_PR_LEASE_INTENTS = new Set([
  "crabbox_lease",
  "crabbox_status",
  "crabbox_stop",
  "crabbox_reset_vnc",
]);

const DEFAULT_TTL_MINUTES: Record<CrabboxPrLeasePlatform, number> = {
  linux: 90,
  mac: 60,
  windows: 90,
};
const MAX_TTL_MINUTES = 240;
const MIN_TTL_MINUTES = 15;
export const CRABBOX_PR_LEASE_IDLE_TIMEOUT_MINUTES = 30;

export function parseCrabboxPrLeaseCommand(command: JsonValue): CrabboxPrLeaseCommand | null {
  const raw = String(command ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
  if (!raw.startsWith("crabbox")) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts[0] !== "crabbox") return null;

  const action = normalizeCrabboxAction(parts[1] ?? "status");
  if (!action) return null;

  let platform: CrabboxPrLeasePlatform = "linux";
  let ttlMinutes: number | null = null;
  for (const part of parts.slice(2)) {
    const nextPlatform = normalizeCrabboxPlatform(part);
    if (nextPlatform) {
      platform = nextPlatform;
      continue;
    }
    const nextTtl = parseDurationMinutes(part);
    if (nextTtl !== null) ttlMinutes = nextTtl;
  }
  return {
    action,
    platform,
    ttlMinutes: clampTtlMinutes(ttlMinutes ?? DEFAULT_TTL_MINUTES[platform]),
  };
}

export function crabboxIntentForAction(action: CrabboxPrLeaseAction): string {
  if (action === "reset-vnc") return "crabbox_reset_vnc";
  return `crabbox_${action}`;
}

export function crabboxActionFromIntent(intent: JsonValue): CrabboxPrLeaseAction | null {
  if (intent === "crabbox_lease") return "lease";
  if (intent === "crabbox_status") return "status";
  if (intent === "crabbox_stop") return "stop";
  if (intent === "crabbox_reset_vnc") return "reset-vnc";
  return null;
}

export function crabboxLeaseSlug(prNumber: JsonValue, platform: JsonValue): string {
  return `pr-${Number(prNumber)}-${String(platform ?? "linux")}`;
}

export function buildCrabboxWarmupArgs({
  platform,
  ttlMinutes,
  prNumber,
}: {
  platform: CrabboxPrLeasePlatform;
  ttlMinutes: number;
  prNumber: JsonValue;
}): string[] {
  const common = [
    "warmup",
    "--provider",
    "aws",
    "--desktop",
    "--browser",
    "--ttl",
    `${ttlMinutes}m`,
    "--idle-timeout",
    `${CRABBOX_PR_LEASE_IDLE_TIMEOUT_MINUTES}m`,
    "--slug",
    crabboxLeaseSlug(prNumber, platform),
  ];
  if (platform === "linux") return [...common, "--target", "linux"];
  if (platform === "mac") return [...common, "--target", "macos", "--market", "on-demand"];
  return [...common, "--target", "windows", "--windows-mode", "normal"];
}

export function renderCrabboxRouterResponse(command: LooseRecord, dispatched: LooseRecord) {
  const action = crabboxActionFromIntent(command.intent);
  const platform = String(command.crabbox_platform ?? "linux");
  const ttl = Number(command.crabbox_ttl_minutes ?? DEFAULT_TTL_MINUTES.linux);
  if (!action) return "";
  if (!dispatched?.crabbox) {
    return [
      `Crabbox ${action} could not be queued.`,
      "",
      `Reason: ${command.reason ?? "Crabbox commands require an open pull request"}.`,
    ].join("\n");
  }
  const label = action === "reset-vnc" ? "reset WebVNC" : action;
  return [
    `Crabbox ${platform} ${label} requested.`,
    "",
    `- Platform: \`${platform}\``,
    action === "lease" ? `- TTL: \`${ttl}m\`` : null,
    action === "lease" ? `- Idle timeout: \`${CRABBOX_PR_LEASE_IDLE_TIMEOUT_MINUTES}m\`` : null,
    `- Action: interactive PR ${label} queued`,
    "",
    action === "lease"
      ? "I will post the WebVNC handoff when the lease is ready."
      : "I will update the PR with the result when the command finishes.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderCrabboxLeaseComment(state: LooseRecord): string {
  const status = String(state.status ?? "ready");
  if (status === "ready") return renderReadyComment(state);
  if (status === "already_active") return renderAlreadyActiveComment(state);
  if (status === "stopped") return renderStoppedComment(state);
  if (status === "reset") return renderResetComment(state);
  return renderFailureComment(state);
}

function renderReadyComment(state: LooseRecord): string {
  return [
    leaseMarker(state),
    "🦞✅",
    "",
    "Crabbox lease ready for PR testing.",
    "",
    leaseSummaryLines(state).join("\n"),
    "",
    `WebVNC: ${state.webvnc_url ?? "unavailable"}`,
    "",
    usefulCommands(state),
  ].join("\n");
}

function renderAlreadyActiveComment(state: LooseRecord): string {
  return [
    leaseMarker(state),
    "🦞👀",
    "",
    `A Crabbox ${state.platform ?? "linux"} lease is already active for this PR.`,
    "",
    leaseSummaryLines(state).join("\n"),
    "",
    `WebVNC: ${state.webvnc_url ?? "unavailable"}`,
    "",
    `Use \`@clawsweeper crabbox status ${state.platform ?? "linux"}\` for health or \`@clawsweeper crabbox stop ${state.platform ?? "linux"}\` before requesting a new lease.`,
  ].join("\n");
}

function renderStoppedComment(state: LooseRecord): string {
  return [
    leaseMarker(state),
    "🦞✅",
    "",
    `Stopped the Crabbox ${state.platform ?? "linux"} lease for this PR.`,
    "",
    `- Lease: \`${state.lease_id ?? "unknown"}\``,
    `- Platform: \`${state.platform ?? "linux"}\``,
    "- Result: provider resources released",
  ].join("\n");
}

function renderResetComment(state: LooseRecord): string {
  return [
    leaseMarker(state),
    "🦞✅",
    "",
    `Reset WebVNC for the Crabbox ${state.platform ?? "linux"} lease.`,
    "",
    `- Lease: \`${state.lease_id ?? "unknown"}\``,
    `- Platform: \`${state.platform ?? "linux"}\``,
    `- Bridge: \`${state.webvnc_bridge ?? "unknown"}\``,
    "",
    `WebVNC: ${state.webvnc_url ?? "unavailable"}`,
  ].join("\n");
}

function renderFailureComment(state: LooseRecord): string {
  const hasLease = Boolean(state.lease_id);
  return [
    leaseMarker(state),
    "🦞⚠️",
    "",
    hasLease
      ? `Crabbox ${state.platform ?? "linux"} lease is alive, but setup did not finish.`
      : `Crabbox ${state.platform ?? "linux"} lease could not be created.`,
    "",
    `- Platform: \`${state.platform ?? "linux"}\``,
    hasLease ? `- Lease: \`${state.lease_id}\`` : null,
    `- Failed step: \`${state.failed_step ?? "unknown"}\``,
    `- Result: ${hasLease ? "lease kept for manual inspection" : "no lease was created"}`,
    state.webvnc_url ? "" : null,
    state.webvnc_url ? `WebVNC: ${state.webvnc_url}` : null,
    "",
    "Failure excerpt:",
    "```text",
    String(state.failure_excerpt ?? "No failure excerpt captured.").slice(0, 1200),
    "```",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function leaseSummaryLines(state: LooseRecord): string[] {
  return [
    `- Platform: \`${state.platform ?? "linux"}\``,
    `- Lease: \`${state.lease_id ?? "unknown"}\``,
    state.slug ? `- Slug: \`${state.slug}\`` : null,
    state.expires_at ? `- Expires: \`${state.expires_at}\`` : null,
    `- Idle timeout: \`${state.idle_timeout_minutes ?? CRABBOX_PR_LEASE_IDLE_TIMEOUT_MINUTES}m\``,
    state.repo && state.pr_number && state.head_sha
      ? `- PR code: \`${state.repo}#${state.pr_number}\` at \`${String(state.head_sha).slice(0, 12)}\``
      : null,
    state.hydration ? `- Hydration: \`${state.hydration}\`` : null,
    state.sharing ? `- Sharing: \`${state.sharing}\`` : null,
  ].filter((line): line is string => Boolean(line));
}

function usefulCommands(state: LooseRecord): string {
  const lease = String(state.lease_id ?? "<lease>");
  return [
    "Useful commands:",
    "```sh",
    `crabbox webvnc status --id ${lease}`,
    `crabbox webvnc reset --id ${lease} --open --take-control`,
    `crabbox ssh --id ${lease}`,
    `crabbox stop ${lease}`,
    "```",
  ].join("\n");
}

function leaseMarker(state: LooseRecord): string {
  return `<!-- clawsweeper-crabbox-lease:${state.repo ?? "unknown"}:${state.pr_number ?? "unknown"}:${state.platform ?? "linux"} -->`;
}

function normalizeCrabboxAction(value: string): CrabboxPrLeaseAction | null {
  if (!value || value === "lease" || value === "start" || value === "open") return "lease";
  if (value === "status") return "status";
  if (value === "stop" || value === "release") return "stop";
  if (value === "reset-vnc" || value === "reset" || value === "webvnc-reset") return "reset-vnc";
  return null;
}

function normalizeCrabboxPlatform(value: string): CrabboxPrLeasePlatform | null {
  if (value === "linux") return "linux";
  if (value === "mac" || value === "macos" || value === "darwin") return "mac";
  if (value === "windows" || value === "win") return "windows";
  return null;
}

function parseDurationMinutes(value: string): number | null {
  const match = value.match(/^(\d+)(m|h)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2] === "h" ? amount * 60 : amount;
}

function clampTtlMinutes(value: number): number {
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.round(value)));
}
