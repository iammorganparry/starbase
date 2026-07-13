import type { Session, StreamEvent } from "@starbase/core"
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
  diffCalls: 0
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsTranscript: async () => [],
    skillsList: async () => [],
    workspaceFiles: async () => [],
    modelsList: async () => [],
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
    agentDecideGate: async () => {},
    agentAnswerQuestion: async () => {},
    agentSetMode: async () => {},
    agentSetModel: async () => {},
    agentCommentPlanStep: async () => {},
    agentRevisePlan: async () => {},
    agentApprovePlan: async () => {},
    agentStop: async () => {}
  }
}))

const session = {
  id: "s1",
  cli: "claude",
  worktreePath: "/tmp/wt",
  mode: "accept-edits",
  model: null
} as unknown as Session

const emit = (event: StreamEvent) => h.streamCb?.(event)
const start = () => createActor(conversationMachine, { input: { session } }).start()
const idle = "awaitingInput" as const

beforeEach(() => {
  h.streamCb = null
  h.agentRunCalls.length = 0
  h.diffValue = "diff-0"
  h.diffCalls = 0
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
})
