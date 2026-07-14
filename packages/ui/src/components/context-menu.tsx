import type { ReactNode } from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import type { LucideIcon } from "lucide-react"
import { cn } from "../lib/cn.js"

export interface ContextMenuItem {
  /** Stable key + accessible label. */
  label: string
  icon?: LucideIcon
  onSelect: () => void
  /** `danger` tints the row red (destructive actions like delete). */
  tone?: "default" | "danger"
  /** Render a hairline separator above this item. */
  separated?: boolean
}

/**
 * A right-click context menu, styled to match the One Dark dropdowns (see
 * `chip-menu.tsx`). Radix owns positioning, focus, keyboard, and dismissal;
 * `children` is the element the menu opens on (right-click / long-press).
 */
export function ContextMenu({
  items,
  children
}: {
  items: ReadonlyArray<ContextMenuItem>
  children: ReactNode
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className="z-50 flex min-w-[168px] flex-col gap-0.5 overflow-hidden rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {items.map((item, i) => {
            const Icon = item.icon
            const danger = item.tone === "danger"
            return (
              <div key={item.label}>
                {item.separated && i > 0 && (
                  <ContextMenuPrimitive.Separator className="my-1 h-px bg-line" />
                )}
                <ContextMenuPrimitive.Item
                  onSelect={item.onSelect}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] outline-none",
                    danger
                      ? "text-red data-[highlighted]:bg-red/10 data-[highlighted]:text-red"
                      : "text-text-body data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                  )}
                >
                  {Icon && <Icon size={13} className="flex-none" />}
                  <span className="flex-1">{item.label}</span>
                </ContextMenuPrimitive.Item>
              </div>
            )
          })}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}
