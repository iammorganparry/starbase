import type { AdversarialReview, CliKind, ReviewFinding, ReviewSeverity, StreamEvent } from "@starbase/core"
import { ReviewError } from "@starbase/core"
import type { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Effect, PubSub, Ref, Schema, Stream } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import { DiscoveryService } from "./discovery.js"
import type { AppPaths } from "./app-paths.js"
import { ReviewStore } from "./review-store.js"
import { adversarialPrompt } from "./review-prompt.js"

/**
 * Runs the adversarial reviewer against a PR diff and returns structured findings.
 *
 * Why this does NOT go through `AgentRunner`: `AgentRunner.prompt` is stateful —
 * it takes the model from the *session*, writes the transcript, persists the
 * harness `resumeId`, and parks on approval gates. All four are wrong here. A
 * review must run on its own (usually stronger) model, leave no trace on the
 * session's conversation, and never block waiting for a human who isn't looking.
 * So we build our own `SessionSpec` and drive `CliAdapter` directly.
 *
 * Two guarantees are structural rather than prompted:
 *
 *  - **Read-only.** `canUseTool` is the only path to an edit or a shell command,
 *    and it always denies. The reviewer keeps ungated Read/Grep/Glob, so it can
 *    still explore the worktree for context — it just cannot change it. Telling a
 *    model "please don't edit" is not a guarantee; this is.
 *  - **Never parks.** `askQuestion` and `proposePlan` resolve immediately. An
 *    auto-review runs with no UI attached, so a reviewer that asked a question
 *    would hang a fiber forever with nobody to answer it.
 */

const SEVERITIES: ReadonlyArray<ReviewSeverity> = ["critical", "major", "minor", "nit"]

/** The reviewer's raw JSON contract — decoded leniently, then normalised. */
const RawFinding = Schema.Struct({
  path: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  endLine: Schema.optional(Schema.NullOr(Schema.Number)),
  severity: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  rationale: Schema.optional(Schema.String),
  suggestion: Schema.optional(Schema.NullOr(Schema.String))
})
const RawReview = Schema.Struct({
  findings: Schema.optional(Schema.Array(RawFinding))
})

/**
 * Pull the LAST fenced ```json block out of the reviewer's reply. Last, because
 * the reviewer often shows an illustrative snippet mid-reasoning; the contract
 * says the real payload is final.
 */
export const extractJsonBlock = (text: string): string | null => {
  // Anchor both fences to a line start (`m` flag) so openers and closers pair
  // correctly. Without the anchors, a preceding ```ts snippet — which reviewers
  // emit constantly to show the offending code — mis-pairs: its CLOSING fence
  // reads as an opener and swallows the real json block's opening fence.
  const fences = [...text.matchAll(/^```[ \t]*[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)^```/gm)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]![1]!.trim()
    if (body.startsWith("{") || body.startsWith("[")) return body
  }
  // Unfenced fallback: the last top-level object that mentions findings.
  const bare = text.lastIndexOf('{"findings"')
  if (bare !== -1) return text.slice(bare).trim()
  return null
}

const asSeverity = (raw: string | undefined): ReviewSeverity => {
  const s = (raw ?? "").toLowerCase().trim()
  return SEVERITIES.includes(s as ReviewSeverity) ? (s as ReviewSeverity) : "minor"
}

/** A positive integer, or null — guards against a model emitting 0 / -1 / 1.5. */
const asLine = (raw: number | null | undefined): number | null =>
  typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null

const nonEmpty = (raw: string | null | undefined): string | null => {
  const s = (raw ?? "").trim()
  return s.length > 0 ? s : null
}

/**
 * Normalise the reviewer's JSON into domain findings. Drops entries with no
 * title (there is nothing to show), and folds an out-of-range severity to
 * "minor" rather than throwing — a malformed field must not lose the other
 * findings in the batch.
 */
export const parseFindings = (text: string): ReadonlyArray<ReviewFinding> | null => {
  const block = extractJsonBlock(text)
  if (block === null) return null
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(RawReview))(block)
  if (decoded._tag === "Left") return null
  const raw = decoded.right.findings ?? []
  return raw.flatMap((f, i): ReadonlyArray<ReviewFinding> => {
    const title = nonEmpty(f.title)
    if (title === null) return []
    const line = asLine(f.line)
    return [
      {
        id: `f${i + 1}`,
        path: nonEmpty(f.path),
        line,
        // An endLine is meaningless without a start, and must not precede it.
        endLine: line === null ? null : (() => {
          const end = asLine(f.endLine)
          return end !== null && end > line ? end : null
        })(),
        severity: asSeverity(f.severity),
        title,
        rationale: nonEmpty(f.rationale) ?? title,
        suggestion: nonEmpty(f.suggestion)
      }
    ]
  })
}

/**
 * What a review run needs from its environment: the harness adapter, CLI
 * discovery, and the executor discovery shells out through.
 */
export type ReviewEnv =
  | CliAdapter
  | DiscoveryService
  | CommandExecutor.CommandExecutor
  | ReviewStore
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

export interface ReviewInput {
  readonly sessionId: string
  readonly prNumber: number
  readonly headSha: string
  readonly cwd: string
  readonly repo: string
  readonly branch: string
  /** The PR's base branch, or null when the session doesn't record one. */
  readonly baseBranch: string | null
  readonly cli: CliKind
  readonly model: string
  readonly diff: string
}

/**
 * How many of a run's events are kept for a late watcher to replay.
 *
 * A review is a few hundred events at most, so this is generous — but it is a
 * ceiling, not a target: without one, a reviewer that spun on tool calls would
 * grow this array until the app died. Overflow drops the OLDEST events, so a
 * late watcher may miss the start of a pathological run and still see its tail.
 */
const REPLAY_CAP = 2000

export class ReviewService extends Effect.Service<ReviewService>()("@starbase/ReviewService", {
  accessors: true,
  effect: Effect.gen(function* () {
    /**
     * Per-session broadcast of the running reviewer's events, so the UI can watch
     * an agent it did not start.
     *
     * A hub rather than a return value because a review is not always something
     * the viewer kicked off: the auto-review is a 60s poll across every session
     * (App.tsx), so by the time you open a session its reviewer may already be
     * mid-flight. `buffer` is what lets that late watcher catch up; `gate` makes
     * "snapshot the buffer, then subscribe" atomic against a concurrent publish —
     * without it a watcher would either miss an event or replay one twice, and a
     * duplicated Assistant chunk shows up as doubled text in its transcript.
     */
    const liveFor = yield* Effect.cachedFunction((_sessionId: string) =>
      Effect.gen(function* () {
        const hub = yield* PubSub.unbounded<StreamEvent>()
        const buffer = yield* Ref.make<ReadonlyArray<StreamEvent>>([])
        const gate = yield* Effect.makeSemaphore(1)
        return { hub, buffer, gate }
      })
    )

    const publish = (sessionId: string, event: StreamEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const live = yield* liveFor(sessionId)
        yield* live.gate.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.update(live.buffer, (acc) =>
              acc.length >= REPLAY_CAP ? [...acc.slice(1), event] : [...acc, event]
            )
            yield* PubSub.publish(live.hub, event)
          })
        )
      })

    /**
     * Drop the previous run's events — a watcher must never see two runs merged.
     * The stored transcript goes too: `watch` falls back to it when the buffer is
     * cold, so leaving it would let the last run's transcript replay underneath
     * the one now starting.
     */
    const resetLive = (sessionId: string): Effect.Effect<void, never, ReviewEnv> =>
      Effect.gen(function* () {
        const live = yield* liveFor(sessionId)
        // BOTH clears under one permit. `watch` reads the buffer and the stored
        // transcript under this same permit, so clearing them separately leaves a
        // window where it sees an empty buffer but a not-yet-deleted file — and
        // replays the previous run ahead of the one just starting.
        yield* live.gate.withPermits(1)(
          Effect.zipRight(Ref.set(live.buffer, []), ReviewStore.clearTranscript(sessionId))
        )
      })

    /**
     * Persist the finished run's events so its tab survives a restart.
     *
     * Only ever called once a run has emitted a terminal event, and deliberately
     * NOT incrementally: a transcript saved mid-run would replay on restart with
     * no `Done`/`Failed` at the end, and its tab would sit at "working" forever
     * for a reviewer that died with the process.
     */
    const persistLive = (sessionId: string): Effect.Effect<void, never, ReviewEnv> =>
      Effect.gen(function* () {
        const live = yield* liveFor(sessionId)
        const events = yield* live.gate.withPermits(1)(Ref.get(live.buffer))
        if (events.length === 0) return
        yield* ReviewStore.setTranscript(sessionId, events)
      })

    /**
     * The running reviewer's events for a session: what it has emitted so far,
     * then everything after, live. Empty (but open) when nothing is running, so a
     * watcher can subscribe before a review starts and still catch the whole run.
     */
    const watch = (sessionId: string): Stream.Stream<StreamEvent, never, ReviewEnv> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const live = yield* liveFor(sessionId)
          // Snapshot + subscribe under the same permit `publish` takes, so no
          // event can slip between the two (missed) or land in both (doubled).
          return yield* live.gate.withPermits(1)(
            Effect.gen(function* () {
              const buffered = yield* Ref.get(live.buffer)
              // A cold buffer means no run has happened in THIS process — so fall
              // back to the last completed run on disk, which is what makes the
              // Reviewer tab survive a restart. Read inside the permit: a run
              // starting between the read and the subscribe would otherwise splice
              // the old transcript onto the new run's events.
              const replay =
                buffered.length > 0 ? buffered : yield* ReviewStore.getTranscript(sessionId)
              const subscription = yield* PubSub.subscribe(live.hub)
              return Stream.concat(Stream.fromIterable(replay), Stream.fromQueue(subscription))
            })
          )
        })
      )

    // One review at a time per session. The handler's de-dupe is a check-then-act
    // with no lock, and the manual run (a mutation) and the auto run (a polled
    // query) live in different react-query caches — so clicking "Review again"
    // while an auto-review is in flight would otherwise spawn two agents on the
    // same diff, both racing the store. `cachedFunction` memoises per sessionId,
    // so each session gets exactly one semaphore.
    const lockFor = yield* Effect.cachedFunction((_sessionId: string) =>
      Effect.makeSemaphore(1)
    )

    const runExclusive = (
      input: ReviewInput
    ): Effect.Effect<AdversarialReview, ReviewError, ReviewEnv> =>
      Effect.gen(function* () {
        const adapter = yield* CliAdapter

        // A harness with no binary — or one with no real adapter (cursor) — is
        // dispatched to the deterministic SCRIPTED stub, which emits canned prose
        // about an unrelated task. That would sail through as a successful review
        // and get cached against this PR head, so the user reads fiction and the
        // de-dupe never lets it retry. Fail loudly instead.
        if (input.cli === "cursor") {
          return yield* Effect.fail(
            new ReviewError({
              message:
                "Cursor can't run an adversarial review yet — choose Claude, Codex or opencode in Settings · GitHub."
            })
          )
        }
        const binPath =
          (yield* DiscoveryService.list().pipe(Effect.orElseSucceed(() => [])))
            .find((c) => c.kind === input.cli)?.binPath ?? null
        if (binPath === null) {
          return yield* Effect.fail(
            new ReviewError({
              message: `The ${input.cli} CLI isn't installed or couldn't be found, so there is nothing to run the review with.`
            })
          )
        }

        // `gh pr diff` folds any failure to "". Reviewing "" produces a confident
        // "found nothing", which then gets cached against the real head SHA — so a
        // transient gh hiccup becomes a permanent false all-clear that only a
        // forced re-run can clear. An empty diff is never worth reviewing anyway.
        if (input.diff.trim().length === 0) {
          return yield* Effect.fail(
            new ReviewError({
              message: "Couldn't read the pull request's diff, so there was nothing to review."
            })
          )
        }

        const collected = yield* Ref.make<ReadonlyArray<string>>([])

        const spec: SessionSpec = {
          cli: input.cli,
          repo: input.repo,
          branch: input.branch,
          cwd: input.cwd,
          prompt: adversarialPrompt({
            prNumber: input.prNumber,
            diff: input.diff,
            baseBranch: input.baseBranch
          }),
          images: [],
          binPath,
          // Paired with the deny-all gate below. "ask" (not "plan") on purpose:
          // plan mode drives the harness toward ExitPlanMode, and a reviewer that
          // proposes a plan instead of reporting findings is useless.
          mode: "ask",
          // The reviewer's own model — NOT the session's. This is the whole point.
          model: input.model,
          resumeId: null,
          // `resumeId: null` alone is NOT enough — the adapter's in-memory resume
          // map wins over the spec, and our key is stable per session, so every
          // re-review would silently resume the previous one and inherit the old
          // head's diff and findings (the model then self-dedupes: "already
          // reported this"). A review must be a pure function of THIS diff.
          fresh: true,
          // The load-bearing half of the read-only guarantee. The deny-all gate
          // below is a denylist over tool names WE map, and the Codex adapter
          // never calls it at all — so without this a Codex review would run
          // `workspace-write` with approval `never` over the very worktree it was
          // told not to touch. Each adapter enforces this in its own vocabulary.
          readOnly: true
        }

        const ctx: AgentContext = {
          emit: (event) =>
            Effect.zipRight(
              // Broadcast everything, so the UI can watch the reviewer work. This
              // is observation only — it must never change what gets parsed, so
              // it sits beside the collector below rather than filtering it.
              publish(input.sessionId, event),
              // Only main-thread text is COLLECTED. A reviewer that spawns a
              // subagent would otherwise interleave its chatter into the reply we
              // parse — and a subagent's illustrative JSON would win the "last
              // block" race.
              event._tag === "Assistant" && event.agentId === undefined
                ? Ref.update(collected, (acc) => [...acc, event.text])
                : Effect.void
            ),
          canUseTool: () => Effect.succeed("deny" as const),
          askQuestion: () => Effect.succeed([]),
          proposePlan: () => Effect.succeed(PlanDecision.Reject())
        }

        // Clear the previous run's replay buffer. Deliberately here, AFTER the
        // pre-flight failures above: those publish nothing, so a "cursor can't
        // review" error stays on the button instead of leaving a phantom failed
        // Reviewer tab that every later watcher would replay.
        yield* resetLive(input.sessionId)

        yield* adapter.run(`review_${input.sessionId}`, spec, ctx).pipe(
          // The adapter emits `Failed` for a turn the harness rejected, but a
          // crash (a throw out of the SDK) fails the Effect with no event at all —
          // which would leave a watcher's tab spinning at "working" forever.
          Effect.tapError((cause) =>
            publish(input.sessionId, { _tag: "Failed", message: cause.message }).pipe(
              Effect.zipRight(persistLive(input.sessionId))
            )
          ),
          Effect.mapError(
            (cause) =>
              new ReviewError({
                message: `The ${input.cli} reviewer failed to run: ${cause.message}`,
                cause
              })
          )
        )

        // Close the stream on our own terms rather than trusting the harness to
        // have emitted `Done`. A run that reached here produced a review — even a
        // refusal, which lands as `note` (see below) — so "done" is the truth,
        // and it wins over any `Failed` the adapter emitted for the turn itself.
        yield* publish(input.sessionId, { _tag: "Done", costUsd: 0, tokens: 0 })
        yield* persistLive(input.sessionId)

        const text = (yield* Ref.get(collected)).join("")
        const findings = parseFindings(text)
        const now = yield* Effect.sync(() => new Date().toISOString())

        return {
          sessionId: input.sessionId,
          prNumber: input.prNumber,
          headSha: input.headSha,
          cli: input.cli,
          model: input.model,
          createdAt: now,
          findings: findings ?? [],
          // A reviewer that ran but emitted no parseable block still produced a
          // review — a refusal, or prose. Surface the text so the user sees why,
          // rather than an empty list that reads as "no bugs found".
          note: findings === null ? nonEmpty(text) ?? "The reviewer produced no output." : null
        }
      })

    const run = (input: ReviewInput): Effect.Effect<AdversarialReview, ReviewError, ReviewEnv> =>
      Effect.gen(function* () {
        const lock = yield* lockFor(input.sessionId)
        return yield* lock.withPermits(1)(runExclusive(input))
      })

    return { run, watch }
  })
}) {}
