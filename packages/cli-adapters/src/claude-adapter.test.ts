import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import type { PermissionMode, Question, QuestionAnswer } from "@starbase/core"
import type { Attachment } from "@starbase/core"
import {
  buildPromptInput,
  editStats,
  formatQuestionAnswer,
  PLAN_REFORMAT,
  mapPermissionMode,
  parseSdkQuestions,
  probeContextUsage,
  streamEventsFor,
  toPermissionRequest,
  type ToolMemo
} from "./claude-adapter.js"
import type { SessionSpec } from "./adapter.js"

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
    expect(mapPermissionMode("accept-edits")).toBe("acceptEdits")
    expect(mapPermissionMode("ask")).toBe("default")
  })

  it("maps 'auto' to 'default', never 'bypassPermissions'", () => {
    // "bypassPermissions" makes the SDK skip canUseTool entirely
    // (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), which silently disables the
    // ExitPlanMode / AskUserQuestion interception that callback also owns — an
    // auto-mode session would swallow every question the agent asks. Gating is
    // unaffected: `verdict()` in agent-runner already allows everything in auto.
    expect(mapPermissionMode("auto")).toBe("default")
  })
})

describe("PLAN_REFORMAT", () => {
  it("names the missing block and tells the agent how to re-submit", () => {
    // Handed back through deny.message when a plan skips the fence — it's the only
    // channel that reaches the agent, so it has to be self-contained.
    expect(PLAN_REFORMAT).toContain("```plan")
    expect(PLAN_REFORMAT).toContain("ExitPlanMode")
    expect(PLAN_REFORMAT).toMatch(/summary/)
    expect(PLAN_REFORMAT).toMatch(/intent/)
  })

  it("asks for a reformat, NOT a different plan", () => {
    // A revision would restart the planning work; we only want the same plan back
    // in the right shape.
    expect(PLAN_REFORMAT.toLowerCase()).toContain("same plan")
    expect(PLAN_REFORMAT.toLowerCase()).toContain("only its format")
  })
})

describe("buildPromptInput", () => {
  const spec = (over: Partial<SessionSpec>): SessionSpec => ({
    cli: "claude",
    repo: "",
    branch: "",
    cwd: "",
    prompt: "do the thing",
    images: [],
    binPath: null,
    mode: "accept-edits",
    model: null,
    resumeId: null,
    ...over
  })
  const image = (name: string): Attachment => ({ id: name, name, mediaType: "image/png", data: "aGk=" })

  it("returns the plain string prompt when there are no attachments", () => {
    expect(buildPromptInput(spec({}), undefined)).toBe("do the thing")
  })

  it("interleaves the text with base64 image blocks in a single user message", async () => {
    const input = buildPromptInput(spec({ images: [image("a.png"), image("b.png")] }), "sess-42")
    expect(typeof input).not.toBe("string")
    const msgs: Array<Record<string, unknown>> = []
    for await (const m of input as AsyncIterable<Record<string, unknown>>) msgs.push(m)
    expect(msgs).toHaveLength(1)
    const message = msgs[0]!
    expect(message.type).toBe("user")
    expect(message.session_id).toBe("sess-42")
    const content = (message.message as { content: Array<Record<string, unknown>> }).content
    expect(content[0]).toStrictEqual({ type: "text", text: "do the thing" })
    expect(content[1]).toStrictEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGk=" }
    })
    expect(content).toHaveLength(3) // text + 2 images
  })

  it("omits the text block for an image-only prompt", async () => {
    const input = buildPromptInput(spec({ prompt: "", images: [image("a.png")] }), undefined)
    const msgs: Array<Record<string, unknown>> = []
    for await (const m of input as AsyncIterable<Record<string, unknown>>) msgs.push(m)
    const content = (msgs[0]!.message as { content: Array<Record<string, unknown>> }).content
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe("image")
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
  it("counts added/removed lines and builds a unified hunk (context + added) for an Edit", () => {
    const { diff, preview } = editStats("Edit", { old_string: "a", new_string: "a\nb\nc" })
    expect(diff).toStrictEqual({ added: 3, removed: 1 })
    // "a" is the shared context line; "b"/"c" are the added lines. Each line's
    // first char is the marker (" " context, "+" added).
    expect(preview).toBe(" a\n+b\n+c")
  })

  it("shows removed and added lines around a real edit, with surrounding context", () => {
    const { preview } = editStats("Edit", {
      old_string: "import x\nconst a = 1\nexport a",
      new_string: "import x\nconst a = 2\nexport a"
    })
    expect(preview).toBe(" import x\n-const a = 1\n+const a = 2\n export a")
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

  it("turns an authentication failure into an actionable failed event", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        error: "authentication_failed",
        message: { content: [] }
      }),
      new Map()
    )

    expect(events).toStrictEqual([
      {
        _tag: "Failed",
        message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
      }
    ])
  })

  it("reports the latest full context, including cached input", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hi" }],
          usage: {
            // These top-level values are cumulative across the request's server
            // loop. The final iteration is the actual context window.
            input_tokens: 1800,
            output_tokens: 500,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 1200,
            iterations: [
              {
                type: "message",
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 10,
                cache_read_input_tokens: 700
              },
              {
                type: "message",
                input_tokens: 150,
                output_tokens: 30,
                cache_creation_input_tokens: 20,
                cache_read_input_tokens: 1100
              }
            ]
          }
        }
      }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "Usage", tokens: 1300 }])
  })

  /**
   * The result message's usage is the run's CUMULATIVE spend: every sampling
   * call in the turn, so a resident 90k context is counted once per tool call.
   * Reading it as occupancy is what made a long tool-using turn report ~600k on
   * a 200k model and compact on every single turn — so it must reach `Done`
   * (where it is billed) and never a `Usage` (where it would be believed).
   */
  it("reports the result's cumulative usage as spend, never as a context reading", () => {
    const events = streamEventsFor(
      msg({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 1.25,
        usage: {
          input_tokens: 400,
          output_tokens: 900,
          cache_creation_input_tokens: 2_000,
          // Ten tool calls against the same resident context.
          cache_read_input_tokens: 900_000
        }
      }),
      new Map()
    )
    expect(events.some((e) => e._tag === "Usage")).toBe(false)
    expect(events).toStrictEqual([{ _tag: "Done", costUsd: 1.25, tokens: 903_300 }])
  })

  it("does not emit Usage for a sub-agent's assistant message (only the main run drives the readout)", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        parent_tool_use_id: "task_1",
        message: { content: [{ type: "text", text: "child" }], usage: { input_tokens: 50, output_tokens: 10 } }
      }),
      new Map()
    )
    expect(events.some((e) => e._tag === "Usage")).toBe(false)
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
      { _tag: "ToolEnd", id: "tu_1", status: "success", meta: null, diff: { added: 2, removed: 1 }, preview: " a\n+b" }
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

  it("keeps what a command printed, so the card can show it", () => {
    const tools = new Map<string, ToolMemo>([["tu_1", { name: "Bash", input: { command: "pnpm test" } }]])
    const events = streamEventsFor(
      msg({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "2 passed\nDone in 2.6s" }
          ]
        }
      }),
      tools
    )
    expect(events[0]).toMatchObject({ _tag: "ToolEnd", id: "tu_1", output: "2 passed\nDone in 2.6s" })
  })

  it("leaves an edit's result out — its card already shows the diff", () => {
    const tools = new Map<string, ToolMemo>([["tu_1", { name: "Edit", input: { old_string: "a", new_string: "b" } }]])
    const events = streamEventsFor(
      msg({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "ok" }] }
      }),
      tools
    )
    // Storing the "ok" ack would add nothing and cost transcript size on every edit.
    expect(events[0]).not.toHaveProperty("output")
  })

  it("caps a huge output, keeping BOTH ends and saying what it dropped", () => {
    // Output rides the RPC and is persisted, so a big test log can't go in whole.
    // Which end matters depends on the command — a compile error leads with its
    // failures, a test run closes with the summary — so both survive.
    const huge = `FIRST_LINE\n${"x".repeat(50_000)}\nLAST_LINE`
    const tools = new Map<string, ToolMemo>([["tu_1", { name: "Bash", input: {} }]])
    const events = streamEventsFor(
      msg({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: huge }] }
      }),
      tools
    )
    const output = (events[0] as { output?: string }).output!
    expect(output.length).toBeLessThan(huge.length)
    expect(output).toContain("FIRST_LINE")
    expect(output).toContain("LAST_LINE")
    // A silent cut would read as "that is all it printed".
    expect(output).toMatch(/characters omitted/)
  })

  it("names the skill on a Skill call, so the card isn't just \"Skill\"", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "s1", name: "Skill", input: { skill: "babysit-pr", args: "46" } }
          ]
        }
      }),
      new Map()
    )
    expect(events[0]).toMatchObject({ _tag: "ToolStart", name: "Skill", target: "babysit-pr 46" })
  })

  it("names a skill invoked without arguments", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "verify" } }] }
      }),
      new Map()
    )
    expect(events[0]).toMatchObject({ _tag: "ToolStart", target: "verify" })
  })

  it("maps the result message to Done with cost + terminal context", () => {
    const events = streamEventsFor(
      msg({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 500
        }
      }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "Done", costUsd: 0.42, tokens: 650 }])
  })

  it("maps an errored result to Failed instead of silently completing", () => {
    const events = streamEventsFor(
      msg({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Claude Code is not logged in."],
        total_cost_usd: 0,
        usage: {}
      }),
      new Map()
    )

    expect(events).toStrictEqual([{ _tag: "Failed", message: "Claude Code is not logged in." }])
  })
})

describe("streamEventsFor — sub-agents", () => {
  it("opens a sub-agent tab (SubagentStarted) plus a main-turn anchor card for a Task spawn", () => {
    const tools = new Map<string, ToolMemo>()
    const events = streamEventsFor(
      msg({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "task_1",
              name: "Task",
              input: { subagent_type: "Explore", description: "Map the tab bar" }
            }
          ]
        }
      }),
      tools
    )
    expect(events).toStrictEqual([
      // parentId null = spawned by the MAIN agent (a top-level tab).
      { _tag: "SubagentStarted", id: "task_1", name: "Explore", description: "Map the tab bar", parentId: null },
      // The Task's own ToolStart is untagged so it anchors a card in the main turn.
      { _tag: "ToolStart", id: "task_1", name: "Task", target: "Map the tab bar" }
    ])
    expect(tools.get("task_1")?.name).toBe("Task")
  })

  it("tags a sub-agent's own output with its agentId (parent_tool_use_id)", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        parent_tool_use_id: "task_1",
        message: {
          content: [
            { type: "thinking", thinking: "reading files" },
            { type: "tool_use", id: "read_1", name: "Read", input: { file_path: "a.ts" } }
          ]
        }
      }),
      new Map()
    )
    expect(events).toStrictEqual([
      { _tag: "Thinking", text: "reading files", seconds: null, done: true, agentId: "task_1" },
      { _tag: "ToolStart", id: "read_1", name: "Read", target: "a.ts", agentId: "task_1" }
    ])
  })

  it("tags a sub-agent's streamed text with its agentId", () => {
    const events = streamEventsFor(
      msg({
        type: "stream_event",
        parent_tool_use_id: "task_1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "found it" } }
      }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "Assistant", text: "found it", agentId: "task_1" }])
  })

  it("does NOT settle the tab on the Task's tool_result (it may be a launch ACK)", () => {
    const tools = new Map<string, ToolMemo>([["task_1", { name: "Task", input: {} }]])
    const events = streamEventsFor(
      msg({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "task_1", is_error: false, content: "done report" }] }
      }),
      tools
    )
    // A BACKGROUNDED Task's tool_result arrives ~150ms after the spawn carrying
    // only "Async agent launched successfully" while the agent runs on for
    // minutes — so the anchor card closes here, but the TAB does not.
    expect(events).toStrictEqual([
      { _tag: "ToolEnd", id: "task_1", status: "success", meta: null, diff: null, preview: null }
    ])
  })

  it("settles the tab on the task_notification bookend (the real completion)", () => {
    const events = streamEventsFor(
      msg({ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "task_1", status: "completed" }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "SubagentEnded", id: "task_1", status: "done" }])
  })

  it("maps a failed/stopped task_notification onto an error status", () => {
    for (const status of ["failed", "stopped"] as const) {
      const events = streamEventsFor(
        msg({ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "task_1", status }),
        new Map()
      )
      expect(events).toStrictEqual([{ _tag: "SubagentEnded", id: "task_1", status: "error" }])
    }
  })

  it("ignores a task_notification with no tool_use_id (ambient/workflow tasks have no tab)", () => {
    const events = streamEventsFor(
      msg({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed" }),
      new Map()
    )
    expect(events).toStrictEqual([])
  })

  it("ignores other system subtypes (task_started/task_updated drive nothing here)", () => {
    // SubagentStarted comes from the assistant tool_use block, which is the only
    // message carrying `parent_tool_use_id` — i.e. the nesting parent.
    expect(
      streamEventsFor(
        msg({ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "task_1", description: "d" }),
        new Map()
      )
    ).toStrictEqual([])
  })

  it("opens a NESTED tab for a Task spawned BY a sub-agent, parented to its spawner", () => {
    const events = streamEventsFor(
      msg({
        type: "assistant",
        parent_tool_use_id: "task_1",
        message: {
          content: [{ type: "tool_use", id: "task_2", name: "Task", input: { subagent_type: "Explore", description: "nested" } }]
        }
      }),
      new Map()
    )
    // The nested agent gets its own tab (parentId = its spawner), and the anchor
    // card lands in the SPAWNER's transcript (agentId: task_1) — not the main turn.
    expect(events).toStrictEqual([
      { _tag: "SubagentStarted", id: "task_2", name: "Explore", description: "nested", parentId: "task_1" },
      { _tag: "ToolStart", id: "task_2", name: "Task", target: "nested", agentId: "task_1" }
    ])
  })

  it("anchors a nested Task's ToolEnd in its spawner's tab, settling via the bookend", () => {
    const tools = new Map<string, ToolMemo>([["task_2", { name: "Task", input: {} }]])
    const events = streamEventsFor(
      msg({
        type: "user",
        parent_tool_use_id: "task_1",
        message: { content: [{ type: "tool_result", tool_use_id: "task_2", is_error: false, content: "nested report" }] }
      }),
      tools
    )
    // The card closes in the SPAWNER's transcript (agentId: task_1); the nested
    // tab itself settles on task_2's own `task_notification`.
    expect(events).toStrictEqual([
      { _tag: "ToolEnd", id: "task_2", status: "success", meta: null, diff: null, preview: null, agentId: "task_1" }
    ])
    // The bookend is what settles the nested tab — and needs no parent context.
    expect(
      streamEventsFor(
        msg({ type: "system", subtype: "task_notification", task_id: "a2", tool_use_id: "task_2", status: "completed" }),
        new Map()
      )
    ).toStrictEqual([{ _tag: "SubagentEnded", id: "task_2", status: "done" }])
  })

  it("keeps a nested sub-agent's own output tagged with its own id (routes to its tab)", () => {
    const events = streamEventsFor(
      msg({
        type: "stream_event",
        parent_tool_use_id: "task_2",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "deep" } }
      }),
      new Map()
    )
    expect(events).toStrictEqual([{ _tag: "Assistant", text: "deep", agentId: "task_2" }])
  })
})

describe("plan mode + AskUserQuestion (canUseTool path)", () => {
  it("maps our 'plan' mode onto the SDK's plan permission mode", () => {
    expect(mapPermissionMode("plan")).toBe("plan")
    expect(mapPermissionMode("accept-edits")).toBe("acceptEdits")
    expect(mapPermissionMode("ask")).toBe("default")
  })

  it("keeps canUseTool live in every mode, so questions/plans are never shadowed", () => {
    // The SDK consults canUseTool in every mode EXCEPT bypassPermissions, so no
    // mode may map to it — see the mapPermissionMode docblock.
    const modes: ReadonlyArray<PermissionMode> = ["auto", "ask", "accept-edits", "plan"]
    for (const mode of modes) {
      expect(mapPermissionMode(mode)).not.toBe("bypassPermissions")
    }
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

/**
 * The end-of-turn context probe.
 *
 * This is the number compaction now runs on, so what matters is that it is
 * either the harness's own measurement or nothing at all — a probe that guessed
 * on failure would reintroduce exactly the class of bug it replaces.
 */
describe("probeContextUsage", () => {
  const query = (over: Record<string, unknown>) =>
    ({ getContextUsage: async () => over }) as unknown as Parameters<typeof probeContextUsage>[0]

  it("reads the harness's own occupancy and raw ceiling", async () => {
    const probe = await probeContextUsage(
      query({ totalTokens: 143_210, maxTokens: 176_000, rawMaxTokens: 200_000 })
    )
    expect(probe).toStrictEqual({ tokens: 143_210, window: 200_000 })
  })

  // `maxTokens` is already discounted by the CLI's own autocompact reserve.
  // Taking it would stack that reserve on the safety margin in `triggerAt` and
  // compact materially earlier than the budget asks for — so it is only a
  // fallback for a harness that doesn't report the raw figure.
  it("falls back to maxTokens only when no raw ceiling is reported", async () => {
    const probe = await probeContextUsage(query({ totalTokens: 1_000, maxTokens: 176_000 }))
    expect(probe?.window).toBe(176_000)
  })

  it("returns null when the CLI is too old to answer", async () => {
    expect(await probeContextUsage({} as Parameters<typeof probeContextUsage>[0])).toBeNull()
  })

  it("returns null rather than a zero reading", async () => {
    expect(await probeContextUsage(query({ totalTokens: 0, rawMaxTokens: 200_000 }))).toBeNull()
  })

  it("returns null when the control request throws", async () => {
    const throwing = {
      getContextUsage: async () => {
        throw new Error("worker gone")
      }
    } as unknown as Parameters<typeof probeContextUsage>[0]
    expect(await probeContextUsage(throwing)).toBeNull()
  })
})
