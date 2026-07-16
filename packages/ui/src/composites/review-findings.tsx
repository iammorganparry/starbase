import { useEffect, useState } from "react"
import type { AdversarialReview, ReviewFinding, ReviewPhase, ReviewSeverity } from "@starbase/core"
import type { BadgeProps } from "../components/badge.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
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
 * Severity → Badge tone. The reviewer is asked for coverage and honest tagging
 * rather than self-filtering, so the whole range shows up and the colour is what
 * lets a reader triage at a glance.
 */
const severityBadge: Record<ReviewSeverity, { tone: BadgeProps["tone"]; label: string }> = {
  critical: { tone: "red", label: "critical" },
  major: { tone: "yellow", label: "major" },
  minor: { tone: "blue", label: "minor" },
  nit: { tone: "count", label: "nit" }
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

/** `path:line`, or null when the finding is about the change as a whole. */
const findingLocation = (finding: ReviewFinding): string | null => {
  if (finding.path === null) return null
  if (finding.line === null) return finding.path
  const range = finding.endLine === null ? `${finding.line}` : `${finding.line}–${finding.endLine}`
  return `${finding.path}:${range}`
}

export interface ReviewFindingRowProps {
  finding: ReviewFinding
  /** Already handed to the agent — the action stays in its terminal state. */
  sent: boolean
  canRoute: boolean
  onSendToAgent?: (findingId: string) => void
}

export function ReviewFindingRow({
  finding,
  sent,
  canRoute,
  onSendToAgent
}: ReviewFindingRowProps) {
  const meta = severityBadge[finding.severity]
  const location = findingLocation(finding)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface/40 p-[11px]">
      <div className="flex items-start gap-2">
        <Badge tone={meta.tone} size="xs" className="mt-[2px] flex-none">
          {meta.label}
        </Badge>
        <span className="flex-1 text-[12.5px] font-semibold leading-[1.35] text-text-bright">
          {finding.title}
        </span>
      </div>
      {location !== null && (
        <span className="font-mono text-[10.5px] text-dim" title={location}>
          {location}
        </span>
      )}
      <p className="text-[12px] leading-[1.45] text-text">{finding.rationale}</p>
      {finding.suggestion !== null && (
        <p className="border-l-2 border-line pl-2 text-[11.5px] leading-[1.45] text-muted-foreground">
          {finding.suggestion}
        </p>
      )}
      {onSendToAgent && (
        <div className="flex justify-end pt-0.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={sent || !canRoute}
            onClick={() => onSendToAgent(finding.id)}
          >
            {sent ? "Sent to agent" : "Send to agent"}
          </Button>
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

      {findings.length > 0 && (
        <div className="flex flex-col gap-2">
          {findings.map((finding) => (
            <ReviewFindingRow
              key={finding.id}
              finding={finding}
              sent={sentFindingIds?.has(finding.id) ?? false}
              canRoute={canRoute}
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
