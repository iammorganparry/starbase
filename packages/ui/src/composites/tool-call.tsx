import type { ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { FileIcon } from "../components/file-icon.js"

export type ToolCallStatus = "success" | "running" | "error"

export interface ToolCallProps {
  status: ToolCallStatus
  /**
   * Tool name, e.g. "Read", "Grep", "Bash".
   *
   * Optional because a command row names itself: `❯ vitest run` already says
   * what it is, and a "Bash" label in front of it is a word of chrome between
   * the glyph and the only thing worth reading.
   */
  name?: string
  /** Primary target — file path or query. */
  target?: ReactNode
  /** Trailing meta, e.g. line count or "exit 1". */
  meta?: ReactNode
  /** Show a file-type glyph before the target (when `target` is a path). */
  filePath?: string | null
  /** Inline body under the header — e.g. a `DiffPeek` for an edit. */
  children?: ReactNode
  icon?: ReactNode
  /**
   * Replaces the leading ✓ / ✗ / pulsing dot.
   *
   * For rows whose status is better told by a mark of their own — a database
   * glyph, a green "listening" beacon — and which would otherwise render that
   * mark *beside* a redundant tick.
   */
  statusIcon?: ReactNode
  /**
   * Make the header a toggle. The host owns the open state (so it can keep
   * rendering the right body); given this, the whole header becomes a button.
   */
  expanded?: boolean
  onToggle?: () => void
  className?: string
}

/**
 * Split a path for display: the directory, and the file itself.
 *
 * These paths are absolute inside a session's worktree, so the first ~60
 * characters are the same on every card and the only part anyone reads — the
 * filename — sits at the END. A plain `truncate` ellipsises the tail, which
 * throws away precisely that and leaves a row of identical prefixes.
 */
const splitPath = (path: string): { dir: string; base: string } => {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/")
  return cut <= 0
    ? { dir: "", base: path }
    : { dir: path.slice(0, cut), base: path.slice(cut + 1) }
}

/** The target as a path: a directory that gives way, and a filename that never does. */
function PathTarget({ path }: { path: string }) {
  const { dir, base } = splitPath(path)
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      {dir && <span className="truncate text-dim">{dir}/</span>}
      {/* `flex-none` so the directory is what shrinks; the filename is the point
          of the card. It still truncates if it alone can't fit — better a cut
          filename than one pushed out of the row entirely. */}
      <span className="max-w-full flex-none truncate text-text-bright">{base}</span>
    </span>
  )
}

/** A single agent tool invocation (success / running / error), with optional peek. */
export function ToolCall({
  status,
  name,
  target,
  meta,
  filePath,
  children,
  icon,
  statusIcon,
  expanded = false,
  onToggle,
  className
}: ToolCallProps) {
  const header = (
    <>
      {statusIcon ?? (
        <>
          {status === "success" && <span className="text-green">✓</span>}
          {status === "error" && <span className="text-red">✗</span>}
          {status === "running" && <StatusDot tone="bg-yellow" size={8} pulse />}
        </>
      )}
      {name && <span className="text-muted-foreground">{name}</span>}
      {icon}
      {filePath && <FileIcon path={filePath} />}
      {filePath ? (
        <PathTarget path={filePath} />
      ) : (
        <span className="flex-1 truncate text-left text-text-bright">{target}</span>
      )}
      {meta && (
        <span className={cn("shrink-0", status === "error" ? "text-red" : "text-dim")}>{meta}</span>
      )}
      {onToggle &&
        (expanded ? (
          <ChevronDown className="size-3 shrink-0 text-line-strong" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-line-strong" />
        ))}
    </>
  )
  const headerClass = cn(
    "flex w-full items-center gap-[9px] px-2.5 py-1.5 font-mono text-[11.5px]",
    status === "running" && "bg-yellow/[0.08]",
    status === "success" && "bg-surface",
    onToggle && "cursor-pointer text-left transition-colors hover:bg-line/20"
  )
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        status === "running" && "border-yellow/30",
        status === "error" && "border-red/35 bg-red/[0.05]",
        status === "success" && "border-line",
        className
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={cn(headerClass, "outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        >
          {header}
        </button>
      ) : (
        <div className={headerClass}>{header}</div>
      )}
      {/* While running with no peek yet, a shimmer bar signals live work. */}
      {status === "running" && children == null && (
        <div className="h-[22px] animate-shine bg-[length:220px_100%] bg-gradient-to-r from-white/[0.02] via-white/[0.07] to-white/[0.02]" />
      )}
      {children}
    </div>
  )
}
