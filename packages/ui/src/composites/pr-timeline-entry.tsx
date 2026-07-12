import type { PrTimelineItem } from "@starbase/core"
import { Check, MessageSquare, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Card } from "../components/card.js"
import { ClaudeGlyph } from "../components/eyebrow.js"
import { CodeChip } from "../components/code-chip.js"
import { Markdown } from "../components/markdown.js"
import { AsyncButton } from "../components/async-button.js"

/** Format an ISO timestamp as a compact relative "2h ago" string. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

const kindMeta = {
  commented: { Icon: MessageSquare, tone: "text-blue", label: "commented", rail: "bg-blue/12" },
  approved: { Icon: Check, tone: "text-green", label: "approved", rail: "bg-green/12" },
  changes_requested: {
    Icon: X,
    tone: "text-red",
    label: "requested changes",
    rail: "bg-red/10"
  }
} as const

/**
 * A single review / comment entry in the PR timeline — a kind-coded left rail,
 * the author's review body, an optional inline code reference, and a "send to
 * agent" action that hands the feedback to the session's agent.
 */
export function PrTimelineEntry({
  item,
  sent = false,
  onSendToAgent
}: {
  item: PrTimelineItem
  /** This entry has already been routed to the agent — the action stays "Sent". */
  sent?: boolean
  onSendToAgent?: (id: string) => Promise<void> | void
}) {
  const meta = kindMeta[item.kind]
  const hasRef = item.path !== null && item.line !== null

  return (
    <div className="flex items-start gap-[11px]">
      <span
        className={cn(
          "mt-0.5 flex size-[26px] flex-none items-center justify-center rounded-full",
          meta.rail
        )}
      >
        <meta.Icon size={13} className={meta.tone} />
      </span>
      <Card className="flex-1">
        <div className="flex items-center gap-[9px] border-b border-hairline px-[14px] py-[11px]">
          <Avatar
            initial={item.author.charAt(0).toUpperCase()}
            src={githubAvatarUrl(item.author)}
            tone="orange"
            size={22}
          />
          <span className="text-[13px] font-semibold text-text-bright">{item.author}</span>
          <span className={cn("text-[11.5px] font-semibold", meta.tone)}>{meta.label}</span>
          <div className="flex-1" />
          <span className="font-mono text-[11px] text-dim">{relativeTime(item.createdAt)}</span>
        </div>
        <div className="flex flex-col gap-[11px] px-[14px] py-[11px]">
          {item.body && <Markdown className="text-[13.5px]">{item.body}</Markdown>}
          {hasRef && (
            <CodeChip path={item.path as string} line={item.line as number} className="self-start" />
          )}
          {onSendToAgent && (
            <div className="flex items-center gap-2">
              <AsyncButton
                variant="secondary"
                icon={<ClaudeGlyph />}
                pendingLabel="Sending…"
                successLabel="Sent"
                doneLabel="Sent to agent"
                terminal
                done={sent}
                onClick={() => onSendToAgent(item.id)}
              >
                Send to agent
              </AsyncButton>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
