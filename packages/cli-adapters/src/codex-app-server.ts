import { spawn } from "node:child_process"
import { stopChild, trackChild } from "./child-registry.js"

/** The app-server is a local probe; never let protocol drift leave it hanging. */
const TIMEOUT_MS = 8000

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

    const timer = setTimeout(() => finish(null), TIMEOUT_MS)

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
