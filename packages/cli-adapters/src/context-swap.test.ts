import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Session, StreamEvent } from "@starbase/core"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliAdapter } from "./adapter.js"
import type { CliAdapterShape, SessionSpec } from "./adapter.js"
import { AgentRunner } from "./agent-runner.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { ConfigService } from "./config.js"
import { ContextManager } from "./context-manager.js"
import { DiscoveryService } from "./discovery.js"
import { PlanStore } from "./plan-store.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { fakeCommandExecutor, withTempRoot } from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

/**
 * The swap: the point where a prepared digest actually reseeds the harness.
 *
 * This is the feature's whole claim, so it is asserted end-to-end through the
 * real `AgentRunner` rather than against the manager in isolation — what matters
 * is the SPEC the harness receives and the transcript the user is left with.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const SESSION = "s_swap"

const installed: FakeCommandHandler = (command, args) => {
  if (command === "which" || command === "where") return { stdout: `/opt/homebrew/bin/${args[0]}` }
  if (args.includes("--version")) return { stdout: "9.9.9" }
  return { stdout: "" }
}

const DIGEST_REPLY = `\`\`\`json
{
  "goal": "Add rate limiting to the refund route",
  "decisions": ["Reused the token bucket in lib/ratelimit.ts rather than adding a dependency"],
  "filesTouched": ["src/routes/billing.ts"],
  "openThreads": ["The 429 test is still failing"],
  "preferences": ["Prefers Effect over raw async"]
}
\`\`\``

const specs: Array<SessionSpec> = []

/**
 * One adapter serving both roles, told apart by the run id: the digest run is
 * keyed `digest_<session>`, the real turn by the session id itself. Recording
 * both is what lets a single test assert the handoff between them.
 */
const adapter: Layer.Layer<CliAdapter> = Layer.succeed(
  CliAdapter,
  CliAdapter.of({
    run: (runId, spec, ctx) =>
      Effect.gen(function* () {
        specs.push(spec)
        if (runId.startsWith("digest_")) {
          yield* ctx.emit({ _tag: "Assistant", text: DIGEST_REPLY } as StreamEvent)
          return
        }
        yield* ctx.emit({ _tag: "Started", sessionId: "harness_thread_new" } as StreamEvent)
        yield* ctx.emit({ _tag: "Assistant", text: "Carrying on." } as StreamEvent)
        yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 12_000 } as StreamEvent)
      }),
    stop: () => Effect.void
  } satisfies CliAdapterShape)
)

const layers = () =>
  Layer.mergeAll(
    AgentRunner.Default,
    ContextManager.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    PlanStore.Default,
    ConfigService.Default,
    DiscoveryService.Default,
    adapter,
    fakeCommandExecutor(installed),
    temp.layer
  )

const seed = (over: Partial<Session> = {}) =>
  Effect.sync(() => {
    const now = new Date().toISOString()
    const session: Session = {
      id: SESSION,
      repo: "trigify-app",
      branch: "starbase/swap",
      title: "Swap",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      // The two numbers deliberately differ, and by orders of magnitude.
      //
      // This fixture used to set `tokens: 290_000` and no `contextTokens`, so the
      // "what was the working set" assertion below passed while the runner was
      // reading the LIFETIME total — which is exactly how the marker shipped
      // saying "Context compacted from 49894.2k". A fixture that cannot tell the
      // two apart cannot catch the bug.
      tokens: 49_894_200,
      contextTokens: 290_000,
      updatedAt: now,
      worktreePath: temp.root,
      model: "sonnet",
      resumeId: "harness_thread_old",
      ...over
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session], null, 2))
  })

const seedTranscript = () =>
  Effect.gen(function* () {
    const now = new Date().toISOString()
    yield* TranscriptStore.append(SESSION, {
      id: "m1",
      role: "user",
      parts: [{ _tag: "Text", text: "add rate limiting" }],
      streaming: false,
      createdAt: now
    })
    yield* TranscriptStore.append(SESSION, {
      id: "m2",
      role: "assistant",
      parts: [{ _tag: "Text", text: "Added the middleware." }],
      streaming: false,
      createdAt: now
    })
  })

/**
 * Block until the digest is built, and DIE if it never is.
 *
 * The give-up used to be silent: the loop simply ran out and the test carried on
 * to prompt without a digest, so a slow machine failed on `expect(spec.fresh)`
 * — pointing at the swap logic when the real story was that the summary hadn't
 * finished yet. A loud failure names the actual condition, and the longer budget
 * keeps it from firing merely because the suite is running under load.
 */
const awaitDigest = () =>
  Effect.gen(function* () {
    for (let i = 0; i < 1500; i++) {
      if ((yield* ContextManager.snapshot(SESSION)).digestReady) return
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(
      new Error("digest never became ready — the compaction never prepared one")
    )
  })

/** Seed, prepare a digest, then run one real turn. Returns what the user is left with. */
const compactThenPrompt = (over: Partial<Session> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed(over)
      yield* seedTranscript()
      yield* ContextManager.compactNow(SESSION)
      yield* awaitDigest()

      const events: Array<StreamEvent> = []
      const runner = yield* AgentRunner
      yield* runner
        .prompt(SESSION, "and what did we decide about the token bucket?")
        .pipe(Stream.runForEach((e) => Effect.sync(() => events.push(e))))

      return {
        events,
        transcript: yield* TranscriptStore.list(SESSION),
        session: yield* SessionStore.get(SESSION)
      }
    }).pipe(Effect.orDie, Effect.provide(layers())) as Effect.Effect<{
      events: Array<StreamEvent>
      transcript: readonly { id: string; parts: readonly { _tag: string }[] }[]
      session: Session
    }>
  )

/** The spec for the real turn (the digest run is recorded under its own id). */
const turnSpec = (): SessionSpec => specs[specs.length - 1]!

beforeEach(() => {
  specs.length = 0
})

describe("compaction swap", () => {
  it("starts a FRESH harness conversation instead of resuming the old thread", async () => {
    await compactThenPrompt()
    const spec = turnSpec()
    // `resumeId: null` alone would lose to the adapter's in-memory resume map,
    // which is keyed per session — the old conversation would quietly continue
    // and the whole compaction would be a no-op that still cost a digest.
    expect(spec.resumeId).toBeNull()
    expect(spec.fresh).toBe(true)
  })

  it("seeds the fresh conversation with what the summary kept", async () => {
    await compactThenPrompt()
    const prompt = turnSpec().prompt
    expect(prompt).toContain("Add rate limiting to the refund route")
    expect(prompt).toContain("token bucket")
    expect(prompt).toContain("src/routes/billing.ts")
    expect(prompt).toContain("429 test")
    expect(prompt).toContain("Prefers Effect over raw async")
  })

  it("still sends the user's actual message, after the primer", async () => {
    await compactThenPrompt()
    const prompt = turnSpec().prompt
    expect(prompt).toContain("and what did we decide about the token bucket?")
    // Order matters: the primer is context for the message, not a reply to it.
    expect(prompt.indexOf("CONTEXT COMPACTED")).toBeLessThan(
      prompt.indexOf("and what did we decide")
    )
  })

  /**
   * The property that distinguishes this from `/compact`: the user's history is
   * untouched. Only the MODEL's working set shrinks — scroll back and everything
   * is still there.
   */
  it("never truncates the transcript", async () => {
    const { transcript } = await compactThenPrompt()
    expect(transcript.map((m) => m.id)).toContain("m1")
    expect(transcript.map((m) => m.id)).toContain("m2")
    // Plus this turn's user + assistant messages.
    expect(transcript.length).toBeGreaterThanOrEqual(4)
  })

  // Without a marker the context meter simply drops with no explanation, which
  // is how `/compact` behaves and exactly why it reads as data loss.
  it("records the compaction in the transcript so the drop is explicable", async () => {
    const { events, transcript } = await compactThenPrompt()
    expect(events.some((e) => e._tag === "ContextCompacted")).toBe(true)
    const parts = transcript.flatMap((m) => m.parts.map((p) => p._tag))
    expect(parts).toContain("Context")
  })

  /**
   * The marker must quote the WORKING SET, never the session's lifetime spend.
   *
   * `Session.tokens` accrues forever and reached ~49.9M on a real session, which
   * the divider rendered as "Context compacted from 49894.2k" — a number larger
   * than any context window in existence. The working set is `contextTokens`,
   * the field the domain type separates out precisely so a compaction can make
   * a number fall.
   */
  it("reports what the working set was before the reseed", async () => {
    const { events } = await compactThenPrompt()
    const marker = events.find((e) => e._tag === "ContextCompacted")
    expect(marker).toBeDefined()
    expect((marker as { tokensBefore: number }).tokensBefore).toBe(290_000)
  })

  it("never quotes the session's lifetime token total", async () => {
    const { events } = await compactThenPrompt()
    const marker = events.find((e) => e._tag === "ContextCompacted") as { tokensBefore: number }
    expect(marker.tokensBefore).not.toBe(49_894_200)
    // Belt and braces: no working set can exceed the model's own window.
    expect(marker.tokensBefore).toBeLessThan(1_000_000)
  })

  // A session that has never reported occupancy has nothing honest to quote, and
  // 0 is how the divider is told to hide the clause entirely.
  it("reports 0 rather than a lifetime total when the working set is unknown", async () => {
    const { events } = await compactThenPrompt({ contextTokens: undefined })
    const marker = events.find((e) => e._tag === "ContextCompacted") as { tokensBefore: number }
    expect(marker.tokensBefore).toBe(0)
  })

  /**
   * Belt and braces against a crash between clearing and the harness reporting
   * its new id: a session left pointing at a thread whose context we have
   * already decided to abandon would resume it on the next launch, silently
   * undoing the compaction.
   */
  it("adopts the new harness thread and never the abandoned one", async () => {
    const { session } = await compactThenPrompt()
    expect(session.resumeId).toBe("harness_thread_new")
    expect(session.resumeId).not.toBe("harness_thread_old")
  })

  it("applies only once — the turn after a swap resumes normally", async () => {
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        yield* seedTranscript()
        yield* ContextManager.compactNow(SESSION)
        yield* awaitDigest()
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, "first").pipe(Stream.runDrain)
        specs.length = 0
        yield* runner.prompt(SESSION, "second").pipe(Stream.runDrain)
        return specs[specs.length - 1]!
      }).pipe(Effect.orDie, Effect.provide(layers())) as Effect.Effect<SessionSpec>
    )
    // The second turn resumes the conversation the first one established.
    expect(second.fresh).toBeUndefined()
    expect(second.resumeId).toBe("harness_thread_new")
    expect(second.prompt).not.toContain("CONTEXT COMPACTED")
  })
})

describe("no compaction pending", () => {
  it("leaves the turn byte-identical to today", async () => {
    const spec = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed()
        yield* seedTranscript()
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, "just a normal turn").pipe(Stream.runDrain)
        return specs[specs.length - 1]!
      }).pipe(Effect.orDie, Effect.provide(layers())) as Effect.Effect<SessionSpec>
    )
    expect(spec.resumeId).toBe("harness_thread_old")
    expect(spec.fresh).toBeUndefined()
    // "Byte-identical" now means "carries no compaction primer". The standing
    // question-channel note prefixes every turn regardless, so the meaningful
    // assertion is that no summary was spliced in and the user's text is last.
    expect(spec.prompt).not.toContain("[CONTEXT COMPACTED]")
    expect(spec.prompt.endsWith("just a normal turn")).toBe(true)
  })
})
