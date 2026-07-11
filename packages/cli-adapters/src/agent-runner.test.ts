import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { GateDecision, PermissionMode, Session, StreamEvent } from "@starbase/core"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliAdapter, makeScriptedCliAdapter } from "./adapter.js"
import { AgentRunner } from "./agent-runner.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { withTempRoot } from "./test-support.js"

/**
 * The runner is the harness-agnostic HITL core. We assert on OUTCOMES the
 * operator observes — which tools ran, which paused for approval, and what got
 * persisted — driving it through the deterministic scripted adapter (delay 0).
 * We never assert on the adapter's internal steps.
 */

let temp: ReturnType<typeof withTempRoot>

beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const SESSION = "s_test"

/** Run one prompt, auto-answering every gate with `decision`; collect events + transcript. */
const runPrompt = (mode: PermissionMode, decision: GateDecision) => {
  const base = Layer.mergeAll(
    AgentRunner.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    makeScriptedCliAdapter(0),
    DiscoveryService.Default,
    temp.layer
  )
  const program = Effect.gen(function* () {
    const runner = yield* AgentRunner
    yield* runner.setMode(SESSION, mode)
    const events: Array<StreamEvent> = []
    yield* runner.prompt(SESSION, "Add rate limiting to the refund endpoint.").pipe(
      Stream.tap((ev) =>
        ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, decision) : Effect.void
      ),
      Stream.runForEach((ev) => Effect.sync(() => events.push(ev)))
    )
    const transcript = yield* TranscriptStore.list(SESSION)
    return { events, transcript }
  })
  return Effect.runPromise(program.pipe(Effect.provide(base)))
}

const gates = (events: ReadonlyArray<StreamEvent>) =>
  events.filter((e): e is Extract<StreamEvent, { _tag: "GateRequested" }> => e._tag === "GateRequested")

const ranTool = (events: ReadonlyArray<StreamEvent>, id: string) =>
  events.some((e) => e._tag === "ToolStart" && e.id === id)

describe("AgentRunner HITL gating", () => {
  it("accept-edits: applies edits without a gate, but pauses for a command", async () => {
    const { events } = await runPrompt("accept-edits", "allow")
    const g = gates(events)
    expect(g).toHaveLength(1)
    expect(g[0]!.gate.kind).toBe("command")
    expect(ranTool(events, "edit-1")).toBe(true) // edit auto-applied
    expect(ranTool(events, "bash-1")).toBe(true) // command ran after approval
  })

  it("ask: pauses for BOTH the edit and the command", async () => {
    const { events } = await runPrompt("ask", "allow")
    const g = gates(events)
    expect(g.map((x) => x.gate.kind)).toStrictEqual(["edit", "command"])
    expect(ranTool(events, "edit-1")).toBe(true)
    expect(ranTool(events, "bash-1")).toBe(true)
  })

  it("auto: runs everything with no gates at all", async () => {
    const { events } = await runPrompt("auto", "deny")
    expect(gates(events)).toHaveLength(0)
    expect(ranTool(events, "edit-1")).toBe(true)
    expect(ranTool(events, "bash-1")).toBe(true)
  })

  it("denying the command gate leaves it unrun", async () => {
    const { events } = await runPrompt("accept-edits", "deny")
    expect(gates(events)).toHaveLength(1)
    expect(ranTool(events, "bash-1")).toBe(false) // command was denied
    expect(events.some((e) => e._tag === "Assistant" && e.text.includes("unrun"))).toBe(true)
  })

  it("persists the transcript as a user turn + a completed assistant turn", async () => {
    const { transcript } = await runPrompt("auto", "allow")
    expect(transcript).toHaveLength(2)
    expect(transcript[0]!.role).toBe("user")
    const assistant = transcript[1]!
    expect(assistant.role).toBe("assistant")
    expect(assistant.streaming).toBe(false)
    // The applied edit's tool card is persisted with its diff.
    const toolPart = assistant.parts.find((p) => p._tag === "Tool" && p.tool.id === "edit-1")
    expect(toolPart && toolPart._tag === "Tool" && toolPart.tool.diff).toStrictEqual({ added: 7, removed: 0 })
  })
})

describe("AgentRunner allowlist", () => {
  it('"always allow" a command means the next run does not gate it', async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      makeScriptedCliAdapter(0),
    DiscoveryService.Default,
      temp.layer
    )
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "accept-edits")

      // First run: "always allow" the command gate.
      yield* runner.prompt(SESSION, "first").pipe(
        Stream.tap((ev) =>
          ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, "always") : Effect.void
        ),
        Stream.runDrain
      )

      // Second run: the same command should now run without any gate.
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, "second").pipe(
        Stream.runForEach((ev) => Effect.sync(() => events.push(ev)))
      )
      return events
    })
    const events = await Effect.runPromise(program.pipe(Effect.provide(base)))
    expect(gates(events)).toHaveLength(0)
    expect(ranTool(events, "bash-1")).toBe(true)
  })
})

describe("AgentRunner model", () => {
  // A harness that reports its real model on init (as the Claude adapter does).
  const modelReportingAdapter = Layer.succeed(
    CliAdapter,
    CliAdapter.of({
      run: (sessionId, _spec, ctx) =>
        ctx
          .emit({ _tag: "Started", sessionId, model: "opus-live" })
          .pipe(Effect.zipRight(ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 }))),
      stop: () => Effect.void
    })
  )

  it("persists the harness's actual model (reported on init) onto the session", async () => {
    // Seed a session on disk so the runner can persist its model back.
    const session: Session = {
      id: SESSION,
      repo: "r",
      branch: "b",
      title: "t",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-11T10:00:00.000Z"
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))

    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      modelReportingAdapter,
      DiscoveryService.Default,
      temp.layer
    )
    const model = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, "hi").pipe(Stream.runDrain)
        const persisted = yield* SessionStore.get(SESSION)
        return persisted.model
      }).pipe(Effect.provide(base))
    )
    expect(model).toBe("opus-live")
  })
})
