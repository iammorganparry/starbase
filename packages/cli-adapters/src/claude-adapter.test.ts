import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import type { Question, QuestionAnswer } from "@starbase/core"
import {
  editStats,
  formatQuestionAnswer,
  mapPermissionMode,
  parseSdkQuestions,
  streamEventsFor,
  toPermissionRequest,
  type ToolMemo
} from "./claude-adapter.js"

/**
 * The Claude adapter's live path needs a real `claude` login, so we test the
 * PURE mapping seam — the behaviour that turns SDK messages + tool inputs into
 * our normalized events and permission requests. These are the outcomes the
 * transcript, HITL machine and diff peek depend on; the socket/process wiring is
 * verified live (documented manual check).
 */

// Build a minimal SDK message; the mapper only reads the fields it needs.
const msg = (m: unknown): SDKMessage => m as SDKMessage

describe("mapPermissionMode", () => {
  it("maps our HITL modes onto the SDK's permission modes", () => {
    expect(mapPermissionMode("auto")).toBe("bypassPermissions")
    expect(mapPermissionMode("accept-edits")).toBe("acceptEdits")
    expect(mapPermissionMode("ask")).toBe("default")
  })
})

describe("toPermissionRequest", () => {
  it("classifies edit tools as edit gates", () => {
    const req = toPermissionRequest("Edit", { file_path: "src/a.ts" })
    expect(req).toStrictEqual({ kind: "edit", tool: "Edit", target: "src/a.ts", command: null })
  })

  it("classifies Bash as a command gate carrying the command", () => {
    const req = toPermissionRequest("Bash", { command: "npm test" })
    expect(req).toStrictEqual({ kind: "command", tool: "Bash", target: "npm test", command: "npm test" })
  })

  it("returns null for read-only tools (never gated)", () => {
    expect(toPermissionRequest("Read", { file_path: "a.ts" })).toBeNull()
    expect(toPermissionRequest("Grep", { pattern: "TODO" })).toBeNull()
  })
})

describe("editStats", () => {
  it("counts added/removed lines and previews the first added line for an Edit", () => {
    const { diff, preview } = editStats("Edit", { old_string: "a", new_string: "a\nb\nc" })
    expect(diff).toStrictEqual({ added: 3, removed: 1 })
    expect(preview).toBe("+ a")
  })

  it("treats a Write as all-added", () => {
    const { diff } = editStats("Write", { content: "line1\nline2" })
    expect(diff).toStrictEqual({ added: 2, removed: 0 })
  })
})

describe("streamEventsFor", () => {
  it("emits Started from the system init message", () => {
    const events = streamEventsFor(msg({ type: "system", subtype: "init", session_id: "s1" }), new Map())
    expect(events).toStrictEqual([{ _tag: "Started", sessionId: "s1" }])
  })

  it("carries the actual model on Started when the init reports one", () => {
    const events = streamEventsFor(
      msg({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-4-20250514" }),
      new Map()
    )
    expect(events).toStrictEqual([
      { _tag: "Started", sessionId: "s1", model: "claude-opus-4-20250514" }
    ])
  })

  it("streams assistant text token-by-token from content_block_delta events", () => {
    const events = streamEventsFor(
      msg({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Editing " } } }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "Assistant", text: "Editing " }])
  })

  it("emits thinking (finished) and tool_use from the assistant message, but not text (already streamed)", () => {
    const tools = new Map<string, ToolMemo>()
    const events = streamEventsFor(
      msg({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "planning" },
            { type: "text", text: "Editing the route." },
            { type: "tool_use", id: "tu_1", name: "Edit", input: { file_path: "src/billing.ts", old_string: "", new_string: "x" } }
          ]
        }
      }),
      tools
    )
    expect(events).toStrictEqual([
      { _tag: "Thinking", text: "planning", seconds: null, done: true },
      { _tag: "ToolStart", id: "tu_1", name: "Edit", target: "src/billing.ts" }
    ])
    expect(tools.get("tu_1")?.name).toBe("Edit")
  })

  it("completes a tool_use with a diff peek from the remembered edit input", () => {
    const tools = new Map<string, ToolMemo>([
      ["tu_1", { name: "Edit", input: { old_string: "a", new_string: "a\nb" } }]
    ])
    const events = streamEventsFor(
      msg({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "ok" }] }
      }),
      tools
    )
    expect(events).toStrictEqual([
      { _tag: "ToolEnd", id: "tu_1", status: "success", meta: null, diff: { added: 2, removed: 1 }, preview: "+ a" }
    ])
  })

  it("marks an errored tool_result as error status", () => {
    const events = streamEventsFor(
      msg({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: "boom" }] }
      }),
      new Map()
    )
    expect(events[0]).toMatchObject({ _tag: "ToolEnd", id: "x", status: "error" })
  })

  it("maps the result message to Done with cost + total tokens", () => {
    const events = streamEventsFor(
      msg({ type: "result", subtype: "success", total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 40 } }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "Done", costUsd: 0.42, tokens: 140 }])
  })
})

describe("plan mode + AskUserQuestion (canUseTool path)", () => {
  it("maps our 'plan' mode onto the SDK's plan permission mode", () => {
    expect(mapPermissionMode("plan")).toBe("plan")
    expect(mapPermissionMode("auto")).toBe("bypassPermissions")
    expect(mapPermissionMode("accept-edits")).toBe("acceptEdits")
    expect(mapPermissionMode("ask")).toBe("default")
  })

  it("suppresses the ExitPlanMode + AskUserQuestion raw tool cards (dedicated UI)", () => {
    const assistant = (name: string) =>
      streamEventsFor(
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input: {} }] } } as never,
        new Map()
      )
    expect(assistant("ExitPlanMode")).toStrictEqual([])
    expect(assistant("AskUserQuestion")).toStrictEqual([])
    // A normal tool still emits a ToolStart card.
    expect(assistant("Read")[0]).toMatchObject({ _tag: "ToolStart", name: "Read" })
  })

  it("parseSdkQuestions reads the AskUserQuestion tool input shape", () => {
    const questions = parseSdkQuestions({
      questions: [
        {
          question: "Which strategy?",
          header: "Strategy",
          multiSelect: false,
          options: [
            { label: "Rotating", description: "secure" },
            { label: "Sliding", description: "simple", preview: "code" }
          ]
        }
      ]
    })
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ question: "Which strategy?", header: "Strategy", multiSelect: false })
    expect(questions[0]!.options[1]).toMatchObject({ label: "Sliding", preview: "code" })
  })

  it("formatQuestionAnswer phrases the picks as the model's reply (deny-message channel)", () => {
    const questions: ReadonlyArray<Question> = [
      { question: "Which strategy?", header: "Strategy", multiSelect: false, options: [] },
      { question: "Which surfaces?", header: "Surfaces", multiSelect: true, options: [] }
    ]
    const answers: ReadonlyArray<QuestionAnswer> = [
      { selected: ["Rotating"], other: null },
      { selected: ["HTTP middleware", "Workers"], other: "CLI" }
    ]
    const msg = formatQuestionAnswer(questions, answers)
    expect(msg).toContain("• Strategy: Rotating")
    expect(msg).toContain("• Surfaces: HTTP middleware, Workers, CLI")
    expect(msg).toMatch(/do not ask again/)
  })

  it("formatQuestionAnswer marks an unanswered question rather than dropping it", () => {
    const questions: ReadonlyArray<Question> = [
      { question: "Which?", header: "Pick", multiSelect: false, options: [] }
    ]
    expect(formatQuestionAnswer(questions, [])).toContain("(no selection)")
  })
})
