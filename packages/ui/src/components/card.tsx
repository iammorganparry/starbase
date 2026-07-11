import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/** A bordered panel (rounded-lg = 5px). The base surface for library cards & rows. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-panel", className)}>
      {children}
    </div>
  )
}

/** Card header row with a title and optional trailing content. */
export function CardHeader({
  title,
  trailing,
  className
}: {
  title: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-hairline px-[13px] py-2.5",
        className
      )}
    >
      <span className="flex-1 text-[12.5px] font-semibold text-text-bright">{title}</span>
      {trailing}
    </div>
  )
}
