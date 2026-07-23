import type { ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/cn.js"

/**
 * Tag / Chip — a small mono label with a tinted background. Tone-colored variants
 * match the design's accent chips; `count` is the neutral count pill.
 */
const badge = cva(
  "inline-flex items-center gap-1.5 font-mono whitespace-nowrap",
  {
    variants: {
      tone: {
        count: "bg-hover text-muted-foreground",
        neutral: "bg-hover text-text",
        blue: "bg-blue/12 text-blue",
        green: "bg-green/[0.13] text-green",
        yellow: "bg-yellow/12 text-yellow",
        red: "bg-red/10 text-red",
        purple: "bg-purple/[0.13] text-purple",
        cyan: "bg-cyan/12 text-cyan"
      },
      size: {
        xs: "text-[9px] rounded-sm px-1.5 py-0.5",
        sm: "text-[10px] rounded-md px-[7px] py-0.5"
      }
    },
    defaultVariants: { tone: "neutral", size: "sm" }
  }
)

export interface BadgeProps extends VariantProps<typeof badge> {
  children: ReactNode
  className?: string
  title?: string
}

export function Badge({ children, tone, size, className, title }: BadgeProps) {
  return (
    <span title={title} className={cn(badge({ tone, size }), className)}>
      {children}
    </span>
  )
}
