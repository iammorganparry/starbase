import type { PrReviewThread, PrThreadComment } from "@starbase/core"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Card } from "../components/card.js"
import { ClaudeGlyph } from "../components/eyebrow.js"
import { Markdown } from "../components/markdown.js"
import { AsyncButton } from "../components/async-button.js"
import { ReviewThreadHunk } from "../diff/review-thread-hunk.js"

/** GitHub's reaction content values → the emoji it renders them as. */
const REACTION_EMOJI: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀"
}

/**
 * The association chips GitHub shows beside a commenter. `CONTRIBUTOR` and
 * `NONE` are the unremarkable cases and get no chip, matching GitHub.
 */
const ASSOCIATION_LABEL: Partial<Record<NonNullable<PrThreadComment["association"]>, string>> = {
  OWNER: "Owner",
  MEMBER: "Member",
  COLLABORATOR: "Collaborator",
  FIRST_TIME_CONTRIBUTOR: "First-time contributor"
}

/**
 * The "Comment on lines +31 to +38" caption.
 *
 * GitHub nulls a thread's live `line`/`startLine` once it's outdated, so the
 * original anchor is the fallback that keeps the caption meaningful — that's the
 * common case on any PR pushed to since review. A start equal to (or absent
 * beside) the end line means a single-line comment.
 */
const anchorCaption = (thread: PrReviewThread): string | null => {
  const end = thread.line ?? thread.originalLine
  if (end === null) return null
  const start = thread.startLine ?? thread.originalStartLine
  return start !== null && start !== end ? `Comment on lines +${start} to +${end}` : `Comment on line +${end}`
}

function ThreadComment({
  comment,
  isAuthor,
  sent,
  onSendToAgent
}: {
  comment: PrThreadComment
  /** This commenter opened the PR — GitHub adds an "Author" chip. */
  isAuthor: boolean
  sent?: boolean
  onSendToAgent?: (id: string) => Promise<void> | void
}) {
  const association = comment.association ? ASSOCIATION_LABEL[comment.association] : undefined
  return (
    <div className="flex flex-col gap-[9px] border-t border-hairline px-[14px] py-[11px] first:border-t-0">
      <div className="flex items-center gap-[9px]">
        <Avatar
          initial={comment.author.charAt(0).toUpperCase()}
          src={comment.authorAvatarUrl ?? githubAvatarUrl(comment.author)}
          tone={comment.isBot ? "purple" : "orange"}
          size={22}
        />
        <span className="text-[13px] font-semibold text-text-bright">{comment.author}</span>
        {comment.isBot && (
          <Badge tone="purple" size="xs">
            Bot
          </Badge>
        )}
        <span className="font-mono text-[11px] text-dim">{relativeTime(comment.createdAt)}</span>
        <div className="flex-1" />
        {isAuthor && (
          <Badge tone="neutral" size="xs">
            Author
          </Badge>
        )}
        {association && (
          <Badge tone="neutral" size="xs">
            {association}
          </Badge>
        )}
      </div>

      {comment.body && <Markdown className="text-[13.5px]">{comment.body}</Markdown>}

      {(comment.reactions.length > 0 || onSendToAgent) && (
        <div className="flex flex-wrap items-center gap-2">
          {comment.reactions.map((r) => (
            <span
              key={r.content}
              title={r.content.toLowerCase().replace(/_/g, " ")}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {REACTION_EMOJI[r.content] ?? "•"} {r.count}
            </span>
          ))}
          {onSendToAgent && (
            <AsyncButton
              variant="secondary"
              icon={<ClaudeGlyph />}
              pendingLabel="Sending…"
              successLabel="Sent"
              doneLabel="Sent to agent"
              terminal
              done={sent}
              onClick={() => onSendToAgent(comment.id)}
            >
              Send to agent
            </AsyncButton>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One inline review thread, rendered the way GitHub does: a collapsible
 * per-file box, the diff hunk it's anchored to, the comment chain, a reply box,
 * and a resolve toggle.
 *
 * Resolved threads start collapsed — GitHub's "Show resolved" — so an addressed
 * review folds away instead of burying the live discussion.
 */
export function PrReviewThreadView({
  thread,
  prAuthor,
  sentEntryIds,
  onSendToAgent,
  onResolve,
  onReply
}: {
  thread: PrReviewThread
  /** The PR's author login, for the "Author" chip. */
  prAuthor?: string
  sentEntryIds?: ReadonlySet<string>
  onSendToAgent?: (id: string) => Promise<void> | void
  onResolve?: (threadId: string, resolved: boolean) => Promise<void> | void
  /** Reply to the thread. `commentId` is the first comment's REST databaseId. */
  onReply?: (commentId: number, body: string) => Promise<void> | void
}) {
  const [open, setOpen] = useState(!thread.isResolved)
  const [draft, setDraft] = useState("")
  const caption = anchorCaption(thread)
  const replyTo = thread.comments[0]?.databaseId ?? null

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-hairline px-[13px] py-2.5 text-left hover:bg-white/[0.02]"
      >
        {open ? (
          <ChevronDown size={13} className="flex-none text-dim" />
        ) : (
          <ChevronRight size={13} className="flex-none text-dim" />
        )}
        <span className="truncate font-mono text-[12px] text-text-bright">{thread.path}</span>
        {thread.isOutdated && (
          <Badge tone="neutral" size="xs" title="The diff has moved since this comment">
            Outdated
          </Badge>
        )}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-dim">
          {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}
        </span>
        {thread.isResolved && (
          <Badge tone="green" size="xs">
            Resolved
          </Badge>
        )}
      </button>

      {open && (
        <>
          {caption && (
            <div className="border-b border-hairline px-[14px] py-[7px] font-mono text-[11px] text-muted-foreground">
              {caption}
            </div>
          )}
          {thread.diffHunk && <ReviewThreadHunk hunk={thread.diffHunk} className="border-b border-hairline" />}

          {thread.comments.map((c) => (
            <ThreadComment
              key={c.id}
              comment={c}
              isAuthor={prAuthor !== undefined && c.author === prAuthor}
              sent={sentEntryIds?.has(c.id)}
              onSendToAgent={onSendToAgent}
            />
          ))}

          {onReply && replyTo !== null && (
            <div className="flex flex-col gap-2 border-t border-hairline px-[14px] py-[11px]">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Reply…"
                rows={2}
                className="w-full resize-y rounded-md border border-line bg-editor px-[9px] py-[7px] text-[13px] text-text-body placeholder:text-dim focus:border-line-strong focus:outline-none"
              />
              {draft.trim().length > 0 && (
                <AsyncButton
                  variant="secondary"
                  className="self-start"
                  pendingLabel="Replying…"
                  successLabel="Replied"
                  onClick={async () => {
                    await onReply(replyTo, draft.trim())
                    setDraft("")
                  }}
                >
                  Reply
                </AsyncButton>
              )}
            </div>
          )}

          {onResolve && (
            <div className="flex items-center gap-[9px] border-t border-hairline bg-surface px-[14px] py-[9px]">
              <AsyncButton
                variant="secondary"
                pendingLabel={thread.isResolved ? "Unresolving…" : "Resolving…"}
                successLabel="Done"
                onClick={() => onResolve(thread.id, !thread.isResolved)}
              >
                {thread.isResolved ? "Unresolve conversation" : "Resolve conversation"}
              </AsyncButton>
              {thread.isResolved && thread.resolvedBy && (
                <span className={cn("text-[12px] text-dim")}>
                  <span className="text-muted-foreground">{thread.resolvedBy}</span> marked this
                  conversation as resolved.
                </span>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
