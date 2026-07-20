import { Effect, Fiber } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { AgentContext, SessionSpec } from "./adapter.js"

/**
 * Interrupting a run must not report "stopped" while the run is still writing.
 *
 * `plan-executor` runs steps SEQUENTIALLY on purpose: they share one worktree,
 * so two agents editing at once interleave writes with no lock. A step that
 * exceeds `STEP_TIMEOUT` is interrupted and retried — and the retry starts the
 * moment interruption completes.
 *
 * Aborting only ASKS the SDK to stop. The `for await` loop and any in-flight
 * Bash command keep running until they notice. So if interruption completes
 * immediately, the retry begins while attempt 1 is mid-write, into the same
 * files, and the corruption is silent and unreproducible.
 *
 * This pins the ordering: the finalizer does not finish until the run body has
 * actually unwound.
 */

/** Set by the mocked SDK's `finally` — i.e. the body has genuinely unwound. */
let bodyUnwound = false

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      try {
        // Stands in for a tool call that keeps running after the abort is
        // signalled: it takes a beat to notice and unwind.
        await new Promise((resolve) => setTimeout(resolve, 300))
        yield { type: "result" } as never
      } finally {
        bodyUnwound = true
      }
    },
    interrupt: async () => {},
    setPermissionMode: async () => {}
  })
}))

const ctx: AgentContext = {
  emit: () => Effect.void,
  canUseTool: () => Effect.succeed("allow" as never),
  askQuestion: () => Effect.succeed([] as never),
  proposePlan: () => Effect.succeed({ _tag: "Reject" } as never),
  registerBackgroundStop: () => Effect.void
}

const spec = {
  cli: "claude",
  repo: "widget",
  branch: "b",
  cwd: "/tmp/wt",
  prompt: "do the thing",
  images: [],
  binPath: null,
  mode: "accept-edits",
  model: null,
  resumeId: null
} as unknown as SessionSpec

describe("interrupting a Claude run", () => {
  it("does not complete until the run body has unwound", async () => {
    const { runClaude } = await import("./claude-adapter.js")

    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(runClaude("s1", spec, ctx, new Map()))
      // Let the run get as far as the iterator, which then parks for 300ms.
      yield* Effect.sleep("50 millis")
      expect(bodyUnwound).toBe(false)

      // Interrupt mid-flight, exactly as the step timeout does.
      yield* Fiber.interrupt(fiber)

      // The discriminator: if the finalizer returned as soon as it signalled
      // the abort, we'd be here at ~50ms with the body still running — and the
      // executor would start its retry into those pending writes.
      expect(bodyUnwound).toBe(true)
    }).pipe(Effect.runPromise)
  })
})
