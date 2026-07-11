import { type ReactNode, useLayoutEffect, useRef } from "react"
import type { GateDecision, Message, PermissionMode, Skill } from "@starbase/core"
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
  const lastTurnRef = useRef<HTMLDivElement>(null)
  const prevCount = useRef(messages.length)

  // Pin each newly-appended turn to the top of the scroll viewport. Only fires on
  // a genuinely new turn (count increased), so streaming into the current turn
  // never yanks the view.
  useLayoutEffect(() => {
    if (messages.length > prevCount.current) {
      lastTurnRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    }
    prevCount.current = messages.length
  }, [messages.length])

  const counts = diffCounts(patch)

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-center justify-end border-b border-hairline px-[30px] py-2">
          <ModeSwitch mode={mode} onChange={onSetMode} paused={paused} />
        </div>

        <div className="flex flex-1 flex-col gap-6 overflow-auto px-[30px] py-[26px]">
          {messages.map((m, i) => (
            <div key={m.id} ref={i === messages.length - 1 ? lastTurnRef : undefined}>
              <MessageTurn message={m} onDecideGate={onDecideGate} />
            </div>
          ))}
          {/* Spacer so a just-sent turn can reach the top with room to fill below. */}
          <div className="min-h-[48vh] shrink-0" aria-hidden />
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

      <DiffPanel patch={patch} added={counts.added} removed={counts.removed} />
    </div>
  )
}
