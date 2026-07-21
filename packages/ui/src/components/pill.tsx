import type { ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/cn.js"
import { StatusDot } from "./status-dot.js"

/** Pill — a status lozenge with an optional leading dot (rounded-lg = 5px). */
const pill = cva("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-[3px] text-[11px]", {
  variants: {
    tone: {
      yellow: "bg-yellow/12 text-yellow",
      green: "bg-green/12 text-green",
      blue: "bg-blue/10 text-blue",
      red: "bg-red/[0.08] text-red"
    }
  },
  defaultVariants: { tone: "blue" }
})

const dotTone: Record<string, string> = {
  yellow: "bg-yellow",
  green: "bg-green",
  blue: "bg-blue",
  red: "bg-red"
}

export interface PillProps extends VariantProps<typeof pill> {
  children: ReactNode
  dot?: boolean
  pulse?: boolean
  className?: string
  /** Hover text — where a detail too long for the pill itself goes. */
  title?: string
}

export function Pill({ children, tone = "blue", dot = true, pulse, className, title }: PillProps) {
  return (
    <span className={cn(pill({ tone }), className)} title={title}>
      {dot && <StatusDot tone={dotTone[tone ?? "blue"]} size={6} pulse={pulse} glow={false} />}
      {children}
    </span>
  )
}
