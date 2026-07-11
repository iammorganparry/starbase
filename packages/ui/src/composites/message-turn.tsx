import type { ContentPart, GateDecision, Message, ToolCall as ToolCallModel } from "@starbase/core"
import { ClaudeGlyph, Eyebrow } from "../components/eyebrow.js"
import { DiffPeek } from "../components/diff-peek.js"
import { ApprovalGate } from "./approval-gate.js"
import { ThoughtBlock } from "./thought-block.js"
import { ToolCall } from "./tool-call.js"

const WIDTH = "max-w-[640px]"

const toolMeta = (tool: ToolCallModel): string | undefined =>
  tool.meta ?? (tool.diff ? `+${tool.diff.added} −${tool.diff.removed}` : undefined)

function PartView({
  part,
  onDecideGate
}: {
  part: ContentPart
  onDecideGate?: (gateId: string, decision: GateDecision) => void
}) {
  switch (part._tag) {
    case "Text":
      return (
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

/** One transcript turn: a You/Claude eyebrow followed by its ordered parts. */
export function MessageTurn({
  message,
  onDecideGate
}: {
  message: Message
  onDecideGate?: (gateId: string, decision: GateDecision) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {message.role === "user" ? (
        <Eyebrow>You</Eyebrow>
      ) : (
        <Eyebrow accent icon={<ClaudeGlyph />}>
          Claude
        </Eyebrow>
      )}
      {message.parts.map((part, i) => (
        <PartView key={i} part={part} onDecideGate={onDecideGate} />
      ))}
    </div>
  )
}
