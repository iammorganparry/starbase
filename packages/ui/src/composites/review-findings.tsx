import { useEffect, useState } from "react"
import type { AdversarialReview, ReviewFinding, ReviewPhase, ReviewSeverity } from "@starbase/core"
import { destinationOf, findingLocation, partitionFindings } from "@starbase/core"
import { AlertTriangle, CornerDownRight, Loader2, type LucideIcon, MessageSquare } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { cn } from "../lib/cn.js"
import { severityAccent } from "../tokens.js"
import { fmtElapsed } from "../lib/relative-time.js"

/**
 * What the reviewer is doing right now, in the operator's words.
 *
 * There is no percentage here on purpose: nothing in a review announces a total,
 * so a bar would be a fabricated animation. Naming the actual phase is honest and
 * more useful — a review stuck on "Reading" for two minutes is legible, where a
 * bar at 60% would not be. `done`/`error` never render (the button leaves its
 * running state), but are mapped so the record is total.
 */
const PHASE_LABEL: Record<ReviewPhase, string> = {
  starting: "Starting…",
  reading: "Reading the code…",
  thinking: "Thinking…",
  writing: "Writing findings…",
  done: "Finishing…",
  error: "Failing…"
}

/**
 * What became of a finding — the card's own account of itself.
 *
 * Findings are no longer sent by hand: critical/major go to the session's agent
 * automatically, minor/nit are posted to the PR. So a card's job changed. It
 * used to offer an action; now it reports an outcome, and the only interesting
 * question is which one.
 */
export type FindingOutcome =
  | { readonly kind: "routed" } // sent to the agent
  | { readonly kind: "posted" } // posted to the PR
  | { readonly kind: "post-failed"; readonly message: string }
  | { readonly kind: "pending" } // the run is done but routing/posting hasn't landed
  | { readonly kind: "manual" } // nothing automatic applies — offer the button

/**
 * Work out a finding's outcome from the review's own stamps.
 *
 * Derived rather than tracked, and that's the point: the in-memory routed-store
 * is empty after a reload, so a card keyed off it alone would show "not sent"
 * for a finding the agent is already fixing. `routedAt`/`postedAt` are persisted
 * with the review, so they survive — and severity says which stamp applies.
 */
export const outcomeOf = (
  finding: ReviewFinding,
  review: AdversarialReview | null,
  opts: { readonly canRoute: boolean; readonly sent: boolean }
): FindingOutcome => {
  if (review === null) return opts.sent ? { kind: "routed" } : { kind: "manual" }
  const destination = destinationOf(finding.severity)
  if (destination === "agent") {
    if (review.routedAt !== null || opts.sent) return { kind: "routed" }
    // No conversation to route through (no live session) — the automatic path
    // can't run, so fall back to offering the button rather than claiming a
    // "pending" that will never resolve.
    return opts.canRoute ? { kind: "pending" } : { kind: "manual" }
  }
  if (opts.sent) return { kind: "routed" }
  if (review.postError !== null) return { kind: "post-failed", message: review.postError }
  if (review.postedAt !== null) return { kind: "posted" }
  /**
   * Unstamped, and NOT pending — "manual".
   *
   * The PR half has no pending window to report. Posting happens inside
   * `Review.run`, which stamps `postedAt` or `postError` before the review is
   * ever returned; the one unstamped path is "no low-severity findings at all",
   * which renders no PR-destined card to ask. So on a review this build produced,
   * reaching here is impossible.
   *
   * It IS reachable for a review persisted BEFORE posting existed: the fields
   * decode to null and nothing backfills them, because posting only ever happens
   * on a fresh run. Reporting "Sending…" there spins a spinner forever for a post
   * that will never come — and, worse, the manual fallback is hidden for pending,
   * so the finding becomes unactionable. "manual" tells the truth (nobody is
   * sending this) and hands back the button.
   */
  return { kind: "manual" }
}

/**
 * The formatted elapsed time since `startedAt`, re-rendering each second while
 * `live`. Returns null when there's nothing to time — so the timer only ticks
 * during a run, and stops dead the moment it ends.
 */
function useTicker(live: boolean, startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live || startedAt === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live, startedAt])
  if (!live || startedAt === null) return null
  return fmtElapsed(now - startedAt)
}

/** Sort order for triage — worst first. */
const SEVERITY_RANK: Record<ReviewSeverity, number> = { critical: 0, major: 1, minor: 2, nit: 3 }

/** Findings ranked worst-first; ties keep the reviewer's own order. */
export const rankFindings = (
  findings: readonly ReviewFinding[]
): readonly ReviewFinding[] =>
  [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

/**
 * How each outcome reads. `manual` is absent by construction — it isn't an
 * outcome to report, it's the absence of one, and `OutcomeLine` renders nothing
 * for it.
 */
const OUTCOME_META: Record<
  Exclude<FindingOutcome["kind"], "manual">,
  { Icon: LucideIcon; label: string; tone: string }
> = {
  routed: { Icon: CornerDownRight, label: "Sent to agent", tone: "text-green" },
  posted: { Icon: MessageSquare, label: "Posted to PR", tone: "text-dim" },
  "post-failed": { Icon: AlertTriangle, label: "Couldn't post to PR", tone: "text-red" },
  pending: { Icon: Loader2, label: "Sending…", tone: "text-dim" }
}

/** The outcome footer — an icon, a word, and nothing else unless it went wrong. */
function OutcomeLine({ outcome }: { outcome: FindingOutcome }) {
  if (outcome.kind === "manual") return null
  const meta = OUTCOME_META[outcome.kind]
  return (
    <div
      className={cn("flex items-center gap-[5px] text-[10.5px] leading-none", meta.tone)}
      title={outcome.kind === "post-failed" ? outcome.message : undefined}
    >
      <meta.Icon size={10.5} strokeWidth={2.25} className={outcome.kind === "pending" ? "animate-spin" : ""} />
      <span>{meta.label}</span>
    </div>
  )
}

export interface ReviewFindingRowProps {
  finding: ReviewFinding
  /** Already handed to the agent — the action stays in its terminal state. */
  sent: boolean
  canRoute: boolean
  /** The review this finding belongs to — carries the routed/posted stamps. */
  review?: AdversarialReview | null
  onSendToAgent?: (findingId: string) => void
}

/**
 * One finding.
 *
 * The severity rail down the left is the whole triage signal: the list is
 * ranked worst-first, and the rail lets you see where "worst" stops without
 * reading a word. A filled badge per row was the old shape — four of them
 * stacked shout equally, which is the opposite of ranking.
 */
export function ReviewFindingRow({
  finding,
  sent,
  canRoute,
  review = null,
  onSendToAgent
}: ReviewFindingRowProps) {
  const accent = severityAccent[finding.severity]
  const location = findingLocation(finding)
  const outcome = outcomeOf(finding, review, { canRoute, sent })
  return (
    <div
      className={cn(
        "group flex flex-col gap-[7px] rounded-[6px] rounded-l-[3px] border border-l-2 border-hairline bg-surface/30 px-[11px] py-[9px] transition-colors hover:bg-surface/50",
        accent.rail
      )}
    >
      <div className="flex items-baseline gap-[7px]">
        <span
          className={cn("size-[5px] flex-none translate-y-[-1px] rounded-full", accent.dot)}
          aria-hidden
        />
        <span className={cn("flex-none text-[10px] font-medium uppercase tracking-[0.5px]", accent.text)}>
          {finding.severity}
        </span>
        {location !== null && (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-dim" title={location}>
            {location}
          </span>
        )}
      </div>

      <span className="text-[12.5px] font-semibold leading-[1.35] text-text-bright">
        {finding.title}
      </span>

      <p className="text-[11.5px] leading-[1.5] text-text">{finding.rationale}</p>

      {finding.suggestion !== null && (
        <p className="rounded-[3px] border-l border-line bg-editor/40 py-[5px] pl-[7px] pr-[6px] text-[11px] leading-[1.45] text-muted-foreground">
          {finding.suggestion}
        </p>
      )}

      {(outcome.kind !== "manual" || onSendToAgent) && (
        <div className="flex items-center justify-between gap-2 pt-[1px]">
          <OutcomeLine outcome={outcome} />
          {/*
            The manual send survives as a FALLBACK, not the main path. It earns
            its place in two states the automatic route can't reach: a nit you
            want the agent to fix anyway, and a critical finding on a session
            with no live conversation to route through. Shown on hover so it
            doesn't compete with the outcome line in the common case.
          */}
          {onSendToAgent && outcome.kind !== "routed" && outcome.kind !== "pending" && (
            <button
              type="button"
              disabled={!canRoute}
              onClick={() => onSendToAgent(finding.id)}
              className="ml-auto rounded-[3px] px-[5px] py-[2px] text-[10.5px] text-dim opacity-0 transition-opacity hover:bg-surface hover:text-text focus-visible:opacity-100 disabled:pointer-events-none group-hover:opacity-100"
            >
              Send to agent
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export interface ReviewFindingsProps {
  review: AdversarialReview | null
  /** A reviewer run is in flight. */
  running: boolean
  /** Where the running reviewer has got to (ignored unless `running`). */
  phase?: ReviewPhase
  /** Epoch ms the run started, or null — drives the button's live timer. */
  startedAt?: number | null
  /** The message from a failed run, or null. */
  error?: string | null
  /** GitHub is connected and the session has a PR — the run action is available. */
  canRun: boolean
  /** The session can receive a routed finding (has a live conversation). */
  canRoute?: boolean
  onRun?: () => void
  onSendFindingToAgent?: (findingId: string) => void
  /** Ids of findings already sent to the agent — their action stays "Sent". */
  sentFindingIds?: ReadonlySet<string>
}

/**
 * The adversarial review panel: the run action, and the findings it produced.
 *
 * Presentational — the caller owns the RPC and the routing. Rendered in the PR
 * right rail; the same rows are reused inline in the Code Review view.
 */
export function ReviewFindings({
  review,
  running,
  phase = "starting",
  startedAt = null,
  error,
  canRun,
  canRoute = true,
  onRun,
  onSendFindingToAgent,
  sentFindingIds
}: ReviewFindingsProps) {
  const findings = review === null ? [] : rankFindings(review.findings)
  const elapsed = useTicker(running && startedAt !== null, startedAt)
  const split = review === null ? null : partitionFindings(review.findings)

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="secondary"
        className="w-full justify-center gap-2"
        disabled={!canRun || running || !onRun}
        onClick={onRun}
      >
        {running && <Spinner size={13} />}
        {running ? (
          <>
            <span>{PHASE_LABEL[phase]}</span>
            {/* Tabular numerals so a ticking timer doesn't jiggle the label. */}
            {elapsed && <span className="text-dim tabular-nums">{elapsed}</span>}
          </>
        ) : review === null ? (
          "Adversarial review"
        ) : (
          "Review again"
        )}
      </Button>

      {error && (
        <Callout tone="red" className="items-start">
          {error}
        </Callout>
      )}

      {/* The reviewer ran but said something we couldn't parse — a refusal, or
          prose. Showing its words beats an empty list that reads as "no bugs". */}
      {review?.note != null && (
        <Callout tone="yellow" className="items-start">
          {review.note}
        </Callout>
      )}

      {review !== null && findings.length === 0 && review.note == null && (
        <Callout tone="green">
          The reviewer argued against this diff and found nothing to report.
        </Callout>
      )}

      {/*
        What the review DID, in one line, above the evidence.
        Routing and posting now happen without anyone asking, so the first thing
        a reader needs is not the findings — it's to know the agent already has
        the serious ones. Without this the automation is invisible and the list
        reads like a to-do list you're expected to work through by hand.
      */}
      {split !== null && findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-[7px] gap-y-1 text-[11px] text-muted-foreground">
          {split.toAgent.length > 0 && (
            <span className="flex items-center gap-[5px]">
              <CornerDownRight size={11} strokeWidth={2.25} className="text-green" />
              <span className="tabular-nums text-text">{split.toAgent.length}</span>
              <span>to the agent</span>
            </span>
          )}
          {split.toAgent.length > 0 && split.toPr.length > 0 && <span className="text-dim">·</span>}
          {split.toPr.length > 0 && (
            <span className="flex items-center gap-[5px]">
              <MessageSquare size={11} strokeWidth={2.25} className="text-blue" />
              <span className="tabular-nums text-text">{split.toPr.length}</span>
              <span>on the PR</span>
            </span>
          )}
        </div>
      )}

      {/* The post failed — say so once, here, rather than only on each nit's
          card. The cause is the review's, not any one finding's. */}
      {review?.postError != null && (
        <Callout tone="red" className="items-start">
          {review.postError}
        </Callout>
      )}

      {findings.length > 0 && (
        <div className="flex flex-col gap-2">
          {findings.map((finding) => (
            <ReviewFindingRow
              key={finding.id}
              finding={finding}
              sent={sentFindingIds?.has(finding.id) ?? false}
              canRoute={canRoute}
              review={review}
              onSendToAgent={onSendFindingToAgent}
            />
          ))}
        </div>
      )}

      {review !== null && (
        <span className="font-mono text-[10px] text-dim">
          {review.model} · {review.headSha.slice(0, 7)}
        </span>
      )}
    </div>
  )
}
