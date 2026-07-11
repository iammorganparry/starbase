import type { CliKind, ContentPart, GateDecision, Message, ToolCall as ToolCallModel } from "@starbase/core"
import { Eyebrow } from "../components/eyebrow.js"
import { DiffPeek } from "../components/diff-peek.js"
import { Markdown } from "../components/markdown.js"
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderIcon } from "../components/provider-icon.js"
import { ApprovalGate } from "./approval-gate.js"
import { ThoughtBlock } from "./thought-block.js"
import { ToolCall } from "./tool-call.js"

const WIDTH = "max-w-[640px]"

const toolMeta = (tool: ToolCallModel): string | undefined =>
  tool.meta ?? (tool.diff ? `+${tool.diff.added} −${tool.diff.removed}` : undefined)

/** A pulsing dots indicator shown while an assistant turn is still streaming. */
function Working() {
  return (
    <div className="flex items-center gap-1.5 py-1" aria-label="Working">
      <span className="size-1.5 animate-pulse-dot rounded-full bg-blue/70" />
      <span className="size-1.5 animate-pulse-dot rounded-full bg-blue/70 [animation-delay:0.2s]" />
      <span className="size-1.5 animate-pulse-dot rounded-full bg-blue/70 [animation-delay:0.4s]" />
    </div>
  )
}

function PartView({
  part,
  markdown,
  onDecideGate
}: {
  part: ContentPart
  markdown: boolean
  onDecideGate?: (gateId: string, decision: GateDecision) => void
}) {
  switch (part._tag) {
    case "Text":
      return markdown ? (
        <Markdown className={WIDTH}>{part.text}</Markdown>
      ) : (
        <p className={`m-0 ${WIDTH} whitespace-pre-wrap text-[14.5px] leading-[1.65] text-text-body`}>
          {part.text}
        </p>
      )
    case "Thinking":
      return (
        <ThoughtBlock
          seconds={part.seconds}
          streaming={part.streaming}
          defaultOpen
          className={WIDTH}
        >
          {part.text}
        </ThoughtBlock>
      )
    case "Tool":
      return (
        <ToolCall
          status={part.tool.status}
          name={part.tool.name}
          target={part.tool.target ?? undefined}
          filePath={part.tool.target}
          meta={toolMeta(part.tool)}
          className={WIDTH}
        >
          {part.tool.preview && <DiffPeek preview={part.tool.preview} />}
        </ToolCall>
      )
    case "Gate":
      return (
        <ApprovalGate
          kind={part.gate.kind}
          title={part.gate.title}
          detail={part.gate.detail}
          command={part.gate.command}
          allowLabel={part.gate.allowLabel}
          status={part.gate.status}
          onDecide={(decision) => onDecideGate?.(part.gate.id, decision)}
          className={WIDTH}
        />
      )
  }
}

/** One transcript turn: a You / provider eyebrow followed by its ordered parts. */
export function MessageTurn({
  message,
  cli = "claude",
  onDecideGate
}: {
  message: Message
  /** The harness that produced assistant turns — sets the eyebrow logo + name. */
  cli?: CliKind
  onDecideGate?: (gateId: string, decision: GateDecision) => void
}) {
  const isAssistant = message.role === "assistant"
  return (
    <div className="flex flex-col gap-3">
      {isAssistant ? (
        // Provider-branded eyebrow: logo + name in the provider's brand colour.
        <Eyebrow icon={<ProviderIcon cli={cli} mono />} style={{ color: PROVIDER_COLOR[cli] }}>
          {PROVIDER_LABEL[cli]}
        </Eyebrow>
      ) : (
        <Eyebrow>You</Eyebrow>
      )}
      {message.parts.map((part, i) => (
        <PartView key={i} part={part} markdown={isAssistant} onDecideGate={onDecideGate} />
      ))}
      {/* Signal the agent is still working (before/while content streams in). */}
      {isAssistant && message.streaming && <Working />}
    </div>
  )
}
