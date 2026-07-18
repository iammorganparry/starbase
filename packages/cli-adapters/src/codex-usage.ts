import type { ProviderUsage, UsageStatus, UsageWindow } from "@starbase/core"
import { requestCodexAppServer } from "./codex-app-server.js"

export interface CodexRateLimitWindow {
  readonly usedPercent: number
  readonly windowDurationMins?: number | null
  readonly resetsAt?: number | null
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null
  readonly limitName?: string | null
  readonly planType?: string | null
  readonly primary?: CodexRateLimitWindow | null
  readonly secondary?: CodexRateLimitWindow | null
  readonly rateLimitReachedType?: string | null
}

export interface CodexRateLimitsResponse {
  readonly rateLimits: CodexRateLimitSnapshot
  readonly rateLimitsByLimitId?: Readonly<Record<string, CodexRateLimitSnapshot>> | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isOptionalNullableNumber = (value: unknown): value is number | null | undefined =>
  value === undefined || value === null || typeof value === "number"

const isOptionalNullableString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string"

const isRateLimitWindow = (value: unknown): value is CodexRateLimitWindow =>
  isRecord(value) &&
  typeof value.usedPercent === "number" &&
  isOptionalNullableNumber(value.windowDurationMins) &&
  isOptionalNullableNumber(value.resetsAt)

const isOptionalWindow = (value: unknown): value is CodexRateLimitWindow | null | undefined =>
  value === undefined || value === null || isRateLimitWindow(value)

const isRateLimitSnapshot = (value: unknown): value is CodexRateLimitSnapshot =>
  isRecord(value) &&
  isOptionalNullableString(value.limitId) &&
  isOptionalNullableString(value.limitName) &&
  isOptionalNullableString(value.planType) &&
  isOptionalNullableString(value.rateLimitReachedType) &&
  isOptionalWindow(value.primary) &&
  isOptionalWindow(value.secondary)

const isCodexRateLimitsResponse = (value: unknown): value is CodexRateLimitsResponse => {
  if (!isRecord(value) || !isRateLimitSnapshot(value.rateLimits)) return false
  const buckets = value.rateLimitsByLimitId
  return (
    buckets === undefined ||
    buckets === null ||
    (isRecord(buckets) && Object.values(buckets).every(isRateLimitSnapshot))
  )
}

const statusOf = (utilization: number, limited: boolean): UsageStatus =>
  limited ? "limited" : utilization >= 95 ? "limited" : utilization >= 80 ? "nearing" : "ok"

const resetIso = (seconds: number | null | undefined): string | null => {
  if (seconds == null || !Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const durationLabel = (minutes: number | null | undefined): string => {
  if (minutes === 300) return "Current session"
  if (minutes === 10_080) return "Weekly"
  if (minutes == null) return "Usage"
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

const windowLabel = (snapshot: CodexRateLimitSnapshot, window: CodexRateLimitWindow): string => {
  const duration = durationLabel(window.windowDurationMins)
  const name = snapshot.limitName || null
  if (duration === "Weekly") return `Weekly · ${name ?? "all models"}`
  return name ? `${duration} · ${name}` : duration
}

const windowFrom = (
  snapshot: CodexRateLimitSnapshot,
  window: CodexRateLimitWindow
): UsageWindow => ({
  label: windowLabel(snapshot, window),
  resetsAt: resetIso(window.resetsAt),
  utilization: window.usedPercent,
  status: statusOf(window.usedPercent, snapshot.rateLimitReachedType != null)
})

const planLabel = (plan: string | null | undefined): string | null => {
  if (!plan || plan === "unknown") return null
  const aliases: Readonly<Record<string, string>> = {
    prolite: "Pro Lite",
    self_serve_business_usage_based: "Business",
    enterprise_cbp_usage_based: "Enterprise"
  }
  return (
    aliases[plan] ??
    plan
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  )
}

/** Map Codex app-server rate-limit buckets onto the shared Usage modal model. */
export const toCodexProviderUsage = (response: CodexRateLimitsResponse): ProviderUsage => {
  const buckets = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : []
  const snapshots = (buckets.length > 0 ? buckets : [response.rateLimits]).sort((a, b) => {
    const defaultFirst = Number(b.limitId === "codex") - Number(a.limitId === "codex")
    return defaultFirst || (a.limitName ?? "").localeCompare(b.limitName ?? "")
  })
  const windows = snapshots.flatMap((snapshot) =>
    [snapshot.primary, snapshot.secondary]
      .filter((window): window is CodexRateLimitWindow => window != null)
      .map((window) => windowFrom(snapshot, window))
  )
  const plan = snapshots.find((snapshot) => snapshot.planType)?.planType
  return {
    cli: "codex",
    name: "Codex",
    plan: planLabel(plan),
    available: windows.length > 0,
    windows
  }
}

/** Read Codex subscription rate limits from the CLI's local app server. */
export const fetchCodexUsage = async (
  binPath?: string | null
): Promise<CodexRateLimitsResponse | null> => {
  const response = await requestCodexAppServer(binPath, "account/rateLimits/read", null)
  return isCodexRateLimitsResponse(response) ? response : null
}
