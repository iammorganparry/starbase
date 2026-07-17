import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, Search } from "lucide-react"
import { cn } from "../lib/cn.js"

export interface ChipOption<T extends string> {
  value: T
  label: ReactNode
  /**
   * What `searchable` matches this option on. Only needed when `label` isn't a
   * plain string — a rendered label can't be read as text, so an option with a
   * non-string label is invisible to search without this.
   */
  searchText?: string
}

/** A titled run of options — one section of the menu (e.g. a harness). */
export interface ChipGroup<T extends string> {
  label: string
  options: ReadonlyArray<ChipOption<T>>
}

/** The text `searchable` matches an option on. */
const textOf = <T extends string>(o: ChipOption<T>): string =>
  o.searchText ?? (typeof o.label === "string" ? o.label : "")

/**
 * A compact chip that opens a dropdown to pick one value — used for the
 * composer's mode and model chips. Built on Radix DropdownMenu (accessible,
 * handles outside-click / Esc / keyboard). Styled to match the composer.
 *
 * Pass `options` for a flat list, or `groups` for sectioned ones (the model chip
 * groups models under their harness, so picking a model also picks a provider).
 */
export function ChipMenu<T extends string>({
  value,
  options,
  groups,
  onSelect,
  icon,
  searchable = false,
  searchPlaceholder = "Search…",
  emptyLabel = "No matches",
  disabled = false,
  className
}: {
  /** The currently-selected value (a check marks it in the list). */
  value: T
  options?: ReadonlyArray<ChipOption<T>>
  /** Sectioned alternative to `options`; takes precedence when both are given. */
  groups?: ReadonlyArray<ChipGroup<T>>
  onSelect?: (value: T) => void
  /** Leading glyph inside the chip. */
  icon?: ReactNode
  /**
   * Put a filter box at the top of the menu, matching an option's text and its
   * section heading — so "codex" finds a harness's models and "opus" finds one
   * model. Worth it for a long, growing list (models); noise on a short fixed
   * one (modes).
   */
  searchable?: boolean
  searchPlaceholder?: string
  /** Shown when the filter matches nothing. */
  emptyLabel?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // Put the caret in the filter box on open, so the menu is type-to-filter the
  // moment it appears. It has to happen AFTER Radix's own focus: a menu focuses
  // its content on open (and there's no `onOpenAutoFocus` on Menu content to
  // pre-empt, unlike a popover), so claiming focus on the next frame wins.
  useEffect(() => {
    if (!open || !searchable) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, searchable])

  // Memoised on the inputs themselves: rebuilding this array every render gives
  // `visible` a new dependency each time, so its own memo never hits and the
  // whole list is re-filtered on every keystroke.
  const sections: ReadonlyArray<ChipGroup<T>> = useMemo(
    () => groups ?? [{ label: "", options: options ?? [] }],
    [groups, options]
  )
  // A lone section needs no header — with one harness installed, labelling it
  // would just be noise above a plain model list. Decided on the FULL list, not
  // the filtered one, so headings don't pop in and out as you type (and so a
  // filtered-down list still says which harness its models belong to).
  const showHeaders = sections.length > 1

  // Match on the option's text OR its section heading: you don't always want a
  // named model — sometimes you want "whatever Codex has".
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!searchable || q === "") return sections
    return sections
      .map((s) => ({
        ...s,
        options: s.options.filter(
          (o) => textOf(o).toLowerCase().includes(q) || s.label.toLowerCase().includes(q)
        )
      }))
      .filter((s) => s.options.length > 0)
  }, [sections, query, searchable])

  const matches = visible.flatMap((s) => s.options)
  const current = sections.flatMap((s) => s.options).find((o) => o.value === value)

  const pick = (v: T) => {
    onSelect?.(v)
    setOpen(false)
  }

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
    <DropdownMenu.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // A stale filter would greet you on reopen with most of the list missing.
        if (!o) setQuery("")
      }}
    >
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
          className={cn(
            "z-50 flex max-h-[300px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl",
            searchable ? "min-w-[210px]" : "min-w-[160px]",
            // When searching, the filter box stays put and only the list scrolls.
            !searchable && "overflow-auto"
          )}
        >
          {searchable && (
            <div className="flex flex-none items-center gap-1.5 border-b border-line px-1.5 pb-1.5">
              <Search size={11} className="flex-none text-dim" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="w-full bg-transparent font-mono text-[12px] text-text-bright outline-none placeholder:text-dim"
                onKeyDown={(e) => {
                  // Radix implements typeahead on the menu: letter keys jump to
                  // matching items. That would eat every keystroke aimed at this
                  // box, so ordinary typing stays local. The keys that mean
                  // "navigate the menu" still belong to Radix — Up/Down move into
                  // the list, Escape closes, Tab leaves.
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") return
                  if (e.key === "Escape" || e.key === "Tab") return
                  if (e.key === "Enter") {
                    // Enter takes the top match, so filtering to one model is
                    // type-then-Enter rather than type-arrow-Enter.
                    e.preventDefault()
                    const first = matches[0]
                    if (first) pick(first.value)
                    return
                  }
                  e.stopPropagation()
                }}
              />
            </div>
          )}
          <div className={cn("flex flex-col gap-0.5", searchable && "min-h-0 flex-1 overflow-auto")}>
            {matches.length === 0 ? (
              <div className="px-2.5 py-[7px] font-mono text-[12px] text-dim">{emptyLabel}</div>
            ) : (
              visible.map((section, i) => (
                <DropdownMenu.Group key={section.label || i}>
                  {showHeaders && (
                    <DropdownMenu.Label
                      className={cn(
                        "px-2.5 pb-1 font-mono text-[10px] uppercase tracking-wider text-dim",
                        i > 0 && "mt-1.5 border-t border-line pt-2"
                      )}
                    >
                      {section.label}
                    </DropdownMenu.Label>
                  )}
                  {section.options.map((o) => (
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
                </DropdownMenu.Group>
              ))
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
