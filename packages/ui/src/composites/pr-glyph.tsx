import type * as React from "react"
import type { SessionPrStatus } from "@starbase/core"
import {
  Check,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * What a session's PR looks like at 14px: an icon, a tint, and — only when it
 * earns one — a corner mark.
 */
export interface PrGlyph {
  /**
   * Any component taking a `className` — not `LucideIcon`, because the no-PR
   * ring is a hand-rolled 14px SVG rather than a lucide glyph, and forcing it
   * through `forwardRef` to satisfy a type nothing here uses would be ceremony.
   */
  readonly Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  /** Tailwind text colour class. */
  readonly tone: string
  /** A tiny mark stamped bottom-right, for the two states worth interrupting for. */
  readonly mark: "pass" | "fail" | null
  /** The hover title. This glyph is 14px, so the words live here. */
  readonly label: string
}

/**
 * The glyph for a session's PR, or for its absence.
 *
 * ## Why the icon says LIFECYCLE and the colour says CI
 *
 * These are two independent facts and each gets its own channel. A PR is open,
 * draft, merged or closed regardless of its build; a build passes or fails
 * regardless of where the PR is. Encoding both in colour alone would need eight
 * shades nobody can tell apart, and encoding both in shape would need eight
 * icons nobody can learn.
 *
 * So: shape = where it is, colour = whether it's healthy, and the corner mark is
 * reserved for the two answers worth a second glyph — green tick for a clean
 * build, red cross for a broken one. A running build gets amber and no mark,
 * because "still going" is not something to act on yet.
 *
 * A session with no PR gets a hollow ring rather than nothing at all. An empty
 * slot would make the rows below it shift left and the list stop scanning as a
 * column.
 */
export const prGlyphOf = (pr: SessionPrStatus | null | undefined): PrGlyph => {
  if (!pr) {
    return { Icon: NoPr, tone: "text-line-strong", mark: null, label: "No pull request" }
  }

  if (pr.state === "merged") {
    return { Icon: GitMerge, tone: "text-purple", mark: null, label: "Pull request merged" }
  }
  if (pr.state === "closed") {
    return {
      Icon: GitPullRequestClosed,
      tone: "text-red/70",
      mark: null,
      label: "Pull request closed"
    }
  }

  // Open or draft: the shape says which, the colour says how CI is doing.
  const Icon = pr.state === "draft" ? GitPullRequestDraft : GitPullRequest
  const where = pr.state === "draft" ? "Draft pull request" : "Pull request open"

  switch (pr.checks) {
    case "fail":
      return { Icon, tone: "text-red", mark: "fail", label: `${where} — checks failing` }
    case "pass":
      return { Icon, tone: "text-green", mark: "pass", label: `${where} — checks passing` }
    case "running":
      return { Icon, tone: "text-yellow", mark: null, label: `${where} — checks running` }
    case "pending":
      return { Icon, tone: "text-yellow/70", mark: null, label: `${where} — checks queued` }
    default:
      // No CI configured on this PR. Purple is the neutral "there is a PR here"
      // colour — deliberately not green, which would claim a passing build that
      // never ran.
      return { Icon, tone: "text-purple", mark: null, label: where }
  }
}

/** A hollow ring for a session with no PR — a placeholder, not a status. */
function NoPr({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 14 14" className={className} aria-hidden focusable="false">
      <circle cx="7" cy="7" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/**
 * The PR status glyph for a sidebar row.
 *
 * `title` carries the words, because 14px of icon cannot. Rendered
 * `aria-hidden` with an adjacent visually-hidden label so a screen reader gets
 * the sentence rather than "graphic".
 */
export function PrStatusGlyph({
  pr,
  size = 14,
  className
}: {
  pr: SessionPrStatus | null | undefined
  size?: number
  className?: string
}) {
  const { Icon, tone, mark, label } = prGlyphOf(pr)
  return (
    <span
      title={label}
      data-testid="pr-glyph"
      data-state={pr?.state ?? "none"}
      data-checks={pr?.checks ?? "none"}
      className={cn("relative flex flex-none items-center justify-center", tone, className)}
      style={{ width: size, height: size }}
    >
      <Icon className="size-full" strokeWidth={2} aria-hidden />
      {mark && (
        // Offset outside the icon's own box so it reads as a stamp ON the glyph
        // rather than as part of it. `bg-panel` punches a hole in the icon's
        // strokes underneath, which is what stops the two overlapping into mush.
        <span
          className={cn(
            "absolute -bottom-[3px] -right-[3px] flex items-center justify-center rounded-full bg-panel",
            mark === "fail" ? "text-red" : "text-green"
          )}
          style={{ width: size * 0.62, height: size * 0.62 }}
        >
          {mark === "fail" ? (
            <X className="size-full" strokeWidth={3.5} aria-hidden />
          ) : (
            <Check className="size-full" strokeWidth={3.5} aria-hidden />
          )}
        </span>
      )}
      <span className="sr-only">{label}</span>
    </span>
  )
}
