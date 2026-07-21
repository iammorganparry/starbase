import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Session, StreamEvent } from "@starbase/core"
import { Effect, Layer, Ref } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliAdapter } from "./adapter.js"
import type { CliAdapterShape, SessionSpec } from "./adapter.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { ConfigService } from "./config.js"
import { ContextManager } from "./context-manager.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { fakeCommandExecutor, withTempRoot } from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

/**
 * The manager is the async half of compaction, so these tests are about
 * TIMING and REFUSAL rather than summarisation quality (that lives in
 * context-digest.test.ts).
 *
 * What matters: it prepares only when it should, never twice at once, gives up
 * rather than burning tokens forever, hands the digest over exactly once, and —
 * the property the whole feature rests on — runs the summary through the
 * session's own authenticated harness rather than any separate credential.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const SESSION = "s_ctx"

/** A host where every harness is installed, so discovery reports them available. */
const installed: FakeCommandHandler = (command, args) => {
  if (command === "which" || command === "where") return { stdout: `/opt/homebrew/bin/${args[0]}` }
  if (args.includes("--version")) return { stdout: "9.9.9" }
  return { stdout: "" }
}

const GOOD_REPLY = `\`\`\`json
{
  "goal": "Add rate limiting to the refund route",
  "decisions": ["Reused the token bucket in lib/ratelimit.ts"],
  "filesTouched": ["src/routes/billing.ts"],
  "openThreads": [],
  "preferences": []
}
\`\`\``

interface Recorder {
  readonly specs: Array<SessionSpec>
  readonly runs: { count: number }
}

/**
 * A `CliAdapter` that records the spec it was handed and replies with `reply`.
 * Recording the spec is how we assert the no-extra-cost property: the digest has
 * to arrive at the user's own binary, on the cheap tier, with `fresh`.
 */
const recordingAdapter = (
  reply: string,
  recorder: Recorder,
  behaviour: "ok" | "hang" = "ok"
): Layer.Layer<CliAdapter> =>
  Layer.succeed(
    CliAdapter,
    CliAdapter.of({
      run: (_sessionId, spec, ctx) =>
        Effect.gen(function* () {
          recorder.specs.push(spec)
          recorder.runs.count += 1
          if (behaviour === "hang") return yield* Effect.never
          yield* ctx.emit({ _tag: "Assistant", text: reply } as StreamEvent)
        }),
      stop: () => Effect.void
    } satisfies CliAdapterShape)
  )

/**
 * A `CliAdapter` that STREAMS its reply as several `Assistant` deltas — the shape
 * a real harness produces (text arrives token by token via `text_delta`), and the
 * one `recordingAdapter` never exercised because it emits the whole reply at once.
 *
 * This is the regression harness for the join bug: the manager concatenates these
 * fragments, and if it joins them with anything but "" a boundary that falls
 * inside a JSON string value corrupts the reply into invalid JSON.
 */
const streamingAdapter = (parts: ReadonlyArray<string>): Layer.Layer<CliAdapter> =>
  Layer.succeed(
    CliAdapter,
    CliAdapter.of({
      run: (_sessionId, _spec, ctx) =>
        Effect.gen(function* () {
          for (const text of parts) {
            yield* ctx.emit({ _tag: "Assistant", text } as StreamEvent)
          }
        }),
      stop: () => Effect.void
    } satisfies CliAdapterShape)
  )

const layersFor = (adapter: Layer.Layer<CliAdapter>) =>
  Layer.mergeAll(
    ContextManager.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    // The swap gate reads background-task state: a task still running is the
    // clearest possible "this session is mid-flow".
    BackgroundTaskStore.Default,
    ConfigService.Default,
    DiscoveryService.Default,
    adapter,
    fakeCommandExecutor(installed),
    temp.layer
  )

/** Seed a session plus a transcript worth summarising. */
const seed = (over: Partial<Session> = {}) =>
  Effect.gen(function* () {
    const now = new Date().toISOString()
    const session: Session = {
      id: SESSION,
      repo: "trigify-app",
      branch: "starbase/ctx",
      title: "Context",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: now,
      worktreePath: temp.root,
      model: "sonnet",
      ...over
    }
    // Write straight to the store's file: `SessionStore.create` would fork a real
    // git worktree, which none of these assertions need.
    yield* Effect.sync(() => {
      mkdirSync(temp.root, { recursive: true })
      writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session], null, 2))
    })
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
    return session
  })

/**
 * `orDie` rather than a `never` error channel: the setup steps genuinely fail
 * (a missing session, an unwritable config), and a test should surface that as a
 * loud defect rather than force every caller to thread the error type.
 */
const run = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  adapter: Layer.Layer<CliAdapter>
): Promise<A> =>
  Effect.runPromise(
    program.pipe(Effect.orDie, Effect.provide(layersFor(adapter))) as Effect.Effect<A>
  )

const recorder = (): Recorder => ({ specs: [], runs: { count: 0 } })

/**
 * Wait until the adapter has been entered `n` times.
 *
 * Polling, not a fixed sleep: the digest runs on a DAEMON fiber that first shells
 * out through discovery to find the harness binary, so how long it takes to reach
 * the adapter varies with the machine. A fixed wait made these tests pass or fail
 * depending on load, which is precisely the flakiness a background feature must
 * not have in its own suite.
 */
const awaitRuns = (rec: Recorder, n: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300; i++) {
      if (rec.runs.count >= n) return
      yield* Effect.sleep("10 millis")
    }
  })

/**
 * A fixed wait, used only for NEGATIVE assertions ("nothing should happen").
 * Generous, because a false pass here means shipping a feature that fires when
 * it was told not to.
 *
 * Timing alone can never PROVE a negative, though, so every refusal test also
 * asserts the phase `observe` computed — that decision is synchronous, so a
 * phase of `idle`/`unknown` means no fork was possible regardless of scheduling.
 */
const settle = () => Effect.sleep("300 millis")

/**
 * One finished turn, in the order a harness actually reports it: the occupancy
 * reading first (`Usage`), then the end-of-turn decision (`Done`).
 *
 * `settle` takes no reading of its own by design — the number that used to be
 * passed here was the run's cumulative spend, which counts resident context
 * once per tool call and so fired a compaction on every turn.
 */
const turnEnd = (tokens: number, window?: number) =>
  Effect.zipRight(
    ContextManager.observe(SESSION, tokens, window ?? null),
    ContextManager.settle(SESSION)
  )

/** Observe, wait, and report both the run count's input and the decided phase. */
const observeAndPhase = (tokens: number) =>
  Effect.gen(function* () {
    yield* turnEnd(tokens)
    const snap = yield* ContextManager.snapshot(SESSION)
    yield* settle()
    return snap.phase
  })

/**
 * Wait until a digest is actually BUILT and waiting.
 *
 * The precise signal, rather than "the adapter was entered plus a hopeful
 * sleep": under full-suite load the daemon fiber can be descheduled between
 * replying and parsing, which made this suite's one timing-based assertion fail
 * roughly one run in ten. Polling the state it is actually waiting on has no
 * such window.
 */
const awaitDigest = () =>
  Effect.gen(function* () {
    for (let i = 0; i < 600; i++) {
      const snap = yield* ContextManager.snapshot(SESSION)
      if (snap.digestReady) return
      yield* Effect.sleep("20 millis")
    }
  })

/** Drive `observe`, then wait for the digest fiber to reach the adapter. */
const observeAndSettle = (tokens: number, rec?: Recorder, runs = 1) =>
  Effect.gen(function* () {
    yield* turnEnd(tokens)
    if (rec === undefined) return yield* settle()
    yield* awaitRuns(rec, runs)
    // The adapter has been entered; give the fiber a moment to finish parsing.
    yield* Effect.sleep("30 millis")
  })

describe("ContextManager.observe", () => {
  it("stays quiet well inside the budget", async () => {
    const rec = recorder()
    const phase = await run(
      Effect.gen(function* () {
        yield* seed()
        return yield* observeAndPhase(50_000)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(phase).toBe("idle")
    expect(rec.runs.count).toBe(0)
  })

  // A 200k Claude triggers at its safety margin (170k), not the 300k budget.
  it("prepares a digest once the working set crosses the trigger", async () => {
    const rec = recorder()
    const digest = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(180_000)
        yield* awaitDigest()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(rec.runs.count).toBe(1)
    expect(digest).not.toBeNull()
    expect(digest!.digest.goal).toContain("rate limiting")
    // The digest covers the transcript as it stood when it was built.
    expect(digest!.digest.throughMessageId).toBe("m2")
  })

  /**
   * The regression: a real harness streams its reply token by token, so the
   * manager sees many `Assistant` deltas, not one. Joining them with "\n" put a
   * raw newline inside the "goal" string below — invalid JSON — so `parseDigest`
   * failed on EVERY real digest while the single-blob scripted path stayed green.
   * The boundaries here deliberately split the goal string and the JSON syntax.
   */
  it("parses a digest whose reply streamed across deltas", async () => {
    const parts = [
      "```json\n{\n  \"goal\": \"Add rate",
      " limiting to the refund route\",",
      "\n  \"decisions\": [], \"filesTouched\": [],",
      " \"openThreads\": [], \"preferences\": []\n}\n```"
    ]
    const digest = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(180_000)
        yield* awaitDigest()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      streamingAdapter(parts)
    )
    expect(digest).not.toBeNull()
    expect(digest!.digest.goal).toBe("Add rate limiting to the refund route")
  })

  /**
   * The no-extra-cost guarantee, asserted at the only place it can be: the spec
   * handed to the adapter. The summary must run through the session's OWN
   * harness binary — the CLI the user has already logged into — on the cheapest
   * model that harness offers. No API client is constructed anywhere in this
   * path, so there is no second credential and no surprise bill.
   */
  it("summarises through the session's own authenticated harness, on the cheap tier", async () => {
    const rec = recorder()
    const discovered = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* observeAndSettle(180_000, rec)
        const clis = yield* DiscoveryService.list()
        return clis.find((c) => c.kind === "claude")?.binPath ?? null
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    const spec = rec.specs[0]!
    expect(spec.cli).toBe("claude")
    /**
     * The digest must go to whatever binary DISCOVERY resolved for this
     * session's harness — that it is the user's own authenticated CLI is the
     * whole no-extra-cost claim.
     *
     * Compared against discovery's own answer rather than asserted non-null: on
     * a machine with Claude installed the absolute-candidate probe finds a real
     * path, and on a clean CI runner it finds nothing. Asserting non-null passed
     * locally and failed in CI while the code was correct in both cases — null
     * simply means "fall through to the scripted adapter", exactly as any other
     * run would.
     */
    expect(spec.binPath).toBe(discovered)
    // haiku, not the session's sonnet — `DEFAULT_DIGEST_MODEL`.
    expect(spec.model).toBe("haiku")
    expect(spec.model).not.toBe("sonnet")
  })

  // `resumeId: null` alone is not enough — the adapter prefers its in-memory
  // resume map, so without `fresh` the digest run would resume the very
  // conversation it is trying to summarise and inherit the context we are
  // attempting to shed.
  it("runs fresh and read-only, so it cannot resume or mutate the worktree", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* observeAndSettle(180_000, rec)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    const spec = rec.specs[0]!
    expect(spec.fresh).toBe(true)
    expect(spec.readOnly).toBe(true)
    expect(spec.resumeId).toBeNull()
    // Not "plan": plan mode steers the harness toward proposing a plan instead
    // of answering, and a summariser that proposes a plan is useless.
    expect(spec.mode).toBe("ask")
  })

  it("does not fork a second digest while one is already in flight", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(180_000)
        yield* turnEnd(185_000)
        yield* turnEnd(190_000)
        yield* awaitRuns(rec, 1)
        yield* settle()
      }),
      recordingAdapter(GOOD_REPLY, rec, "hang")
    )
    expect(rec.runs.count).toBe(1)
  })

  it("does not re-prepare while a digest is already waiting to be applied", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* observeAndSettle(180_000, rec)
        yield* observeAndSettle(190_000, rec)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(rec.runs.count).toBe(1)
  })

  // A session whose digest keeps failing would otherwise fork a doomed fiber on
  // every turn forever, burning the user's tokens on a background task that has
  // never once produced a result they can see.
  it("stops retrying after repeated failures", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* observeAndSettle(180_000, rec, 1)
        yield* observeAndSettle(185_000, rec, 2)
        yield* observeAndSettle(190_000, rec, 2)
        yield* observeAndSettle(195_000, rec, 2)
      }),
      recordingAdapter("I'm sorry, I can't do that.", rec)
    )
    expect(rec.runs.count).toBe(2)
  })

  it("persists the reading so it survives a restart", async () => {
    const rec = recorder()
    const session = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* ContextManager.observe(SESSION, 123_456)
        return yield* SessionStore.get(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect((session as Session).contextTokens).toBe(123_456)
  })

  it("ignores a garbage reading", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* observeAndSettle(Number.NaN)
        yield* observeAndSettle(0)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(rec.runs.count).toBe(0)
  })

  describe("refusals", () => {
    it("leaves the session alone when auto-compaction is off globally", async () => {
      const rec = recorder()
      const phase = await run(
        Effect.gen(function* () {
          yield* seed()
          yield* ConfigService.setContext({ auto: false, budgetTokens: 300_000 })
          return yield* observeAndPhase(900_000)
        }),
        recordingAdapter(GOOD_REPLY, rec)
      )
      expect(phase).toBe("unknown")
      expect(rec.runs.count).toBe(0)
    })

    // The per-session override wins in both directions: a user mid-way through
    // something delicate can pin one session open with its history intact.
    it("honours a per-session opt-out even with the global switch on", async () => {
      const rec = recorder()
      const phase = await run(
        Effect.gen(function* () {
          yield* seed({ autoCompact: false })
          return yield* observeAndPhase(900_000)
        }),
        recordingAdapter(GOOD_REPLY, rec)
      )
      expect(phase).toBe("unknown")
      expect(rec.runs.count).toBe(0)
    })

    // Cursor has no headless adapter and runs on the scripted fallback, whose
    // token numbers are fixtures. Compacting against invented data is worse than
    // not compacting at all.
    it("leaves a harness that reports no usage alone", async () => {
      const rec = recorder()
      const phase = await run(
        Effect.gen(function* () {
          yield* seed({ cli: "cursor", model: "auto" })
          return yield* observeAndPhase(900_000)
        }),
        recordingAdapter(GOOD_REPLY, rec)
      )
      expect(phase).toBe("unknown")
      expect(rec.runs.count).toBe(0)
    })

    // opencode resolves models from the user's own credentials across ~167
    // providers, so there is no honest window to infer — it stays unknown until
    // the user declares one in Settings.
    it("leaves a harness with an unknowable window alone", async () => {
      const rec = recorder()
      const phase = await run(
        Effect.gen(function* () {
          yield* seed({ cli: "opencode", model: "opencode/big-pickle" })
          return yield* observeAndPhase(900_000)
        }),
        recordingAdapter(GOOD_REPLY, rec)
      )
      expect(phase).toBe("unknown")
      expect(rec.runs.count).toBe(0)
    })

    it("compacts opencode once the user declares the window", async () => {
      const rec = recorder()
      await run(
        Effect.gen(function* () {
          yield* seed({ cli: "opencode", model: "opencode/big-pickle" })
          yield* ConfigService.setProvider("opencode", {
            enabled: true,
            defaultMode: "accept-edits",
            contextWindow: 200_000
          })
          yield* observeAndSettle(180_000, rec)
        }),
        recordingAdapter(GOOD_REPLY, rec)
      )
      expect(rec.runs.count).toBe(1)
    })
  })
})

/**
 * The `observe` / `settle` split, which exists because of a real bug.
 *
 * Claude and opencode report usage per assistant message, so a turn that uses
 * tools reports several times before it ends. Forking on one of those readings
 * summarised a transcript whose last message was still streaming — and because
 * the digest stamps `throughMessageId` with that message's id, `tailAfter` then
 * skipped the REST of that same turn at swap time. Every tool result and closing
 * paragraph that landed afterwards was neither summarised nor replayed.
 */
describe("mid-turn readings", () => {
  it("records a mid-turn reading without starting a digest", async () => {
    const rec = recorder()
    const session = await run(
      Effect.gen(function* () {
        yield* seed()
        // Well over the 170k trigger, but the turn has not finished.
        yield* ContextManager.observe(SESSION, 180_000)
        yield* Effect.sleep("300 millis")
        return yield* SessionStore.get(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    // The reading still lands — the meter and a reload both depend on it.
    expect(session.contextTokens).toBe(180_000)
    // …but nothing was summarised from a half-written transcript.
    expect(rec.runs.count).toBe(0)
  })

  it("starts the digest once the turn settles", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* ContextManager.observe(SESSION, 175_000)
        yield* ContextManager.observe(SESSION, 178_000)
        expect(rec.runs.count).toBe(0)
        yield* turnEnd(180_000)
        yield* awaitRuns(rec, 1)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(rec.runs.count).toBe(1)
  })
})

describe("ContextManager.applyIfReady", () => {
  it("returns nothing when no digest is waiting", async () => {
    const rec = recorder()
    const digest = await run(
      Effect.gen(function* () {
        yield* seed()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(digest).toBeNull()
  })

  // Applying twice would reseed a fresh conversation with a summary of the
  // conversation it just replaced — compounding the loss on every turn.
  it("hands the digest over exactly once", async () => {
    const rec = recorder()
    const [first, second] = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(180_000)
        yield* awaitDigest()
        const a = yield* ContextManager.applyIfReady(SESSION)
        const b = yield* ContextManager.applyIfReady(SESSION)
        return [a, b] as const
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  // A digest that failed to parse must not be applied. Null is a real answer:
  // the session then behaves exactly as it does today.
  it("never applies an unparseable digest", async () => {
    const rec = recorder()
    const digest = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* observeAndSettle(180_000, rec)
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter("no json here at all", rec)
    )
    expect(digest).toBeNull()
  })
})

/**
 * What the manager BELIEVES about a session once a swap has happened.
 *
 * Every other `applyIfReady` test stops at the handover, and that gap is where
 * the eager-compaction bug lived: the reseed starts a brand-new harness
 * conversation, but the manager kept the reading that described the OLD one. A
 * session compacted at 290k therefore still measured as 290k, so the meter read
 * "compacting soon" over a 40k conversation and the very next `settle` forked a
 * second digest against a conversation that no longer existed.
 */
describe("life after a compaction", () => {
  /** Drive a session over the trigger, build a digest, and apply it. */
  const compactOnce = () =>
    Effect.gen(function* () {
      yield* seed()
      yield* turnEnd(180_000)
      yield* awaitDigest()
      return yield* ContextManager.applyIfReady(SESSION)
    })

  it("forgets the pre-compaction reading, so the next turn is not measured against it", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* compactOnce()
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.tokens).toBe(0)
    // Was "prepare" — the state behind "40k · compacting soon".
    expect(snap.phase).toBe("idle")
  })

  // The reading `settle` falls back to lives on disk, so clearing only the
  // in-memory copy would let the stale number come straight back.
  it("clears the persisted reading too, so a restart cannot resurrect it", async () => {
    const rec = recorder()
    const persisted = await run(
      Effect.gen(function* () {
        yield* compactOnce()
        return yield* SessionStore.get(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(persisted.contextTokens ?? 0).toBe(0)
  })

  // The turn after a swap has not reported usage yet. Measuring it against the
  // pre-swap number compacts a conversation that is one primer long.
  it("does not immediately fork a second digest", async () => {
    const rec = recorder()
    const runs = await run(
      Effect.gen(function* () {
        yield* compactOnce()
        const before = rec.runs.count
        // A turn that ends with no new reading at all.
        yield* ContextManager.settle(SESSION)
        yield* settle()
        return { before, after: rec.runs.count }
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(runs.after).toBe(runs.before)
  })
})

/**
 * The window the manager BELIEVES a session has, versus what it has been seen
 * holding.
 *
 * The model-id table is a guess, and a wrong guess in the low direction is not
 * the harmless conservatism it was written to be: a 1M Opus read as 200k puts
 * `triggerAt` at 170k, so the meter reads "compacting soon" at 213k and the
 * session reseeds itself every turn while the harness is entirely comfortable.
 */
describe("window correction", () => {
  it("stops trusting a table guess the session has already exceeded", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        // `opus` alone still reads as 200k from the table…
        yield* seed({ model: "opus" })
        // …but a session cannot hold 598k inside a 200k window.
        yield* ContextManager.observe(SESSION, 598_000, null)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(598_000)
    // 170k before, which is why a comfortable session compacted every turn.
    expect(snap.triggerAt).toBe(400_000)
  })

  it("keeps the corrected window after the reading falls back", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ model: "opus" })
        yield* ContextManager.observe(SESSION, 598_000, null)
        // A compaction (or simply a smaller turn) shrinks the working set. The
        // CEILING did not move.
        yield* ContextManager.observe(SESSION, 40_000, null)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(598_000)
    expect(snap.phase).toBe("idle")
  })

  // Modern Opus needs no correction at all — the table now knows it.
  it("reads a 1M window for opus 4.5+ straight from the table", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ model: "claude-opus-4-8" })
        yield* ContextManager.observe(SESSION, 213_600, null)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(1_000_000)
    // The screenshot that started this: 213.6k must read as idle, not as
    // "compacting soon".
    expect(snap.phase).toBe("idle")
  })

  // An unmeasurable harness must not have a ceiling invented from one reading.
  it("still reports unknown for a harness with no window", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ cli: "opencode", model: "opencode/big-pickle" })
        yield* ContextManager.observe(SESSION, 598_000, null)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBeNull()
    expect(snap.phase).toBe("unknown")
  })
})

/**
 * Whether a READY swap should actually be taken this turn.
 *
 * Crossing the budget says a compaction is worth doing; it says nothing about
 * whether now is the moment. Dropping a reseed into the middle of a plan or an
 * unanswered question discards exactly the working state the next turn needs —
 * so the swap waits for a boundary, bounded by the ceiling and a deferral cap.
 */
describe("the mid-flow hold", () => {
  const MID_FLOW_REPLY = `\`\`\`json
{
  "goal": "Chase down the failing 429 test",
  "decisions": [],
  "filesTouched": [],
  "openThreads": ["the 429 test"],
  "preferences": [],
  "midFlow": true,
  "midFlowReason": "mid-way through debugging the 429"
}
\`\`\``

  /** A turn ending with a question the user has not answered yet. */
  const seedUnansweredQuestion = () =>
    TranscriptStore.append(SESSION, {
      id: "m3",
      role: "assistant",
      parts: [
        {
          _tag: "Question",
          request: {
            id: "q1",
            questions: [
              { question: "Which approach?", header: "Approach", multiSelect: false, options: [] }
            ]
          },
          answers: null
        }
      ],
      streaming: false,
      createdAt: new Date().toISOString()
    })

  // 175k is over the 170k trigger (so a digest exists) but under the 190k hold
  // ceiling for a 200k window — the band the gate actually operates in.
  const IN_BAND = 175_000

  it("declines the swap while the summary says the session is mid-task", async () => {
    const rec = recorder()
    const applied = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(IN_BAND)
        yield* awaitDigest()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(MID_FLOW_REPLY, rec)
    )
    expect(applied).toBeNull()
  })

  // Holding must never DISCARD the digest — that would spend a summary for
  // nothing and force the whole thing to be rebuilt next turn.
  it("keeps the digest ready so the next turn can still take it", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(IN_BAND)
        yield* awaitDigest()
        yield* ContextManager.applyIfReady(SESSION)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(MID_FLOW_REPLY, rec)
    )
    expect(snap.digestReady).toBe(true)
    expect(snap.held).toBe(true)
    expect(snap.heldReason).toContain("429")
    // One summary, not one per turn spent holding.
    expect(rec.runs.count).toBe(1)
  })

  // A session that always looks busy would otherwise never compact at all.
  it("takes the swap once the deferral cap is reached", async () => {
    const rec = recorder()
    const attempts = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(IN_BAND)
        yield* awaitDigest()
        const results: Array<boolean> = []
        for (let i = 0; i < 4; i++) {
          results.push((yield* ContextManager.applyIfReady(SESSION)) !== null)
        }
        return results
      }),
      recordingAdapter(MID_FLOW_REPLY, rec)
    )
    expect(attempts).toStrictEqual([false, false, false, true])
  })

  // Deferral is a quality preference; the ceiling is physics. Past it the
  // alternative to compacting is a hard context error mid-turn.
  it("swaps anyway once the session is against its ceiling", async () => {
    const rec = recorder()
    const applied = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(195_000)
        yield* awaitDigest()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(MID_FLOW_REPLY, rec)
    )
    expect(applied).not.toBeNull()
  })

  /**
   * The structural half, which no summary can see: the digest here reports a
   * clean boundary, and the hold comes entirely from the transcript.
   */
  it("holds on an unanswered question even when the summary saw a boundary", async () => {
    const rec = recorder()
    const applied = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(IN_BAND)
        yield* awaitDigest()
        yield* seedUnansweredQuestion()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(applied).toBeNull()
  })

  // The common case must be untouched: a session at a natural boundary compacts
  // the moment its digest is ready, exactly as before.
  it("does not hold a session that is at a boundary", async () => {
    const rec = recorder()
    const applied = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(IN_BAND)
        yield* awaitDigest()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(applied).not.toBeNull()
  })
})

describe("ContextManager.compactNow", () => {
  it("prepares a digest well below the trigger", async () => {
    const rec = recorder()
    const digest = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* ContextManager.compactNow(SESSION)
        yield* awaitDigest()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(rec.runs.count).toBe(1)
    expect(digest).not.toBeNull()
  })

  it("is a no-op while a digest is already in flight", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed()
        yield* ContextManager.compactNow(SESSION)
        yield* ContextManager.compactNow(SESSION)
        yield* awaitRuns(rec, 1)
        yield* settle()
      }),
      recordingAdapter(GOOD_REPLY, rec, "hang")
    )
    expect(rec.runs.count).toBe(1)
  })

  // Manual or not, a compaction against an unmeasurable harness is guesswork.
  it("still refuses a harness whose window is unknown", async () => {
    const rec = recorder()
    await run(
      Effect.gen(function* () {
        yield* seed({ cli: "opencode", model: "opencode/big-pickle" })
        yield* ContextManager.compactNow(SESSION)
        yield* settle()
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(rec.runs.count).toBe(0)
  })
})

describe("ContextManager.cancel", () => {
  it("interrupts an in-flight digest so a stopped session stops summarising", async () => {
    const rec = recorder()
    const digest = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(180_000)
        yield* ContextManager.cancel(SESSION)
        yield* settle()
        return yield* ContextManager.applyIfReady(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec, "hang")
    )
    expect(digest).toBeNull()
  })
})

describe("ContextManager.snapshot", () => {
  it("reports the trigger point, not the raw window", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(100_000)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(200_000)
    expect(snap.triggerAt).toBe(170_000)
    expect(snap.tokens).toBe(100_000)
    expect(snap.phase).toBe("idle")
  })

  // The headline property, visible in the UI: a 1M model fills its meter against
  // the quality budget, not against 1M.
  it("measures a 1M-window model against the budget", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ model: "claude-fable-5" })
        yield* turnEnd(100_000)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(1_000_000)
    expect(snap.triggerAt).toBe(400_000)
  })

  // The regression this whole change exists for: a model whose real ceiling the
  // prefix table under-reports must be measured against what the HARNESS says,
  // not against the guess. `claude-opus-4-8` matches the `opus → 200k` row, so
  // the guess alone would trigger at 170k and compact a session that is barely
  // half full.
  it("prefers the window the harness reported over the guessed table", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ model: "claude-opus-4-8" })
        yield* turnEnd(250_000, 1_000_000)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(1_000_000)
    expect(snap.triggerAt).toBe(400_000)
    expect(snap.phase).toBe("idle")
    expect(rec.runs.count).toBe(0)
  })

  // The user's explicit Settings value is also the escape hatch for a harness
  // whose self-report we have reason to distrust, so it still wins.
  it("lets the user's configured window override the harness report", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ model: "claude-opus-4-8" })
        yield* ConfigService.setProvider("claude", {
          enabled: true,
          defaultMode: "accept-edits",
          contextWindow: 200_000
        })
        yield* turnEnd(100_000, 1_000_000)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBe(200_000)
    expect(snap.triggerAt).toBe(170_000)
  })

  it("reports unknown for a harness it cannot measure", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ cli: "cursor", model: "auto" })
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.window).toBeNull()
    expect(snap.triggerAt).toBeNull()
    expect(snap.phase).toBe("unknown")
  })

  // A freshly reopened session must show its real size before its first turn,
  // which is exactly what the persisted reading is for.
  it("falls back to the persisted reading before the first turn", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed({ contextTokens: 175_000 })
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.tokens).toBe(175_000)
  })

  it("counts compactions so the UI can show what happened", async () => {
    const rec = recorder()
    const snap = await run(
      Effect.gen(function* () {
        yield* seed()
        yield* turnEnd(180_000)
        yield* awaitDigest()
        yield* ContextManager.applyIfReady(SESSION)
        return yield* ContextManager.snapshot(SESSION)
      }),
      recordingAdapter(GOOD_REPLY, rec)
    )
    expect(snap.compactions).toBe(1)
    expect(snap.lastCompactedAt).not.toBeNull()
  })
})
