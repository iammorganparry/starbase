import { useLayoutEffect, useRef, useState } from "react"
import type {
  CliKind,
  GateDecision,
  Message,
  ModelOption,
  PermissionMode,
  QuestionAnswer,
  QuestionRequest,
  Skill
} from "@starbase/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useHotkeys } from "react-hotkeys-hook"
import { Lock, PanelRight, RotateCcw } from "lucide-react"
import type { ArchiveReason } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Composer } from "../composites/composer.js"
import { QuestionCard } from "../composites/question-card.js"
import { MessageTurn } from "../composites/message-turn.js"
import { ArchivedBanner } from "../composites/archived-banner.js"
import { DiffPanel } from "./diff-panel.js"
import type { DiffActions } from "../diff/diff-view.js"

/** Shift+Tab cycles through the HITL modes, Claude-Code style. */
const MODE_CYCLE: ReadonlyArray<PermissionMode> = ["ask", "accept-edits", "auto"]

export interface ConversationViewProps {
  messages: ReadonlyArray<Message>
  mode: PermissionMode
  /** The harness driving this session — sets the assistant eyebrow logo/name. */
  cli?: CliKind
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  /** The worktree's unified diff, shown in the Changes rail. */
  patch?: string
  paused?: boolean
  /** Current harness model id + the models it supports (composer model chip). */
  model?: string
  models?: ReadonlyArray<ModelOption>
  onSetModel?: (model: string) => void
  onSend?: (text: string) => void
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onSetMode?: (mode: PermissionMode) => void
  /** A pending AskUserQuestion — replaces the composer with the question card. */
  question?: QuestionRequest | null
  onAnswerQuestion?: (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => void
  /** Revert / comment interactions for the Changes rail (worktree diff). */
  changeActions?: DiffActions
  /**
   * When set, the session is archived (its PR merged/closed): a banner is shown,
   * the transcript dims to read-only, and the composer is replaced by a locked bar.
   */
  archived?: {
    reason: ArchiveReason
    prNumber: number | null
    base?: string | null
    onRestore?: () => void
    onDelete?: () => void
  }
}

/** Count added/removed lines in a unified diff, ignoring the file headers. */
const diffCounts = (patch: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

/**
 * The session workspace pane: the mode bar + interleaved transcript + composer,
 * with the live Changes rail (the worktree's real diff). Purely presentational —
 * the renderer's conversation machine feeds it `messages`/`patch` + callbacks.
 * New turns autoscroll to the top of the viewport so a streaming response has
 * room to fill downward (the design's "room to follow").
 */
export function ConversationView({
  messages,
  mode,
  cli = "claude",
  skills = [],
  files = [],
  patch = "",
  paused = false,
  model,
  models = [],
  onSetModel,
  onSend,
  onDecideGate,
  onSetMode,
  question,
  onAnswerQuestion,
  changeActions,
  archived
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCount = useRef(messages.length)
  const [showChanges, setShowChanges] = useState(true)

  // Shift+Tab cycles the HITL mode (works while typing in the composer).
  useHotkeys(
    "shift+tab",
    () => {
      const i = MODE_CYCLE.indexOf(mode)
      onSetMode?.(MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!)
    },
    { enableOnFormTags: true, preventDefault: true },
    [mode, onSetMode]
  )

  const counts = diffCounts(patch)
  const hasChanges = counts.added + counts.removed > 0
  // Reserve "room to fill" (as virtualizer paddingEnd) only while the latest
  // turn streams, so a newly-sent turn can pin to the top and grow downward
  // without leaving dead space once it completes.
  const streaming = messages[messages.length - 1]?.streaming ?? false
  const room = streaming ? Math.round((scrollRef.current?.clientHeight ?? 700) * 0.42) : 0

  // Virtualize the transcript so large sessions stay fast. Heights are dynamic
  // (markdown, tool cards, diffs) so we measure each turn as it renders/grows.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    // Include the index so a stray duplicate message id (e.g. from an older
    // transcript recorded before ids were seeded per-session) can't collide in
    // the measurement cache and stack rows. The transcript is append-only, so
    // the index is stable per message.
    getItemKey: (i) => `${messages[i]!.id}-${i}`,
    paddingEnd: room,
    overscan: 6
  })

  // Pin each newly-appended turn to the top of the viewport (autoscroll-to-top).
  // Only on a genuinely new turn — streaming growth of the current turn doesn't
  // re-pin, so the view stays put while it fills.
  useLayoutEffect(() => {
    if (messages.length > prevCount.current) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "start" })
    }
    prevCount.current = messages.length
  }, [messages.length, virtualizer])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {archived && (
          <ArchivedBanner
            reason={archived.reason}
            prNumber={archived.prNumber}
            base={archived.base}
            onRestore={archived.onRestore}
            onDelete={archived.onDelete}
          />
        )}
        {/* Slim bar just for the Changes toggle — only when there are changes. */}
        {!archived && hasChanges && (
          <div className="flex flex-none items-center justify-end border-b border-hairline px-[30px] py-2">
            <button
              type="button"
              onClick={() => setShowChanges((v) => !v)}
              title={showChanges ? "Hide changes" : "Show changes"}
              aria-pressed={showChanges}
              className="flex size-7 items-center justify-center rounded-md border border-line outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelRight size={15} className={cn(showChanges ? "text-blue" : "text-dim")} />
            </button>
          </div>
        )}

        <div
          ref={scrollRef}
          className={cn(
            "flex-1 overflow-auto px-[30px] py-[26px]",
            archived && "opacity-60"
          )}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const m = messages[item.index]!
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {/* pb gives the inter-turn gap (absolute layout drops flex gap). */}
                  <div className="pb-6">
                    <MessageTurn message={m} cli={cli} onDecideGate={onDecideGate} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex-none px-[22px] pb-[18px] pt-[11px]">
          {archived ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-line bg-sunken px-[14px] py-3 text-[12.5px] text-muted-foreground">
              <Lock size={14} className="flex-none text-dim" />
              <span className="min-w-0 flex-1">
                Composer disabled — this session is archived.{" "}
                <button
                  type="button"
                  onClick={archived.onRestore}
                  className="text-blue outline-none hover:underline"
                >
                  Restore it
                </button>{" "}
                to send messages.
              </span>
              {archived.onRestore && (
                <Button variant="secondary" size="sm" className="gap-1.5" onClick={archived.onRestore}>
                  <RotateCcw size={12} />
                  Restore
                </Button>
              )}
            </div>
          ) : question ? (
            <QuestionCard
              request={question}
              onSubmit={(answers) => onAnswerQuestion?.(question.id, answers)}
            />
          ) : (
            <Composer
              skills={skills}
              files={files}
              paused={paused}
              model={model}
              models={models}
              onSetModel={onSetModel}
              mode={mode}
              onSetMode={onSetMode}
              onSend={onSend}
            />
          )}
        </div>
      </div>

      {!archived && hasChanges && showChanges && (
        <DiffPanel patch={patch} added={counts.added} removed={counts.removed} actions={changeActions} />
      )}
    </div>
  )
}
