import { applyStreamEvent, assistantMessage } from "@starbase/core"
import type { ThreadEvent } from "@openai/codex-sdk"
import { describe, expect, it } from "vitest"
import {
  agentReply,
  codexCompletionEvents,
  codexTurnTokens,
  codexEventToStreamEvents,
  mapCodexReasoning,
  mapCodexPolicy,
  rememberThread,
  threadIdFor
} from "./codex-adapter.js"

/**
 * Codex's live path needs a real `codex` login, so we test the PURE seam — the
 * mode→policy mapping and the ThreadEvent→StreamEvent fold that the transcript,
 * tool cards and Done depend on. The socket/process wiring is verified live.
 */

const ev = (e: unknown): ThreadEvent => e as ThreadEvent

describe("mapCodexReasoning", () => {
  it("leaves default unset and uses native Codex effort names", () => {
    expect(mapCodexReasoning(undefined)).toBeUndefined()
    expect(mapCodexReasoning("off")).toBe("minimal")
    expect(mapCodexReasoning("think")).toBe("medium")
    expect(mapCodexReasoning("think-hard")).toBe("high")
    expect(mapCodexReasoning("ultrathink")).toBe("xhigh")
  })
})

describe("mapCodexPolicy", () => {
  it("gives auto full access, accept-edits workspace writes, and ask safe read-only", () => {
    expect(mapCodexPolicy("auto")).toStrictEqual({ sandboxMode: "danger-full-access", approvalPolicy: "never" })
    expect(mapCodexPolicy("accept-edits")).toStrictEqual({ sandboxMode: "workspace-write", approvalPolicy: "never" })
    expect(mapCodexPolicy("ask")).toStrictEqual({ sandboxMode: "read-only", approvalPolicy: "never" })
  })

  /**
   * The sandbox is the ONLY thing standing between a read-only run and the
   * worktree on this harness: `runCodex` never calls `ctx.canUseTool`, so a
   * caller that denies every gated action (the adversarial reviewer) gets zero
   * protection from that callback. Without this, a Codex review would run
   * `workspace-write` + approval `never` over the branch it must not touch.
   */
  it("read-only overrides every mode, including auto", () => {
    for (const mode of ["ask", "accept-edits", "plan", "auto"] as const) {
      expect(mapCodexPolicy(mode, true)).toStrictEqual({
        sandboxMode: "read-only",
        approvalPolicy: "never"
      })
    }
  })

  it("defaults to not read-only, so ordinary sessions are unaffected", () => {
    expect(mapCodexPolicy("ask")).toStrictEqual(mapCodexPolicy("ask", false))
  })

  /**
   * Plan mode's entire promise is that the agent CANNOT edit until the operator
   * approves. On Claude the SDK's own plan permission mode keeps that promise;
   * Codex has no equivalent, so the sandbox is the only thing keeping it. Before
   * this branch existed `plan` fell through to `workspace-write` and a planning
   * turn could rewrite the worktree while claiming to be planning.
   */
  it("plan mode is read-only even without an explicit readOnly flag", () => {
    expect(mapCodexPolicy("plan")).toStrictEqual({
      sandboxMode: "read-only",
      approvalPolicy: "never"
    })
    // And it is not quietly widened by the flags that widen other modes.
    expect(mapCodexPolicy("plan", false, false)).toStrictEqual({
      sandboxMode: "read-only",
      approvalPolicy: "never"
    })
  })

  it("still widens once an approved plan restores a real exec mode", () => {
    // The approval path re-opens the thread with the RESTORED mode, not "plan" —
    // if this widened nothing, an approved plan could never be carried out.
    expect(mapCodexPolicy("accept-edits").sandboxMode).toBe("workspace-write")
  })
})

describe("agentReply", () => {
  /**
   * Codex has no `canUseTool` and no `ExitPlanMode`, so BOTH out-of-band
   * channels arrive as fenced blocks in an ordinary message. This is the one
   * place that decides what "the model talking" means; without it the question
   * and plan interceptions each re-derived it and could drift apart.
   */
  it("returns the text of a completed agent message", () => {
    expect(
      agentReply(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "hello" } }))
    ).toBe("hello")
  })

  /**
   * A block is only answerable once the message is whole — reading a partial one
   * would parse a half-written fence and propose a truncated plan.
   */
  it("ignores an in-progress message", () => {
    expect(
      agentReply(ev({ type: "item.started", item: { id: "m1", type: "agent_message", text: "hel" } }))
    ).toBe(null)
  })

  it("ignores every non-message event", () => {
    expect(agentReply(ev({ type: "thread.started", thread_id: "t1" }))).toBe(null)
    expect(agentReply(ev({ type: "turn.completed", usage: {} }))).toBe(null)
    expect(
      agentReply(ev({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls" } }))
    ).toBe(null)
  })

  it("preserves an empty reply as empty rather than as absent", () => {
    // "" is the model saying nothing; null is a different event entirely. A
    // conflation here would make `reply !== null` skip a real (if useless) turn.
    expect(
      agentReply(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "" } }))
    ).toBe("")
  })
})

describe("codexEventToStreamEvents", () => {
  it("maps thread.started to Started carrying Codex's OWN thread id (persisted as the resume id)", () => {
    expect(codexEventToStreamEvents(ev({ type: "thread.started", thread_id: "t1" }), "s1")).toStrictEqual([
      { _tag: "Started", sessionId: "t1" }
    ])
  })

  it("falls back to the Starbase session key when thread.started has no thread id", () => {
    expect(codexEventToStreamEvents(ev({ type: "thread.started" }), "s1")).toStrictEqual([
      { _tag: "Started", sessionId: "s1" }
    ])
  })

  it("maps a command execution start/complete to a Bash tool card", () => {
    const startedTools = new Set<string>()
    const start = codexEventToStreamEvents(
      ev({ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } }),
      "s1",
      startedTools
    )
    expect(start).toStrictEqual([{ _tag: "ToolStart", id: "c1", name: "Bash", target: "npm test" }])

    const end = codexEventToStreamEvents(
      ev({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 0, status: "completed" } }),
      "s1",
      startedTools
    )
    // codex keeps a command's output in `aggregated_output`; surface it as the
    // card's authoritative output (the bash widgets read it), not a dropped field.
    expect(end).toStrictEqual([
      { _tag: "ToolEnd", id: "c1", status: "success", meta: "exit 0", diff: null, preview: null, output: "ok" }
    ])
  })

  it("omits output on a command that printed nothing, rather than an empty string", () => {
    const end = codexEventToStreamEvents(
      ev({ type: "item.completed", item: { id: "c2", type: "command_execution", command: "true", aggregated_output: "", exit_code: 0, status: "completed" } }),
      "s1"
    )
    expect(end).toStrictEqual([
      { _tag: "ToolStart", id: "c2", name: "Bash", target: "true" },
      { _tag: "ToolEnd", id: "c2", status: "success", meta: "exit 0", diff: null, preview: null }
    ])
  })

  it("streams a running command's aggregated output as a ToolDelta on item.updated", () => {
    const tick = codexEventToStreamEvents(
      ev({ type: "item.updated", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "RUN  v2\n ✓ a\n", status: "in_progress" } }),
      "s1"
    )
    // Same id as the ToolStart, so it folds onto that running card. Cumulative
    // snapshot, capped the same way as final output.
    expect(tick).toStrictEqual([
      { _tag: "ToolStart", id: "c1", name: "Bash", target: "npm test" },
      { _tag: "ToolDelta", id: "c1", output: "RUN  v2\n ✓ a\n" }
    ])
  })

  it("does not emit a ToolDelta before a running command has printed anything", () => {
    expect(
      codexEventToStreamEvents(
        ev({ type: "item.updated", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } }),
        "s1"
      )
    ).toStrictEqual([])
  })

  it("maps a file_change completion to an Edit tool card with a file count", () => {
    const end = codexEventToStreamEvents(
      ev({
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }], status: "completed" }
      }),
      "s1"
    )
    expect(end).toStrictEqual([
      { _tag: "ToolStart", id: "f1", name: "Edit", target: "src/a.ts" },
      { _tag: "ToolEnd", id: "f1", status: "success", meta: "2 files", diff: null, preview: null }
    ])
  })

  it("produces a settled edit card when Codex emits only file_change completion", () => {
    const events = codexEventToStreamEvents(
      ev({
        type: "item.completed",
        item: {
          id: "f1",
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "update" }],
          status: "completed"
        }
      }),
      "s1"
    )
    const message = events.reduce(
      (current, event) => applyStreamEvent(current, event),
      assistantMessage("a1", "2026-07-23T00:00:00.000Z")
    )
    expect(message.parts).toMatchObject([
      {
        _tag: "Tool",
        tool: { id: "f1", name: "Edit", target: "src/a.ts", status: "success" }
      }
    ])
  })

  it("preserves MCP failures and Codex todo-list progress", () => {
    const failed = codexEventToStreamEvents(
      ev({
        type: "item.completed",
        item: {
          id: "mcp1",
          type: "mcp_tool_call",
          server: "github",
          tool: "create_issue",
          arguments: {},
          error: { message: "permission denied" },
          status: "failed"
        }
      }),
      "s1"
    )
    expect(failed.at(-1)).toMatchObject({
      _tag: "ToolEnd",
      status: "error",
      output: "permission denied"
    })

    const todo = codexEventToStreamEvents(
      ev({
        type: "item.completed",
        item: {
          id: "todo1",
          type: "todo_list",
          items: [
            { text: "Inspect", completed: true },
            { text: "Fix", completed: false }
          ]
        }
      }),
      "s1"
    )
    expect(todo).toStrictEqual([
      { _tag: "ToolStart", id: "todo1", name: "Todo", target: null },
      {
        _tag: "ToolEnd",
        id: "todo1",
        status: "success",
        meta: "1/2 done",
        diff: null,
        preview: null,
        output: "[x] Inspect\n[ ] Fix"
      }
    ])
  })

  it("accepts Codex's runtime null MCP error on a successful connector call", () => {
    const events = codexEventToStreamEvents(
      ev({
        type: "item.completed",
        item: {
          id: "mcp-null-error",
          type: "mcp_tool_call",
          server: "posthog",
          tool: "exec",
          arguments: {},
          result: { content: [], structured_content: { rows: 1 } },
          error: null,
          status: "completed"
        }
      }),
      "s1"
    )
    expect(events.at(-1)).toMatchObject({
      _tag: "ToolEnd",
      status: "success",
      output: '{"rows":1}'
    })
  })

  it("maps agent_message and reasoning completions to Assistant / Thinking", () => {
    expect(
      codexEventToStreamEvents(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } }), "s1")
    ).toStrictEqual([{ _tag: "Assistant", text: "Done." }])
    expect(
      codexEventToStreamEvents(ev({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "planning" } }), "s1")
    ).toStrictEqual([{ _tag: "Thinking", text: "planning", seconds: null, done: true }])
  })

  // Production fixture from s_royal-liskov. Codex's SDK reported 2,979,284
  // cumulative tokens at turn completion while its persisted token-count event
  // reported only 193,496 tokens resident in a 258,400-token window. The SDK
  // number is useful spend data, but it must never drive context compaction.
  it("keeps cumulative turn spend out of context occupancy", () => {
    expect(
      codexEventToStreamEvents(
        ev({
          type: "turn.completed",
          usage: {
            input_tokens: 2_961_789,
            cached_input_tokens: 2_758_656,
            output_tokens: 17_495,
            reasoning_output_tokens: 10_295
          }
        }),
        "s1"
      )
    ).toStrictEqual([{ _tag: "Done", costUsd: 0, tokens: 2_979_284 }])
    expect(
      codexEventToStreamEvents(ev({ type: "turn.failed", error: { message: "boom" } }), "s1")
    ).toStrictEqual([{ _tag: "Failed", message: "boom" }])
  })

  it("emits authoritative occupancy before cumulative spend settles the turn", () => {
    const usage = {
      input_tokens: 2_961_789,
      cached_input_tokens: 2_758_656,
      output_tokens: 17_495,
      reasoning_output_tokens: 10_295
    }
    expect(
      codexCompletionEvents(usage, { tokens: 193_496, window: 258_400 }, true)
    ).toStrictEqual([
      { _tag: "Usage", tokens: 193_496, window: 258_400 },
      { _tag: "Done", costUsd: 0, tokens: 2_979_284 }
    ])
    expect(
      codexCompletionEvents(usage, { tokens: 193_496, window: 258_400 }, false)
    ).toStrictEqual([{ _tag: "Usage", tokens: 193_496, window: 258_400 }])
    expect(codexCompletionEvents(usage, null, true)).toStrictEqual([
      { _tag: "Done", costUsd: 0, tokens: 2_979_284 }
    ])
  })

  /**
   * `fresh` was silently ignored here while Claude and opencode honoured it, so
   * BOTH one-shot callers quietly no-opped on Codex: the adversarial reviewer
   * resumed the previous review's thread, and a compaction resumed the very
   * conversation it had just summarised — paying for the digest and shedding
   * nothing. Only an app restart cleared it.
   */
  describe("fresh threads", () => {
    it("resumes the live thread on a normal turn", () => {
      const resume = new Map<string, string>([["s1", "thread_live"]])
      expect(threadIdFor({ resume, sessionId: "s1", resumeId: "thread_persisted" })).toBe("thread_live")
    })

    it("falls back to the persisted id after a restart cleared the map", () => {
      expect(
        threadIdFor({ resume: new Map(), sessionId: "s1", resumeId: "thread_persisted" })
      ).toBe("thread_persisted")
    })

    // The map WINS over the spec, so clearing the persisted id is not enough on
    // its own — this is the case that was broken.
    it("starts a brand-new thread when fresh, even with a live thread in the map", () => {
      const resume = new Map<string, string>([["s1", "thread_live"]])
      expect(
        threadIdFor({ resume, sessionId: "s1", resumeId: "thread_persisted", fresh: true })
      ).toBeUndefined()
    })

    it("leaves no trace, so the next turn cannot resume the one-shot thread", () => {
      const resume = new Map<string, string>()
      rememberThread({ resume, sessionId: "s1", threadId: "thread_oneshot", fresh: true })
      expect(resume.has("s1")).toBe(false)
      rememberThread({ resume, sessionId: "s1", threadId: "thread_real" })
      expect(resume.get("s1")).toBe("thread_real")
    })
  })

  describe("codexTurnTokens", () => {
    // The subset trap. `cached_input_tokens` is part of `input_tokens` (codex
    // derives non-cached input by subtracting it) and `reasoning_output_tokens`
    // is part of `output_tokens`. Summing all four double-counts both — and on a
    // long, heavily-cached session the cache IS most of the input, so the reading
    // would run to nearly double reality and compact at half the real budget.
    it("excludes cached input, which is a subset of input_tokens", () => {
      expect(
        codexTurnTokens({ input_tokens: 100_000, cached_input_tokens: 90_000, output_tokens: 2_000 })
      ).toBe(102_000)
    })

    it("excludes reasoning output, which is a subset of output_tokens", () => {
      expect(
        codexTurnTokens({ input_tokens: 1_000, output_tokens: 500, reasoning_output_tokens: 400 })
      ).toBe(1_500)
    })

    // A malformed or partial usage payload must read as 0 — which `contextPhase`
    // treats as idle — rather than NaN, which would poison every comparison
    // downstream and silently disable compaction for the session.
    it("degrades to zero on a missing or malformed payload", () => {
      expect(codexTurnTokens({})).toBe(0)
      expect(codexTurnTokens({ input_tokens: Number.NaN, output_tokens: 5 })).toBe(5)
      expect(codexTurnTokens({ input_tokens: -10, output_tokens: 5 })).toBe(5)
      expect(codexTurnTokens(undefined as never)).toBe(0)
    })
  })

  it("ignores intermediate events with no card to fill (turn.started, a non-command item.updated)", () => {
    expect(codexEventToStreamEvents(ev({ type: "turn.started" }), "s1")).toStrictEqual([])
    // Only a running COMMAND streams live output; a mid-flight agent_message is
    // re-sent whole on completion, so an update to it carries no ToolDelta.
    expect(
      codexEventToStreamEvents(ev({ type: "item.updated", item: { id: "m1", type: "agent_message", text: "partial" } }), "s1")
    ).toStrictEqual([])
  })
})

describe("mapCodexPolicy — unattended", () => {
  it("never hands an unattended run full disk access", () => {
    // `auto` is a reasonable choice for a session the operator is supervising.
    // Inheriting it silently for a planning role or a plan step is not: nobody
    // is there to stop it. Codex confines writes to the workspace, which is
    // more than Claude's own default does.
    expect(mapCodexPolicy("auto", false, true).sandboxMode).toBe("workspace-write")
    expect(mapCodexPolicy("auto", false, false).sandboxMode).toBe("danger-full-access")
  })

  it("still prefers read-only when the spec asks for it", () => {
    // Planning roles are read-only AND unattended; the stricter one wins.
    expect(mapCodexPolicy("auto", true, true).sandboxMode).toBe("read-only")
  })

  it("keeps accept-edits writable and ask safely read-only", () => {
    expect(mapCodexPolicy("accept-edits", false, true).sandboxMode).toBe("workspace-write")
    expect(mapCodexPolicy("ask", false, false).sandboxMode).toBe("read-only")
  })
})
