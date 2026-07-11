import type { Skill } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { SlashCommandRow } from "./slash-command-row.js"

/**
 * The `/` command palette that surfaces the harness's skills + built-in commands.
 * Presentational + controlled: the composer owns the query/active index and
 * filters, this renders the floating list. `skills` come from the harness (so the
 * menu is model-agnostic).
 */
export function CommandMenu({
  skills,
  activeIndex,
  onSelect,
  onHover,
  className
}: {
  skills: ReadonlyArray<Skill>
  activeIndex: number
  onSelect: (skill: Skill) => void
  onHover?: (index: number) => void
  className?: string
}) {
  if (skills.length === 0) return null
  return (
    <div
      role="listbox"
      className={cn(
        "flex max-h-[260px] flex-col gap-0.5 overflow-auto rounded-lg border border-line bg-sunken p-1.5 shadow-2xl",
        className
      )}
    >
      {skills.map((skill, i) => (
        <button
          key={skill.name}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(skill)
          }}
          onMouseEnter={() => onHover?.(i)}
          className="text-left"
        >
          <SlashCommandRow
            name={skill.name}
            description={skill.description}
            glyphTone={skill.source === "skill" ? "purple" : "blue"}
            badge={skill.source === "skill" ? "skill" : undefined}
            badgeTone="purple"
            active={i === activeIndex}
          />
        </button>
      ))}
    </div>
  )
}
