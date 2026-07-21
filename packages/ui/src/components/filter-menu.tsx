import * as React from "react"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * A menu of AXES, each opening a flyout of mutually-exclusive values.
 *
 * The alternative — one segmented control per axis, stacked in the sidebar
 * header — is what this replaced. Two axes already cost two rows of permanent
 * chrome above the list they filter; four would have cost more vertical space
 * than the first three sessions. A menu spends one 24px button and shows every
 * axis's CURRENT value on its row, so the closed state still answers "what am I
 * looking at" without being opened.
 */

/** One selectable value within an axis. */
export interface FilterOption<T extends string> {
  readonly value: T
  readonly label: string
  /** Optional trailing count, e.g. how many sessions this value would show. */
  readonly count?: number
}

/** One axis: a row in the root menu, and the flyout it opens. */
export interface FilterAxis<T extends string = string> {
  readonly id: string
  readonly label: string
  readonly value: T
  readonly options: ReadonlyArray<FilterOption<T>>
  readonly onSelect: (value: T) => void
  /** Draw a hairline above this axis — used to separate filtering from arranging. */
  readonly separated?: boolean
}

const ROW =
  "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] outline-none " +
  "text-text-body data-[highlighted]:bg-surface data-[highlighted]:text-text-bright " +
  "data-[state=open]:bg-surface data-[state=open]:text-text-bright"

const CONTENT =
  "z-50 flex min-w-[190px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line " +
  "bg-sunken p-1.5 shadow-2xl"

/** One axis row + its flyout. Split out so the root stays a flat map. */
function Axis<T extends string>({ axis }: { axis: FilterAxis<T> }) {
  const current = axis.options.find((o) => o.value === axis.value)
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={ROW}>
        <span className="flex-1">{axis.label}</span>
        {/*
          The current value, on the closed row. This is the reason the menu can
          replace visible controls at all: shut, it still says "Status: Active,
          Group by: Repository", so nothing is hidden — only folded.
        */}
        <span className="text-muted-foreground">{current?.label ?? axis.value}</span>
        <ChevronRight size={12} className="flex-none text-dim" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className={CONTENT} sideOffset={4} collisionPadding={8}>
          {axis.options.map((option) => {
            const selected = option.value === axis.value
            return (
              <DropdownMenu.Item
                key={option.value}
                onSelect={() => axis.onSelect(option.value)}
                aria-current={selected}
                className={cn(ROW, selected && "text-text-bright")}
              >
                <span className="flex-1 truncate">{option.label}</span>
                {option.count !== undefined && (
                  <span className="font-mono text-[10.5px] tabular-nums text-dim">
                    {option.count}
                  </span>
                )}
                {/* The tick occupies its slot whether or not it is drawn, so the
                    labels of the other options don't shift left by 14px. */}
                <span className="flex w-3.5 flex-none justify-center">
                  {selected && <Check size={13} className="text-blue" />}
                </span>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

/**
 * The filter menu. `children` is the trigger.
 *
 * Radix owns positioning, focus, keyboard and dismissal; the flyouts have
 * collision padding because this opens from a sidebar that can itself be a 52px
 * rail against the window's left edge.
 */
export function FilterMenu({
  axes,
  children,
  align = "start"
}: {
  axes: ReadonlyArray<FilterAxis<never>> | ReadonlyArray<FilterAxis<string>>
  children: React.ReactNode
  align?: "start" | "end"
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={CONTENT} sideOffset={6} align={align} collisionPadding={8}>
          {(axes as ReadonlyArray<FilterAxis<string>>).map((axis, i) => (
            <React.Fragment key={axis.id}>
              {axis.separated && i > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
              <Axis axis={axis} />
            </React.Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
