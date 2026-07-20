import { useState } from "react"
import type { ExecutionMode, Plan, PlanStatus } from "@starbase/core"
import { ClipboardList, GitBranch, MousePointerClick, Play, Send } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Pill } from "../components/pill.js"
import { ResizeHandle, useResizableWidth } from "../components/resizable.js"
import { PlanStepChanges } from "../composites/plan-step-changes.js"
import { PlanStepDetail } from "../composites/plan-step-detail.js"
import { PlanStepList } from "../composites/plan-step-list.js"
import { PlanApprovalActions } from "../composites/plan-approval-actions.js"
import { cn } from "../lib/cn.js"

const STATUS_PILL: Partial<Record<PlanStatus, { label: string; tone: "yellow" | "blue" | "green" }>> = {
  proposed: { label: "Awaiting approval", tone: "yellow" },
  revising: { label: "Agent revising", tone: "yellow" },
  approved: { label: "Approved", tone: "green" }
}

const branchCount = (plan: Plan): number => plan.steps.filter((s) => s.kind === "branch").length

/**
 * Screen 04/05 — the Plan Review workspace. Two columns: the step list
 * (navigator) and the interactive flow, which gives way to a step's full spec —
 * including its discussion + comment composer — when one is selected. Approve /
 * revise live in the header, and commenting happens in the step spec, so there's
 * a single place to discuss. Purely presentational — the desktop pane wires the
 * plan + callbacks from the live conversation machine.
 */
export function PlanReview({
  plan,
  patch = "",
  selectedStepId,
  compact = false,
  onSelectStep,
  onApprove,
  onResume,
  onRevise,
  onComment
}: {
  plan: Plan | null
  /** The session worktree's live unified diff, sliced per-step into the changes rail. */
  patch?: string
  /**
   * Open at a specific step (a deep link from the Conversation view's progress
   * rail). Takes precedence over the local pick, so the host MUST clear it on
   * `onSelectStep` or the user would be snapped back to it on every click.
   */
  selectedStepId?: string | null
  /** Narrow split-pane layout: one step at a time, navigated by the detail footer. */
  compact?: boolean
  /** A step was picked here — lets the host drop a spent deep link. */
  onSelectStep?: (stepId: string) => void
  onApprove?: (executionMode?: ExecutionMode) => void
  /** Approve a STALE plan (its original run is gone, e.g. after a restart) — re-drives execution. */
  onResume?: () => void
  onRevise?: () => void
  onComment?: (stepId: string, body: string) => void
}) {
  // Uncontrolled by default (Storybook, and the plain Plan tab); `selectedStepId`
  // layers a deep link on top without forcing every caller to own the selection.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const list = useResizableWidth({ storageKey: "sb.plan.list", initial: 280, min: 220, max: 420 })
  const changes = useResizableWidth({ storageKey: "sb.plan.changes", initial: 380, min: 280, max: 560 })

  if (!plan) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor text-center">
        <ClipboardList className="size-8 text-line-strong" />
        <div className="max-w-xs text-[13px] leading-[1.5] text-muted-foreground">
          No plan yet. In <span className="font-semibold text-text">Plan</span> mode, ask the agent for a
          change and it will map out an approach here for you to review.
        </div>
      </div>
    )
  }

  // Flows now live per-step. On entry (nothing explicitly selected) auto-open the
  // first step that carries a flow, so a diagram is visible immediately; if no
  // step has one, fall through to the pick-a-step prompt.
  const firstFlowStepId = plan.steps.find((s) => s.graph != null)?.id ?? null
  // ...except with a single step there's nothing TO pick — prompting to choose the
  // only row is a dead end. This is the unstructured fallback's exact shape (one
  // step wrapping the raw markdown), where not auto-opening hid the plan entirely.
  const soleStepId = plan.steps.length === 1 ? (plan.steps[0]?.id ?? null) : null
  // Precedence: an explicit deep link, then the local pick, then the auto-open.
  const effectiveId =
    selectedStepId ??
    selectedId ??
    firstFlowStepId ??
    soleStepId ??
    (compact ? (plan.steps[0]?.id ?? null) : null)
  const selected = plan.steps.find((s) => s.id === effectiveId) ?? null
  const select = (id: string) => {
    setSelectedId(id)
    onSelectStep?.(id)
  }
  const statusPill = STATUS_PILL[plan.status]
  const openComments = plan.comments.filter((c) => !c.routed && c.author === "user").length
  const branches = branchCount(plan)
  const readOnly = plan.status === "approved" || plan.status === "rejected" || plan.status === "stale"

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      {/* Header — summary + status on the left, the terminal actions on the right. */}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-panel px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{plan.summary}</span>
        {statusPill && (
          <Pill tone={statusPill.tone} pulse={plan.status !== "approved"}>
            {statusPill.label}
          </Pill>
        )}
        <span className="ml-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <GitBranch className="size-3" />
          {plan.steps.length} steps · {branches} {branches === 1 ? "branch" : "branches"}
        </span>

        <div
          className={cn(
            "ml-auto flex items-center gap-2",
            compact && "w-full flex-wrap justify-end border-t border-hairline pt-2"
          )}
        >
          {plan.status === "stale" ? (
            // The original planning run is gone (e.g. reopened app) — approving
            // re-drives execution on a fresh run rather than resuming a dead one.
            <>
              <span className="text-[11px] text-muted-foreground">reopened — approve to resume</span>
              <Button size="sm" onClick={onResume}>
                <Play className="size-3.5" />
                Approve &amp; implement
              </Button>
            </>
          ) : readOnly ? (
            <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Play className="size-3.5" />
              {plan.status === "approved" ? "Execution started" : "Plan rejected"}
            </span>
          ) : (
            <>
              {openComments > 0 && (
                <Badge tone="yellow" size="xs">
                  {openComments} open {openComments === 1 ? "comment" : "comments"}
                </Badge>
              )}
              <Button variant="secondary" size="sm" onClick={onRevise} disabled={openComments === 0}>
                <Send className="size-3.5" />
                Route to agent · revise
              </Button>
              <PlanApprovalActions onApprove={onApprove} />
            </>
          )}
        </div>
      </div>

      {/* Body — step list + flow ↔ step spec (the spec owns the discussion). */}
      {compact ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          {selected ? (
            <PlanStepDetail plan={plan} step={selected} onSelect={select} onComment={onComment} />
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-5 text-center text-[12px] text-muted-foreground">
              This plan has no steps to review.
            </div>
          )}
        </div>
      ) : (
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          style={{ width: list.width }}
          className="flex min-h-0 flex-none flex-col overflow-auto border-r border-hairline bg-panel"
        >
          <PlanStepList plan={plan} selectedId={effectiveId} onSelect={select} />
        </div>
        <ResizeHandle aria-label="Resize step list" onResize={list.adjust} />

        <div className="flex min-h-0 min-w-0 flex-1">
          {selected ? (
            <PlanStepDetail plan={plan} step={selected} onSelect={select} onComment={onComment} />
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor text-center">
              <MousePointerClick className="size-8 text-line-strong" />
              <div className="max-w-xs text-[13px] leading-[1.5] text-muted-foreground">
                Select a step to review its spec, proposed changes, and — where the logic branches —
                its own control flow.
              </div>
            </div>
          )}
        </div>

        {/* Right rail — the selected step's ACTUAL file changes (from the worktree diff). */}
        {selected && (
          <>
            <ResizeHandle aria-label="Resize changes" onResize={(dx) => changes.adjust(-dx)} />
            <div
              style={{ width: changes.width }}
              className="flex min-h-0 flex-none flex-col overflow-hidden border-l border-hairline"
            >
              <PlanStepChanges step={selected} patch={patch} />
            </div>
          </>
        )}
      </div>
      )}

      {readOnly && plan.status === "stale" && (
        <div className="flex-none border-t border-hairline p-3">
          <Callout tone="yellow">
            This plan is stale (the run ended). Ask the agent to plan again to continue.
          </Callout>
        </div>
      )}
    </div>
  )
}
