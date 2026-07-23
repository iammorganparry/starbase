import type { Plan, Session, StreamEvent } from "@starbase/core"
import { latestPlan, STOPPED_NOTE } from "@starbase/core"
import { createActor, waitFor } from "xstate"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { conversationMachine } from "./conversation-machine.js"

/**
 * The renderer's conversation flow is a deterministic XState chart. Its only
 * side-effects go through `rpc-client`, which we mock — so the machine runs under
 * node with no Electron/`window`. We drive it through the same events the view
 * sends and assert the OUTCOMES the operator sees: a mid-run send is queued and
 * replayed, the Changes rail refreshes live on an edit, images ride along on the
 * turn, and Stop abandons the queue.
 */

// Shared harness state the mocked rpc reads/writes (hoisted for the vi.mock factory).
const h = vi.hoisted(() => ({
  streamCb: null as null | ((event: unknown) => void),
  agentRunCalls: [] as Array<{
    sessionId: string
    text: string
    images: unknown
    options: unknown
  }>,
  execCalls: [] as Array<{ sessionId: string; planId: string; executionMode: string | undefined }>,
  resumeCalls: [] as Array<{ sessionId: string; planId: string }>,
  diffValue: "diff-0",
  diffCalls: 0,
  statusWrites: [] as Array<string>,
  skillsListCalls: 0,
  stopCalls: [] as Array<string>,
  // Drives the "a stop that rejects must still let the session move on" case.
  stopFails: false,
  /** Push reviewer events into the machine, as ReviewService's stream would. */
  reviewCb: null as null | ((event: unknown) => void),
  // Lets a test hold the catalogue in flight to prove nothing waits on it.
  catalogGate: Promise.resolve() as Promise<void>,
  // Same, for the skills probe — it spawns the harness, so nothing may wait on it.
  skillsGate: Promise.resolve() as Promise<void>,
  // Lets a test hold the transcript load, to drive the "typed before it lands" race.
  transcriptGate: Promise.resolve() as Promise<void>,
  setHarnessCalls: [] as Array<{ sessionId: string; cli: string; model: string }>,
  planCalls: [] as Array<{ sessionId: string; brief: string | undefined }>,
  reasoningCalls: [] as Array<string | undefined>,
  readinessGate: Promise.resolve() as Promise<void>,
  readiness: { ready: true, vendors: [], reason: null } as {
    ready: boolean
    vendors: ReadonlyArray<unknown>
    reason: string | null
  },
  catalog: [
    { cli: "claude", label: "Claude Code", models: [{ id: "opus", label: "opus" }] },
    { cli: "codex", label: "Codex CLI", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }] }
  ]
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsTranscript: async () => {
      await h.transcriptGate
      return []
    },
    skillsList: async () => {
      h.skillsListCalls += 1
      await h.skillsGate
      return [{ name: "/deploy", description: "Ship it", source: "skill" }]
    },
    workspaceFiles: async () => [],
    modelsCatalog: async () => {
      await h.catalogGate
      return h.catalog
    },
    sessionsDiff: async () => {
      h.diffCalls += 1
      return h.diffValue
    },
    agentRun: (
      sessionId: string,
      text: string,
      onEvent: (event: unknown) => void,
      images: unknown,
      options: unknown
    ) => {
      h.agentRunCalls.push({ sessionId, text, images, options })
      h.streamCb = onEvent
      return () => {
        h.streamCb = null
      }
    },
    planReadiness: async () => {
      await h.readinessGate
      return h.readiness
    },
    agentResumePlan: (sessionId: string, planId: string, onEvent: (event: unknown) => void) => {
      h.resumeCalls.push({ sessionId, planId })
      h.streamCb = onEvent
      return () => {
        h.streamCb = null
      }
    },
    planExecute: (
      sessionId: string,
      planId: string,
      executionMode: string | undefined,
      onEvent: (event: unknown) => void
    ) => {
      h.execCalls.push({ sessionId, planId, executionMode })
      h.streamCb = onEvent
      return () => {
        h.streamCb = null
      }
    },
    planAdversarial: (sessionId: string, brief: string | undefined, onEvent: (event: unknown) => void) => {
      h.planCalls.push({ sessionId, brief })
      h.streamCb = onEvent
      return () => {
        h.streamCb = null
      }
    },
    reviewWatch: (_sessionId: string, onEvent: (event: unknown) => void) => {
      h.reviewCb = onEvent
      return () => {
        h.reviewCb = null
      }
    },
    agentDecideGate: async () => {},
    agentAnswerQuestion: async () => {},
    agentSetMode: async () => {},
    agentSetReasoning: async (_sessionId: string, effort: string | undefined) => {
      h.reasoningCalls.push(effort)
    },
    agentSetHarness: async (sessionId: string, cli: string, model: string) => {
      h.setHarnessCalls.push({ sessionId, cli, model })
    },
    agentCommentPlanStep: async () => {},
    agentRevisePlan: async () => {},
    agentApprovePlan: async () => {},
    agentStop: async (sessionId: string) => {
      h.stopCalls.push(sessionId)
      if (h.stopFails) throw new Error("stop failed")
    },
    sessionsSetStatus: async (_id: string, status: string) => {
      h.statusWrites.push(status)
    }
  }
}))

const session = {
  id: "s1",
  cli: "claude",
  worktreePath: "/tmp/wt",
  mode: "accept-edits",
  model: null,
  status: "idle"
} as unknown as Session

const emit = (event: StreamEvent) => h.streamCb?.(event)
const start = () => createActor(conversationMachine, { input: { session } }).start()
const idle = "awaitingInput" as const

beforeEach(() => {
  h.streamCb = null
  h.agentRunCalls.length = 0
  h.diffValue = "diff-0"
  h.diffCalls = 0
  h.statusWrites.length = 0
  h.skillsListCalls = 0
  h.stopCalls.length = 0
  h.stopFails = false
  h.setHarnessCalls.length = 0
  h.catalogGate = Promise.resolve()
  h.skillsGate = Promise.resolve()
  h.transcriptGate = Promise.resolve()
  h.reviewCb = null
  h.planCalls.length = 0
  h.reasoningCalls.length = 0
  h.execCalls.length = 0
  h.resumeCalls.length = 0
  h.readinessGate = Promise.resolve()
  h.readiness = { ready: true, vendors: [], reason: null }
})

describe("conversationMachine — context size", () => {
  it("rehydrates the persisted context reading before the next live event", async () => {
    const persisted = { ...session, contextTokens: 206_865 } as Session
    const actor = createActor(conversationMachine, { input: { session: persisted } }).start()
    await waitFor(actor, (s) => s.matches(idle))

    expect(actor.getSnapshot().context.tokens).toBe(206_865)
    actor.stop()
  })

  it("keeps the last context reading visible while the next turn starts", async () => {
    const persisted = { ...session, contextTokens: 206_865 } as Session
    const actor = createActor(conversationMachine, { input: { session: persisted } }).start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "continue" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(actor.getSnapshot().context.tokens).toBe(206_865)
    actor.stop()
  })

  it("tracks the latest context and does not replace it with the final run total", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "inspect the repo" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({ _tag: "Usage", tokens: 120_000 })
    expect(actor.getSnapshot().context.tokens).toBe(120_000)

    // Compaction genuinely shrinks the context. A high-water mark would keep
    // lying that the old, larger context was still loaded.
    emit({ _tag: "Usage", tokens: 45_000 })
    expect(actor.getSnapshot().context.tokens).toBe(45_000)

    // Done can carry a terminal context reading for adapters without a live
    // event. It must not overwrite the newer live reading we already received.
    emit({ _tag: "Done", costUsd: 0, tokens: 300_000 })
    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.tokens).toBe(45_000)
    actor.stop()
  })

  it("uses Done as a fallback when a harness has no live context event", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "inspect the repo" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Done", costUsd: 0, tokens: 42_000 })
    await waitFor(actor, (s) => s.matches(idle))

    expect(actor.getSnapshot().context.tokens).toBe(42_000)
    actor.stop()
  })
})

describe("conversationMachine — queue while busy", () => {
  it("queues a message sent mid-run and replays it once the run completes", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.agentRunCalls).toHaveLength(1)
    expect(h.agentRunCalls[0]!.text).toBe("first")

    // Sent while the agent is busy → queued, not dispatched.
    actor.send({ type: "SEND", text: "second" })
    expect(actor.getSnapshot().context.queued).toEqual([
      { text: "second", images: [], target: "session" }
    ])
    expect(h.agentRunCalls).toHaveLength(1)

    // Finishing the turn drains the queue: refresh diff, then start the queued turn.
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(h.agentRunCalls[1]!.text).toBe("second")
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })

  it("keeps each queued message on the target selected when it was sent", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "working turn" })
    actor.send({ type: "SET_MODE", mode: "gigaplan" })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(h.agentRunCalls[1]).toMatchObject({
      text: "working turn",
      options: { target: "session" }
    })

    actor.send({ type: "SEND", text: "intake turn" })
    actor.send({ type: "SET_MODE", mode: "accept-edits" })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 3, { timeout: 3000 })
    expect(h.agentRunCalls[2]).toMatchObject({
      text: "intake turn",
      options: { target: "orchestrator" }
    })
    actor.stop()
  })

  it("UNQUEUE drops a still-pending queued message", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "a" })
    actor.send({ type: "SEND", text: "b" })
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["a", "b"])

    actor.send({ type: "UNQUEUE", index: 0 })
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["b"])
    actor.stop()
  })

  it("SEND_NOW interrupts the current turn and runs the picked message next (jumping the queue)", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.agentRunCalls).toHaveLength(1)

    // Queue two; steer to the second one ("b") mid-run.
    actor.send({ type: "SEND", text: "a" })
    actor.send({ type: "SEND", text: "b" })
    actor.send({ type: "SEND_NOW", index: 1 })

    // The current turn is interrupted and "b" runs next, ahead of "a".
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(h.agentRunCalls[1]!.text).toBe("b")
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["a"])
    actor.stop()
  })

  it("STOP abandons any queued messages", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({ type: "SEND", text: "queued" })
    expect(actor.getSnapshot().context.queued).toHaveLength(1)

    actor.send({ type: "STOP" })
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })
})

describe("conversationMachine — nothing gates the transcript on a CLI probe", () => {
  /**
   * `loading` handles almost no events, so anything it waits on becomes a window
   * where the operator's input is silently swallowed. `Skills.list` asks the
   * HARNESS what commands it has — it spawns the binary, taking up to seconds —
   * so awaiting it in `loadConversation` meant a prompt typed on open did
   * nothing at all: the composer looked alive, the send vanished.
   *
   * Holding the skills fetch in flight here proves the machine reaches
   * `awaitingInput` regardless, mirroring the same guarantee the catalogue has.
   */
  /**
   * The composer is enabled from the first paint, so a prompt can be sent before
   * the transcript lands. A dropped one is invisible — the box clears and the
   * operator believes they sent it — so it's held and run the moment the load
   * settles, exactly as a send during a run is.
   */
  it("holds a prompt sent before the transcript lands, then runs it", async () => {
    let release = () => {}
    h.transcriptGate = new Promise<void>((r) => (release = r))

    const actor = start()
    expect(actor.getSnapshot().matches("loading")).toBe(true)

    actor.send({ type: "SEND", text: "typed on open" })
    // Held, not dispatched — there's no transcript to append it to yet.
    expect(h.agentRunCalls).toHaveLength(0)
    expect(actor.getSnapshot().context.queued).toEqual([
      { text: "typed on open", images: [], target: "session" }
    ])

    release()
    await waitFor(actor, (s) => s.matches("running"), { timeout: 3000 })
    expect(h.agentRunCalls).toHaveLength(1)
    expect(h.agentRunCalls[0]!.text).toBe("typed on open")
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })

  /** Losing the transcript is no reason to also lose what the operator typed. */
  it("still runs a held prompt when the load FAILS", async () => {
    h.transcriptGate = Promise.reject(new Error("disk gone"))

    const actor = start()
    actor.send({ type: "SEND", text: "typed on open" })

    await waitFor(actor, (s) => s.matches("running"), { timeout: 3000 })
    expect(h.agentRunCalls[0]!.text).toBe("typed on open")
    actor.stop()
  })

  it("reaches idle and accepts a send while the skills probe is still in flight", async () => {
    let release = () => {}
    h.skillsGate = new Promise<void>((r) => (release = r))

    const actor = start()
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })

    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"), { timeout: 3000 })
    expect(h.agentRunCalls).toHaveLength(1)

    // The `/` menu fills itself in a beat later, without having blocked anything.
    release()
    await waitFor(actor, (s) => s.context.skills.length > 0, { timeout: 3000 })
    actor.stop()
  })
})

describe("conversationMachine — realtime Changes rail", () => {
  it("re-reads the diff mid-run when an edit tool lands", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "edit a file" })
    await waitFor(actor, (s) => s.matches("running"))

    const before = h.diffCalls
    h.diffValue = "diff-after-edit"
    emit({ _tag: "ToolStart", id: "e1", name: "Write", target: "a.ts" })
    emit({ _tag: "ToolEnd", id: "e1", status: "success", meta: null, diff: { added: 3, removed: 0 }, preview: null })

    await waitFor(actor, (s) => s.context.patch === "diff-after-edit", { timeout: 3000 })
    expect(h.diffCalls).toBeGreaterThan(before)
    // The turn is still live — the live refresh doesn't end it.
    expect(actor.getSnapshot().matches("running")).toBe(true)
    actor.stop()
  })

  it("does not refresh the diff for a read-only tool (no file change)", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "read a file" })
    await waitFor(actor, (s) => s.matches("running"))

    const before = h.diffCalls
    emit({ _tag: "ToolStart", id: "r1", name: "Read", target: "a.ts" })
    emit({ _tag: "ToolEnd", id: "r1", status: "success", meta: "10 lines", diff: null, preview: null })

    // A Read reports no diff → no live refresh fires.
    expect(h.diffCalls).toBe(before)
    actor.stop()
  })
})

describe("conversationMachine — image attachments", () => {
  it("passes attached images to the agent and records them on the user turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    const image = { id: "i1", name: "x.png", mediaType: "image/png", data: "aGk=" }

    actor.send({ type: "SEND", text: "see this", images: [image] })
    await waitFor(actor, (s) => s.matches("running"))

    expect(h.agentRunCalls[0]!.images).toEqual([image])
    const user = actor.getSnapshot().context.messages.find((m) => m.role === "user")!
    expect(user.parts.some((p) => p._tag === "Image" && p.attachment.id === "i1")).toBe(true)
    actor.stop()
  })

  it("loads the model catalogue into context", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.context.catalog.length > 0)
    expect(actor.getSnapshot().context.catalog).toStrictEqual(h.catalog)
    expect(actor.getSnapshot().context.cli).toBe("claude")
    actor.stop()
  })

  /**
   * REGRESSION: the catalogue must NOT be part of `loadConversation`.
   *
   * `loading` has no event handlers, so anything the operator does before the
   * load settles is dropped on the floor. Fetching the catalogue inline reaches
   * DiscoveryService + probes the Codex CLI for models — seconds — which widened
   * that window enough that an immediate Shift+Tab or send was silently ignored
   * (it broke four e2e tests). The transcript must not wait on the model chip.
   */
  it("reaches idle without waiting for the model catalogue", async () => {
    let releaseCatalog = () => {}
    h.catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })

    const actor = start()
    // Idle while the catalogue is still in flight — so events aren't dropped.
    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.catalog).toStrictEqual([])

    // The operator can act immediately, and it takes effect.
    actor.send({ type: "SET_MODE", mode: "auto" })
    expect(actor.getSnapshot().context.mode).toBe("auto")

    releaseCatalog()
    await waitFor(actor, (s) => s.context.catalog.length > 0)
    actor.stop()
  })

  describe("SET_HARNESS", () => {
    it("changes only the model when staying on the same harness", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      // Skills land OUT OF BAND now (the fetch probes the harness, so gating the
      // transcript on it would freeze the composer) — wait for the first one
      // before asserting that a same-harness switch doesn't trigger a second.
      await waitFor(actor, (s) => s.context.skills.length > 0)
      const skillsBefore = h.skillsListCalls

      actor.send({ type: "SET_HARNESS", cli: "claude", model: "haiku" })

      const { context } = actor.getSnapshot()
      expect(context.model).toBe("haiku")
      expect(context.cli).toBe("claude")
      expect(h.setHarnessCalls).toStrictEqual([{ sessionId: "s1", cli: "claude", model: "haiku" }])
      // Same harness → same skills; refetching would be pointless work.
      expect(h.skillsListCalls).toBe(skillsBefore)
      expect(context.skills.length).toBeGreaterThan(0)
      actor.stop()
    })

    /**
     * The composer's chips are live while the conversation loads, and loading is
     * NOT instant — it asks the harness for its command list, which means
     * spawning it. A switch made in that window used to be swallowed: the menu
     * closed, the chip snapped back, nothing happened.
     *
     * Every other test here waits for `idle` first, which is exactly why none of
     * them caught it — this one deliberately does not.
     */
    it("honours a switch made while the conversation is still loading", async () => {
      const actor = start()
      expect(actor.getSnapshot().matches("loading")).toBe(true)

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      expect(actor.getSnapshot().context.cli).toBe("codex")
      expect(h.setHarnessCalls).toStrictEqual([
        { sessionId: "s1", cli: "codex", model: "gpt-5.6-sol" }
      ])

      // …and the load completing must not clobber the choice: `onDone` assigns
      // transcript state only.
      await waitFor(actor, (s) => s.matches(idle))
      expect(actor.getSnapshot().context.cli).toBe("codex")
      expect(actor.getSnapshot().context.model).toBe("gpt-5.6-sol")
      actor.stop()
    })

    it("honours a mode change made while the conversation is still loading", async () => {
      const actor = start()
      expect(actor.getSnapshot().matches("loading")).toBe(true)

      actor.send({ type: "SET_MODE", mode: "auto" })

      expect(actor.getSnapshot().context.mode).toBe("auto")
      await waitFor(actor, (s) => s.matches(idle))
      expect(actor.getSnapshot().context.mode).toBe("auto")
      actor.stop()
    })

    it("switches harness and refetches the harness-specific skills", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      // As above — count from AFTER the out-of-band initial fetch, or the
      // "+1 refetch" assertion below races it.
      await waitFor(actor, (s) => s.context.skills.length > 0)
      const skillsBefore = h.skillsListCalls

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      expect(actor.getSnapshot().context.cli).toBe("codex")
      expect(actor.getSnapshot().context.model).toBe("gpt-5.6-sol")
      // The old harness's `/` menu must not linger.
      expect(h.skillsListCalls).toBe(skillsBefore + 1)
      await waitFor(actor, (s) => s.context.skills.length > 0)
      actor.stop()
    })

    // The runner reads `session.cli`; if the mirror lagged, the chip would say
    // "codex" while the next turn still ran on Claude.
    it("mirrors the switch onto the session and drops the stale resume id", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      const { session: updated } = actor.getSnapshot().context
      expect(updated.cli).toBe("codex")
      expect(updated.resumeId).toBeUndefined()
      actor.stop()
    })

    it("keeps plan mode when the new harness can plan too", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      actor.send({ type: "SET_MODE", mode: "plan" })
      expect(actor.getSnapshot().context.mode).toBe("plan")

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      // Codex submits its plan as a fenced block instead of `ExitPlanMode`, so
      // there is nothing to downgrade — dropping the mode would have discarded
      // the operator's in-flight planning session for no reason.
      expect(actor.getSnapshot().context.mode).toBe("plan")
      actor.stop()
    })

    it("degrades plan mode to ask on a harness that cannot plan", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      actor.send({ type: "SET_MODE", mode: "plan" })

      actor.send({ type: "SET_HARNESS", cli: "cursor", model: "composer-1" })

      // Cursor falls through to the scripted stub, so its "plan" would be
      // fabricated. Better to say `ask` than to invent one.
      expect(actor.getSnapshot().context.mode).toBe("ask")
      actor.stop()
    })
  })
})

/**
 * The adversarial reviewer is surfaced as a tab in the same bar as the harness's
 * sub-agents — but it is NOT part of a turn (the PR button or the background
 * auto-review poll starts it), which is what makes its lifetime different.
 */
describe("conversationMachine — reviewer tab", () => {
  const review = (event: StreamEvent) => h.reviewCb?.(event)

  it("has no reviewer tab until a review runs", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.reviewer).toBeNull()
    expect(actor.getSnapshot().context.reviewStartedAt).toBeNull()
    actor.stop()
  })

  it("opens a working tab and accrues the reviewer's output", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Assistant", text: "Looks suspicious" })

    const { reviewer } = actor.getSnapshot().context
    expect(reviewer?.status).toBe("working")
    expect(reviewer?.name).toBe("Reviewer")
    expect(reviewer?.message.parts.some((p) => p._tag === "Text" && p.text.includes("suspicious"))).toBe(true)
    actor.stop()
  })

  // The button's whole job: say where the review is, from the reviewer's own events.
  it("tracks the phase through the run", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    review({ _tag: "Started", sessionId: "review_s1" })
    expect(actor.getSnapshot().context.reviewPhase).toBe("starting")

    review({ _tag: "ToolStart", id: "t1", name: "Read", target: "a.ts" })
    expect(actor.getSnapshot().context.reviewPhase).toBe("reading")

    // A gap between tool calls must not strobe the label back to something else.
    review({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    expect(actor.getSnapshot().context.reviewPhase).toBe("reading")

    review({ _tag: "Assistant", text: '{"findings":[]}' })
    expect(actor.getSnapshot().context.reviewPhase).toBe("writing")

    review({ _tag: "Done", costUsd: 0, tokens: 0 })
    expect(actor.getSnapshot().context.reviewPhase).toBe("done")
    // Timer stops → the button drops out of its running state.
    expect(actor.getSnapshot().context.reviewStartedAt).toBeNull()
    expect(actor.getSnapshot().context.reviewer?.status).toBe("done")
    actor.stop()
  })

  it("times the run from Started", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    expect(actor.getSnapshot().context.reviewStartedAt).not.toBeNull()
    actor.stop()
  })

  it("marks the tab errored when the reviewer fails", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Failed", message: "boom" })

    expect(actor.getSnapshot().context.reviewer?.status).toBe("error")
    expect(actor.getSnapshot().context.reviewPhase).toBe("error")
    expect(actor.getSnapshot().context.reviewStartedAt).toBeNull()
    actor.stop()
  })

  // Re-reviewing publishes onto the same channel; without a reset the second run's
  // output would append onto the first's transcript.
  it("starts a fresh tab when a second review begins", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Assistant", text: "first run" })
    review({ _tag: "Done", costUsd: 0, tokens: 0 })

    review({ _tag: "Started", sessionId: "review_s1" })
    const { reviewer } = actor.getSnapshot().context
    expect(reviewer?.status).toBe("working")
    expect(JSON.stringify(reviewer?.message.parts)).not.toContain("first run")
    actor.stop()
  })

  it("keeps a running reviewer when a new turn starts", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Assistant", text: "still working" })

    // Sending a message clears the turn's sub-agents — but the review isn't part
    // of that turn, and losing sight of a live agent for typing would be wrong.
    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(actor.getSnapshot().context.subagents).toEqual([])
    expect(actor.getSnapshot().context.reviewer?.status).toBe("working")
    actor.stop()
  })

  it("clears a finished reviewer when a new turn starts", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Done", costUsd: 0, tokens: 0 })

    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"))

    // A done tab clears with the sub-agents — same rule as theirs.
    expect(actor.getSnapshot().context.reviewer).toBeNull()
    actor.stop()
  })

  // STOP interrupts the agent turn, not the review — they're separate runs.
  it("does not stop the reviewer when the turn is stopped", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"))
    review({ _tag: "Started", sessionId: "review_s1" })

    actor.send({ type: "STOP" })
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })

    expect(actor.getSnapshot().context.reviewer?.status).toBe("working")
    actor.stop()
  })
})

/**
 * The persisted `Session.status` is what the sidebar falls back to for a session
 * the operator hasn't opened this run. It used to be written once at creation and
 * never updated, so every unopened session read "idle" — even one blocked on an
 * approval. These assert it now tracks reality, and — critically — that a BUSY
 * status is never written: a run dies with the app, so persisting "thinking"
 * would strand the session in it forever after a restart.
 */
describe("conversationMachine — persisted status", () => {
  it("does not write on load when the status already matches", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    expect(h.statusWrites).toStrictEqual([])
    actor.stop()
  })

  it("never persists a busy status while the agent runs", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Assistant", text: "working" })

    expect(h.statusWrites).toStrictEqual([])
    actor.stop()
  })

  it("records needs-input when a turn settles on a pending gate", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({
      _tag: "GateRequested",
      gate: {
        id: "g1",
        kind: "command",
        title: "run a command",
        detail: "Not in your allowlist.",
        command: "npm test",
        allowLabel: "npm test",
        status: "pending"
      }
    })
    emit({ _tag: "Done", costUsd: 0, tokens: 1 })
    await waitFor(actor, (s) => s.matches(idle))

    expect(h.statusWrites).toStrictEqual(["needs-input"])
    actor.stop()
  })

  it("returns to idle once the gate is decided, and never re-writes the same status", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({
      _tag: "GateRequested",
      gate: {
        id: "g1",
        kind: "command",
        title: "run a command",
        detail: "d",
        command: "npm test",
        allowLabel: "npm test",
        status: "pending"
      }
    })
    emit({ _tag: "Done", costUsd: 0, tokens: 1 })
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "DECIDE_GATE", gateId: "g1", decision: "allow" })
    actor.send({ type: "SEND", text: "again" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Done", costUsd: 0, tokens: 1 })
    await waitFor(actor, (s) => s.matches(idle))

    // needs-input → idle, and no duplicate writes of an unchanged status.
    expect(h.statusWrites).toStrictEqual(["needs-input", "idle"])
    actor.stop()
  })
})

describe("conversationMachine — PlanUpdated across turns", () => {
  /** A minimal one-step plan; only the id/status/steps matter to the fold. */
  const planFixture = (stepStatus: "proposed" | "done"): Plan =>
    ({
      id: "plan_1",
      summary: "Refactor auth",
      structured: true,
      graph: null,
      comments: [],
      status: "approved",
      raw: "# Refactor auth",
      steps: [
        {
          id: "s_01",
          number: "01",
          title: "Create TokenStore",
          intent: "A dedicated store.",
          approach: [],
          kind: "step",
          condition: null,
          parentId: null,
          dependsOn: [],
          blocks: [],
          files: [{ path: "src/auth/token-store.ts", change: "A", added: 40, removed: 0 }],
          guards: [],
          code: null,
          diff: null,
          status: stepStatus,
          flagged: false
        }
      ]
    }) as unknown as Plan

  it("applies a PlanUpdated to the plan's own message, not the latest one", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    // Turn 1: the plan lands in this turn's assistant message.
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "PlanProposed", plan: planFixture("proposed") })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, (s) => s.matches(idle))

    // Turn 2: a fresh assistant message — the plan part is now behind us, which
    // is exactly when a patchLast fold would silently drop the update.
    actor.send({ type: "SEND", text: "implement it" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "PlanUpdated", plan: planFixture("done") })

    const plan = latestPlan(actor.getSnapshot().context.messages)
    expect(plan?.steps[0]!.status).toBe("done")
    actor.stop()
  })
})

describe("conversationMachine — stop", () => {
  it("settles the halted turn instead of leaving it streaming forever", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Assistant", text: "working…" })
    expect(actor.getSnapshot().context.messages.at(-1)!.streaming).toBe(true)

    actor.send({ type: "STOP" })

    // The runner's own terminal event can't help here: STOP leaves `running`,
    // and STREAM_EVENT is only handled there. The machine must settle it itself.
    const last = actor.getSnapshot().context.messages.at(-1)!
    expect(last.streaming).toBe(false)
    expect(last.parts.some((p) => p._tag === "Text" && p.text === STOPPED_NOTE)).toBe(true)
    actor.stop()
  })

  it("asks the main process to stop the agent, and drops the queue", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({ type: "SEND", text: "queued" })
    expect(actor.getSnapshot().context.queued).toHaveLength(1)

    actor.send({ type: "STOP" })

    expect(h.stopCalls).toContain("s1")
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })

  /**
   * The renderer half of the silent-turn fix.
   *
   * `callStop` used to be fire-and-forget: the machine asked main to halt the
   * run and transitioned onward in the same breath, so the interrupt could land
   * after the NEXT turn had been forked and kill that instead. The operator's
   * fresh message came back as a bare "Stopped." and they re-sent it. Going
   * through `stopping` means the halt has landed before anything can start.
   */
  it("waits in `stopping` until the halt lands, before any next turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({ type: "SEND", text: "next" })

    actor.send({ type: "SEND_NOW", index: 0 })

    // Not `running` yet — the promoted message must not start until the stop
    // has been acknowledged. This is the assertion the old code failed.
    expect(actor.getSnapshot().matches("stopping")).toBe(true)
    expect(h.stopCalls).toContain("s1")

    // …and once it has, the promoted message runs as normal.
    await waitFor(actor, (s) => s.matches("running"))
    expect(actor.getSnapshot().context.pendingText).toBe("next")
    actor.stop()
  })

  // Every exit from `stopping` leads onward, including the unhappy ones: a stop
  // that rejects must never strand the session in a state with no composer.
  it("moves on even when the stop RPC fails", async () => {
    h.stopFails = true
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "STOP" })

    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.messages.at(-1)!.streaming).toBe(false)
    actor.stop()
  })
})

describe("conversationMachine — adversarial planning", () => {
  it("continues Gigaplan as orchestrator chat until explicit handoff", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SET_MODE", mode: "gigaplan" })

    actor.send({ type: "SEND", text: "The export must preserve filters" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.planCalls).toEqual([])
    expect(h.agentRunCalls[0]).toMatchObject({
      text: "The export must preserve filters",
      options: { target: "orchestrator" }
    })
    expect(actor.getSnapshot().context.messages.at(-2)?.source).toBe("gigaplan-intake")
    expect(actor.getSnapshot().context.messages.at(-1)?.source).toBe("gigaplan-intake")

    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "HANDOFF_PLAN" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.planCalls).toEqual([{ sessionId: "s1", brief: undefined }])
    const localHandoff = actor.getSnapshot().context.messages.at(-2)
    expect(localHandoff?.parts).toContainEqual({
      _tag: "Text",
      text: "Hand off this Gigaplan conversation to planning."
    })
  })

  it("applies a changed thinking strength to the next turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SET_REASONING", reasoningEffort: "think-hard" })
    actor.send({ type: "SEND", text: "inspect the repo" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(h.reasoningCalls).toEqual(["think-hard"])
    expect(h.agentRunCalls[0]).toMatchObject({
      options: { target: "session", reasoningEffort: "think-hard" }
    })
  })

  it("routes a handoff through the planning RPC, not a normal turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "HANDOFF_PLAN" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(h.planCalls).toEqual([{ sessionId: "s1", brief: undefined }])
    // Crucially NOT an Agent.run — a planning round is not a turn.
    expect(h.agentRunCalls).toEqual([])
  })

  it("refuses to start when only one lab is reachable", async () => {
    // The entry is disabled in the UI, but a stale readiness or a keyboard path
    // must not start a round the service would only refuse.
    h.readiness = { ready: false, vendors: [], reason: "needs a second provider" }
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "HANDOFF_PLAN" })
    expect(actor.getSnapshot().matches(idle)).toBe(true)
    expect(h.planCalls).toEqual([])
  })

  it("does not start before readiness has loaded", async () => {
    // Null readiness means "we do not know yet". Starting on an assumption would
    // burn two flagship runs to arrive at a refusal.
    let release = () => {}
    h.readinessGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "HANDOFF_PLAN" })
    expect(h.planCalls).toEqual([])

    release()
    await waitFor(actor, (s) => s.context.planReadiness !== null)
    actor.send({ type: "HANDOFF_PLAN" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.planCalls).toHaveLength(1)
  })

  it("folds the round's plan through the path a single-agent plan already uses", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "HANDOFF_PLAN" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({
      _tag: "PlanProposed",
      plan: {
        id: "p1",
        summary: "Add a tier column",
        steps: [],
        comments: [],
        status: "proposed",
        structured: true,
        raw: "# plan"
      }
    })
    const plans = actor
      .getSnapshot()
      .context.messages.flatMap((m) => m.parts.filter((p) => p._tag === "Plan"))
    expect(plans).toHaveLength(1)
  })

  it("clears handoff state so the next normal turn is not another round", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "HANDOFF_PLAN" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "now build it" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(h.planCalls).toHaveLength(1)
    expect(h.agentRunCalls).toHaveLength(1)
  })
})

/**
 * Approving is a fact about the PLAN, not about the composer.
 *
 * The approve button lives on the plan review screen, which outlives the mode
 * chip: a round finishes, the operator flips back to `accept-edits` to read
 * something, then approves. Guarding approval on the live mode meant that click
 * was swallowed — no run, no error, a button that simply did nothing.
 */
describe("conversationMachine — approving a plan after the mode changed", () => {
  const assignedPlan = {
    id: "p_assigned",
    summary: "Ship it",
    steps: [
      {
        id: "s1",
        number: "01",
        title: "Do the thing",
        intent: "i",
        approach: [],
        kind: "step",
        condition: null,
        parentId: null,
        dependsOn: [],
        blocks: [],
        files: [],
        guards: [],
        code: null,
        diff: null,
        status: "proposed",
        flagged: false,
        assignee: { cli: "codex", model: "gpt-5", reason: "best at schema work" }
      }
    ],
    comments: [],
    status: "proposed",
    structured: true,
    raw: "x"
  } as unknown as Plan

  const seed = (actor: ReturnType<typeof start>, plan: Plan) => {
    actor.send({ type: "HANDOFF_PLAN" })
    h.streamCb?.({ _tag: "PlanProposed", plan })
    h.streamCb?.({ _tag: "Done", costUsd: 0, tokens: 0 })
  }

  it("still runs an assigned plan per-step once the operator left Gigaplan", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    seed(actor, assignedPlan)
    await waitFor(actor, (s) => s.matches(idle))

    // The exact sequence that used to drop the click.
    actor.send({ type: "SET_MODE", mode: "accept-edits" })
    actor.send({ type: "APPROVE_PLAN", planId: assignedPlan.id })

    await waitFor(actor, (s) => s.matches("running"))
    expect(h.execCalls).toEqual([
      { sessionId: "s1", planId: "p_assigned", executionMode: "accept-edits" }
    ])
  })

  it("runs an assigned plan in auto when approval explicitly asks for it", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    seed(actor, assignedPlan)
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "APPROVE_PLAN", planId: assignedPlan.id, executionMode: "auto" })

    await waitFor(actor, (s) => s.matches("running"))
    expect(h.execCalls).toEqual([
      { sessionId: "s1", planId: "p_assigned", executionMode: "auto" }
    ])
  })

  it("never swallows the click — an unassigned plan re-drives instead", async () => {
    const plain = { ...assignedPlan, id: "p_plain", steps: [] } as unknown as Plan
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    seed(actor, plain)
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SET_MODE", mode: "accept-edits" })
    actor.send({ type: "APPROVE_PLAN", planId: "p_plain" })

    // Whatever it does, it must not sit in idle doing nothing.
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.execCalls).toEqual([])
    // The assertion that matters, and the one this test originally lacked:
    // it asserted only ABSENCES, so it passed while the machine quietly started
    // a second full planning round — two flagship models — on an approval.
    expect(h.planCalls).toHaveLength(1)
    // And it actually re-drove, rather than merely not-doing-the-wrong-thing.
    expect(h.resumeCalls).toEqual([{ sessionId: "s1", planId: "p_plain" }])
  })
})
