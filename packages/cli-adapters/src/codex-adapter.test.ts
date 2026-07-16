import type { ThreadEvent } from "@openai/codex-sdk"
import { describe, expect, it } from "vitest"
import { codexEventToStreamEvents, mapCodexPolicy } from "./codex-adapter.js"

/**
 * Codex's live path needs a real `codex` login, so we test the PURE seam — the
 * mode→policy mapping and the ThreadEvent→StreamEvent fold that the transcript,
 * tool cards and Done depend on. The socket/process wiring is verified live.
 */

const ev = (e: unknown): ThreadEvent => e as ThreadEvent

describe("mapCodexPolicy", () => {
  it("gives auto full access, other modes workspace-write (approval never — no callback)", () => {
    expect(mapCodexPolicy("auto")).toStrictEqual({ sandboxMode: "danger-full-access", approvalPolicy: "never" })
    expect(mapCodexPolicy("accept-edits")).toStrictEqual({ sandboxMode: "workspace-write", approvalPolicy: "never" })
    expect(mapCodexPolicy("ask")).toStrictEqual({ sandboxMode: "workspace-write", approvalPolicy: "never" })
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
    const start = codexEventToStreamEvents(
      ev({ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } }),
      "s1"
    )
    expect(start).toStrictEqual([{ _tag: "ToolStart", id: "c1", name: "Bash", target: "npm test" }])

    const end = codexEventToStreamEvents(
      ev({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 0, status: "completed" } }),
      "s1"
    )
    expect(end).toStrictEqual([{ _tag: "ToolEnd", id: "c1", status: "success", meta: "exit 0", diff: null, preview: null }])
  })

  it("maps a file_change completion to an Edit tool card with a file count", () => {
    const end = codexEventToStreamEvents(
      ev({
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }], status: "completed" }
      }),
      "s1"
    )
    expect(end).toStrictEqual([{ _tag: "ToolEnd", id: "f1", status: "success", meta: "2 files", diff: null, preview: null }])
  })

  it("maps agent_message and reasoning completions to Assistant / Thinking", () => {
    expect(
      codexEventToStreamEvents(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } }), "s1")
    ).toStrictEqual([{ _tag: "Assistant", text: "Done." }])
    expect(
      codexEventToStreamEvents(ev({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "planning" } }), "s1")
    ).toStrictEqual([{ _tag: "Thinking", text: "planning", seconds: null, done: true }])
  })

  it("maps turn.completed to Done with summed tokens and turn.failed to Failed", () => {
    expect(
      codexEventToStreamEvents(
        ev({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 } }),
        "s1"
      )
    ).toStrictEqual([{ _tag: "Done", costUsd: 0, tokens: 140 }])
    expect(
      codexEventToStreamEvents(ev({ type: "turn.failed", error: { message: "boom" } }), "s1")
    ).toStrictEqual([{ _tag: "Failed", message: "boom" }])
  })

  it("ignores intermediate events (turn.started, item.updated)", () => {
    expect(codexEventToStreamEvents(ev({ type: "turn.started" }), "s1")).toStrictEqual([])
    expect(
      codexEventToStreamEvents(ev({ type: "item.updated", item: { id: "m1", type: "agent_message", text: "partial" } }), "s1")
    ).toStrictEqual([])
  })
})
