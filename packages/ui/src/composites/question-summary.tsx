import type { QuestionAnswer, QuestionRequest } from "@starbase/core"
import { CircleCheck } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"

/**
 * A compact, in-transcript record of an answered AskUserQuestion — what the agent
 * asked and what the operator picked — so the choice stays visible after the
 * docked question card is gone (otherwise it's easy to forget what was selected).
 */
export function QuestionSummary({
  request,
  answers,
  className
}: {
  request: QuestionRequest
  answers: ReadonlyArray<QuestionAnswer>
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel px-3.5 py-3", className)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-green">
        <CircleCheck className="size-3.5" />
        Your answer
      </div>
      <div className="flex flex-col gap-2.5">
        {request.questions.map((q, i) => {
          const a = answers[i]
          const picks = a ? [...a.selected, ...(a.other ? [a.other] : [])] : []
          return (
            <div key={i} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                {q.header && (
                  <Badge tone="neutral" size="xs">
                    {q.header}
                  </Badge>
                )}
                {q.question}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {picks.length > 0 ? (
                  picks.map((p) => (
                    <span
                      key={p}
                      className="rounded-md border border-blue/45 bg-blue/10 px-2 py-0.5 text-[12px] font-medium text-text"
                    >
                      {p}
                    </span>
                  ))
                ) : (
                  <span className="text-[12px] text-dim">No selection</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
