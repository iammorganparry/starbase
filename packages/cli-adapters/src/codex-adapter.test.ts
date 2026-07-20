import type { ThreadEvent } from "@openai/codex-sdk"
import { describe, expect, it } from "vitest"
import {
  codexContextTokens,
  codexEventToStreamEvents,
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
    expect(end).toStrictEqual([{ _tag: "ToolEnd", id: "c2", status: "success", meta: "exit 0", diff: null, preview: null }])
  })

  it("streams a running command's aggregated output as a ToolDelta on item.updated", () => {
    const tick = codexEventToStreamEvents(
      ev({ type: "item.updated", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "RUN  v2\n ✓ a\n", status: "in_progress" } }),
      "s1"
    )
    // Same id as the ToolStart, so it folds onto that running card. Cumulative
    // snapshot, capped the same way as final output.
    expect(tick).toStrictEqual([{ _tag: "ToolDelta", id: "c1", output: "RUN  v2\n ✓ a\n" }])
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

  // A Codex turn resends the whole thread, so the turn's `input_tokens` IS the
  // conversation as the model saw it; adding the reply gives what the next turn
  // inherits. Without this, Codex sessions could never take part in
  // auto-compaction — the reading was hard-coded to 0.
  it("reports context occupancy from turn.completed", () => {
    expect(
      codexEventToStreamEvents(
        ev({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 } }),
        "s1"
      )
    ).toStrictEqual([
      { _tag: "Usage", tokens: 140 },
      { _tag: "Done", costUsd: 0, tokens: 140 }
    ])
    expect(
      codexEventToStreamEvents(ev({ type: "turn.failed", error: { message: "boom" } }), "s1")
    ).toStrictEqual([{ _tag: "Failed", message: "boom" }])
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

  describe("codexContextTokens", () => {
    // The subset trap. `cached_input_tokens` is part of `input_tokens` (codex
    // derives non-cached input by subtracting it) and `reasoning_output_tokens`
    // is part of `output_tokens`. Summing all four double-counts both — and on a
    // long, heavily-cached session the cache IS most of the input, so the reading
    // would run to nearly double reality and compact at half the real budget.
    it("excludes cached input, which is a subset of input_tokens", () => {
      expect(
        codexContextTokens({ input_tokens: 100_000, cached_input_tokens: 90_000, output_tokens: 2_000 })
      ).toBe(102_000)
    })

    it("excludes reasoning output, which is a subset of output_tokens", () => {
      expect(
        codexContextTokens({ input_tokens: 1_000, output_tokens: 500, reasoning_output_tokens: 400 })
      ).toBe(1_500)
    })

    // A malformed or partial usage payload must read as 0 — which `contextPhase`
    // treats as idle — rather than NaN, which would poison every comparison
    // downstream and silently disable compaction for the session.
    it("degrades to zero on a missing or malformed payload", () => {
      expect(codexContextTokens({})).toBe(0)
      expect(codexContextTokens({ input_tokens: Number.NaN, output_tokens: 5 })).toBe(5)
      expect(codexContextTokens({ input_tokens: -10, output_tokens: 5 })).toBe(5)
      expect(codexContextTokens(undefined as never)).toBe(0)
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
