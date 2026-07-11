import type { UsageStatus } from "@starbase/core"

/**
 * Process-global capture of Claude's rate-limit windows. The Claude adapter
 * records each `rate_limit_event` the SDK emits during a run (reset time +
 * status, and a utilization % when the server includes one); `UsageService`
 * reads the latest snapshot for the Usage & limits modal. Kept a plain module
 * singleton since it's cross-cutting main-process state.
 */

/** The shape of the SDK's `rate_limit_info` (subset we use). */
export interface RateLimitInfo {
  readonly status?: string
  readonly utilization?: number
  /** Unix seconds. */
  readonly resetsAt?: number
  readonly rateLimitType?: string
}

interface WindowEntry {
  readonly utilization: number | null
  readonly resetsAt: string | null
  readonly status: UsageStatus
}

const claudeWindows = new Map<string, WindowEntry>()
let fetchedAt: string | null = null

const statusOf = (s: string | undefined): UsageStatus =>
  s === "rejected" ? "limited" : s === "allowed_warning" ? "nearing" : "ok"

/** Record one Claude rate-limit window, keyed by its `rateLimitType`. */
export const recordClaudeRateLimit = (info: RateLimitInfo): void => {
  if (!info.rateLimitType) return
  claudeWindows.set(info.rateLimitType, {
    utilization: typeof info.utilization === "number" ? info.utilization : null,
    resetsAt: typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null,
    status: statusOf(info.status)
  })
  fetchedAt = new Date().toISOString()
}

export interface ClaudeUsageSnapshot {
  readonly windows: ReadonlyMap<string, WindowEntry>
  readonly fetchedAt: string | null
}

/** A snapshot of the captured Claude windows. */
export const readClaudeUsage = (): ClaudeUsageSnapshot => ({
  windows: new Map(claudeWindows),
  fetchedAt
})

/** Reset the store (tests). */
export const clearUsage = (): void => {
  claudeWindows.clear()
  fetchedAt = null
}
