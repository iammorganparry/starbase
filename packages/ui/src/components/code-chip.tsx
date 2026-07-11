import { X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { FileIcon } from "./file-icon.js"

/**
 * A rendered `@file` code reference — the chip form of a mention inserted from
 * the composer's `@` menu. Optional `onRemove` shows a dismiss affordance.
 */
export function CodeChip({
  path,
  line,
  onRemove,
  className
}: {
  path: string
  line?: number
  onRemove?: () => void
  className?: string
}) {
  const name = path.split("/").pop() ?? path
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-bright",
        className
      )}
    >
      <FileIcon path={path} size={12} />
      {name}
      {line !== undefined && <span className="text-dim">:{line}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="text-dim hover:text-text"
        >
          <X size={11} />
        </button>
      )}
    </span>
  )
}
