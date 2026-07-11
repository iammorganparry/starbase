import * as React from "react"
import { cn } from "../lib/cn.js"

/** shadcn Input restyled to the One Dark form field (sunken bg, blue focus). */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-8 w-full rounded-md border border-line bg-sunken px-2.5 py-[7px] text-[12.5px] text-text outline-none transition-colors placeholder:text-dim focus:border-blue/50 focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
))
Input.displayName = "Input"
