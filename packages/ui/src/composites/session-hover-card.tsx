import type { Session, SessionActivity, SessionPrStatus } from "@starbase/core"
import { activityLabel, displayStatusOf, UNTITLED_SESSION } from "@starbase/core"
import { GitBranch } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { StatusDot } from "../components/status-dot.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { DiffStat } from "../components/diff-stat.js"
import { PrStatusGlyph } from "./pr-glyph.js"
import { displayStatusLabel, displayStatusTone, statusTextClass } from "../tokens.js"

/**
 * What a session looks like when the sidebar is a 52px rail.
 *
 * The rail can show two facts — that a session exists, and roughly how it's
 * doing. This card is where the other six live, so collapsing the sidebar costs
 * reach rather than information. It deliberately carries the SAME facts as
 * `SessionRow` (title, repo/branch, status, diff, PR, age) and no more: a card
 * that showed things the expanded sidebar doesn't would make the two states
 * disagree about what a session is.
 *
 * Read-only by design. Archive and delete stay on the row, because a card you
 * must chase with the pointer to click is a card you will misclick.
 */
export function SessionHoverCard({
  session,
  activity,
  prState
}: {
  session: Session
  /** What the agent is doing right now; absent falls back to the persisted status. */
  activity?: SessionActivity
  /** Live PR state; `null`/absent renders no PR line at all. */
  prState?: SessionPrStatus | null
}) {
  const display = displayStatusOf(activity, session.status)
  // The detail line ("Running pnpm test -- auth") when there IS live activity;
  // the five-word rollup otherwise. Never both — they'd say the same thing twice.
  const detail = activity ? activityLabel(activity) : displayStatusLabel[display]
  const { added, removed } = session.diff
  const hasDiff = added > 0 || removed > 0

  return (
    <div className="flex w-[240px] flex-col gap-1.5">
      {/* The harness leads the card because it leads the rail cell — the icon
          you hovered is the first thing the card confirms. */}
      <span className="flex min-w-0 items-center gap-1.5">
        <ProviderIcon cli={session.cli} size={13} className="flex-none" />
        <span className="truncate text-[12.5px] font-semibold leading-snug text-text-bright">
          {session.title || UNTITLED_SESSION}
        </span>
      </span>

      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-dim">
        <GitBranch size={11} className="flex-none text-cyan" />
        <span className="truncate">
          {session.repo} · {session.branch}
        </span>
      </span>

      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[11px]",
          statusTextClass[displayStatusTone[display]]
        )}
      >
        <StatusDot status={displayStatusTone[display]} size={7} />
        <span className="truncate">{detail}</span>
      </span>

      {/* The footer only exists when it has something to say — an untouched
          session with no PR would otherwise get an empty grey strip. */}
      {(hasDiff || session.prNumber !== null) && (
        <div className="flex items-center gap-2.5 border-t border-hairline pt-1.5">
          {hasDiff && <DiffStat added={added} removed={removed} />}
          {session.prNumber !== null && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-dim">
              <PrStatusGlyph pr={prState ?? null} size={12} />#{session.prNumber}
            </span>
          )}
        </div>
      )}

      <span className="font-mono text-[10px] text-muted-foreground">
        {relativeTime(session.updatedAt)}
      </span>
    </div>
  )
}
