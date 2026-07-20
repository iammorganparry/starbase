import type { CliKind, Subagent } from "@starbase/core"
import { Bot } from "lucide-react"
import { MessageTurn } from "../composites/message-turn.js"

/**
 * A watch-only view of one sub-agent's live transcript. A sub-agent runs
 * autonomously (the harness exposes no way to steer it mid-run), so there is no
 * composer or HITL affordance here — just its thinking/tool-calls/output as they
 * stream, rendered with the same `MessageTurn` the main transcript uses. The
 * sub-agent's whole run accrues onto a single rolling assistant message.
 */
export function SubagentView({
  subagent,
  cli = "claude"
}: {
  subagent: Subagent
  /** The session's harness — the fallback when the sub-agent doesn't name its own. */
  cli?: CliKind
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor">
      {/* A slim header naming the agent + its task, so the tab has context. */}
      <div className="flex flex-none items-center gap-2 border-b border-hairline px-[30px] py-2.5">
        <Bot className="size-3.5 flex-none text-blue" />
        <span className="text-[12.5px] font-medium text-text">{subagent.name}</span>
        {subagent.description && (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{subagent.description}</span>
        )}
        <span className="ml-auto flex-none font-mono text-[10px] uppercase tracking-wide text-dim">
          watch-only
        </span>
      </div>

      <div className="flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[760px]">
          <MessageTurn message={subagent.message} cli={subagent.cli ?? cli} />
        </div>
      </div>
    </div>
  )
}
