import { spawn } from "node:child_process"
import { stopChild, trackChild } from "./child-registry.js"

/** The app-server is a local probe; never let protocol drift leave it hanging. */
const REQUEST_TIMEOUT_MS = 8000
/** Context telemetry must not hold a completed reply hostage for discovery's full timeout. */
const CONTEXT_USAGE_TIMEOUT_MS = 2000
/** A timed-out thread did not replay usage; do not pay the same timeout on every turn. */
const unsupportedContextThreads = new Set<string>()

export interface CodexContextUsage {
  /** Tokens resident in the model's context for its latest request. */
  readonly tokens: number
  /** The effective context ceiling reported by the running Codex model. */
  readonly window: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * Decode the one app-server notification that describes context occupancy.
 *
 * `tokenUsage.total` is cumulative spend across every model request in the
 * thread. `tokenUsage.last` is what the latest request actually held, and is
 * the value Codex's own context meter uses. Keeping that distinction in this
 * decoder prevents a multi-million-token agent loop from masquerading as a
 * multi-million-token context window.
 */
export const codexContextUsageFromMessage = (
  message: unknown,
  expectedThreadId: string
): CodexContextUsage | null => {
  if (!isRecord(message) || message.method !== "thread/tokenUsage/updated") return null
  const params = message.params
  if (!isRecord(params) || params.threadId !== expectedThreadId) return null
  const tokenUsage = params.tokenUsage
  if (!isRecord(tokenUsage)) return null
  const last = tokenUsage.last
  if (!isRecord(last)) return null
  const tokens = last.totalTokens
  const window = tokenUsage.modelContextWindow
  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof window !== "number" ||
    !Number.isFinite(window) ||
    window <= 0
  ) {
    return null
  }
  return { tokens, window }
}

/**
 * Make one request against Codex's newline-delimited JSON-RPC app server.
 *
 * Every request starts a short-lived process, performs `initialize`, sends the
 * requested method, and tears the process down. Failures resolve to null because
 * model/usage discovery is optional UI data and must never take down Starbase.
 */
export const requestCodexAppServer = (
  binPath: string | null | undefined,
  method: string,
  params: unknown
): Promise<unknown | null> =>
  new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn> | null = null

    const finish = (result: unknown | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child) stopChild(child)
      resolve(result)
    }

    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS)

    try {
      child = trackChild(
        spawn(binPath || "codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] })
      )
    } catch {
      finish(null)
      return
    }

    child.on("error", () => finish(null))
    child.on("exit", () => finish(null))
    child.stdin?.on("error", () => finish(null))

    const send = (id: number, requestMethod: string, requestParams: unknown) => {
      try {
        child?.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: requestParams })}\n`
        )
      } catch {
        finish(null)
      }
    }

    let buffer = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      // `for (;;)` with an explicit break, not `while ((n = indexOf(...)) >= 0)`.
      // An assignment buried in a loop condition reads as a comparison at a
      // glance, which is the one place you cannot afford to misread a stream
      // parser — and the re-scan cannot simply move to the end of the body,
      // because the body `continue`s past it on a blank or unparseable line.
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let message: { id?: number; result?: unknown; error?: unknown }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }

        if (message.id === 1) {
          if (message.error !== undefined) return finish(null)
          send(2, method, params)
        }
        if (message.id === 2) return finish(message.result ?? null)
      }
    })

    send(1, "initialize", { clientInfo: { name: "starbase", version: "1" } })
  })

/**
 * Read the authoritative context occupancy for a persisted Codex thread.
 *
 * The exec SDK's `turn.completed.usage` is cumulative spend and deliberately
 * does not expose the resident-context fields. The app-server does: resuming a
 * persisted thread replays `thread/tokenUsage/updated`, whose `last` reading and
 * runtime window are the same source Codex's own UI uses.
 *
 * Best-effort like the other discovery probes in this module. Protocol drift,
 * a missing thread, a failed process, or a timeout all resolve to null so usage
 * telemetry can never fail an otherwise successful agent turn.
 */
export const readCodexContextUsage = (
  binPath: string | null | undefined,
  threadId: string,
  signal?: AbortSignal
): Promise<CodexContextUsage | null> => {
  if (
    threadId.length === 0 ||
    unsupportedContextThreads.has(threadId) ||
    signal?.aborted === true
  ) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn> | null = null

    const finish = (result: CodexContextUsage | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (child) stopChild(child)
      resolve(result)
    }

    const abort = () => finish(null)
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => {
      unsupportedContextThreads.add(threadId)
      finish(null)
    }, CONTEXT_USAGE_TIMEOUT_MS)

    try {
      child = trackChild(
        spawn(binPath || "codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] })
      )
    } catch {
      finish(null)
      return
    }

    child.on("error", () => finish(null))
    child.on("exit", () => finish(null))
    child.stdin?.on("error", () => finish(null))

    const send = (message: Record<string, unknown>) => {
      try {
        child?.stdin?.write(`${JSON.stringify(message)}\n`)
      } catch {
        finish(null)
      }
    }

    let buffer = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }

        const usage = codexContextUsageFromMessage(message, threadId)
        if (usage !== null) {
          finish(usage)
          continue
        }
        if (!isRecord(message)) continue

        if (message.id === 1) {
          if (message.error !== undefined) {
            finish(null)
            continue
          }
          // The protocol requires the initialized acknowledgement before any
          // thread method. It has no id because it is a notification.
          send({ jsonrpc: "2.0", method: "initialized", params: {} })
          // Do not set `excludeTurns`: Codex intentionally skips the restored
          // token-usage replay in that mode.
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "thread/resume",
            params: { threadId }
          })
          continue
        }
        if (message.id === 2 && message.error !== undefined) finish(null)
      }
    })

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "starbase", version: "1" } }
    })
  })
}
