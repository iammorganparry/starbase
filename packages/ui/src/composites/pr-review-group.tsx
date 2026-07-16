import type { PrReviewThread } from "@starbase/core"
import { MessageSquare } from "lucide-react"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { PrReviewThreadView } from "./pr-review-thread.js"

/**
 * A set of inline review threads opened by one review submission, under a single
 * "<author> reviewed <when>" header — GitHub's grouping. Threads carry no author
 * or timestamp of their own, so both are taken from the earliest comment in the
 * group.
 */
export function PrReviewGroup({
  threads,
  prAuthor,
  sentEntryIds,
  onSendToAgent,
  onResolve,
  onReply
}: {
  /** Threads sharing a `reviewId`; never empty. */
  threads: ReadonlyArray<PrReviewThread>
  prAuthor?: string
  sentEntryIds?: ReadonlySet<string>
  onSendToAgent?: (id: string) => Promise<void> | void
  onResolve?: (threadId: string, resolved: boolean) => Promise<void> | void
  onReply?: (commentId: number, body: string) => Promise<void> | void
}) {
  const opener = threads[0]?.comments[0]
  if (opener === undefined) return null

  return (
    <div className="flex items-start gap-[11px]">
      <span className="mt-0.5 flex size-[26px] flex-none items-center justify-center rounded-full bg-blue/12">
        <MessageSquare size={13} className="text-blue" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[9px]">
        <div className="flex items-center gap-[9px]">
          <Avatar
            initial={opener.author.charAt(0).toUpperCase()}
            src={opener.authorAvatarUrl ?? githubAvatarUrl(opener.author)}
            tone={opener.isBot ? "purple" : "orange"}
            size={22}
          />
          <span className="text-[13px] font-semibold text-text-bright">{opener.author}</span>
          {opener.isBot && (
            <Badge tone="purple" size="xs">
              Bot
            </Badge>
          )}
          <span className="text-[11.5px] font-semibold text-blue">reviewed</span>
          <span className="font-mono text-[11px] text-dim">{relativeTime(opener.createdAt)}</span>
        </div>
        {threads.map((thread) => (
          <PrReviewThreadView
            key={thread.id}
            thread={thread}
            prAuthor={prAuthor}
            sentEntryIds={sentEntryIds}
            onSendToAgent={onSendToAgent}
            onResolve={onResolve}
            onReply={onReply}
          />
        ))}
      </div>
    </div>
  )
}
