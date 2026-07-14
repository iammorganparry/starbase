import { cn } from "../lib/cn.js"

/** A labelled hairline divider ("or with email") between OAuth and the form. */
export function AuthDivider({ label = "or with email", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex w-full items-center gap-2.5 text-dim", className)}>
      <div className="h-px flex-1 bg-hairline" />
      <span className="text-[10px] uppercase tracking-[0.08em]">{label}</span>
      <div className="h-px flex-1 bg-hairline" />
    </div>
  )
}
