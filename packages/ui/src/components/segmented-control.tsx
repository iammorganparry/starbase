import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface SegmentItem<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

/** A compact segmented toggle (One Dark). Controlled by `value`/`onChange`. */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  className
}: {
  items: ReadonlyArray<SegmentItem<T>>
  value: T
  onChange?: (value: T) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex gap-0.5 rounded-lg border border-line bg-sunken p-0.5", className)}
    >
      {items.map((item) => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => !item.disabled && onChange?.(item.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-[11px] py-1 text-[11.5px] transition-colors",
              active
                ? "bg-surface font-semibold text-text-bright"
                : item.disabled
                  ? "cursor-not-allowed text-line-strong"
                  : "text-muted-foreground hover:text-text"
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
