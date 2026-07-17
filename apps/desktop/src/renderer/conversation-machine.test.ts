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
  agentRunCalls: [] as Array<{ sessionId: string; text: string; images: unknown }>,
  diffValue: "diff-0",
  diffCalls: 0,
  statusWrites: [] as Array<string>,
  skillsListCalls: 0,
  stopCalls: [] as Array<string>,
  /** Push reviewer events into the machine, as ReviewService's stream would. */
  reviewCb: null as null | ((event: unknown) => void),
  // Lets a test hold the catalogue in flight to prove nothing waits on it.
  catalogGate: Promise.resolve() as Promise<void>,
  // Same, for the skills probe — it spawns the harness, so nothing may wait on it.
  skillsGate: Promise.resolve() as Promise<void>,
  setHarnessCalls: [] as Array<{ sessionId: string; cli: string; model: string }>,
  catalog: [
    { cli: "claude", label: "Claude Code", models: [{ id: "opus", label: "opus" }] },
    { cli: "codex", label: "Codex CLI", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }] }
  ]
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsTranscript: async () => [],
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
    agentRun: (sessionId: string, text: string, onEvent: (event: unknown) => void, images: unknown) => {
      h.agentRunCalls.push({ sessionId, text, images })
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
    agentSetHarness: async (sessionId: string, cli: string, model: string) => {
      h.setHarnessCalls.push({ sessionId, cli, model })
    },
    agentCommentPlanStep: async () => {},
    agentRevisePlan: async () => {},
    agentApprovePlan: async () => {},
    agentStop: async (sessionId: string) => {
      h.stopCalls.push(sessionId)
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
  h.setHarnessCalls.length = 0
  h.catalogGate = Promise.resolve()
  h.skillsGate = Promise.resolve()
  h.reviewCb = null
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
    expect(actor.getSnapshot().context.queued).toEqual([{ text: "second", images: [] }])
    expect(h.agentRunCalls).toHaveLength(1)

    // Finishing the turn drains the queue: refresh diff, then start the queued turn.
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(h.agentRunCalls[1]!.text).toBe("second")
    expect(actor.getSnapshot().context.queued).toEqual([])
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

    it("degrades plan mode to ask when leaving Claude", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      actor.send({ type: "SET_MODE", mode: "plan" })
      expect(actor.getSnapshot().context.mode).toBe("plan")

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      // Plan mode is Claude-only — Codex would be handed a mode it can't honour.
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
})
