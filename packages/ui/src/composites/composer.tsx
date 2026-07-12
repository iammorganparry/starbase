import { useMemo, useRef, useState } from "react"
import type { ModelOption, PermissionMode, Skill } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { ChipMenu, type ChipOption } from "../components/chip-menu.js"
import { CodeChip } from "../components/code-chip.js"
import { Pill } from "../components/pill.js"
import { CommandMenu } from "./command-menu.js"
import { MentionMenu } from "./mention-menu.js"

const MODE_OPTIONS: ReadonlyArray<ChipOption<PermissionMode>> = [
  { value: "ask", label: "ask" },
  { value: "accept-edits", label: "accept edits" },
  { value: "auto", label: "auto" }
]
/** Plan mode is Claude-only (the other harnesses are autonomous). */
const PLAN_OPTION: ChipOption<PermissionMode> = { value: "plan", label: "plan" }

type MenuState = { kind: "slash" | "mention"; query: string; start: number }

/** The trigger token (`/…` or `@…`) immediately before the caret, if any. */
const activeToken = (value: string, caret: number): MenuState | null => {
  const match = value.slice(0, caret).match(/(?:^|\s)([/@])(\S*)$/)
  if (!match) return null
  const query = match[2] ?? ""
  return {
    kind: match[1] === "/" ? "slash" : "mention",
    query,
    start: caret - query.length - 1
  }
}

/**
 * The prompt composer — a real controlled textarea with Enter-to-send /
 * Shift+Enter newline, plus two typeahead palettes: `/` surfaces the harness's
 * skills (harness-agnostic) and `@` references worktree files as code chips.
 */
export function Composer({
  skills = [],
  files = [],
  onSend,
  model,
  models = [],
  onSetModel,
  mode = "accept-edits",
  onSetMode,
  allowPlan = false,
  paused = false,
  placeholder = "Message Claude…",
  className
}: {
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  onSend?: (text: string) => void
  /** Current harness model id (shown in the model chip). */
  model?: string
  /** Models the harness supports (the model chip's menu). */
  models?: ReadonlyArray<ModelOption>
  onSetModel?: (model: string) => void
  /** Current HITL mode (shown in the mode chip; Shift+Tab cycles it). */
  mode?: PermissionMode
  onSetMode?: (mode: PermissionMode) => void
  /** Offer the Plan mode option (Claude sessions only). */
  allowPlan?: boolean
  paused?: boolean
  placeholder?: string
  className?: string
}) {
  const modeOptions = allowPlan ? [...MODE_OPTIONS, PLAN_OPTION] : MODE_OPTIONS
  const [value, setValue] = useState("")
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  const skillMatches = useMemo(
    () =>
      menu?.kind === "slash"
        ? skills.filter((s) => s.name.toLowerCase().includes(menu.query.toLowerCase()))
        : [],
    [menu, skills]
  )
  const fileMatches = useMemo(
    () =>
      menu?.kind === "mention"
        ? files.filter((f) => f.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 50)
        : [],
    [menu, files]
  )
  const count = menu?.kind === "slash" ? skillMatches.length : fileMatches.length

  const mentions = useMemo(() => [...value.matchAll(/@(\S+)/g)].map((m) => m[1]!), [value])

  const sync = (next: string, caret: number) => {
    setValue(next)
    setMenu(activeToken(next, caret))
    setActiveIndex(0)
  }

  const replaceToken = (insert: string) => {
    if (!menu) return
    const before = value.slice(0, menu.start)
    const after = value.slice(menu.start + 1 + menu.query.length)
    const next = `${before}${insert} ${after}`
    setValue(next)
    setMenu(null)
    requestAnimationFrame(() => ref.current?.focus())
  }

  const send = () => {
    const text = value.trim()
    if (text.length === 0 || paused) return
    onSend?.(text)
    setValue("")
    setMenu(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && count > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % count)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + count) % count)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        if (menu.kind === "slash") replaceToken(skillMatches[activeIndex]!.name)
        else replaceToken(`@${fileMatches[activeIndex]!}`)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className={cn("relative flex flex-col gap-2", className)}>
      {menu && count > 0 && (
        <div className="absolute inset-x-0 bottom-full z-10 mb-2">
          {menu.kind === "slash" ? (
            <CommandMenu
              skills={skillMatches}
              activeIndex={activeIndex}
              onSelect={(s) => replaceToken(s.name)}
              onHover={setActiveIndex}
            />
          ) : (
            <MentionMenu
              files={fileMatches}
              activeIndex={activeIndex}
              onSelect={(p) => replaceToken(`@${p}`)}
              onHover={setActiveIndex}
            />
          )}
        </div>
      )}

      <div
        className={cn(
          "flex flex-col gap-[11px] rounded-xl border border-line bg-sunken px-[13px] py-2.5",
          paused && "opacity-70"
        )}
      >
        {mentions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {mentions.map((path, i) => (
              <CodeChip
                key={`${path}-${i}`}
                path={path}
                onRemove={() => setValue((v) => v.replace(`@${path}`, "").replace(/\s{2,}/g, " ").trimStart())}
              />
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={value}
          rows={1}
          disabled={paused}
          placeholder={paused ? "Reply, or answer the prompt above…" : placeholder}
          onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          className="max-h-40 min-h-[22px] w-full resize-none bg-transparent text-[14px] leading-[1.5] text-text-body outline-none placeholder:text-dim"
        />
        <div className="flex items-center gap-2">
          <ChipMenu
            value={model ?? models[0]?.id ?? ""}
            options={models.map((m) => ({ value: m.id, label: m.label }))}
            onSelect={onSetModel}
            disabled={models.length === 0}
          />
          <ChipMenu value={mode} options={modeOptions} onSelect={onSetMode} />
          <span className="font-mono text-[11px] text-line-strong">/ · @</span>
          <div className="flex-1" />
          {paused ? (
            <Pill tone="yellow" dot>
              paused for approval
            </Pill>
          ) : (
            <Button variant="primary" size="sm" onClick={send}>
              Send ↵
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
