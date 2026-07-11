import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import type { GateDecision, Message, PermissionMode, Skill } from "@starbase/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import { PanelRight } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Composer } from "../composites/composer.js"
import { MessageTurn } from "../composites/message-turn.js"
import { ModeSwitch } from "../composites/mode-switch.js"
import { DiffPanel } from "./diff-panel.js"

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "ask each time",
  "accept-edits": "accept edits",
  auto: "auto"
}

export interface ConversationViewProps {
  messages: ReadonlyArray<Message>
  mode: PermissionMode
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  /** The worktree's unified diff, shown in the Changes rail. */
  patch?: string
  paused?: boolean
  model?: ReactNode
  onSend?: (text: string) => void
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onSetMode?: (mode: PermissionMode) => void
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
  skills = [],
  files = [],
  patch = "",
  paused = false,
  model,
  onSend,
  onDecideGate,
  onSetMode
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCount = useRef(messages.length)
  const [showChanges, setShowChanges] = useState(true)

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
    getItemKey: (i) => messages[i]!.id,
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
        <div className="flex flex-none items-center gap-2 border-b border-hairline px-[30px] py-2">
          <div className="flex-1" />
          <ModeSwitch mode={mode} onChange={onSetMode} paused={paused} />
          {/* Show/hide the Changes rail — only offered when there are changes. */}
          {hasChanges && (
            <button
              type="button"
              onClick={() => setShowChanges((v) => !v)}
              title={showChanges ? "Hide changes" : "Show changes"}
              aria-pressed={showChanges}
              className="flex size-7 items-center justify-center rounded-md border border-line outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelRight size={15} className={cn(showChanges ? "text-blue" : "text-dim")} />
            </button>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto px-[30px] py-[26px]">
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
                    <MessageTurn message={m} onDecideGate={onDecideGate} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex-none px-[22px] pb-[18px] pt-[11px]">
          <Composer
            skills={skills}
            files={files}
            paused={paused}
            model={model}
            mode={MODE_LABEL[mode]}
            onSend={onSend}
          />
        </div>
      </div>

      {hasChanges && showChanges && (
        <DiffPanel patch={patch} added={counts.added} removed={counts.removed} />
      )}
    </div>
  )
}
