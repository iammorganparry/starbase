import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { GateDecision, Message, PermissionMode, Plan, Session, StreamEvent } from "@starbase/core"
import { CliExecError, findApprovedPlan, STOPPED_NOTE } from "@starbase/core"
import { Deferred, Effect, Fiber, Layer, Ref, Stream, TestClock, TestContext } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliAdapter, makeScriptedCliAdapter, scriptedPlan } from "./adapter.js"
import type { CliAdapterShape, PermissionDecision } from "./adapter.js"
import { ConfigService } from "./config.js"
import { AgentRunner } from "./agent-runner.js"
import { ContextManager } from "./context-manager.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
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
    ConfigService.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    PlanStore.Default,
    makeScriptedCliAdapter(0),
    DiscoveryService.Default,
    ContextManager.Default,
    ConfigService.Default,
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

  /**
   * An adapter that asks permission for one command and one edit, then ends.
   * The scripted adapter can't be used here: in plan mode it proposes a plan and
   * blocks on the decision instead of running tools.
   */
  const probeAdapter = (out: {
    command: PermissionDecision | null
    edit: PermissionDecision | null
  }): Layer.Layer<CliAdapter> =>
    Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: (_sessionId, _spec, ctx) =>
          Effect.gen(function* () {
            out.command = yield* ctx.canUseTool({
              kind: "command",
              tool: "Bash",
              target: null,
              command: "git log --oneline -5"
            })
            out.edit = yield* ctx.canUseTool({
              kind: "edit",
              tool: "Edit",
              target: "src/auth/session.ts",
              command: null
            })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<CliAdapterShape["run"]>,
        stop: () => Effect.void
      })
    )

  const probe = (mode: PermissionMode) => {
    const out: { command: PermissionDecision | null; edit: PermissionDecision | null } = {
      command: null,
      edit: null
    }
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      PlanStore.Default,
      probeAdapter(out),
      DiscoveryService.Default,
      ContextManager.Default,
      temp.layer
    )
    return Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, mode)
        yield* runner.prompt(SESSION, "how does auth work?").pipe(
          // Deny anything that does gate, so a gate is visible as a denial rather
          // than a hang.
          Stream.tap((ev) =>
            ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, "deny") : Effect.void
          ),
          Stream.runDrain
        )
      }).pipe(Effect.provide(base))
    ).then(() => out)
  }

  it("plan: a command runs unattended (planning cannot write), an edit still gates", async () => {
    // Planning reads — `git log`, `rg`, `gh pr view`. Gating those trained the
    // operator to click "allow" on actions that cannot change anything.
    expect(await probe("plan")).toStrictEqual({ command: "allow", edit: "deny" })
  })

  it("ask: the same command still gates", async () => {
    expect(await probe("ask")).toStrictEqual({ command: "deny", edit: "deny" })
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
          yield* ctx.emit({
            _tag: "SubagentStarted",
            id: "task_1",
            name: "Explore",
            description: "sub task",
            parentId: null
          })
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      subagentAdapter,
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
    DiscoveryService.Default,
    ContextManager.Default,
    ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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

  it("restores the operator's PRE-PLAN mode (auto), not the CLI-config default", async () => {
    // Regression: execDefaults (CLI config → "accept-edits" fallback) used to win
    // over priorModes, silently re-gating commands after approving a plan even
    // though the operator was running the session in "auto".
    seedSession("auto")
    const mode = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        // Running in auto, then switch to plan (captures "auto" as the prior mode).
        yield* runner.setMode(SESSION, "auto")
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
    expect(mode).toBe("auto")
  })

  it("uses the explicit auto override when approving from another execution mode", async () => {
    seedSession("accept-edits")
    const mode = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "accept-edits")
        yield* runner.setMode(SESSION, "plan")
        yield* runner.prompt(SESSION, "[[plan]] refactor auth").pipe(
          Stream.tap((ev) =>
            ev._tag === "PlanProposed" ? runner.approvePlan(SESSION, ev.plan.id, "auto") : Effect.void
          ),
          Stream.runDrain
        )
        return (yield* SessionStore.get(SESSION)).mode
      }).pipe(Effect.provide(base()))
    )

    expect(mode).toBe("auto")
  })

  it("keeps plan mode TRANSIENT — never persists 'plan' as the session mode", async () => {
    // If "plan" were persisted, a restart (empty in-memory maps) would resurrect
    // plan mode from session.mode with no priorModes captured, and approval would
    // fall back to "accept-edits". Keeping session.mode at the real exec mode is
    // what makes approval reliably restore it.
    seedSession("auto")
    const persisted = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.setMode(SESSION, "plan")
        return (yield* SessionStore.get(SESSION)).mode
      }).pipe(Effect.provide(base()))
    )
    expect(persisted).toBe("auto") // NOT "plan"
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      modelReportingAdapter,
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      recordingAdapter(captured),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
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
    expect(captured.prompt).toContain("<session-context>")
    expect(captured.prompt).toContain(planFile) // the absolute plan path is handed over
    // Anchors the agent to its worktree so it doesn't chase the plan file's
    // (out-of-tree) location and cd out of the project.
    expect(captured.prompt).toContain(WT)
    // The user's actual text is preserved at the end (the note is only a prefix).
    expect(captured.prompt?.endsWith("please implement the plan")).toBe(true)
  })

  it("does NOT prepend a pointer when the worktree has no saved plan", async () => {
    seedSessionWithWorktree("auto")
    const captured: { prompt: string | null } = { prompt: null }
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      recordingAdapter(captured),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, "just do X").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    // The standing "ask through your native channel" note prefixes every turn,
    // so assert on the plan pointer's absence rather than the whole string.
    expect(captured.prompt).toContain("just do X")
    expect(captured.prompt).not.toContain("saved plan")
    expect(captured.prompt?.endsWith("just do X")).toBe(true)
  })

  it("keeps a slash command first, so the harness still expands it", async () => {
    seedSessionWithWorktree("auto")
    const captured: { prompt: string | null } = { prompt: null }
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      PlanStore.Default,
      recordingAdapter(captured),
      DiscoveryService.Default,
      ContextManager.Default,
      temp.layer
    )
    await Effect.runPromise(
      PlanStore.write(WT, { ...scriptedPlan("s1", 1), summary: "Ship it", raw: "the full plan" }).pipe(
        Effect.provide(Layer.merge(PlanStore.Default, temp.layer))
      )
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, "/babysit-pr get it to main").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    // Prefixing the pointer demoted the command to prose, and the turn came back
    // empty. The context now rides along AFTER it.
    expect(captured.prompt?.startsWith("/babysit-pr get it to main")).toBe(true)
    expect(captured.prompt).toContain("<session-context>")
  })
})

describe("AgentRunner resume across restarts", () => {
  const seedBareSession = () => {
    const session: Session = {
      id: SESSION,
      repo: "acme/widget",
      branch: "b",
      title: "t",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-11T10:00:00.000Z",
      mode: "auto"
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))
  }

  // An adapter that records the resume id it was handed and reports `harnessId`
  // as the harness's own session id (on Started) — the value that should persist.
  const resumeAdapter = (
    captured: { resumeId: string | null },
    harnessId: string
  ): Layer.Layer<CliAdapter> =>
    Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: (_sessionId, spec, ctx) =>
          Effect.gen(function* () {
            captured.resumeId = spec.resumeId
            yield* ctx.emit({ _tag: "Started", sessionId: harnessId })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<CliAdapterShape["run"]>,
        stop: () => Effect.void
      })
    )

  it("persists the harness session id and resumes with it on the next run (survives a restart)", async () => {
    seedBareSession()
    const captured: { resumeId: string | null } = { resumeId: null }
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      resumeAdapter(captured, "sdk-123"),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )

    // First run: no prior resume id; the harness reports "sdk-123" on Started.
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, "start").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    expect(captured.resumeId).toBeNull()

    // It was persisted on the session (survives an app restart).
    const persisted = await Effect.runPromise(
      SessionStore.get(SESSION).pipe(Effect.provide(Layer.merge(SessionStore.Default, temp.layer)))
    )
    expect(persisted.resumeId).toBe("sdk-123")

    // A SECOND run through a FRESH runner (= a restart, empty in-memory map) picks
    // the id up from persistence and hands it to the adapter as spec.resumeId.
    captured.resumeId = null
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, "continue").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    expect(captured.resumeId).toBe("sdk-123")
  })

  it("keeps Gigaplan intake read-only on its own resumable orchestrator thread", async () => {
    seedBareSession()
    const sessionsPath = join(temp.root, "sessions.json")
    const seeded = JSON.parse(readFileSync(sessionsPath, "utf8")) as Array<Session>
    writeFileSync(sessionsPath, JSON.stringify([{ ...seeded[0]!, resumeId: "normal-before" }]))

    const specs: Array<{
      cli: string
      model: string | null
      resumeId: string | null
      readOnly: boolean | undefined
      prompt: string
    }> = []
    let gigaplanRuns = 0
    const capturing = Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: (_sessionId, spec, ctx) =>
          Effect.gen(function* () {
            specs.push({
              cli: spec.cli,
              model: spec.model,
              resumeId: spec.resumeId,
              readOnly: spec.readOnly,
              prompt: spec.prompt
            })
            const harnessId = spec.readOnly
              ? `gigaplan-${++gigaplanRuns}`
              : "normal-after"
            yield* ctx.emit({ _tag: "Started", sessionId: harnessId })
            yield* ctx.emit({ _tag: "Assistant", text: "ok", agentId: undefined })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<CliAdapterShape["run"]>,
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      PlanStore.Default,
      capturing,
      DiscoveryService.Default,
      ContextManager.Default,
      temp.layer
    )

    const persisted = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ConfigService.setOrchestrator("codex", "gpt-5")
        const runner = yield* AgentRunner
        yield* runner
          .prompt(SESSION, "Preserve the filters", [], "orchestrator")
          .pipe(Stream.runDrain)
        yield* runner.prompt(SESSION, "Normal follow-up").pipe(Stream.runDrain)
        yield* runner
          .prompt(SESSION, "Also export CSV", [], "orchestrator")
          .pipe(Stream.runDrain)
        return yield* SessionStore.get(SESSION)
      }).pipe(Effect.provide(base))
    )

    expect(specs[0]).toMatchObject({
      cli: "codex",
      model: "gpt-5",
      resumeId: null,
      readOnly: true
    })
    expect(specs[0]!.prompt).toContain("Preserve the filters")
    expect(specs[0]!.prompt).toContain("read-only")
    expect(specs[1]).toMatchObject({ resumeId: "normal-before", readOnly: undefined })
    expect(specs[2]).toMatchObject({ resumeId: "gigaplan-1", readOnly: true })
    expect(specs[2]!.prompt).toContain("Also export CSV")
    expect(persisted.resumeId).toBe("normal-after")
    expect(persisted.gigaplanResumeId).toBe("gigaplan-2")
  })
})

describe("AgentRunner plan progress across turns", () => {
  const WT_X = "/tmp/starbase/worktrees/starbase/crossturn"

  const seedCrossTurnSession = () => {
    const session: Session = {
      id: SESSION,
      repo: "acme/widget",
      branch: "starbase/crossturn",
      title: "Cross-turn session",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-11T10:00:00.000Z",
      worktreePath: WT_X,
      mode: "auto"
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))
  }

  /**
   * Turn 1 proposes a plan and does NO work; turn 2 edits a file the plan
   * declared. That's the shape of every real session — the plan is approved once
   * and execution runs on across many later turns, each with its own assistant
   * message. `edit` is the path the second turn writes.
   */
  const twoTurnAdapter = (edit: string, plan?: (p: Plan) => Plan): Layer.Layer<CliAdapter> => {
    let turn = 0
    return Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: (sessionId, _spec, ctx) =>
          Effect.gen(function* () {
            turn += 1
            if (turn === 1) {
              const base = scriptedPlan(sessionId, 1)
              yield* ctx.proposePlan(plan ? plan(base) : base)
              yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
              return
            }
            yield* ctx.emit({ _tag: "ToolStart", id: "x1", name: "Write", target: edit })
            yield* ctx.emit({
              _tag: "ToolEnd",
              id: "x1",
              status: "success",
              meta: null,
              diff: { added: 40, removed: 0 },
              preview: null
            })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<CliAdapterShape["run"]>,
        stop: () => Effect.void
      })
    )
  }

  /** Turn 1: propose + approve. Turn 2: the edit lands. Returns the plan after. */
  const runTwoTurns = (edit: string, plan?: (p: Plan) => Plan) => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      twoTurnAdapter(edit, plan),
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    return Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, "plan the refactor").pipe(
          Stream.tap((ev) =>
            ev._tag === "PlanProposed" ? runner.approvePlan(SESSION, ev.plan.id) : Effect.void
          ),
          Stream.runDrain
        )
        // A FRESH assistant message: the plan part is now behind us.
        yield* runner.prompt(SESSION, "now implement it").pipe(Stream.runDrain)
        return findApprovedPlan(yield* TranscriptStore.list(SESSION))
      }).pipe(Effect.provide(base))
    )
  }

  const stepStatus = (
    located: { readonly plan: Plan } | null,
    id: string
  ): string | undefined => located?.plan.steps.find((s) => s.id === id)?.status

  it("marks a step done when the edit lands on a LATER turn than the plan", async () => {
    seedCrossTurnSession()
    // s_02 declares src/auth/token-store.ts.
    const located = await runTwoTurns(`${WT_X}/src/auth/token-store.ts`)
    expect(stepStatus(located, "s_02")).toBe("done")
  })

  it("leaves the plan's other steps untouched", async () => {
    seedCrossTurnSession()
    const located = await runTwoTurns(`${WT_X}/src/auth/token-store.ts`)
    expect(stepStatus(located, "s_01")).toBe("proposed")
    expect(stepStatus(located, "s_05")).toBe("proposed")
  })

  /** Point step s_01 at a bare filename — the shape that breaks a naive suffix match. */
  const bareFilenameStep = (p: Plan): Plan => ({
    ...p,
    steps: p.steps.map((s) =>
      s.id === "s_01"
        ? { ...s, files: [{ path: "session.ts", change: "M" as const, added: 1, removed: 0 }] }
        : s
    )
  })

  it("does not tick a step on a bare-filename suffix collision", async () => {
    seedCrossTurnSession()
    // s_01 declares "session.ts"; the edit hits an unrelated "refund-session.ts".
    // An unanchored endsWith matches those two and ticks a step that had nothing
    // to do with the edit — a boundary-anchored match must not.
    const located = await runTwoTurns(`${WT_X}/src/billing/refund-session.ts`, bareFilenameStep)
    expect(stepStatus(located, "s_01")).not.toBe("done")
  })

  it("still ticks a bare-filename step on a genuine path match", async () => {
    seedCrossTurnSession()
    // The boundary anchor must not overshoot: "session.ts" still matches a real
    // /…/session.ts edit.
    const located = await runTwoTurns(`${WT_X}/src/auth/session.ts`, bareFilenameStep)
    expect(stepStatus(located, "s_01")).toBe("done")
  })
})

/**
 * No harness discovered.
 *
 * The real DiscoveryService shells out (`which claude`, filesystem probes) as
 * part of every `prompt` setup. These tests wait on the run actually starting, so
 * that probe sits inside the window they measure — and under load it blew the
 * budget and made them flake. The runner doesn't need a real binary here: the
 * adapter is injected.
 */
const noHarnesses: Layer.Layer<DiscoveryService> = Layer.succeed(
  DiscoveryService,
  new DiscoveryService({ list: () => Effect.succeed([]) })
)

describe("AgentRunner failures", () => {
  it("surfaces an adapter's actionable failure instead of replacing it with a generic message", async () => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([
        {
          id: SESSION,
          repo: "acme/widget",
          branch: "starbase/auth",
          title: "Auth failure",
          status: "idle",
          cli: "claude",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: "2026-07-20T00:00:00.000Z",
          worktreePath: temp.root,
          mode: "auto"
        }
      ])
    )
    const failingAdapter = Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: () =>
          Effect.fail(
            new CliExecError({
              kind: "claude",
              message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
            })
          ),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      ContextManager.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      PlanStore.Default,
      failingAdapter,
      noHarnesses,
      temp.layer
    )

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        return yield* runner.prompt(SESSION, "hello").pipe(Stream.runCollect)
      }).pipe(Effect.provide(base))
    )

    expect(Array.from(events)).toContainEqual({
      _tag: "Failed",
      message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
    })
  })
})

describe("AgentRunner stop", () => {
  /**
   * An agent that runs until something interrupts it. `started` fires once it's
   * really going, and `interrupted` once it's torn down — mirroring the real
   * Claude adapter, which aborts its CLI process in exactly such an `onInterrupt`
   * finalizer. That finalizer is the ONLY route to the process: `CliAdapter.stop`
   * is a no-op in every implementation.
   */
  const hangingAdapter = (
    started: Deferred.Deferred<boolean>,
    interrupted: Deferred.Deferred<boolean>,
    gate?: { readonly wanted: boolean }
  ): Layer.Layer<CliAdapter> =>
    Layer.succeed(
      CliAdapter,
      CliAdapter.of({
        run: (_sessionId, _spec, ctx) =>
          Effect.gen(function* () {
            yield* ctx.emit({ _tag: "Assistant", text: "working…" })
            yield* Deferred.succeed(started, true)
            // Optionally park on a gate, to cover the blocked-agent case.
            if (gate?.wanted) {
              yield* ctx.canUseTool({
                kind: "command",
                tool: "Bash",
                command: "sleep 600",
                target: null
              })
            }
            yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, true))) as ReturnType<
            CliAdapterShape["run"]
          >,
        stop: () => Effect.void
      })
    )

  /**
   * Drive a run to the point where the agent is genuinely working, then stop it.
   *
   * We wait on `started` rather than sleeping: `prompt` does real I/O (session
   * load, CLI discovery) before forking the run, so a fixed sleep races that
   * setup and stops before there is anything to interrupt.
   */
  const runAndStop = (opts: { readonly gate?: { readonly wanted: boolean } } = {}) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<boolean>()
      const base = Layer.mergeAll(
        AgentRunner.Default,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
        PlanStore.Default,
        ContextManager.Default,
        ConfigService.Default,
        hangingAdapter(started, interrupted, opts.gate),
        noHarnesses,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "ask")
        const events: Array<StreamEvent> = []
        // Consume in a fiber: this run never ends on its own.
        const consumer = yield* Effect.fork(
          runner
            .prompt(SESSION, "go")
            .pipe(Stream.runForEach((ev) => Effect.sync(() => events.push(ev))))
        )
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        yield* runner.stop(SESSION)
        yield* Fiber.join(consumer).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        const wasInterrupted = yield* Deferred.await(interrupted).pipe(
          Effect.timeoutTo({ duration: "2 seconds", onTimeout: () => false, onSuccess: () => true })
        )
        return { wasInterrupted, events, transcript: yield* TranscriptStore.list(SESSION) }
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

  it("interrupts an agent that is mid-run and blocked on nothing", async () => {
    // The case a stop button exists for: the agent is streaming, waiting on
    // nobody. Denying pending gates — all `stop` used to do — is a no-op here.
    const { wasInterrupted } = await runAndStop()
    expect(wasInterrupted).toBe(true)
  })

  it("interrupts an agent parked on a gate", async () => {
    const { wasInterrupted } = await runAndStop({ gate: { wanted: true } })
    expect(wasInterrupted).toBe(true)
  })

  /**
   * The invariant behind the regression this change exists for.
   *
   * `stop` used to read a session's run by id alone, so an interrupt that landed
   * after the NEXT turn had been forked killed that turn instead — the
   * operator's fresh message came back as a bare "Stopped." and they re-sent it
   * (64 of 946 assistant turns in ~/starbase/transcripts are exactly this).
   *
   * Asserting the SYMPTOM cannot be done honestly: reproducing it needs the
   * stop's map read to be scheduled after the next run registers, which is a
   * timing construction, not a fact about the code — the same reason the
   * deregistration guard next to it is reviewed rather than pinned. What IS
   * deterministic is the ordering that makes the symptom impossible: a turn
   * cannot begin setup while a stop for that session is still in flight. Pin
   * that, and the race has nowhere to happen.
   *
   * Run A's teardown is made slow on purpose, so "did B wait?" is observable
   * rather than a coin toss.
   */
  it("holds the next turn until an in-flight stop has finished unwinding", async () => {
    const log = await Effect.gen(function* () {
      const started = yield* Deferred.make<boolean>()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (what: string) => Ref.update(order, (l) => [...l, what])
      const slowAdapter = Layer.succeed(
        CliAdapter,
        CliAdapter.of({
          run: (_sessionId, spec, ctx) =>
            (spec.prompt.includes("second")
              ? Effect.gen(function* () {
                  yield* note("B-setup-ran")
                  yield* ctx.emit({ _tag: "Assistant", text: "second" })
                  yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 1 })
                })
              : Effect.gen(function* () {
                  yield* ctx.emit({ _tag: "Assistant", text: "first" })
                  yield* Deferred.succeed(started, true)
                  yield* Effect.never
                }).pipe(
                  // A real harness takes time to tear its child down; without
                  // that, "B waited" and "B raced and won" look identical.
                  Effect.onInterrupt(() => Effect.sleep("400 millis").pipe(Effect.zipRight(note("A-torn-down"))))
                )) as ReturnType<CliAdapterShape["run"]>,
          stop: () => Effect.void
        })
      )
      const base = Layer.mergeAll(
        AgentRunner.Default,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
        PlanStore.Default,
        ContextManager.Default,
        slowAdapter,
        noHarnesses,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "ask")
        yield* Effect.fork(runner.prompt(SESSION, "first").pipe(Stream.runDrain))
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        // Forked, NOT awaited — this is how the renderer used to fire it, and
        // the whole point is that firing it that way must still be safe.
        yield* Effect.fork(runner.stop(SESSION))
        yield* Effect.sleep("50 millis")
        yield* runner.prompt(SESSION, "second").pipe(Stream.runDrain, Effect.timeout("5 seconds"))
        return yield* Ref.get(order)
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    expect(log).toEqual(["A-torn-down", "B-setup-ran"])
  })

  it("ends the stream and records the stop, rather than reporting a crash", async () => {
    const { events, transcript } = await runAndStop()
    // The stream must terminate — a consumer that never completes hangs the UI.
    expect(events.some((e) => e._tag === "Failed" && e.message === STOPPED_NOTE)).toBe(true)
    // The operator's own stop must not surface as "the agent run failed".
    expect(events.some((e) => e._tag === "Failed" && e.message.includes("failed"))).toBe(false)
    // And the turn settles, rather than streaming forever.
    expect(transcript[transcript.length - 1]!.streaming).toBe(false)
  })
})

/**
 * The other half of the silent-turn bug: a harness child that hangs before it
 * says anything at all.
 *
 * Nothing in the stack used to bound this. `drainRun` in the renderer only
 * synthesises a terminal event when the stream ENDS, `Effect.ensuring(out.end)`
 * only runs when `adapter.run` RETURNS, and the unsettled-turn instrumentation
 * is a finalizer — none of them can fire on a run that neither emits nor exits.
 * 32 of 946 assistant turns in ~/starbase/transcripts are frozen exactly there:
 * empty parts, `streaming: true`, and an eyebrow pulsing over nothing.
 */
describe("AgentRunner first-event watchdog", () => {
  it("settles a turn whose harness never says anything", async () => {
    const events = await Effect.gen(function* () {
      const entered = yield* Deferred.make<boolean>()
      const muteAdapter = Layer.succeed(
        CliAdapter,
        CliAdapter.of({
          run: () =>
            Effect.gen(function* () {
              // Signals that the run is live WITHOUT emitting — the case a
              // finalizer cannot see, because nothing ever ends.
              yield* Deferred.succeed(entered, true)
              yield* Effect.never
            }) as ReturnType<CliAdapterShape["run"]>,
          stop: () => Effect.void
        })
      )
      const base = Layer.mergeAll(
        AgentRunner.Default,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
        PlanStore.Default,
        ContextManager.Default,
        muteAdapter,
        noHarnesses,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        const seen: Array<StreamEvent> = []
        const consumer = yield* Effect.fork(
          runner.prompt(SESSION, "hello?").pipe(Stream.runForEach((e) => Effect.sync(() => seen.push(e))))
        )
        // The watchdog is forked immediately before the adapter runs, so once
        // the adapter is live the sleep is registered and the clock can jump.
        yield* Deferred.await(entered)
        yield* TestClock.adjust("121 seconds")
        yield* Fiber.join(consumer).pipe(Effect.ignore)
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise)

    const failed = events.find((e) => e._tag === "Failed")
    expect(failed).toBeDefined()
    // Actionable, and NOT the bare "Stopped." — the operator did not do this.
    expect(failed).toMatchObject({ message: expect.stringContaining("produced no output") })
    expect(events.some((e) => e._tag === "Failed" && e.message === STOPPED_NOTE)).toBe(false)
  })

  it("leaves a slow but living turn alone", async () => {
    const events = await Effect.gen(function* () {
      const spoke = yield* Deferred.make<boolean>()
      const chattyAdapter = Layer.succeed(
        CliAdapter,
        CliAdapter.of({
          run: (_sessionId, _spec, ctx) =>
            Effect.gen(function* () {
              yield* ctx.emit({ _tag: "Assistant", text: "thinking hard" })
              yield* Deferred.succeed(spoke, true)
              yield* Effect.never
            }) as ReturnType<CliAdapterShape["run"]>,
          stop: () => Effect.void
        })
      )
      const base = Layer.mergeAll(
        AgentRunner.Default,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
        PlanStore.Default,
        ContextManager.Default,
        chattyAdapter,
        noHarnesses,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        const seen: Array<StreamEvent> = []
        yield* Effect.fork(
          runner.prompt(SESSION, "hello?").pipe(Stream.runForEach((e) => Effect.sync(() => seen.push(e))))
        )
        yield* Deferred.await(spoke)
        yield* TestClock.adjust("121 seconds")
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise)

    // One event is enough to prove the harness is alive. Killing a slow turn
    // that is genuinely working would be far worse than the bug being fixed.
    expect(events.some((e) => e._tag === "Failed")).toBe(false)
  })
})

describe("AgentRunner live tool output", () => {
  /** A harness that streams a running command's stdout, then settles with no output of its own. */
  const deltaAdapter = Layer.succeed(CliAdapter, {
    run: (_sessionId, _spec, { emit }) =>
      Effect.gen(function* () {
        yield* emit({ _tag: "Started", sessionId: "harness-1" })
        yield* emit({ _tag: "ToolStart", id: "bash-1", name: "Bash", target: "pnpm test" })
        yield* emit({ _tag: "ToolDelta", id: "bash-1", output: "RUN v2\n" })
        yield* emit({ _tag: "ToolDelta", id: "bash-1", output: "RUN v2\n ✓ 3 passed\n" })
        // Settle WITHOUT re-stating the output — so the only way the tool could
        // carry text in the transcript is if a delta had been persisted.
        yield* emit({ _tag: "ToolEnd", id: "bash-1", status: "success", meta: null, diff: null, preview: null })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
      }),
    stop: () => Effect.void
  })

  it("streams ToolDelta to the consumer but never persists it to the transcript", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
    BackgroundTaskStore.Default,
      PlanStore.Default,
      deltaAdapter,
      DiscoveryService.Default,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    const { events, transcript } = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        const collected: Array<StreamEvent> = []
        yield* runner
          .prompt(SESSION, "run the tests")
          .pipe(Stream.runForEach((ev) => Effect.sync(() => collected.push(ev))))
        return { events: collected, transcript: yield* TranscriptStore.list(SESSION) }
      }).pipe(Effect.provide(base))
    )

    // The live snapshots reach the consumer — that's what the renderer folds into
    // the running card so a widget can light up mid-run.
    expect(events.filter((e) => e._tag === "ToolDelta")).toHaveLength(2)

    // But the persisted card carries NO output, because ToolEnd stated none and
    // the deltas were stream-only. If a delta had been folded into transcript.json,
    // this would be the delta's text instead of undefined — the assertion that pins
    // the "never persist a per-tick full-file rewrite" contract.
    const toolPart = transcript
      .flatMap((m) => m.parts)
      .find((p) => p._tag === "Tool" && p.tool.id === "bash-1")
    expect(toolPart && toolPart._tag === "Tool" && toolPart.tool.status).toBe("success")
    expect(toolPart && toolPart._tag === "Tool" && toolPart.tool.output).toBeUndefined()
  })
})

describe("AgentRunner on the Starbase harness", () => {
  /**
   * A session whose harness is the orchestrator must run on a REAL one.
   *
   * `starbase` is us, not something that can execute a turn, so without a
   * substitution the dispatcher falls through to the scripted stub and the
   * session silently does nothing — looking, from the outside, exactly like a
   * broken app. This asserts the spec the adapter actually receives.
   */
  const captureSpec = (sessionCli: "starbase" | "claude") =>
    Effect.gen(function* () {
      let seen: { cli: string; model: string | null } | null = null
      const capturing: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
        run: (_id, spec, ctx) => {
          seen = { cli: spec.cli, model: spec.model }
          return ctx.emit({ _tag: "Assistant", text: "ok", agentId: undefined })
        },
        stop: () => Effect.void
      } as CliAdapterShape)

      const base = Layer.mergeAll(
        AgentRunner.Default,
        ConfigService.Default,
        ContextManager.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
        PlanStore.Default,
        capturing,
        noHarnesses,
        temp.layer
      )
      // Seeded on disk rather than through the store's `create`, which forks a
      // real git worktree — irrelevant here, and slow.
      mkdirSync(temp.root, { recursive: true })
      writeFileSync(
        join(temp.root, "sessions.json"),
        JSON.stringify([
          {
            id: SESSION,
            repo: "widget",
            branch: "starbase/x",
            title: "t",
            status: "idle",
            cli: sessionCli,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-19T00:00:00.000Z",
            worktreePath: temp.root,
            model: "sonnet"
          }
        ])
      )
      yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, "hello").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
      return seen as { cli: string; model: string | null } | null
    }).pipe(Effect.runPromise)

  it("runs a Starbase session on the orchestrator's model, not on 'starbase'", async () => {
    // Defaults to Claude Opus, and deliberately IGNORES the session's own stored
    // model: the orchestrator has one identity, chosen in settings, so a stale
    // per-session model must not quietly change who you are talking to.
    expect(await captureSpec("starbase")).toStrictEqual({ cli: "claude", model: "opus" })
  })

  it("leaves an ordinary session's harness and model exactly alone", async () => {
    // The substitution must be scoped to the orchestrator; everyone else keeps
    // the model they picked.
    expect(await captureSpec("claude")).toStrictEqual({ cli: "claude", model: "sonnet" })
  })
})

describe("AgentRunner usage accrual", () => {
  /**
   * `Session.costUsd` and `tokens` were written as 0 at creation and never
   * updated, so the sidebar reported nothing however much work a session did.
   */
  it("adds each finished turn's usage to the session's running total", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      ConfigService.Default,
      ContextManager.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      PlanStore.Default,
      makeScriptedCliAdapter(0),
      noHarnesses,
      temp.layer
    )
    const totals = await Effect.gen(function* () {
      mkdirSync(temp.root, { recursive: true })
      writeFileSync(
        join(temp.root, "sessions.json"),
        JSON.stringify([
          {
            id: SESSION,
            repo: "widget",
            branch: "b",
            title: "t",
            status: "idle",
            cli: "claude",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-19T00:00:00.000Z",
            worktreePath: temp.root
          }
        ])
      )
      const runner = yield* AgentRunner
      // Two turns: the totals must ACCUMULATE. A session is many turns, and the
      // last turn's usage is not the session's usage.
      // The scripted harness gates its edit and its command; nothing else here
      // answers them, so the run would park forever.
      const turn = (text: string) =>
        runner.prompt(SESSION, text).pipe(
          Stream.tap((ev) =>
            ev._tag === "GateRequested"
              ? runner.decideGate(SESSION, ev.gate.id, "allow")
              : Effect.void
          ),
          Stream.runDrain
        )
      yield* turn("one")
      const afterOne = yield* SessionStore.get(SESSION)
      yield* turn("two")
      const afterTwo = yield* SessionStore.get(SESSION)
      return { afterOne, afterTwo }
    }).pipe(Effect.provide(base), Effect.runPromise)

    // The scripted harness reports a fixed 0.38 / 42_100 per turn.
    expect(totals.afterOne.costUsd).toBeCloseTo(0.38, 5)
    expect(totals.afterOne.tokens).toBe(42_100)
    expect(totals.afterTwo.costUsd).toBeCloseTo(0.76, 5)
    expect(totals.afterTwo.tokens).toBe(84_200)
  })
})
