import * as React from "react"
import type { BackgroundTask } from "@starbase/core"
import { ChevronRight, FileText, Loader2, Octagon, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"

/** Compact duration: "8s", "2m 04s", "1h 12m". */
const duration = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const TONE: Record<BackgroundTask["status"], { label: string; tone: "blue" | "purple" | "red" | "neutral" }> = {
  running: { label: "Running", tone: "blue" },
  stopping: { label: "Stopping", tone: "neutral" },
  completed: { label: "Done", tone: "purple" },
  stopped: { label: "Stopped", tone: "neutral" },
  failed: { label: "Failed", tone: "red" }
}

const isLive = (t: BackgroundTask): boolean => t.status === "running" || t.status === "stopping"

/**
 * One background task's row: what it is, what it's doing right now, and the two
 * actions the operator has over it.
 */
function TaskRow({
  task,
  onStop,
  onView,
  onDismiss
}: {
  task: BackgroundTask
  onStop?: (taskId: string) => void
  onView?: (taskId: string) => void
  onDismiss?: (taskId: string) => void
}) {
  const tone = TONE[task.status]
  const live = isLive(task)
  return (
    <div
      data-testid={`bg-task-${task.id}`}
      data-status={task.status}
      className="flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 hover:bg-surface/40"
    >
      {live ? (
        <Loader2 size={13} className="flex-none animate-spin text-blue" />
      ) : (
        <span className={cn("size-[7px] flex-none rounded-full", task.status === "failed" ? "bg-red" : "bg-purple")} />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[13px] text-text">{task.description}</span>
        <div className="flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground">
          <Badge tone={tone.tone} size="sm">
            {tone.label}
          </Badge>
          {task.subagentType && <span className="truncate">{task.subagentType}</span>}
          {/*
            While a task runs there is no output stream — only these progress
            fields — so they ARE the live view. Once it settles the harness hands
            us a transcript instead, and the summary replaces them.
          */}
          {live ? (
            <>
              <span>{duration(task.durationMs)}</span>
              {task.toolUses > 0 && <span>{task.toolUses} tools</span>}
              {task.tokens > 0 && <span>{tokens(task.tokens)} tokens</span>}
              {task.lastTool && <span className="truncate text-text/70">{task.lastTool}</span>}
            </>
          ) : (
            <span className="truncate">{task.summary ?? duration(task.durationMs)}</span>
          )}
        </div>
      </div>

      {/* View only once settled: before that `outputFile` does not exist yet. */}
      {!live && task.outputFile && onView && (
        <Button
          variant="ghost"
          size="sm"
          className="flex-none gap-1.5"
          onClick={() => onView(task.id)}
          aria-label={`View output of ${task.description}`}
        >
          <FileText size={12} />
          View
        </Button>
      )}
      {live && onStop && (
        <Button
          variant="ghost"
          size="sm"
          className="flex-none gap-1.5"
          // Disabled while stopping — the request is already in flight and the
          // harness confirms asynchronously. The label is what tells the operator
          // their click landed; without the `stopping` state this row would look
          // untouched and invite a second click.
          disabled={task.status === "stopping"}
          onClick={() => onStop(task.id)}
          aria-label={`Stop ${task.description}`}
        >
          <Octagon size={12} />
          {task.status === "stopping" ? "Stopping…" : "Stop"}
        </Button>
      )}
      {/*
        Only failures get a dismiss control. Every other settled task ages out of
        the registry on its own after a short grace period, so a button to remove
        it would race that and mean nothing. A FAILED task is held indefinitely —
        an error nobody saw is the one outcome worth insisting on — so this is the
        only way to acknowledge it and clear the row.
      */}
      {task.status === "failed" && onDismiss && (
        <Button
          variant="ghost"
          size="sm"
          className="flex-none"
          onClick={() => onDismiss(task.id)}
          aria-label={`Dismiss ${task.description}`}
        >
          <X size={12} />
        </Button>
      )}
    </div>
  )
}

/**
 * The background-task dock: harness work that OUTLIVES the turn that started it.
 *
 * It exists because that work was previously invisible — an agent could
 * background a shell command or a sub-agent and it would run to completion with
 * nothing in the UI to say it existed, let alone stop it. It sits alongside the
 * terminal dock rather than in the sub-agent tab bar for a structural reason:
 * the tab bar is per-run and cleared when the next turn starts, which would
 * delete the row while the work carried on.
 *
 * Renders nothing at all when the session's harness has no background-task
 * support (codex, opencode) or when there is nothing to show — an empty dock is
 * chrome that costs attention and reports nothing.
 */
export function BackgroundTaskDock({
  tasks,
  supported = true,
  onStop,
  onView,
  onDismiss,
  className
}: {
  tasks: ReadonlyArray<BackgroundTask>
  /** False for a harness with no per-task background support — hides the dock. */
  supported?: boolean
  onStop?: (taskId: string) => void
  onView?: (taskId: string) => void
  /** Clear a failed task's row (other settled rows age out on their own). */
  onDismiss?: (taskId: string) => void
  className?: string
}) {
  // Collapsed on every mount, deliberately — and deliberately NOT persisted, so
  // it is collapsed on every mount rather than merely the first. An expanded dock
  // eats the bottom of the transcript and crowds the composer, and the header
  // badges below already report both the live count and the total, which is the
  // whole of what a glance needs. Expanding is the operator's move, not ours.
  const [open, setOpen] = React.useState(false)
  const live = tasks.filter(isLive)
  // Running first (that's what you act on), then most recently finished.
  const ordered = React.useMemo(
    () =>
      [...tasks].sort((a, b) => {
        if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1
        return (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt)
      }),
    [tasks]
  )

  if (!supported || tasks.length === 0) return null

  return (
    <div
      data-testid="background-task-dock"
      className={cn("flex flex-none flex-col border-t border-hairline bg-panel", className)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Collapse background tasks" : "Expand background tasks"}
        className="flex items-center gap-2 px-3 py-2 text-left hover:bg-surface/40"
      >
        <ChevronRight size={13} className={cn("flex-none transition-transform", open && "rotate-90")} />
        <span className="flex-1 text-[11.5px] font-semibold text-text">Background tasks</span>
        {live.length > 0 && (
          <Badge tone="blue" size="xs">
            {live.length} running
          </Badge>
        )}
        <Badge tone="count" size="xs">
          {tasks.length}
        </Badge>
      </button>
      {open && (
        <div className="flex max-h-[220px] flex-col gap-[2px] overflow-y-auto px-1.5 pb-1.5">
          {ordered.map((task) => (
            <TaskRow key={task.id} task={task} onStop={onStop} onView={onView} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A settled task's transcript, shown over the dock. */
export function BackgroundTaskOutput({
  task,
  output,
  onClose
}: {
  task: BackgroundTask
  output: string
  onClose?: () => void
}) {
  return (
    <div data-testid="bg-task-output" className="flex min-h-0 flex-col border-t border-hairline bg-editor">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <FileText size={13} className="flex-none text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-text">{task.description}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task output"
            className="flex-none rounded p-1 text-muted-foreground hover:bg-surface hover:text-text"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-muted-foreground">
        {output.length > 0 ? output : "No output recorded for this task."}
      </pre>
    </div>
  )
}
