import type { StreamEvent } from "@starbase/core"
import { capOutput } from "./output-cap.js"
import type { JsonRpcMessage } from "./codex-app-server-client.js"
import { codexContextUsageFromMessage } from "./codex-app-server.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringAt = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" ? value : null
}

const recordAt = (
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const arrayAt = (record: Record<string, unknown>, key: string): ReadonlyArray<unknown> => {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

export interface CodexAppServerEventState {
  readonly startedTools: Set<string>
  readonly toolOutput: Map<string, string>
}

export const makeCodexAppServerEventState = (): CodexAppServerEventState => ({
  startedTools: new Set(),
  toolOutput: new Map()
})

const toolStart = (item: Record<string, unknown>): StreamEvent | null => {
  const id = stringAt(item, "id")
  const type = stringAt(item, "type")
  if (id === null || type === null) return null
  switch (type) {
    case "commandExecution":
      return { _tag: "ToolStart", id, name: "Bash", target: stringAt(item, "command") }
    case "fileChange": {
      const first = arrayAt(item, "changes")[0]
      return {
        _tag: "ToolStart",
        id,
        name: "Edit",
        target: isRecord(first) ? stringAt(first, "path") : null
      }
    }
    case "webSearch":
      return { _tag: "ToolStart", id, name: "WebSearch", target: stringAt(item, "query") }
    case "mcpToolCall":
      return {
        _tag: "ToolStart",
        id,
        name: stringAt(item, "tool") ?? "MCP",
        target: stringAt(item, "server")
      }
    case "dynamicToolCall":
      return {
        _tag: "ToolStart",
        id,
        name: stringAt(item, "tool") ?? "Tool",
        target: stringAt(item, "namespace")
      }
    case "collabAgentToolCall":
      return {
        _tag: "ToolStart",
        id,
        name: stringAt(item, "tool") ?? "Agent",
        target: stringAt(item, "prompt")
      }
    default:
      return null
  }
}

const ensureToolStart = (
  item: Record<string, unknown>,
  state: CodexAppServerEventState
): ReadonlyArray<StreamEvent> => {
  const id = stringAt(item, "id")
  const start = toolStart(item)
  if (id === null || start === null || state.startedTools.has(id)) return []
  state.startedTools.add(id)
  return [start]
}

const completedItemEvents = (
  item: Record<string, unknown>,
  state: CodexAppServerEventState
): ReadonlyArray<StreamEvent> => {
  const id = stringAt(item, "id")
  const type = stringAt(item, "type")
  if (id === null || type === null) return []

  if (type === "agentMessage") {
    const text = stringAt(item, "text")
    return text === null ? [] : [{ _tag: "Assistant", text }]
  }
  if (type === "reasoning") {
    const summary = arrayAt(item, "summary").filter(
      (value): value is string => typeof value === "string"
    )
    const text = summary.join("\n")
    return text.length === 0 ? [] : [{ _tag: "Thinking", text, seconds: null, done: true }]
  }

  const starts = ensureToolStart(item, state)
  if (type === "commandExecution") {
    const status = stringAt(item, "status")
    const exitCode = item.exitCode
    const output =
      stringAt(item, "aggregatedOutput") ?? state.toolOutput.get(id) ?? ""
    return [
      ...starts,
      {
        _tag: "ToolEnd",
        id,
        status: status === "failed" || status === "declined" ? "error" : "success",
        meta: typeof exitCode === "number" ? `exit ${exitCode}` : null,
        diff: null,
        preview: null,
        ...(output.length > 0 ? { output: capOutput(output) } : {})
      }
    ]
  }
  if (type === "fileChange") {
    const changes = arrayAt(item, "changes")
    const status = stringAt(item, "status")
    return [
      ...starts,
      {
        _tag: "ToolEnd",
        id,
        status: status === "failed" || status === "declined" ? "error" : "success",
        meta: `${changes.length} file${changes.length === 1 ? "" : "s"}`,
        diff: null,
        preview: null
      }
    ]
  }
  if (type === "mcpToolCall") {
    const error = recordAt(item, "error")
    const result = recordAt(item, "result")
    const structured = result?.structuredContent
    const content = result?.content
    const rendered =
      error !== null
        ? stringAt(error, "message") ?? ""
        : structured !== undefined && structured !== null
          ? JSON.stringify(structured)
          : content === undefined
            ? ""
            : JSON.stringify(content)
    return [
      ...starts,
      {
        _tag: "ToolEnd",
        id,
        status: error !== null || stringAt(item, "status") === "failed" ? "error" : "success",
        meta: null,
        diff: null,
        preview: null,
        ...(rendered.length > 0 ? { output: capOutput(rendered) } : {})
      }
    ]
  }
  if (
    type === "webSearch" ||
    type === "dynamicToolCall" ||
    type === "collabAgentToolCall"
  ) {
    const failed =
      stringAt(item, "status") === "failed" ||
      (type === "dynamicToolCall" && item.success === false)
    return [
      ...starts,
      {
        _tag: "ToolEnd",
        id,
        status: failed ? "error" : "success",
        meta: null,
        diff: null,
        preview: null
      }
    ]
  }
  return []
}

/**
 * Fold one app-server notification into Starbase's normalized stream.
 * Server requests are handled by the live adapter because they need AgentContext.
 */
export const codexAppServerMessageToStreamEvents = (
  message: JsonRpcMessage,
  threadId: string,
  state: CodexAppServerEventState
): ReadonlyArray<StreamEvent> => {
  const method = stringAt(message, "method")
  const params = recordAt(message, "params")
  if (method === null || params === null) return []

  const usage = codexContextUsageFromMessage(message, threadId)
  if (usage !== null) {
    return [{ _tag: "Usage", tokens: usage.tokens, window: usage.window }]
  }

  if (method === "item/started") {
    const item = recordAt(params, "item")
    return item === null ? [] : ensureToolStart(item, state)
  }
  if (method === "item/completed") {
    const item = recordAt(params, "item")
    return item === null ? [] : completedItemEvents(item, state)
  }
  if (method === "item/agentMessage/delta") {
    // Hold assistant text until `item/completed`. Question and plan blocks are
    // intercepted from the complete message; streaming their partial JSON into
    // the transcript would show raw protocol content before the card replaces it.
    return []
  }
  if (method === "item/commandExecution/outputDelta") {
    const id = stringAt(params, "itemId")
    const delta = stringAt(params, "delta")
    if (id === null || delta === null || delta.length === 0) return []
    const output = `${state.toolOutput.get(id) ?? ""}${delta}`
    state.toolOutput.set(id, output)
    return [{ _tag: "ToolDelta", id, output: capOutput(output) }]
  }
  if (method === "error") {
    // Recoverable transport/model retries are informational. Emitting Failed
    // here would settle the Starbase turn even though Codex keeps working and
    // later emits a successful turn/completed notification.
    if (params.willRetry === true) return []
    const error = recordAt(params, "error")
    const messageText = error === null ? null : stringAt(error, "message")
    return messageText === null ? [] : [{ _tag: "Failed", message: messageText }]
  }
  return []
}

export const completedAgentReply = (message: JsonRpcMessage): string | null => {
  if (message.method !== "item/completed") return null
  const params = recordAt(message, "params")
  if (params === null) return null
  const item = recordAt(params, "item")
  if (item === null || item.type !== "agentMessage") return null
  return stringAt(item, "text")
}

export const completedTurn = (
  message: JsonRpcMessage,
  threadId: string
): { readonly turnId: string; readonly status: string; readonly error: string | null } | null => {
  if (message.method !== "turn/completed") return null
  const params = recordAt(message, "params")
  if (params === null || params.threadId !== threadId) return null
  const turn = recordAt(params, "turn")
  if (turn === null) return null
  const turnId = stringAt(turn, "id")
  const status = stringAt(turn, "status")
  if (turnId === null || status === null) return null
  const error = recordAt(turn, "error")
  return { turnId, status, error: error === null ? null : stringAt(error, "message") }
}
