import type { ProviderUsage, UsageStatus, UsageWindow } from "@starbase/core"

/**
 * Claude plan usage, read on demand from the SDK's structured `/usage` control
 * request (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). Unlike
 * the `rate_limit_event`s the SDK only emits incidentally mid-run, this returns
 * the real claude.ai plan windows — utilization %, reset time, subscription —
 * every time, which is what the Usage & limits modal needs. The mapping is a
 * pure function (unit-tested against a captured fixture); the live call is
 * verified by an integration test gated on the user's `claude` login.
 */

/** The subset of the SDK's `get_usage` response we consume. */
export interface SdkUsageWindow {
  readonly utilization: number | null
  readonly resets_at: string | null
}

export interface SdkUsageResponse {
  readonly subscription_type: string | null
  readonly rate_limits_available: boolean
  readonly rate_limits:
    | {
        readonly five_hour?: SdkUsageWindow | null
        readonly seven_day?: SdkUsageWindow | null
        readonly seven_day_opus?: SdkUsageWindow | null
      }
    | null
}

/** Utilization → status band. Null utilization stays "unknown" (no data). */
const statusOf = (u: number | null): UsageStatus =>
  u == null ? "unknown" : u >= 95 ? "limited" : u >= 80 ? "nearing" : "ok"

const windowFrom = (label: string, w: SdkUsageWindow | null | undefined): UsageWindow => {
  const utilization = typeof w?.utilization === "number" ? w.utilization : null
  return { label, resetsAt: w?.resets_at ?? null, utilization, status: statusOf(utilization) }
}

/** "max" → "Max"; null stays null. */
const pl_ = (s: string | null): string | null => (s ? s.charAt(0).toUpperCase() + s.slice(1) : null)

/**
 * Map the SDK's usage response onto our provider model. `rate_limits_available`
 * is false for API-key / Bedrock / Vertex sessions (no plan limits) → we surface
 * that as "not available". The Opus window is only shown when the plan reports it.
 */
export const toClaudeProviderUsage = (r: SdkUsageResponse): ProviderUsage => {
  const plan = pl_(r.subscription_type)
  if (!r.rate_limits_available || !r.rate_limits) {
    return { cli: "claude", name: "Claude", plan, available: false, windows: [] }
  }
  const rl = r.rate_limits
  const windows: UsageWindow[] = [
    windowFrom("Current session", rl.five_hour),
    windowFrom("Weekly · all models", rl.seven_day)
  ]
  if (rl.seven_day_opus) windows.push(windowFrom("Weekly · Opus", rl.seven_day_opus))
  return { cli: "claude", name: "Claude", plan, available: true, windows }
}

/**
 * Read Claude's plan usage live. Opens a streaming-input query purely to issue
 * the `/usage` control request (no model turn is sent), then tears it down.
 * Runs in SDK isolation (`settingSources: []`) so the user's SessionStart hooks
 * and settings don't fire for a read-only poll. Requires the user's `claude`
 * login; rejects otherwise (the caller treats a rejection as "unavailable").
 */
export const fetchClaudeUsage = async (binPath: string | null): Promise<SdkUsageResponse> => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  // Streaming-input mode keeps the control channel alive; we never yield a turn.
  async function* prompt() {
    await gate
  }

  const q = query({
    prompt: prompt(),
    options: {
      pathToClaudeCodeExecutable: binPath ?? undefined,
      permissionMode: "default",
      settingSources: []
    }
  })

  // Pump the generator so the SDK processes the control request/response. The
  // control request itself queues until the subprocess handshake completes.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        // ignore stream messages — we only want the control response
      }
    } catch {
      // interrupt tears the stream down; swallow
    }
  })()

  try {
    return (await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()) as SdkUsageResponse
  } finally {
    release()
    try {
      await q.interrupt?.()
    } catch {
      // best-effort teardown
    }
    await drain.catch(() => {})
  }
}
