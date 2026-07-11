import { cn } from "../lib/cn.js"

/** A small One Dark spinner. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border-2 border-dim border-t-transparent [animation:var(--animate-spin-fast)]",
        className
      )}
      style={{ width: size, height: size }}
    />
  )
}

/** A shimmering skeleton placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block h-5 rounded-md [background-size:220px_100%] [animation:var(--animate-shine)]",
        "bg-[linear-gradient(90deg,rgba(255,255,255,.02),rgba(255,255,255,.07),rgba(255,255,255,.02))]",
        className
      )}
    />
  )
}
