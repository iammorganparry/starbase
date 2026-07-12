import * as React from "react"
import { Undo2, X } from "lucide-react"
import { Button } from "../components/button.js"
import { ClaudeGlyph } from "../components/eyebrow.js"
import { Toggle } from "../components/toggle.js"

/**
 * The inline comment box anchored below a selected diff range. Drafts a comment
 * on `path` L{startLine}–{endLine}, optionally routed to the active session's
 * agent, then either stashes it in the review or sends it straight to the agent.
 */
export function InlineCommentComposer({
  path,
  startLine,
  endLine,
  connected,
  routeTargetSession,
  onCancel,
  onAddToReview,
  onCommentAndSend,
  onRevert
}: {
  path: string
  startLine: number
  endLine: number
  connected: boolean
  routeTargetSession: string | null
  onCancel: () => void
  onAddToReview: (draft: { body: string; routeToAgent: boolean }) => void
  onCommentAndSend: (draft: { body: string; routeToAgent: boolean }) => void
  /** Revert the selected lines (only wired for a session's uncommitted diff). */
  onRevert?: () => void
}) {
  const [body, setBody] = React.useState("")
  const [routeToAgent, setRouteToAgent] = React.useState(routeTargetSession !== null)
  const name = path.split("/").pop() ?? path
  const range = endLine > startLine ? `L${startLine}–${endLine}` : `L${startLine}`

  return (
    <div className="max-w-[560px] overflow-hidden rounded-lg border border-blue/45 bg-panel shadow-[0_12px_30px_-14px_rgba(0,0,0,0.7)]">
      <div className="flex items-center gap-2 border-b border-hairline bg-blue/[0.06] px-[11px] py-2">
        <span className="text-[11.5px] font-semibold text-text-bright">Comment on</span>
        <span className="rounded-md bg-blue/[0.14] px-2 py-0.5 font-mono text-[10.5px] text-blue">
          {name} {range}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Cancel comment"
          onClick={onCancel}
          className="text-dim hover:text-text"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Suggest a change or ask the agent to fix this…"
        rows={3}
        className="w-full resize-none bg-transparent px-[13px] py-[10px] text-[13.5px] text-text-body outline-none placeholder:text-dim"
      />
      <div className="flex flex-col gap-3 border-t border-hairline px-[15px] py-[11px]">
        {routeTargetSession && (
          <label className="flex items-center gap-2 text-[12px] text-text">
            <Toggle checked={routeToAgent} onCheckedChange={setRouteToAgent} />
            Route to <span className="font-semibold text-blue">{routeTargetSession}</span>
          </label>
        )}
        <div className="flex items-center justify-end gap-2.5">
          {onRevert && (
            <Button variant="danger" size="sm" className="mr-auto gap-1.5" onClick={onRevert}>
              <Undo2 size={13} />
              Revert {range}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onAddToReview({ body: body.trim(), routeToAgent })}
          >
            Add to review
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!connected}
            onClick={() => onCommentAndSend({ body: body.trim(), routeToAgent })}
          >
            <ClaudeGlyph />
            Comment &amp; send
          </Button>
        </div>
      </div>
    </div>
  )
}
