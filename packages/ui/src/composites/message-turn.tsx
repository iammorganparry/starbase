import { type ReactNode, useState } from "react"
import type { CliKind, ContentPart, ExecutionMode, GateDecision, Message, ToolCall as ToolCallModel } from "@starbase/core"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "../lib/cn.js"
import { AttachmentThumb } from "../components/attachment-thumb.js"
import { Eyebrow } from "../components/eyebrow.js"
import { DiffPeek } from "../components/diff-peek.js"
import { Markdown } from "../components/markdown.js"
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderIcon } from "../components/provider-icon.js"
import { ApprovalGate } from "./approval-gate.js"
import { PlanCard } from "./plan-card.js"
import { QuestionSummary } from "./question-summary.js"
import { ThoughtBlock } from "./thought-block.js"
import { ToolCall } from "./tool-call.js"

// Parts fill the transcript's centered content column (width is owned by
// ConversationView), so nothing here caps its own width.
const WIDTH = "w-full"

/** A run of this many consecutive tool calls (no text between) collapses to the latest. */
const COLLAPSE_MIN = 3

type ToolPart = Extract<ContentPart, { _tag: "Tool" }>
type ImagePart = Extract<ContentPart, { _tag: "Image" }>

/** An attached image on a user turn — a read-only transcript thumbnail. */
const IMAGE_THUMB = "h-[80px] w-[132px]"

const toolMeta = (tool: ToolCallModel): string | undefined =>
  tool.meta ?? (tool.diff ? `+${tool.diff.added} −${tool.diff.removed}` : undefined)

/**
 * Tools whose `target` is a file path, and so get a file glyph and the
 * filename-preserving layout. Everything else targets a query or a command
 * (Bash, Grep, Glob), where the useful part is the START of the string and a
 * file icon would be a lie.
 */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "Update",
  "MultiEdit",
  "NotebookEdit"
])

const pathOf = (tool: ToolCallModel): string | null =>
  tool.target && PATH_TOOLS.has(tool.name) ? tool.target : null

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

/** Lines of a diff hunk shown before the "Show all" affordance kicks in. */
const HUNK_PREVIEW_LINES = 12

function ToolCardView({ tool }: { tool: ToolCallModel }) {
  const [expanded, setExpanded] = useState(false)
  const lines = tool.preview ? tool.preview.replace(/\n+$/, "").split("\n") : []
  const clipped = lines.length > HUNK_PREVIEW_LINES && !expanded
  const shown = clipped ? lines.slice(0, HUNK_PREVIEW_LINES).join("\n") : tool.preview
  // An edit's change is already spelled out by its diff peek, so its header stays
  // inert and the existing "Show all N lines" control owns that body. Everything
  // else — a command and what it printed — only fits once opened.
  const openable = !tool.preview && (tool.output !== undefined || (tool.target?.length ?? 0) > 0)
  const path = pathOf(tool)
  return (
    <ToolCall
      status={tool.status}
      name={tool.name}
      target={tool.target ?? undefined}
      filePath={path}
      meta={toolMeta(tool)}
      expanded={expanded}
      onToggle={openable ? () => setExpanded((v) => !v) : undefined}
      className={WIDTH}
    >
      {openable && expanded && (
        <div className="border-t border-line bg-editor">
          {/* The header truncates a long command to one line; this is where you
              read the whole thing. */}
          {tool.target && (
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-[1.5] text-text-bright">
              {tool.target}
            </pre>
          )}
          {tool.output === undefined ? (
            <div className="px-3 pb-2 font-mono text-[11px] text-dim">
              {tool.status === "running" ? "Running…" : "No output."}
            </div>
          ) : (
            <pre className="max-h-[320px] overflow-auto border-t border-line/60 px-3 py-2 font-mono text-[11px] leading-[1.5] text-muted-foreground">
              {tool.output}
            </pre>
          )}
        </div>
      )}
      {tool.preview && shown && (
        <div>
          <DiffPeek preview={shown} />
          {lines.length > HUNK_PREVIEW_LINES && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center gap-1 bg-editor px-3 py-1 text-[11px] text-line-strong transition-colors hover:text-muted-foreground active:scale-[0.99]"
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {expanded ? "Hide" : `Show all ${lines.length} lines`}
            </button>
          )}
        </div>
      )}
    </ToolCall>
  )
}

/**
 * A run of consecutive tool calls, collapsed to the latest one with a "+ N more"
 * toggle above it — so a storm of Reads/greps doesn't drown the conversation.
 */
function ToolGroup({ tools }: { tools: ReadonlyArray<ToolCallModel> }) {
  const [expanded, setExpanded] = useState(false)
  const hidden = tools.length - 1
  return (
    <div className={cn("flex flex-col gap-3", WIDTH)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 self-start rounded-md border border-line px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-surface hover:text-text active:scale-[0.98]"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {expanded
          ? `Hide ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`
          : `+ ${hidden} more tool ${hidden === 1 ? "call" : "calls"}`}
      </button>
      {expanded ? (
        tools.map((tool, i) => <ToolCardView key={i} tool={tool} />)
      ) : (
        <ToolCardView tool={tools[tools.length - 1]!} />
      )}
    </div>
  )
}

function PartView({
  part,
  markdown,
  onDecideGate,
  onApprovePlan,
  onResumePlan,
  onOpenPlanReview
}: {
  part: ContentPart
  markdown: boolean
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onApprovePlan?: (planId: string, executionMode?: ExecutionMode) => void
  onResumePlan?: (planId: string) => void
  onOpenPlanReview?: () => void
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
    case "Image":
      // Images are normally grouped into a row (see renderParts); this covers a
      // lone image part rendered directly.
      return <AttachmentThumb attachment={part.attachment} className={IMAGE_THUMB} />
    case "Thinking":
      return (
        <ThoughtBlock seconds={part.seconds} streaming={part.streaming} defaultOpen className={WIDTH}>
          {part.text}
        </ThoughtBlock>
      )
    case "Tool":
      return <ToolCardView tool={part.tool} />
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
    case "Question":
      // Pending questions dock in the composer (as the QuestionCard); once
      // answered, show a compact record of the picks here so the choice persists.
      return part.answers === null ? null : (
        <QuestionSummary request={part.request} answers={part.answers} className={WIDTH} />
      )
    case "Plan":
      return (
        <PlanCard
          plan={part.plan}
          onApprove={(executionMode) => onApprovePlan?.(part.plan.id, executionMode)}
          onResume={() => onResumePlan?.(part.plan.id)}
          onOpenReview={onOpenPlanReview}
        />
      )
  }
}

/**
 * Render a turn's parts, collapsing runs of ≥ `COLLAPSE_MIN` consecutive tool
 * calls (with no text between) into a single `ToolGroup`. Anything else renders
 * in program order.
 */
function renderParts(
  parts: ReadonlyArray<ContentPart>,
  markdown: boolean,
  handlers: {
    onDecideGate?: (gateId: string, decision: GateDecision) => void
    onApprovePlan?: (planId: string, executionMode?: ExecutionMode) => void
    onResumePlan?: (planId: string) => void
    onOpenPlanReview?: () => void
  }
): ReactNode[] {
  const out: ReactNode[] = []
  let run: ToolPart[] = []
  let runStart = 0
  const flush = () => {
    if (run.length === 0) return
    if (run.length >= COLLAPSE_MIN) {
      out.push(<ToolGroup key={`g${runStart}`} tools={run.map((p) => p.tool)} />)
    } else {
      run.forEach((p, k) => out.push(<ToolCardView key={`${runStart}-${k}`} tool={p.tool} />))
    }
    run = []
  }
  // Consecutive attached images render as a single wrapping thumbnail row.
  let imgs: ImagePart[] = []
  let imgStart = 0
  const flushImgs = () => {
    if (imgs.length === 0) return
    out.push(
      <div key={`i${imgStart}`} className={cn("flex flex-wrap gap-2", WIDTH)}>
        {imgs.map((p, k) => (
          <AttachmentThumb key={`${imgStart}-${k}`} attachment={p.attachment} className={IMAGE_THUMB} />
        ))}
      </div>
    )
    imgs = []
  }
  parts.forEach((part, i) => {
    if (part._tag === "Tool") {
      flushImgs()
      if (run.length === 0) runStart = i
      run.push(part)
      return
    }
    if (part._tag === "Image") {
      flush()
      if (imgs.length === 0) imgStart = i
      imgs.push(part)
      return
    }
    flush()
    flushImgs()
    out.push(<PartView key={i} part={part} markdown={markdown} {...handlers} />)
  })
  flush()
  flushImgs()
  return out
}

/** One transcript turn: a You / provider eyebrow followed by its ordered parts. */
export function MessageTurn({
  message,
  cli = "claude",
  onDecideGate,
  onApprovePlan,
  onResumePlan,
  onOpenPlanReview
}: {
  message: Message
  /** The harness that produced assistant turns — sets the eyebrow logo + name. */
  cli?: CliKind
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  /** Approve a proposed plan inline (from the transcript's plan card). */
  onApprovePlan?: (planId: string, executionMode?: ExecutionMode) => void
  /** Approve a stale plan inline (re-drives execution after a restart). */
  onResumePlan?: (planId: string) => void
  /** Open the full Plan Review view from the inline plan card. */
  onOpenPlanReview?: () => void
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
      {renderParts(message.parts, isAssistant, { onDecideGate, onApprovePlan, onResumePlan, onOpenPlanReview })}
      {/* Signal the agent is still working (before/while content streams in). */}
      {isAssistant && message.streaming && <Working />}
    </div>
  )
}
