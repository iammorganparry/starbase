import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { GateDecision, Message, PermissionMode, Session, StreamEvent } from "@starbase/core"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliAdapter, makeScriptedCliAdapter, scriptedPlan } from "./adapter.js"
import type { CliAdapterShape } from "./adapter.js"
import { AgentRunner } from "./agent-runner.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { PlanStore } from "./plan-store.js"
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
    PlanStore.Default,
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

describe("AgentRunner sub-agents", () => {
  // An adapter that emits a main line, then a sub-agent's whole lifecycle, then done.
  const subagentAdapter: Layer.Layer<CliAdapter> = Layer.succeed(
    CliAdapter,
    CliAdapter.of({
      run: (_sessionId, _spec, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit({ _tag: "Assistant", text: "main output" })
          yield* ctx.emit({ _tag: "SubagentStarted", id: "task_1", name: "Explore", description: "sub task" })
          yield* ctx.emit({ _tag: "Assistant", text: "SUBTEXT", agentId: "task_1" })
          yield* ctx.emit({ _tag: "ToolStart", id: "r1", name: "Read", target: "a.ts", agentId: "task_1" })
          yield* ctx.emit({ _tag: "SubagentEnded", id: "task_1", status: "done" })
          yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }) as ReturnType<CliAdapterShape["run"]>,
      stop: () => Effect.void
    })
  )

  const runSubagentPrompt = () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      subagentAdapter,
      DiscoveryService.Default,
      temp.layer
    )
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "auto")
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, "fan out").pipe(Stream.runForEach((ev) => Effect.sync(() => events.push(ev))))
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, transcript }
    })
    return Effect.runPromise(program.pipe(Effect.provide(base)))
  }

  it("surfaces sub-agent events downstream but keeps them out of the persisted main turn", async () => {
    const { events, transcript } = await runSubagentPrompt()

    // The renderer still receives the full sub-agent lifecycle.
    expect(events.some((e) => e._tag === "SubagentStarted" && e.id === "task_1")).toBe(true)
    expect(events.some((e) => e._tag === "SubagentEnded" && e.id === "task_1")).toBe(true)
    expect(events.some((e) => e._tag === "Assistant" && e.agentId === "task_1")).toBe(true)

    // But the persisted assistant turn contains ONLY the main output — no
    // sub-agent text and no sub-agent tool card leaked in.
    const assistant = transcript[1]!
    expect(assistant.role).toBe("assistant")
    const text = assistant.parts.filter((p) => p._tag === "Text").map((p) => (p as { text: string }).text).join("")
    expect(text).toContain("main output")
    expect(text).not.toContain("SUBTEXT")
    expect(assistant.parts.some((p) => p._tag === "Tool" && p.tool.id === "r1")).toBe(false)
  })
})

describe("AgentRunner image attachments", () => {
  it("persists attached images on the user turn alongside the text", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      temp.layer
    )
    const image = { id: "img1", name: "login.png", mediaType: "image/png", data: "aGVsbG8=" }
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "auto")
      yield* runner.prompt(SESSION, "look at this", [image]).pipe(Stream.runDrain)
      return yield* TranscriptStore.list(SESSION)
    })
    const transcript = await Effect.runPromise(program.pipe(Effect.provide(base)))

    const user = transcript[0]!
    expect(user.role).toBe("user")
    // The image is persisted as an Image part, before the text part.
    const imagePart = user.parts.find((p) => p._tag === "Image")
    expect(imagePart && imagePart._tag === "Image" && imagePart.attachment).toStrictEqual(image)
    expect(user.parts.some((p) => p._tag === "Text" && p.text === "look at this")).toBe(true)
  })
})

describe("AgentRunner AskUserQuestion", () => {
  it("emits QuestionRequested, resumes on answer, and records it in the transcript", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      temp.layer
    )
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, "[[ask]] migrate the store").pipe(
        // Answer each question group as it arrives.
        Stream.tap((ev) =>
          ev._tag === "QuestionRequested"
            ? runner.answerQuestion(SESSION, ev.request.id, [
                { selected: ["Rotating refresh tokens"], other: null },
                { selected: ["HTTP middleware"], other: null }
              ])
            : Effect.void
        ),
        Stream.runForEach((e) => Effect.sync(() => events.push(e)))
      )
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, transcript }
    })
    const { events, transcript } = await Effect.runPromise(program.pipe(Effect.provide(base)))

    // The run paused for a question and then completed.
    expect(events.some((e) => e._tag === "QuestionRequested")).toBe(true)
    expect(events.some((e) => e._tag === "Done")).toBe(true)
    // The transcript's question part carries the recorded answers (so a reload
    // won't re-show it as pending).
    const qpart = transcript.flatMap((m) => m.parts).find((p) => p._tag === "Question")
    expect(qpart).toBeDefined()
    if (qpart && qpart._tag === "Question") {
      expect(qpart.answers).not.toBeNull()
      expect(qpart.answers?.[0]?.selected).toStrictEqual(["Rotating refresh tokens"])
    }
  })
})

describe("AgentRunner ids", () => {
  // The id counter is in-memory (resets on app restart) but the transcript
  // persists — so a run after a restart must not re-emit colliding ids, which
  // would make the virtualized transcript stack rows keyed by id.
  it("does not reuse message ids across a runner restart", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      temp.layer
    )
    // Each provide of AgentRunner.Default builds a fresh runner (fresh counter),
    // so two separate runs against the same temp root simulate a restart.
    const runOnce = (text: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runner = yield* AgentRunner
          yield* runner.setMode(SESSION, "auto")
          yield* runner.prompt(SESSION, text).pipe(Stream.runDrain)
        }).pipe(Effect.provide(base))
      )

    await runOnce("first")
    await runOnce("second")

    const transcript = await Effect.runPromise(
      TranscriptStore.list(SESSION).pipe(Effect.provide(Layer.merge(TranscriptStore.Default, temp.layer)))
    )
    const ids = transcript.map((m) => m.id)
    expect(ids.length).toBeGreaterThan(2)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("AgentRunner allowlist", () => {
  it('"always allow" a command means the next run does not gate it', async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
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

describe("AgentRunner plan mode", () => {
  const base = () =>
    Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      temp.layer
    )

  const planParts = (transcript: ReadonlyArray<Message>) => {
    const out: Array<Extract<Message["parts"][number], { _tag: "Plan" }>> = []
    for (const m of transcript) for (const p of m.parts) if (p._tag === "Plan") out.push(p)
    return out
  }

  /** Seed a session on disk so `SessionStore.get`/`setMode` have a record to patch. */
  const seedSession = (mode: PermissionMode) => {
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
      updatedAt: "2026-07-11T10:00:00.000Z",
      mode
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))
  }

  it("proposes a plan, records a step comment, and executes on approval", async () => {
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "plan")
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
        Stream.tap((ev) =>
          ev._tag === "PlanProposed"
            ? runner
                .commentPlanStep(SESSION, ev.plan.id, "s_4a", "Guard the refresh loop.")
                .pipe(Effect.zipRight(runner.approvePlan(SESSION, ev.plan.id)))
            : Effect.void
        ),
        Stream.runForEach((e) => Effect.sync(() => events.push(e)))
      )
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, transcript }
    })
    const { events, transcript } = await Effect.runPromise(program.pipe(Effect.provide(base())))

    expect(events.some((e) => e._tag === "PlanProposed")).toBe(true)
    // Execution started only after approval.
    expect(ranTool(events, "plan-edit-1")).toBe(true)
    expect(events.some((e) => e._tag === "Done")).toBe(true)

    const parts = planParts(transcript)
    expect(parts).toHaveLength(1)
    const plan = parts[0]!.plan
    expect(plan.status).toBe("approved")
    expect(plan.comments.map((c) => c.body)).toContain("Guard the refresh loop.")
    expect(plan.steps.find((s) => s.id === "s_4a")?.flagged).toBe(true)
  })

  it("marks a plan step done when an executed edit touches one of its files", async () => {
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "plan")
      yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
        Stream.tap((ev) => (ev._tag === "PlanProposed" ? runner.approvePlan(SESSION, ev.plan.id) : Effect.void)),
        Stream.runDrain
      )
      return yield* TranscriptStore.list(SESSION)
    })
    const transcript = await Effect.runPromise(program.pipe(Effect.provide(base())))
    const plan = planParts(transcript)[0]!.plan
    const statusOf = (id: string) => plan.steps.find((s) => s.id === id)?.status
    // The scripted approval writes token-store.ts (02), session.ts (03) and
    // session.test.ts (05) — each ties back to its step.
    expect(statusOf("s_02")).toBe("done")
    expect(statusOf("s_03")).toBe("done")
    expect(statusOf("s_05")).toBe("done")
    // A step whose files were never edited stays proposed.
    expect(statusOf("s_06")).toBe("proposed")
  })

  it("restores the exec mode on approval so edits then run without a plan gate", async () => {
    seedSession("accept-edits")
    const mode = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        // Start in accept-edits, switch to plan (captures accept-edits as prior).
        yield* runner.setMode(SESSION, "accept-edits")
        yield* runner.setMode(SESSION, "plan")
        yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
          Stream.tap((ev) =>
            ev._tag === "PlanProposed" ? runner.approvePlan(SESSION, ev.plan.id) : Effect.void
          ),
          Stream.runDrain
        )
        return (yield* SessionStore.get(SESSION)).mode
      }).pipe(Effect.provide(base()))
    )
    expect(mode).toBe("accept-edits")
  })

  it("re-drives execution for a stale plan (no live run): switches out of plan mode and runs", async () => {
    seedSession("plan")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        // Seed a transcript holding the (now orphaned) plan, as after a restart.
        const plan = scriptedPlan(SESSION, 1)
        const msg: Message = {
          id: "a_seed",
          role: "assistant",
          parts: [{ _tag: "Plan", plan }],
          streaming: false,
          createdAt: "2026-07-13T00:00:00.000Z"
        }
        yield* TranscriptStore.append(SESSION, msg)
        const events: Array<StreamEvent> = []
        yield* runner.resumePlan(SESSION, plan.id).pipe(
          Stream.tap((ev) =>
            ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, "allow") : Effect.void
          ),
          Stream.runForEach((ev) => Effect.sync(() => events.push(ev)))
        )
        const mode = (yield* SessionStore.get(SESSION)).mode
        return { events, mode }
      }).pipe(Effect.provide(base()))
    )
    // A fresh run streamed to completion — proving the session left plan mode (else
    // the scripted adapter would re-enter the plan branch and park forever).
    expect(result.events.some((e) => e._tag === "Started")).toBe(true)
    expect(result.events.some((e) => e._tag === "Done")).toBe(true)
    expect(result.mode).not.toBe("plan")
  })

  it("resumePlan streams nothing for an unknown plan id", async () => {
    seedSession("plan")
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        const out: Array<StreamEvent> = []
        yield* runner.resumePlan(SESSION, "nope").pipe(Stream.runForEach((ev) => Effect.sync(() => out.push(ev))))
        return out
      }).pipe(Effect.provide(base()))
    )
    expect(events).toHaveLength(0)
  })

  it("routes an open comment as a revision, then executes the revised plan", async () => {
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "plan")
      const seen: Array<string> = []
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
        Stream.tap((ev) => {
          if (ev._tag !== "PlanProposed") return Effect.void
          const first = seen.length === 0
          seen.push(ev.plan.id)
          return first
            ? runner
                .commentPlanStep(SESSION, ev.plan.id, "s_4a", "Add a single-flight guard.")
                .pipe(Effect.zipRight(runner.revisePlan(SESSION, ev.plan.id)))
            : runner.approvePlan(SESSION, ev.plan.id)
        }),
        Stream.runForEach((e) => Effect.sync(() => events.push(e)))
      )
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, seen, transcript }
    })
    const { events, seen, transcript } = await Effect.runPromise(program.pipe(Effect.provide(base())))

    // The original plan and a distinct revised plan were both proposed.
    expect(new Set(seen).size).toBe(2)
    expect(ranTool(events, "plan-edit-1")).toBe(true)

    const parts = planParts(transcript)
    expect(parts).toHaveLength(2)
    expect(parts[0]!.plan.status).toBe("revising")
    expect(parts[0]!.plan.comments[0]?.routed).toBe(true)
    expect(parts[1]!.plan.status).toBe("approved")
  })

  it("stop rejects a pending plan (no dead buttons on reload)", async () => {
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "plan")
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
        Stream.tap((ev) => (ev._tag === "PlanProposed" ? runner.stop(SESSION) : Effect.void)),
        Stream.runForEach((e) => Effect.sync(() => events.push(e)))
      )
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, transcript }
    })
    const { events, transcript } = await Effect.runPromise(program.pipe(Effect.provide(base())))

    expect(ranTool(events, "plan-edit-1")).toBe(false)
    expect(planParts(transcript)[0]!.plan.status).toBe("rejected")
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
      PlanStore.Default,
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

describe("AgentRunner plan library", () => {
  const WT = "/tmp/starbase/worktrees/starbase/mysession"

  /** Seed a session that owns a worktree (so the runner writes/points at plans). */
  const seedSessionWithWorktree = (mode: PermissionMode) => {
    const session: Session = {
      id: SESSION,
      repo: "acme/widget",
      branch: "starbase/mysession",
      title: "My session",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-11T10:00:00.000Z",
      worktreePath: WT,
      mode
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))
  }

  /** An adapter that records the prompt it was handed, then completes. */
  const recordingAdapter = (out: { prompt: string | null }): Layer.Layer<CliAdapter> =>
    Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: (_sessionId, spec, ctx) =>
          Effect.gen(function* () {
            out.prompt = spec.prompt
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<CliAdapterShape["run"]>,
        stop: () => Effect.void
      })
    )

  it("writes a proposed plan into the session's plan library (~/starbase/.starbase/<worktree>/)", async () => {
    seedSessionWithWorktree("plan")
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      temp.layer
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "plan")
        yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
          Stream.tap((ev) =>
            ev._tag === "PlanProposed" ? runner.approvePlan(SESSION, ev.plan.id) : Effect.void
          ),
          Stream.runDrain
        )
      }).pipe(Effect.provide(base))
    )
    // scriptedPlan's summary "Refactor auth flow" → file "refactor-auth-flow.md",
    // namespaced by the worktree basename, under the app's .starbase library.
    const file = join(temp.root, ".starbase", basename(WT), "refactor-auth-flow.md")
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("Refactor auth flow")
  })

  it("prepends the saved-plan pointer (with the file path) to the next run", async () => {
    seedSessionWithWorktree("auto")
    const captured: { prompt: string | null } = { prompt: null }
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      recordingAdapter(captured),
      DiscoveryService.Default,
      temp.layer
    )
    // A saved plan already exists for this worktree.
    const planFile = await Effect.runPromise(
      PlanStore.write(WT, { ...scriptedPlan("s1", 1), summary: "Ship it", raw: "the full plan" }).pipe(
        Effect.provide(Layer.merge(PlanStore.Default, temp.layer))
      )
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, "please implement the plan").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    expect(captured.prompt).toContain("<saved-plan>")
    expect(captured.prompt).toContain(planFile) // the absolute path is handed over
    // The user's actual text is preserved at the end (the note is only a prefix).
    expect(captured.prompt?.endsWith("please implement the plan")).toBe(true)
  })

  it("does NOT prepend a pointer when the worktree has no saved plan", async () => {
    seedSessionWithWorktree("auto")
    const captured: { prompt: string | null } = { prompt: null }
    const base = Layer.mergeAll(
      AgentRunner.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      PlanStore.Default,
      recordingAdapter(captured),
      DiscoveryService.Default,
      temp.layer
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, "just do X").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    expect(captured.prompt).toBe("just do X")
  })
})
