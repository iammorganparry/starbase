import { Trash2 } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { FileIcon } from "../components/file-icon.js"

export interface ReviewDraft {
  id: string
  path: string
  line: number
  endLine: number | null
  body: string
  routeToAgent: boolean
}

/**
 * The right rail of the Code Review view — the stack of pending inline comments,
 * the session they'll route to, and the two ways to finish the review.
 */
export function ReviewTray({
  drafts,
  routeTargetSession,
  onRemoveDraft,
  onFinishReview
}: {
  drafts: readonly ReviewDraft[]
  routeTargetSession: string | null
  onRemoveDraft: (id: string) => void
  onFinishReview: (mode: "comment_only" | "send_to_agent") => void
}) {
  const count = drafts.length
  return (
    <div className="flex w-[300px] flex-none flex-col border-l border-hairline bg-panel">
      <div className="flex h-[42px] flex-none items-center gap-2 border-b border-hairline px-[15px]">
        <span className="flex-1 text-[12px] font-semibold text-text-bright">Your review</span>
        {count > 0 && (
          <Badge tone="yellow" size="sm">
            {count} pending
          </Badge>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-[9px] overflow-auto p-2.5">
        {count === 0 ? (
          <p className="px-1 pt-2 text-[12px] text-dim">
            Select lines in the diff to start a comment.
          </p>
        ) : (
          drafts.map((draft) => {
            const name = draft.path.split("/").pop() ?? draft.path
            const range =
              draft.endLine && draft.endLine > draft.line
                ? `L${draft.line}–${draft.endLine}`
                : `L${draft.line}`
            return (
              <div key={draft.id} className="overflow-hidden rounded-md border border-line">
                <div className="flex items-center gap-2 bg-surface px-[11px] py-2">
                  <FileIcon path={draft.path} size={12} />
                  <span className="flex-1 truncate font-mono text-[10.5px] text-text-bright">
                    {name}
                  </span>
                  <span className="font-mono text-[10px] text-blue">{range}</span>
                  <button
                    type="button"
                    aria-label="Remove comment"
                    onClick={() => onRemoveDraft(draft.id)}
                    className="text-dim hover:text-red"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <p className="px-[10px] py-[7px] text-[12px] leading-[1.5] text-text">
                  {draft.body}
                </p>
              </div>
            )
          })
        )}
      </div>

      <div className="flex flex-none flex-col gap-[11px] border-t border-hairline p-[11px]">
        {routeTargetSession && (
          <div className="flex items-center gap-[9px] rounded-md border border-blue/30 bg-blue/[0.06] px-2.5 py-2">
            <span className="flex size-[22px] flex-none items-center justify-center rounded-md bg-blue font-mono text-[11px] font-bold text-editor">
              C
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-muted-foreground">Added to context of</div>
              <div className="truncate text-[12.5px] font-semibold text-text-bright">
                {routeTargetSession}
              </div>
            </div>
          </div>
        )}
        <div className="flex gap-[9px]">
          <Button
            variant="secondary"
            className="flex-1 justify-center"
            disabled={count === 0}
            onClick={() => onFinishReview("comment_only")}
          >
            Comment only
          </Button>
          <Button
            className="flex-[1.4] justify-center"
            disabled={count === 0}
            onClick={() => onFinishReview("send_to_agent")}
          >
            Send {count} to agent →
          </Button>
        </div>
      </div>
    </div>
  )
}
