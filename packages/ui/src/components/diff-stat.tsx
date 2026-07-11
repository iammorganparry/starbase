import { cn } from "../lib/cn.js"

/** Added / removed line counts (+313 −23). Omits a side when its count is 0. */
export function DiffStat({
  added,
  removed,
  className
}: {
  added: number
  removed?: number
  className?: string
}) {
  return (
    <span className={cn("inline-flex gap-1.5 font-mono text-[10px]", className)}>
      {added > 0 && <span className="text-green">+{added}</span>}
      {removed !== undefined && removed > 0 && <span className="text-red">−{removed}</span>}
    </span>
  )
}
