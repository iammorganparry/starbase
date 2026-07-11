import { cn } from "../lib/cn.js"
import { FileIcon } from "../components/file-icon.js"

/**
 * The `@` code-reference palette — lists the session's worktree files so the
 * operator can reference code in a prompt. Presentational + controlled (the
 * composer owns the query/active index and filtering).
 */
export function MentionMenu({
  files,
  activeIndex,
  onSelect,
  onHover,
  className
}: {
  files: ReadonlyArray<string>
  activeIndex: number
  onSelect: (path: string) => void
  onHover?: (index: number) => void
  className?: string
}) {
  if (files.length === 0) return null
  return (
    <div
      role="listbox"
      className={cn(
        "flex max-h-[260px] flex-col gap-0.5 overflow-auto rounded-lg border border-line bg-sunken p-1.5 shadow-2xl",
        className
      )}
    >
      {files.map((path, i) => {
        const name = path.split("/").pop() ?? path
        const dir = path.slice(0, path.length - name.length)
        return (
          <button
            key={path}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(path)
            }}
            onMouseEnter={() => onHover?.(i)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-[7px] text-left",
              i === activeIndex && "bg-surface"
            )}
          >
            <FileIcon path={path} />
            <span className="font-mono text-[12px] text-text-bright">{name}</span>
            {dir && <span className="truncate font-mono text-[10.5px] text-dim">{dir}</span>}
          </button>
        )
      })}
    </div>
  )
}
