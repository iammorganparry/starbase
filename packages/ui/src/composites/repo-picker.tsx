import * as React from "react"
import type { Repo } from "@starbase/core"
import { ChevronDown, Star } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { ChipMenu, type ChipGroup } from "../components/chip-menu.js"

/**
 * The repo field in the New Session dialog: a full-width control that opens a
 * SEARCHABLE, sectioned list.
 *
 * Built on `ChipMenu` rather than the Radix `Select` this replaces. A Select
 * implements its own typeahead — letter keys jump to matching items — which eats
 * every keystroke aimed at a filter box mounted inside it. `ChipMenu` already
 * solved that for the composer's model list (it stops propagation on ordinary
 * keys and hands Up/Down/Escape/Enter back to Radix), and duplicating that fix
 * for a second menu is how two subtly different menus end up in one app. This
 * component is the field's trigger and the star toggle; the list behaviour is
 * inherited.
 */
export function RepoPicker({
  repos,
  value,
  onChange,
  starredRepos = [],
  onToggleStar,
  disabled = false
}: {
  repos: ReadonlyArray<Repo>
  /** Absolute path of the selected repo, or "" when none is chosen. */
  value: string
  onChange: (repoPath: string) => void
  /** Absolute paths of starred repos — surfaced in their own section, first. */
  starredRepos?: ReadonlyArray<string>
  /** Toggle a repo's starred state. Presence wires the per-row star button. */
  onToggleStar?: (repoPath: string) => void | Promise<void>
  disabled?: boolean
}) {
  const starredSet = React.useMemo(() => new Set(starredRepos), [starredRepos])

  // Partitioned into two sections, preserving the caller's order within each.
  // Memoised on the inputs so `ChipMenu`'s own filter memo can actually hit.
  const groups: ReadonlyArray<ChipGroup<string>> = React.useMemo(() => {
    const toOption = (r: Repo) => ({
      value: r.path,
      label: r.name,
      // Match on the PATH as well as the name: two checkouts of the same repo
      // differ only by directory, and "starbase" alone can't tell them apart.
      searchText: `${r.name} ${r.path}`
    })
    const starred = repos.filter((r) => starredSet.has(r.path))
    const rest = repos.filter((r) => !starredSet.has(r.path))
    if (starred.length === 0) return [{ label: "All repos", options: rest.map(toOption) }]
    return [
      { label: "Starred", options: starred.map(toOption) },
      { label: "All repos", options: rest.map(toOption) }
    ]
  }, [repos, starredSet])

  const selected = repos.find((r) => r.path === value)

  return (
    <ChipMenu<string>
      value={value}
      groups={groups}
      onSelect={onChange}
      searchable
      searchPlaceholder="Search repos…"
      emptyLabel="No repos match"
      // Fields open DOWNWARD and match their trigger's width — the chip menu's
      // upward, intrinsically-sized default belongs to a chip in a composer.
      side="bottom"
      matchTriggerWidth
      disabled={disabled || repos.length === 0}
      renderTrailing={
        onToggleStar
          ? (option) => (
              <StarToggle
                starred={starredSet.has(option.value)}
                onToggle={() => void onToggleStar(option.value)}
              />
            )
          : undefined
      }
      trigger={({ open }) => (
        <span
          data-testid="repo-picker-trigger"
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-lg border bg-sunken px-3 font-mono text-[12.5px] transition-colors",
            open ? "border-blue" : "border-line hover:border-line-strong",
            selected ? "text-text-bright" : "text-dim"
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selected?.name ?? (repos.length === 0 ? "No repositories" : "Select a repo")}
          </span>
          <ChevronDown size={13} className="flex-none text-dim" />
        </span>
      )}
    />
  )
}

/**
 * A star toggle living inside a menu item.
 *
 * It swallows the pointer and click events so tapping the star pins the repo
 * without selecting it (which would close the menu). Radix commits a menu item's
 * selection on pointer UP, so stopping `pointerdown` and `click` alone is not
 * enough — `pointerup` and keyboard activation have to go too. (Carried over
 * verbatim from the Select-based picker, where each of those was learned the
 * hard way.)
 */
function StarToggle({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  const swallow = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      aria-label={starred ? "Unstar repo" : "Star repo"}
      aria-pressed={starred}
      onPointerDown={swallow}
      onPointerUp={swallow}
      onClick={(e) => {
        swallow(e)
        onToggle()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          swallow(e)
          onToggle()
        }
      }}
      className={cn("size-5 flex-none rounded hover:bg-surface", starred && "text-yellow hover:text-yellow")}
    >
      <Star size={13} className={starred ? "fill-current" : undefined} />
    </Button>
  )
}
