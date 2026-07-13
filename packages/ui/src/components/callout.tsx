import type { ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/cn.js"

const callout = cva("flex items-center gap-[9px] rounded-xl border px-[11px] py-[9px] text-[11.5px]", {
  variants: {
    tone: {
      yellow: "border-yellow/30 bg-yellow/[0.06]",
      green: "border-green/30 bg-green/[0.05]",
      blue: "border-blue/30 bg-blue/[0.06]",
      red: "border-red/30 bg-red/[0.06]",
      purple: "border-purple/30 bg-purple/[0.06]"
    }
  },
  defaultVariants: { tone: "yellow" }
})

const iconColor: Record<string, string> = {
  yellow: "text-yellow",
  green: "text-green",
  blue: "text-blue",
  red: "text-red",
  purple: "text-purple"
}

const defaultGlyph: Record<string, string> = {
  yellow: "!",
  green: "✓",
  blue: "✦",
  red: "✗",
  purple: "✓"
}

export interface CalloutProps extends VariantProps<typeof callout> {
  children: ReactNode
  glyph?: ReactNode
  className?: string
}

/** An inline notice with a leading glyph (One Dark, rounded-xl = 7px). */
export function Callout({ children, tone = "yellow", glyph, className }: CalloutProps) {
  return (
    <div className={cn(callout({ tone }), className)}>
      <span className={cn("flex-none", iconColor[tone ?? "yellow"])}>
        {glyph ?? defaultGlyph[tone ?? "yellow"]}
      </span>
      <span className="text-text">{children}</span>
    </div>
  )
}
