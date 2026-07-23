import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { stopChild, trackChild } from "./child-registry.js"

export type JsonRpcId = number | string
export type JsonRpcMessage = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageId = (message: JsonRpcMessage): JsonRpcId | null => {
  const id = message.id
  return typeof id === "number" || typeof id === "string" ? id : null
}

const errorMessage = (error: unknown): string => {
  if (!isRecord(error)) return String(error)
  const message = error.message
  return typeof message === "string" ? message : JSON.stringify(error)
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: Error) => void
  readonly timeout: NodeJS.Timeout
}

export interface CodexAppServerConnectionOptions {
  readonly requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * A newline-delimited JSON-RPC 2.0 connection to Codex app-server.
 *
 * Responses are correlated here; notifications and server-initiated requests
 * remain ordered in `nextMessage()`, which lets the adapter process usage,
 * approvals, item deltas, and terminal events through one deterministic loop.
 */
export class CodexAppServerConnection {
  readonly #input: Writable
  readonly #output: Readable
  readonly #closeTransport: () => void
  readonly #requestTimeoutMs: number
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #queued: Array<JsonRpcMessage> = []
  readonly #waiting: Array<(message: JsonRpcMessage | null) => void> = []
  #nextId = 1
  #buffer = ""
  #closed = false
  #failure: Error | null = null

  constructor(
    input: Writable,
    output: Readable,
    closeTransport: () => void,
    options: CodexAppServerConnectionOptions = {}
  ) {
    this.#input = input
    this.#output = output
    this.#closeTransport = closeTransport
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    output.on("data", this.#onData)
    output.on("error", this.#onError)
    output.on("end", this.#onEnd)
    input.on("error", this.#onError)
  }

  readonly #onData = (chunk: Buffer | string): void => {
    this.#buffer += chunk.toString()
    for (;;) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.trim().length === 0) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (isRecord(parsed)) this.#receive(parsed)
    }
  }

  readonly #onError = (cause: Error): void => {
    this.#finish(cause)
  }

  readonly #onEnd = (): void => {
    this.#finish(null)
  }

  #receive(message: JsonRpcMessage): void {
    const id = messageId(message)
    if (id !== null && message.method === undefined) {
      const pending = this.#pending.get(id)
      if (pending === undefined) return
      this.#pending.delete(id)
      clearTimeout(pending.timeout)
      if (message.error !== undefined) {
        pending.reject(new Error(errorMessage(message.error)))
      } else {
        pending.resolve(message.result ?? null)
      }
      return
    }

    const waiter = this.#waiting.shift()
    if (waiter !== undefined) waiter(message)
    else this.#queued.push(message)
  }

  #finish(cause: Error | null): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = cause
    this.#output.off("data", this.#onData)
    this.#output.off("error", this.#onError)
    this.#output.off("end", this.#onEnd)
    this.#input.off("error", this.#onError)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(cause ?? new Error("Codex app-server closed"))
    }
    this.#pending.clear()
    for (const waiter of this.#waiting.splice(0)) waiter(null)
  }

  #send(message: JsonRpcMessage): void {
    if (this.#closed) throw this.#failure ?? new Error("Codex app-server is closed")
    this.#input.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(
          new Error(
            `Codex app-server request "${method}" timed out after ${this.#requestTimeoutMs}ms`
          )
        )
      }, this.#requestTimeoutMs)
      timeout.unref()
      this.#pending.set(id, { resolve, reject, timeout })
      try {
        this.#send({ jsonrpc: "2.0", id, method, params })
      } catch (cause) {
        this.#pending.delete(id)
        clearTimeout(timeout)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params })
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.#send({ jsonrpc: "2.0", id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.#send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  nextMessage(): Promise<JsonRpcMessage | null> {
    const queued = this.#queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#closed) return Promise.resolve(null)
    return new Promise((resolve) => this.#waiting.push(resolve))
  }

  /**
   * Wait for one notification without leaving a stale waiter behind on timeout.
   * Used for request-adjacent notifications whose delivery is not atomic with
   * the JSON-RPC response.
   */
  nextMessageWithin(timeoutMs: number): Promise<JsonRpcMessage | null> {
    const queued = this.#queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const waiter = (message: JsonRpcMessage | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(message)
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        const index = this.#waiting.indexOf(waiter)
        if (index >= 0) this.#waiting.splice(index, 1)
        resolve(null)
      }, timeoutMs)
      timeout.unref()
      this.#waiting.push(waiter)
    })
  }

  /** Take notifications already delivered with a request response without waiting. */
  drainMessages(): ReadonlyArray<JsonRpcMessage> {
    return this.#queued.splice(0)
  }

  close(): void {
    if (this.#closed) return
    this.#closeTransport()
    this.#finish(null)
  }
}

export interface StartCodexAppServerOptions {
  readonly binPath?: string | null
  readonly env?: NodeJS.ProcessEnv
}

/** Spawn and initialize one app-server connection for one Starbase run. */
export const startCodexAppServer = async (
  options: StartCodexAppServerOptions
): Promise<CodexAppServerConnection> => {
  const child = trackChild(
    spawn(options.binPath || "codex", ["app-server"], {
      env: options.env,
      stdio: ["pipe", "pipe", "ignore"]
    })
  )
  if (child.stdin === null || child.stdout === null) {
    stopChild(child)
    throw new Error("Codex app-server did not expose stdio")
  }
  const connection = new CodexAppServerConnection(
    child.stdin,
    child.stdout,
    () => stopChild(child)
  )
  child.on("error", () => connection.close())
  child.on("exit", () => connection.close())

  try {
    await connection.request("initialize", {
      clientInfo: { name: "starbase", version: "1" },
      capabilities: { experimentalApi: true }
    })
    connection.notify("initialized", {})
    return connection
  } catch (cause) {
    connection.close()
    throw cause
  }
}
