import { useCallback, useLayoutEffect, useRef } from "react"
import type {
  Attachment,
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
import { ImageIcon, Lock, RotateCcw, X, Zap } from "lucide-react"
import type { ArchiveReason } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Composer } from "../composites/composer.js"
import { QuestionCard } from "../composites/question-card.js"
import { MessageTurn } from "../composites/message-turn.js"
import { ArchivedBanner } from "../composites/archived-banner.js"
import { RunStats } from "../composites/run-stats.js"

/**
 * Shift+Tab cycles through the HITL modes, Claude-Code style. Plan mode is
 * Claude-only (the other harnesses are autonomous), so it's appended to the
 * cycle only for Claude sessions — see `cycleFor`.
 */
const MODE_CYCLE: ReadonlyArray<PermissionMode> = ["ask", "accept-edits", "auto"]
const cycleFor = (cli: CliKind): ReadonlyArray<PermissionMode> =>
  cli === "claude" ? [...MODE_CYCLE, "plan"] : MODE_CYCLE

export interface ConversationViewProps {
  messages: ReadonlyArray<Message>
  mode: PermissionMode
  /** The harness driving this session — sets the assistant eyebrow logo/name. */
  cli?: CliKind
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  paused?: boolean
  /** Current harness model id + the models it supports (composer model chip). */
  model?: string
  models?: ReadonlyArray<ModelOption>
  onSetModel?: (model: string) => void
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void
  /** The agent is producing a turn — the composer queues messages instead of blocking. */
  busy?: boolean
  /** Cumulative tokens for the current/last run (live analytics readout). */
  tokens?: number
  /** Epoch ms the current run started, or null when idle — drives the elapsed timer. */
  runStartedAt?: number | null
  /** Messages the operator queued while the agent was busy (sent FIFO once it's free). */
  queued?: ReadonlyArray<{ text: string; images: ReadonlyArray<Attachment> }>
  /** Drop a queued message before it's sent (by its index in `queued`). */
  onUnqueue?: (index: number) => void
  /**
   * Interrupt the current turn and run a queued message now (by index) — lets the
   * operator steer mid-stream instead of waiting for the turn to finish.
   */
  onSendNow?: (index: number) => void
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onSetMode?: (mode: PermissionMode) => void
  /** A pending AskUserQuestion — replaces the composer with the question card. */
  question?: QuestionRequest | null
  onAnswerQuestion?: (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => void
  /** Approve a proposed plan inline (from a transcript plan card). */
  onApprovePlan?: (planId: string) => void
  /** Approve a stale plan inline (re-drives execution after a restart). */
  onResumePlan?: (planId: string) => void
  /** Open the full Plan Review view (from a transcript plan card). */
  onOpenPlanReview?: () => void
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
  /** One-shot draft to seed the composer with (task prefilled from an issue). */
  initialDraft?: string
}

/** Count added/removed lines in a unified diff, ignoring the file headers. */
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
  paused = false,
  model,
  models = [],
  onSetModel,
  onSend,
  busy = false,
  tokens = 0,
  runStartedAt = null,
  queued = [],
  onUnqueue,
  onSendNow,
  onDecideGate,
  onSetMode,
  question,
  onAnswerQuestion,
  onApprovePlan,
  onResumePlan,
  onOpenPlanReview,
  archived,
  initialDraft
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Sticky-bottom: follow the newest content while the operator is parked at the
  // bottom, but never yank them down once they've scrolled up to read.
  const stick = useRef(true)

  // Shift+Tab cycles the HITL mode (works while typing in the composer). Plan
  // mode joins the cycle on Claude sessions only (matches the composer's gate).
  const cycle = cycleFor(cli)
  useHotkeys(
    "shift+tab",
    () => {
      const i = cycle.indexOf(mode)
      onSetMode?.(cycle[(i + 1) % cycle.length]!)
    },
    { enableOnFormTags: true, preventDefault: true },
    [mode, onSetMode, cycle]
  )

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
    overscan: 6
  })

  // Standard chat scroll: keep the newest content in view while stuck to the
  // bottom, so the transcript grows downward and never leaves trailing dead
  // space. `messages` is a fresh array on every stream delta, so this re-pins as
  // the current turn fills — but only while the operator hasn't scrolled up.
  useLayoutEffect(() => {
    if (stick.current && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" })
    }
  }, [messages, virtualizer])

  // Track whether we're parked at the bottom (within a small threshold), so
  // scrolling up to read pauses the auto-follow and scrolling back resumes it.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

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
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            // `both-edges` reserves the scrollbar gutter symmetrically so the
            // centered content stays on the window's centre axis — matching the
            // composer below (which has no scrollbar) exactly.
            "flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]",
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
                  {/* Centered content column (same width as the composer below). */}
                  <div className="mx-auto w-full max-w-[760px] pb-6">
                    <MessageTurn
                      message={m}
                      cli={cli}
                      onDecideGate={onDecideGate}
                      onApprovePlan={onApprovePlan}
                      onResumePlan={onResumePlan}
                      onOpenPlanReview={onOpenPlanReview}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Same gutter + centered max-width as the transcript column above. */}
        <div className="flex-none px-[30px] pb-[18px] pt-[11px]">
          <div className="mx-auto w-full max-w-[760px]">
          {/* Live session analytics — elapsed + token consumption, right above the
              composer so the session's cost/time sits with where you type. */}
          {!archived && (busy || runStartedAt !== null || tokens > 0) && (
            <div className="mb-1.5 flex items-center justify-end">
              <RunStats startedAt={runStartedAt} tokens={tokens} busy={busy} />
            </div>
          )}
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
            <>
              {queued.length > 0 && (
                <div className="mb-2 flex flex-col gap-1.5">
                  {queued.map((item, i) => (
                    <div
                      key={`${i}-${item.text.slice(0, 24)}`}
                      className="flex items-center gap-2 rounded-lg border border-line bg-sunken/60 px-3 py-1.5 text-[12.5px] text-muted-foreground"
                    >
                      <span className="flex-none font-mono text-[10px] uppercase tracking-wide text-dim">
                        Queued
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text-body">
                        {item.text || <span className="text-dim">(image only)</span>}
                      </span>
                      {item.images.length > 0 && (
                        <span className="flex flex-none items-center gap-1 font-mono text-[10.5px] text-cyan">
                          <ImageIcon size={11} />
                          {item.images.length}
                        </span>
                      )}
                      {onSendNow && busy && (
                        <button
                          type="button"
                          onClick={() => onSendNow(i)}
                          title="Send now — interrupts the current turn to steer the agent"
                          className="flex flex-none items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-blue outline-none transition-colors hover:bg-blue/10 hover:text-blue focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Zap size={11} />
                          Send now
                        </button>
                      )}
                      {onUnqueue && (
                        <button
                          type="button"
                          onClick={() => onUnqueue(i)}
                          title="Remove from queue"
                          className="flex size-5 flex-none items-center justify-center rounded text-dim outline-none transition-colors hover:bg-surface hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <Composer
                skills={skills}
                files={files}
                paused={paused}
                busy={busy}
                model={model}
                models={models}
                onSetModel={onSetModel}
                mode={mode}
                onSetMode={onSetMode}
                allowPlan={cli === "claude"}
                onSend={onSend}
                initialValue={initialDraft}
              />
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
