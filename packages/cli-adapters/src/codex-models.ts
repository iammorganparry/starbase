import type { ModelOption } from "@starbase/core"
import { spawn } from "node:child_process"
import { stopChild, trackChild } from "./child-registry.js"

/**
 * Codex's model catalogue, read from the Codex CLI itself.
 *
 * Why not the OpenAI API: `GET api.openai.com/v1/models` needs an
 * `OPENAI_API_KEY`, which Codex users on ChatGPT subscription auth do not have
 * (their credentials live in `~/.codex/auth.json` as refresh tokens). It also
 * returns the *API* catalogue — a different vocabulary from Codex's own models
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, …), most of which it never lists. So that
 * route could not produce a correct list even with a key.
 *
 * Instead we speak the CLI's own app-server protocol over stdio: newline-
 * delimited JSON-RPC, `initialize` then `model/list`. It reuses whatever auth
 * the CLI already has, so it works for subscription and API-key users alike, and
 * the list is exactly what `codex` itself would offer.
 *
 * The protocol is marked experimental upstream, so every failure here is
 * non-fatal — callers fall back to `FALLBACK_MODELS`.
 */

/** One entry of `model/list`'s response (only the fields we consume). */
export interface CodexModel {
  readonly id: string
  readonly displayName?: string
  readonly hidden?: boolean
  readonly isDefault?: boolean
}

/**
 * Fold `model/list`'s payload into chip options — the pure, unit-tested seam
 * (the surrounding process plumbing is verified live, as with `runCodex`).
 */
export const toModelOptions = (models: ReadonlyArray<CodexModel>): ReadonlyArray<ModelOption> =>
  models
    // `hidden` models (e.g. codex-auto-review) aren't user-selectable.
    .filter((m) => m?.id && !m.hidden)
    // Surface the CLI's own default first: callers treat index 0 as the default
    // model, so this keeps us in step with `codex` itself.
    .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
    .map((m) => ({ id: m.id, label: m.displayName ?? m.id }))

/** How long the whole handshake gets before we give up and use the fallback. */
const TIMEOUT_MS = 8000

/**
 * Ask a Codex binary for its models. Resolves `null` on *any* problem (binary
 * missing, protocol drift, timeout, not logged in) — never rejects, never hangs.
 */
export const fetchCodexModels = (binPath?: string | null): Promise<ReadonlyArray<ModelOption> | null> =>
  new Promise((resolve) => {
    let settled = false
    /** Resolve once, and always tear the child down with it. */
    const finish = (result: ReadonlyArray<ModelOption> | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The app-server runs until its stdin closes; kill it so a failed probe
      // can't leave an orphaned process behind the desktop app.
      stopChild(child)
      resolve(result)
    }

    const timer = setTimeout(() => finish(null), TIMEOUT_MS)

    let child: ReturnType<typeof spawn>
    try {
      // Tracked so a quit mid-probe can't orphan it.
      child = trackChild(
        spawn(binPath || "codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] })
      )
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }

    // A missing binary surfaces here rather than as a throw from spawn().
    child.on("error", () => finish(null))
    child.on("exit", () => finish(null))
    // Writing to the stdin of a child that has already exited fails ASYNCHRONOUSLY
    // — the EPIPE arrives as an 'error' event on the pipe, which `send`'s
    // try/catch cannot see. With no listener that becomes an unhandled exception
    // and takes the whole process down. A broken pipe just means the child is
    // gone, which is exactly what `finish(null)` is for.
    child.stdin?.on("error", () => finish(null))

    const send = (id: number, method: string, params: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      } catch {
        // Only catches a synchronous throw (e.g. the stream already destroyed);
        // the async path is handled by the 'error' listener above.
        finish(null)
      }
    }

    let buffer = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      // Responses are newline-delimited JSON; a chunk may hold several or half.
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let message: { id?: number; result?: { data?: ReadonlyArray<CodexModel> } }
        try {
          message = JSON.parse(line)
        } catch {
          continue // notifications / partial noise we don't care about
        }

        // `initialize` acked → now ask for the catalogue.
        if (message.id === 1) send(2, "model/list", {})

        if (message.id === 2) {
          const models = message.result?.data
          if (!Array.isArray(models)) return finish(null)
          const options = toModelOptions(models)
          return finish(options.length > 0 ? options : null)
        }
      }
    })

    send(1, "initialize", { clientInfo: { name: "starbase", version: "1" } })
  })
