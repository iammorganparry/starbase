import type { ReactNode } from "react"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "../lib/cn.js"

export interface ChipOption<T extends string> {
  value: T
  label: ReactNode
}

/**
 * A compact chip that opens a dropdown to pick one value — used for the
 * composer's mode and model chips. Built on Radix DropdownMenu (accessible,
 * handles outside-click / Esc / keyboard). Styled to match the composer.
 */
export function ChipMenu<T extends string>({
  value,
  options,
  onSelect,
  icon,
  disabled = false,
  className
}: {
  /** The currently-selected value (a check marks it in the list). */
  value: T
  options: ReadonlyArray<ChipOption<T>>
  onSelect?: (value: T) => void
  /** Leading glyph inside the chip. */
  icon?: ReactNode
  disabled?: boolean
  className?: string
}) {
  const current = options.find((o) => o.value === value)
  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-[3px] font-mono text-[11px] text-text-bright",
        !disabled && "cursor-pointer hover:border-line-strong",
        className
      )}
    >
      {icon}
      {current?.label ?? value}
      {!disabled && <ChevronDown size={11} className="text-dim" />}
    </span>
  )

  if (disabled) return chip

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-md">
          {chip}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 flex max-h-[300px] min-w-[160px] flex-col gap-0.5 overflow-auto rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {options.map((o) => (
            <DropdownMenu.Item
              key={o.value}
              onSelect={() => onSelect?.(o.value)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] font-mono text-[12px] outline-none",
                "text-text-body data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
              )}
            >
              <span className="flex-1">{o.label}</span>
              {o.value === value && <Check size={13} className="text-blue" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
