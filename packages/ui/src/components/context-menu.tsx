import type { ReactNode } from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { ChevronRight, type LucideIcon } from "lucide-react"
import { cn } from "../lib/cn.js"

export interface ContextMenuItem {
  /** The accessible label, and the React key when no `id` is given. */
  label: string
  /**
   * Stable identity, for rows whose LABEL can repeat.
   *
   * Static menus (Rename / Archive / Delete) can key on the label safely — those
   * strings are written here and are unique by construction. Rows built from
   * DATA cannot: "Split with ▸" is one row per session, labelled with the
   * session's title, and titles are auto-generated and operator-editable, so two
   * sessions called "Fix build" is an ordinary Tuesday. Keying those on the label
   * hands React two children with the same key.
   *
   * What that costs today is a console error on every open, which is the whole
   * of the *observed* damage — both rows do render and each still runs its own
   * `onSelect` (`context-menu.test.tsx` pins both). The reason to fix it anyway
   * is that React documents sibling keys as required-unique and its behaviour
   * with duplicates as undefined, so "it happens to work" is a property of this
   * version rather than a guarantee — and a menu that errors every time it opens
   * trains you to ignore the console.
   *
   * Named `id` rather than `key` deliberately: `key` on a plain object looks
   * like React's reserved prop, and would be silently swallowed by React the
   * first time somebody spread an item onto a component.
   */
  id?: string
  icon?: LucideIcon
  /** Ignored when `submenu` is present — a parent row opens rather than acts. */
  onSelect: () => void
  /** `danger` tints the row red (destructive actions like delete). */
  tone?: "default" | "danger"
  /** Render a hairline separator above this item. */
  separated?: boolean
  /**
   * Nested items, rendered as a flyout (Arc's "Split with ▸"). Present but
   * EMPTY renders a disabled row rather than a menu that opens onto nothing —
   * "Split with" with no other sessions is information, not a dead end.
   */
  submenu?: ReadonlyArray<ContextMenuItem>
}

/** Identity for React, preferring the explicit one. See `ContextMenuItem.id`. */
const keyOf = (item: ContextMenuItem): string => item.id ?? item.label

/** Shared by the flyout and the root content, so nesting can't drift in style. */
const CONTENT_CLASS =
  "z-50 flex min-w-[168px] flex-col gap-0.5 overflow-hidden rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"

const ITEM_CLASS = (danger: boolean) =>
  cn(
    "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] outline-none",
    danger
      ? "text-red data-[highlighted]:bg-red/10 data-[highlighted]:text-red"
      : "text-text-body data-[highlighted]:bg-surface data-[highlighted]:text-text-bright",
    "data-[disabled]:cursor-default data-[disabled]:text-dim data-[disabled]:data-[highlighted]:bg-transparent"
  )

/** One row: a plain item, a disabled item, or a parent that opens a flyout. */
function Row({ item }: { item: ContextMenuItem }) {
  const Icon = item.icon
  const danger = item.tone === "danger"
  const label = (
    <>
      {Icon && <Icon size={13} className="flex-none" />}
      <span className="flex-1">{item.label}</span>
    </>
  )
  if (item.submenu) {
    if (item.submenu.length === 0) {
      return (
        <ContextMenuPrimitive.Item disabled className={ITEM_CLASS(false)}>
          {label}
        </ContextMenuPrimitive.Item>
      )
    }
    return (
      <ContextMenuPrimitive.Sub>
        <ContextMenuPrimitive.SubTrigger className={ITEM_CLASS(danger)}>
          {label}
          <ChevronRight size={12} className="flex-none text-dim" />
        </ContextMenuPrimitive.SubTrigger>
        <ContextMenuPrimitive.Portal>
          <ContextMenuPrimitive.SubContent className={CONTENT_CLASS} sideOffset={2}>
            {item.submenu.map((child) => (
              <Row key={keyOf(child)} item={child} />
            ))}
          </ContextMenuPrimitive.SubContent>
        </ContextMenuPrimitive.Portal>
      </ContextMenuPrimitive.Sub>
    )
  }
  return (
    <ContextMenuPrimitive.Item onSelect={item.onSelect} className={ITEM_CLASS(danger)}>
      {label}
    </ContextMenuPrimitive.Item>
  )
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
        <ContextMenuPrimitive.Content className={CONTENT_CLASS}>
          {items.map((item, i) => (
            <div key={keyOf(item)}>
              {item.separated && i > 0 && (
                <ContextMenuPrimitive.Separator className="my-1 h-px bg-line" />
              )}
              <Row item={item} />
            </div>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}
