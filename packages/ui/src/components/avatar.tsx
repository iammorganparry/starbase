import { cn } from "../lib/cn.js"

const toneBg: Record<string, string> = {
  blue: "bg-blue",
  orange: "bg-orange",
  dim: "bg-dim",
  green: "bg-green",
  purple: "bg-purple"
}

/** A monogram avatar — colored circle with dark initial (matches the design). */
export function Avatar({
  initial,
  tone = "blue",
  size = 26,
  className
}: {
  initial: string
  tone?: keyof typeof toneBg
  size?: number
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full font-bold text-editor",
        toneBg[tone],
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initial}
    </span>
  )
}
