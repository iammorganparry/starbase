import type { AdversarialReview, CliKind, ReviewFinding, ReviewSeverity } from "@starbase/core"
import { ReviewError } from "@starbase/core"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Ref, Schema } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import { DiscoveryService } from "./discovery.js"
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
export type ReviewEnv = CliAdapter | DiscoveryService | CommandExecutor.CommandExecutor

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

export class ReviewService extends Effect.Service<ReviewService>()("@starbase/ReviewService", {
  accessors: true,
  effect: Effect.gen(function* () {
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
              message: "Cursor can't run an adversarial review yet — choose Claude or Codex in Settings · GitHub."
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
          // Only main-thread text. A reviewer that spawns a subagent would
          // otherwise interleave its chatter into the reply we parse — and a
          // subagent's illustrative JSON would win the "last block" race.
          emit: (event) =>
            event._tag === "Assistant" && event.agentId === undefined
              ? Ref.update(collected, (acc) => [...acc, event.text])
              : Effect.void,
          canUseTool: () => Effect.succeed("deny" as const),
          askQuestion: () => Effect.succeed([]),
          proposePlan: () => Effect.succeed(PlanDecision.Reject())
        }

        yield* adapter.run(`review_${input.sessionId}`, spec, ctx).pipe(
          Effect.mapError(
            (cause) =>
              new ReviewError({
                message: `The ${input.cli} reviewer failed to run: ${cause.message}`,
                cause
              })
          )
        )

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

    return { run }
  })
}) {}
