import type { StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { PermissionDecision } from "./adapter.js"
import { CliAdapter } from "./adapter.js"
import type { AgentContext, CliAdapterShape, SessionSpec } from "./adapter.js"
import { CommandExecutor } from "@effect/platform"
import { Effect, Fiber, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DiscoveryService } from "./discovery.js"
import { ReviewService, extractJsonBlock, parseFindings } from "./review.js"
import { adversarialPrompt, fenceFor } from "./review-prompt.js"
import type { ReviewEnv, ReviewInput } from "./review.js"
import { ReviewStore } from "./review-store.js"
import { fakeCommandExecutor, withTempRoot } from "./test-support.js"

/**
 * The reviewer has two guarantees that are load-bearing and easy to break
 * silently, so they are asserted rather than trusted:
 *
 *  1. It NEVER mutates the branch — every gated action is denied.
 *  2. It NEVER parks — an auto-review runs with no UI, so a question or a plan
 *     proposal would hang a fiber forever with nobody to answer it.
 *
 * Plus the parser, which is the one place a well-behaved reviewer's output can
 * still be lost.
 */

const INPUT: ReviewInput = {
  sessionId: "s1",
  prNumber: 42,
  headSha: "abc123",
  cwd: "/wt",
  repo: "acme/widget",
  branch: "feature",
  baseBranch: "main",
  cli: "claude",
  model: "claude-fable-5",
  diff: "diff --git a/a.ts b/a.ts\n+const x = 1\n"
}

/** A CliAdapter whose `run` is the supplied script. */
const stubAdapter = (
  script: (sessionId: string, spec: SessionSpec, ctx: AgentContext) => Effect.Effect<void>
): Layer.Layer<CliAdapter> =>
  Layer.succeed(
    CliAdapter,
    CliAdapter.of({
      run: ((sessionId: string, spec: SessionSpec, ctx: AgentContext) =>
        script(sessionId, spec, ctx)) as CliAdapterShape["run"],
      stop: () => Effect.void
    })
  )

/** A host where `claude` and `codex` resolve on PATH (so discovery finds a binary). */
const installedHarnesses = fakeCommandExecutor((command, args) => {
  if (command === "which" || command === "where") {
    return args[0] === "claude" || args[0] === "codex"
      ? { stdout: `/usr/local/bin/${args[0]}` }
      : { stdout: "" }
  }
  return { stdout: "2.1.0" }
})

/** A host with no coding CLI installed at all. */
const noHarnesses = fakeCommandExecutor(() => ({ exitCode: 1, stdout: "" }))

// A real temp `~/starbase` per test: the reviewer's transcript is persisted so
// its tab survives a restart, and asserting that against a real file is the only
// way to know the round-trip actually works.
let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => {
  temp.cleanup()
})

const env = (
  adapter: Layer.Layer<CliAdapter>,
  executor: Layer.Layer<CommandExecutor.CommandExecutor> = installedHarnesses
) =>
  Layer.mergeAll(
    ReviewService.Default,
    adapter,
    DiscoveryService.Default,
    ReviewStore.Default,
    // Real FS + AppPaths for the transcript store…
    temp.layer,
    // …but CLI detection must stay canned, so the fake executor is merged LAST
    // and wins over the Node one `temp.layer` brings in.
    executor
  ) as Layer.Layer<ReviewService | ReviewEnv>

const runReview = (adapter: Layer.Layer<CliAdapter>, input: ReviewInput = INPUT) =>
  Effect.runPromise(ReviewService.run(input).pipe(Effect.provide(env(adapter))))

const emitJson = (ctx: AgentContext, body: string) =>
  ctx.emit({ _tag: "Assistant", text: "```json\n" + body + "\n```" })

/** An adapter that counts spawns — so "no reviewer ran" is a fact, not a hope. */
const countingStub = () => {
  const state = { spawns: 0 }
  const layer = stubAdapter((_id, _s, ctx) =>
    Effect.gen(function* () {
      state.spawns += 1
      yield* emitJson(ctx, '{"findings":[]}')
    })
  )
  return {
    layer,
    get spawns() {
      return state.spawns
    }
  }
}

describe("ReviewService — read-only guarantee", () => {
  it("denies every gated action, so the branch is never mutated", async () => {
    const decisions: PermissionDecision[] = []
    const adapter = stubAdapter((_id, _spec, ctx) =>
      Effect.gen(function* () {
        decisions.push(
          yield* ctx.canUseTool({ kind: "edit", tool: "Edit", target: "a.ts", command: null })
        )
        decisions.push(
          yield* ctx.canUseTool({ kind: "command", tool: "Bash", target: null, command: "rm -rf ." })
        )
        decisions.push(
          yield* ctx.canUseTool({ kind: "command", tool: "Bash", target: null, command: "git push" })
        )
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await runReview(adapter)
    expect(decisions).toStrictEqual(["deny", "deny", "deny"])
  })
})

describe("ReviewService — never parks", () => {
  // No UI is attached to an auto-review. A reviewer that asks a question or
  // proposes a plan must be answered immediately, or the run hangs forever.
  it("answers a question immediately instead of waiting for a user", async () => {
    const adapter = stubAdapter((_id, _spec, ctx) =>
      Effect.gen(function* () {
        const answers = yield* ctx.askQuestion({
          id: "q1",
          questions: [{ question: "Which module?", header: "Scope", options: [], multiSelect: false }]
        })
        expect(answers).toStrictEqual([])
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await expect(runReview(adapter)).resolves.toBeDefined()
  })

  it("rejects a proposed plan immediately", async () => {
    const adapter = stubAdapter((_id, _spec, ctx) =>
      Effect.gen(function* () {
        const decision = yield* ctx.proposePlan({
          id: "p1",
          summary: "A plan",
          steps: [],
          status: "proposed"
        } as never)
        expect(decision._tag).toBe("Reject")
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await expect(runReview(adapter)).resolves.toBeDefined()
  })
})

describe("ReviewService — spec", () => {
  it("runs on the configured review model, not the session's", async () => {
    let spec: SessionSpec | undefined
    const adapter = stubAdapter((_id, s, ctx) =>
      Effect.gen(function* () {
        spec = s
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await runReview(adapter)
    expect(spec?.model).toBe("claude-fable-5")
  })

  it("runs in the session's worktree as a fresh throwaway conversation", async () => {
    let spec: SessionSpec | undefined
    const adapter = stubAdapter((_id, s, ctx) =>
      Effect.gen(function* () {
        spec = s
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await runReview(adapter)
    expect(spec?.cwd).toBe("/wt")
    expect(spec?.resumeId).toBeNull()
    // `resumeId: null` alone is NOT enough — the real adapter's in-memory resume
    // map WINS over the spec, and our adapter key is stable per session, so
    // without `fresh` every re-review would silently resume the previous one and
    // inherit the old head's diff and findings. Asserting resumeId against a stub
    // adapter cannot catch that; this can.
    expect(spec?.fresh).toBe(true)
  })

  it("asks the harness itself to enforce read-only, not just our gate", async () => {
    let spec: SessionSpec | undefined
    const adapter = stubAdapter((_id, s, ctx) =>
      Effect.gen(function* () {
        spec = s
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await runReview(adapter)
    // `canUseTool` alone is not enough twice over: it only fires for tool names
    // we map, and the Codex adapter never calls it. See mapCodexPolicy /
    // READ_ONLY_DISALLOWED for how each harness honours this.
    expect(spec?.readOnly).toBe(true)
  })

  it("feeds the diff to the reviewer so it needs no tool call to find it", async () => {
    let spec: SessionSpec | undefined
    const adapter = stubAdapter((_id, s, ctx) =>
      Effect.gen(function* () {
        spec = s
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )
    await runReview(adapter)
    expect(spec?.prompt).toContain("const x = 1")
    expect(spec?.prompt).toContain("#42")
  })

  /**
   * The scripted-stub trap. `selectHarness` routes to the deterministic SCRIPTED
   * adapter whenever `binPath === null` (or for cursor, which has no adapter).
   * The stub emits canned prose about an unrelated task — which would parse to
   * "no findings", succeed, and get CACHED against the real PR head. The user
   * would read fiction as a review of their code, and the de-dupe would never
   * let it retry. It must fail loudly instead.
   */
  it("refuses to run when the harness isn't installed, rather than reviewing with the stub", async () => {
    const { layer, spawns } = countingStub()
    const exit = await Effect.runPromiseExit(
      ReviewService.run(INPUT).pipe(Effect.provide(env(layer, noHarnesses)))
    )
    expect(exit._tag).toBe("Failure")
    expect(spawns).toBe(0)
  })

  it("refuses cursor, which has no headless adapter to review with", async () => {
    const { layer, spawns } = countingStub()
    const exit = await Effect.runPromiseExit(
      ReviewService.run({ ...INPUT, cli: "cursor" }).pipe(Effect.provide(env(layer)))
    )
    expect(exit._tag).toBe("Failure")
    expect(spawns).toBe(0)
  })

  /**
   * `gh pr diff` folds any failure to "". Reviewing "" yields a confident "found
   * nothing", cached against the real head — so a transient gh hiccup becomes a
   * permanent false all-clear only a forced re-run can clear.
   */
  it("refuses an empty diff rather than reporting a false all-clear", async () => {
    const { layer, spawns } = countingStub()
    const exit = await Effect.runPromiseExit(
      ReviewService.run({ ...INPUT, diff: "   " }).pipe(Effect.provide(env(layer)))
    )
    expect(exit._tag).toBe("Failure")
    expect(spawns).toBe(0)
  })

  it("serialises concurrent reviews of one session", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const adapter = stubAdapter((_id, _s, ctx) =>
      Effect.gen(function* () {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        yield* Effect.sleep("10 millis")
        yield* emitJson(ctx, '{"findings":[]}')
        inFlight -= 1
      })
    )
    // The handler's de-dupe is a check-then-act with no lock, and the manual run
    // (a mutation) and auto run (a polled query) sit in different react-query
    // caches — so without this, clicking "Review again" mid-auto-review spawns a
    // second agent on the same diff.
    await Effect.runPromise(
      Effect.all([ReviewService.run(INPUT), ReviewService.run(INPUT)], {
        concurrency: "unbounded"
      }).pipe(Effect.provide(env(adapter)))
    )
    expect(maxInFlight).toBe(1)
  })

  it("surfaces a harness failure as a ReviewError", async () => {
    const adapter = stubAdapter(() =>
      Effect.fail({ message: "claude not installed" }) as unknown as Effect.Effect<void>
    )
    const exit = await Effect.runPromiseExit(
      ReviewService.run(INPUT).pipe(Effect.provide(env(adapter)))
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("ReviewService — output handling", () => {
  it("decodes findings and stamps the review with the reviewed head", async () => {
    const adapter = stubAdapter((_id, _spec, ctx) =>
      emitJson(
        ctx,
        JSON.stringify({
          findings: [
            {
              path: "src/auth.ts",
              line: 12,
              endLine: null,
              severity: "critical",
              title: "Token compared with ==",
              rationale: "Timing-unsafe.",
              suggestion: "Use timingSafeEqual."
            }
          ]
        })
      )
    )
    const review = await runReview(adapter)
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]!.severity).toBe("critical")
    expect(review.findings[0]!.path).toBe("src/auth.ts")
    expect(review.headSha).toBe("abc123")
    expect(review.note).toBeNull()
  })

  // A clean review is a real outcome, distinct from a broken one.
  it("an empty findings array is a clean review, not a note", async () => {
    const adapter = stubAdapter((_id, _spec, ctx) => emitJson(ctx, '{"findings":[]}'))
    const review = await runReview(adapter)
    expect(review.findings).toStrictEqual([])
    expect(review.note).toBeNull()
  })

  it("folds unparseable output to a note instead of failing", async () => {
    const adapter = stubAdapter((_id, _spec, ctx) =>
      ctx.emit({ _tag: "Assistant", text: "I cannot review this diff." })
    )
    const review = await runReview(adapter)
    expect(review.findings).toStrictEqual([])
    expect(review.note).toContain("cannot review")
  })

  it("never reports an empty list as a clean review when the reviewer said nothing", async () => {
    const adapter = stubAdapter(() => Effect.void)
    const review = await runReview(adapter)
    expect(review.note).not.toBeNull()
  })

  // A reviewer that spawns a subagent would otherwise interleave its chatter,
  // and a subagent's illustrative JSON could win the "last block" race.
  it("ignores subagent output when collecting the reply", async () => {
    const adapter = stubAdapter((_id, _spec, ctx) =>
      Effect.gen(function* () {
        yield* ctx.emit({
          _tag: "Assistant",
          text: '```json\n{"findings":[{"title":"from a subagent","severity":"nit"}]}\n```',
          agentId: "task_1"
        })
        yield* emitJson(ctx, '{"findings":[{"title":"from the reviewer","severity":"major"}]}')
      })
    )
    const review = await runReview(adapter)
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]!.title).toBe("from the reviewer")
  })
})

/**
 * The diff is arbitrary, attacker-influenced text. A fixed ``` fence lets any PR
 * that touches a markdown file (a README, a changeset — this very feature's own
 * PR) close the block early, spilling the rest of the diff out of the code block
 * where it reads as prose the reviewer may follow.
 */
describe("fenceFor / diff embedding", () => {
  it("uses a plain fence for a diff with no backticks", () => {
    expect(fenceFor("+const x = 1")).toBe("```")
  })

  it("outgrows any fence the content itself contains", () => {
    expect(fenceFor("+```json")).toBe("````")
    expect(fenceFor("+````\n+```")).toBe("`````")
  })

  it("ignores short inline-code runs", () => {
    expect(fenceFor("+call `foo()` here")).toBe("```")
  })

  it("keeps a diff that patches a fenced markdown block inside the block", () => {
    const diff = ["+# Title", "+", "+```ts", "+const a = 1", "+```"].join("\n")
    const prompt = adversarialPrompt({ prNumber: 1, diff, baseBranch: "main" })
    const fence = fenceFor(diff)
    expect(fence).toBe("````")
    // Opened and closed by the LONGER fence, so the ```ts inside is just content.
    expect(prompt).toContain(`${fence}diff\n${diff}\n${fence}`)
    // And the reviewer is told the region is data, not instructions.
    expect(prompt).toContain("data, not")
  })

  it("embeds an ordinary diff verbatim", () => {
    const diff = "diff --git a/a.ts b/a.ts\n+const x = 1"
    expect(adversarialPrompt({ prNumber: 7, diff, baseBranch: "main" })).toContain(
      "```diff\n" + diff + "\n```"
    )
  })

  it("names the base branch only when there is one", () => {
    const diff = "+x"
    expect(adversarialPrompt({ prNumber: 7, diff, baseBranch: "develop" })).toContain(
      "targeting `develop`"
    )
    expect(adversarialPrompt({ prNumber: 7, diff, baseBranch: null })).not.toContain("targeting")
  })
})

describe("extractJsonBlock", () => {
  it("takes the LAST fenced block, not an illustrative one mid-reasoning", () => {
    const text = [
      "Here is the shape I'll use:",
      "```json",
      '{"findings":[{"title":"EXAMPLE"}]}',
      "```",
      "And here is the real result:",
      "```json",
      '{"findings":[{"title":"REAL"}]}',
      "```"
    ].join("\n")
    expect(extractJsonBlock(text)).toContain("REAL")
    expect(extractJsonBlock(text)).not.toContain("EXAMPLE")
  })

  it("accepts a bare fence with no language tag", () => {
    expect(extractJsonBlock('```\n{"findings":[]}\n```')).toBe('{"findings":[]}')
  })

  it("skips fenced blocks that are not JSON", () => {
    const text = '```ts\nconst x = 1\n```\n```json\n{"findings":[]}\n```'
    expect(extractJsonBlock(text)).toBe('{"findings":[]}')
  })

  // Regression: reviewers quote the offending code before their verdict. A
  // fence matcher that doesn't anchor to line starts pairs the ```ts block's
  // CLOSING fence with the json block's OPENING fence, and the verdict is lost.
  it("survives a code snippet quoted before the verdict", () => {
    const text = [
      "The problem is here:",
      "```ts",
      "if (token == secret) { grant() }",
      "```",
      "That comparison is timing-unsafe.",
      "```json",
      '{"findings":[{"title":"Timing-unsafe comparison","severity":"critical"}]}',
      "```"
    ].join("\n")
    expect(parseFindings(text)).toHaveLength(1)
    expect(parseFindings(text)?.[0]!.title).toBe("Timing-unsafe comparison")
  })

  it("survives a quoted diff block before the verdict", () => {
    const text = [
      "```diff",
      "-const a = 1",
      "+const a = 2",
      "```",
      "```json",
      '{"findings":[]}',
      "```"
    ].join("\n")
    expect(extractJsonBlock(text)).toBe('{"findings":[]}')
  })

  it("falls back to an unfenced findings object", () => {
    expect(extractJsonBlock('Result: {"findings":[]}')).toBe('{"findings":[]}')
  })

  it("returns null when there is no JSON at all", () => {
    expect(extractJsonBlock("Looks good to me!")).toBeNull()
  })
})

describe("parseFindings", () => {
  const block = (findings: unknown) => "```json\n" + JSON.stringify({ findings }) + "\n```"

  it("returns null for prose (a refusal), so the caller can note it", () => {
    expect(parseFindings("I will not review this.")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseFindings("```json\n{ not json\n```")).toBeNull()
  })

  it("distinguishes an empty review from a broken one", () => {
    expect(parseFindings(block([]))).toStrictEqual([])
  })

  it("assigns stable ids so routed findings can be tracked", () => {
    const parsed = parseFindings(block([{ title: "a" }, { title: "b" }]))
    expect(parsed?.map((f) => f.id)).toStrictEqual(["f1", "f2"])
  })

  // One malformed field must not lose the rest of the batch.
  it("folds an unknown severity to minor rather than dropping the finding", () => {
    const parsed = parseFindings(block([{ title: "a", severity: "blocker" }]))
    expect(parsed?.[0]!.severity).toBe("minor")
  })

  it("normalises severity case", () => {
    expect(parseFindings(block([{ title: "a", severity: "CRITICAL" }]))?.[0]!.severity).toBe("critical")
  })

  it("drops a finding with no title — there is nothing to show", () => {
    expect(parseFindings(block([{ title: "", rationale: "x" }, { title: "real" }]))).toHaveLength(1)
  })

  it("keeps a finding that is not anchored to a file", () => {
    const parsed = parseFindings(block([{ title: "Design is wrong", path: null, line: null }]))
    expect(parsed?.[0]!.path).toBeNull()
    expect(parsed?.[0]!.line).toBeNull()
  })

  it("rejects a nonsense line number rather than anchoring to it", () => {
    expect(parseFindings(block([{ title: "a", path: "x.ts", line: 0 }]))?.[0]!.line).toBeNull()
    expect(parseFindings(block([{ title: "a", path: "x.ts", line: -3 }]))?.[0]!.line).toBeNull()
    expect(parseFindings(block([{ title: "a", path: "x.ts", line: 1.5 }]))?.[0]!.line).toBeNull()
  })

  it("drops an endLine that precedes its start", () => {
    const parsed = parseFindings(block([{ title: "a", path: "x.ts", line: 10, endLine: 4 }]))
    expect(parsed?.[0]!.endLine).toBeNull()
  })

  it("keeps a valid multi-line range", () => {
    const parsed = parseFindings(block([{ title: "a", path: "x.ts", line: 10, endLine: 14 }]))
    expect(parsed?.[0]!.endLine).toBe(14)
  })

  it("falls back to the title when the reviewer gives no rationale", () => {
    expect(parseFindings(block([{ title: "Leaks a handle" }]))?.[0]!.rationale).toBe("Leaks a handle")
  })

  it("treats a blank suggestion as absent", () => {
    expect(parseFindings(block([{ title: "a", suggestion: "   " }]))?.[0]!.suggestion).toBeNull()
  })
})

/**
 * `watch` is what lets the UI show a reviewer it did not start — the auto-review
 * poll runs one on a new head with nobody's finger on the button. These assert
 * the behaviours a watcher depends on: it sees the run's events, a run always
 * terminates the stream, and two runs never bleed into each other.
 */
describe("ReviewService.watch", () => {
  // Reached through the service instance, not the generated accessor — the
  // accessors are Effect-shaped and mangle a Stream-returning method. This is the
  // same way the RPC handler consumes it (`Stream.unwrap(Effect.map(...))`).
  const watchStream = (sessionId: string) =>
    Stream.unwrap(Effect.map(ReviewService, (r) => r.watch(sessionId)))

  /** Run a review while collecting everything a watcher attached first would see. */
  const runWatched = (adapter: Layer.Layer<CliAdapter>, input: ReviewInput = INPUT) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen: Array<StreamEvent> = []
        const watcher = yield* watchStream(input.sessionId).pipe(
          Stream.runForEach((e) => Effect.sync(() => seen.push(e))),
          Effect.fork
        )
        yield* Effect.yieldNow()
        const review = yield* ReviewService.run(input).pipe(Effect.either)
        // The stream stays open for the next run, so stop watching once the run
        // settles rather than waiting for an end that never comes.
        yield* Fiber.interrupt(watcher)
        return { seen, review }
      }).pipe(Effect.provide(env(adapter)))
    )

  const workingStub = () =>
    stubAdapter((_id, _s, ctx) =>
      Effect.gen(function* () {
        yield* ctx.emit({ _tag: "Started", sessionId: "review_s1" })
        yield* ctx.emit({ _tag: "ToolStart", id: "t1", name: "Read", target: "a.ts" })
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )

  it("streams the reviewer's activity to a watcher", async () => {
    const { seen } = await runWatched(workingStub())
    expect(seen.map((e) => e._tag)).toContain("ToolStart")
    expect(seen.map((e) => e._tag)).toContain("Assistant")
  })

  // Without a terminal event the watcher's tab spins at "working" forever.
  it("ends the stream with Done when the review completes", async () => {
    const { seen } = await runWatched(workingStub())
    expect(seen[seen.length - 1]!._tag).toBe("Done")
  })

  // A crash out of the adapter fails the Effect and emits NO event of its own —
  // the reviewer would otherwise appear to still be running.
  it("ends the stream with Failed when the reviewer crashes", async () => {
    const crashing = stubAdapter(
      () => Effect.fail(new CliExecError({ kind: "claude", message: "boom" })) as unknown as Effect.Effect<void>
    )
    const { seen, review } = await runWatched(crashing)
    expect(review._tag).toBe("Left")
    expect(seen[seen.length - 1]!._tag).toBe("Failed")
  })

  // A pre-flight failure never spawns a reviewer, so it must not leave a failed
  // event in the buffer — every later watcher would replay it and show a phantom
  // errored Reviewer tab for a review that never ran.
  it("publishes nothing when the review can't start", async () => {
    const { seen, review } = await runWatched(workingStub(), { ...INPUT, diff: "   " })
    expect(review._tag).toBe("Left")
    expect(seen).toEqual([])
  })

  // The auto-review can be mid-flight before you open the session.
  it("replays the run so far to a watcher that attaches late", async () => {
    const seen: Array<StreamEvent> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ReviewService.run(INPUT)
        // Attach only AFTER the whole run is over.
        const watcher = yield* watchStream(INPUT.sessionId).pipe(
          Stream.runForEach((e) => Effect.sync(() => seen.push(e))),
          Effect.fork
        )
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(watcher)
      }).pipe(Effect.provide(env(workingStub())))
    )
    expect(seen.map((e) => e._tag)).toContain("ToolStart")
    expect(seen[seen.length - 1]!._tag).toBe("Done")
  })

  it("does not merge two runs into one replay", async () => {
    const seen: Array<StreamEvent> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ReviewService.run(INPUT)
        yield* ReviewService.run(INPUT)
        const watcher = yield* watchStream(INPUT.sessionId).pipe(
          Stream.runForEach((e) => Effect.sync(() => seen.push(e))),
          Effect.fork
        )
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(watcher)
      }).pipe(Effect.provide(env(workingStub())))
    )
    // Exactly one run's worth — the second run cleared the first's buffer.
    expect(seen.filter((e) => e._tag === "Done")).toHaveLength(1)
    expect(seen.filter((e) => e._tag === "ToolStart")).toHaveLength(1)
  })

  it("stays quiet, and open, when no review has run", async () => {
    const seen: Array<StreamEvent> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const watcher = yield* watchStream("never-reviewed").pipe(
          Stream.runForEach((e) => Effect.sync(() => seen.push(e))),
          Effect.fork
        )
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(watcher)
      }).pipe(Effect.provide(env(workingStub())))
    )
    expect(seen).toEqual([])
  })
})

/**
 * The Reviewer tab must survive a restart — the findings already do, so a tab
 * that vanishes while its verdict remains reads as a bug. Persistence rides on
 * `watch`'s replay: a fresh process has a cold buffer and falls back to disk, so
 * the renderer needs no idea any of this happened.
 *
 * "A fresh process" is modelled by building a SECOND ReviewService over the same
 * temp `~/starbase` — a new instance has new in-memory state and can only know
 * what actually reached the disk.
 */
describe("ReviewService — transcript persistence", () => {
  const watchStream = (sessionId: string) =>
    Stream.unwrap(Effect.map(ReviewService, (r) => r.watch(sessionId)))

  const workingStub = () =>
    stubAdapter((_id, _s, ctx) =>
      Effect.gen(function* () {
        yield* ctx.emit({ _tag: "Started", sessionId: "review_s1" })
        yield* ctx.emit({ _tag: "ToolStart", id: "t1", name: "Read", target: "a.ts" })
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )

  /**
   * Everything a watcher sees when it attaches, in a given service instance.
   *
   * Collected via a quiet-period timeout rather than a yield: restoring from disk
   * is real file IO, so a watcher on a cold buffer has not produced anything yet
   * by the next tick — and the hub stays open for the next review, so there is no
   * end-of-stream to wait for either.
   */
  const attach = (sessionId: string) =>
    watchStream(sessionId).pipe(
      Stream.timeout("250 millis"),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk) as ReadonlyArray<StreamEvent>)
    )

  it("replays a finished review to a brand-new process", async () => {
    const adapter = workingStub()
    // Process 1: run a review.
    await Effect.runPromise(ReviewService.run(INPUT).pipe(Effect.provide(env(adapter))))
    // Process 2: a cold instance over the same ~/starbase.
    const seen = await Effect.runPromise(attach(INPUT.sessionId).pipe(Effect.provide(env(adapter))))

    expect(seen.map((e) => e._tag)).toContain("ToolStart")
    expect(seen.map((e) => e._tag)).toContain("Assistant")
  })

  // Without a terminal event the restored tab would sit at "working" forever.
  it("restores a transcript that ends in a terminal event", async () => {
    const adapter = workingStub()
    await Effect.runPromise(ReviewService.run(INPUT).pipe(Effect.provide(env(adapter))))
    const seen = await Effect.runPromise(attach(INPUT.sessionId).pipe(Effect.provide(env(adapter))))
    expect(seen[seen.length - 1]!._tag).toBe("Done")
  })

  it("restores a failed reviewer as failed", async () => {
    const crashing = stubAdapter(
      () => Effect.fail(new CliExecError({ kind: "claude", message: "boom" })) as unknown as Effect.Effect<void>
    )
    await Effect.runPromise(ReviewService.run(INPUT).pipe(Effect.provide(env(crashing)), Effect.either))
    const seen = await Effect.runPromise(attach(INPUT.sessionId).pipe(Effect.provide(env(crashing))))
    expect(seen[seen.length - 1]!._tag).toBe("Failed")
  })

  // A review that never spawned has no transcript to restore — persisting one
  // would leave a phantom Reviewer tab for a review that never happened.
  it("stores nothing when the review can't start", async () => {
    const adapter = workingStub()
    await Effect.runPromise(
      ReviewService.run({ ...INPUT, diff: "   " }).pipe(Effect.provide(env(adapter)), Effect.either)
    )
    const seen = await Effect.runPromise(attach(INPUT.sessionId).pipe(Effect.provide(env(adapter))))
    expect(seen).toEqual([])
  })

  it("has nothing to restore for a session that was never reviewed", async () => {
    const seen = await Effect.runPromise(
      attach("never-reviewed").pipe(Effect.provide(env(workingStub())))
    )
    expect(seen).toEqual([])
  })

  /**
   * The dangerous one. A new run clears the STORED transcript as well as the live
   * buffer — otherwise a watcher attaching in the gap before the reviewer's first
   * event finds a cold buffer, falls back to the PREVIOUS run's transcript, and
   * splices it in front of the run now starting.
   *
   * That gap is the whole point, so the reviewer is held open inside it: attaching
   * after a run instead would find a warm buffer, never read the disk, and pass
   * whether or not the clear happens.
   */
  it("does not splice a stored transcript onto a new run", async () => {
    // A completed review, whose transcript is now on disk.
    await Effect.runPromise(ReviewService.run(INPUT).pipe(Effect.provide(env(workingStub()))))

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocking = stubAdapter((_id, _s, ctx) =>
      Effect.gen(function* () {
        // Parked AFTER the run reset the buffers, BEFORE its first event.
        yield* Effect.promise(() => held)
        yield* ctx.emit({ _tag: "Started", sessionId: "review_s1" })
        yield* ctx.emit({ _tag: "ToolStart", id: "t1", name: "Read", target: "a.ts" })
        yield* emitJson(ctx, '{"findings":[]}')
      })
    )

    // A cold instance, as after a restart: its buffer is empty, so a watcher that
    // attaches now can only fall back to the disk.
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* Effect.fork(ReviewService.run(INPUT))
        yield* Effect.sleep("50 millis")
        const watcher = yield* Effect.fork(attach(INPUT.sessionId))
        yield* Effect.sleep("20 millis")
        yield* Effect.sync(() => release())
        yield* Fiber.join(run)
        return yield* Fiber.join(watcher)
      }).pipe(Effect.provide(env(blocking)))
    )

    // Exactly one run's worth: the stale transcript was cleared, not prepended.
    expect(seen.filter((e) => e._tag === "Done")).toHaveLength(1)
    expect(seen.filter((e) => e._tag === "ToolStart")).toHaveLength(1)
  })

  it("drops the transcript when the session's review is cleared", async () => {
    const adapter = workingStub()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ReviewService.run(INPUT)
        yield* ReviewStore.clear(INPUT.sessionId)
      }).pipe(Effect.provide(env(adapter)))
    )
    const seen = await Effect.runPromise(attach(INPUT.sessionId).pipe(Effect.provide(env(adapter))))
    expect(seen).toEqual([])
  })
})
