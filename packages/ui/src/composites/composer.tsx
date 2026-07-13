import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Attachment, ModelOption, PermissionMode, Skill } from "@starbase/core"
import { ImagePlus, Plus } from "lucide-react"
import { cn } from "../lib/cn.js"
import { AttachmentThumb } from "../components/attachment-thumb.js"
import { Button } from "../components/button.js"
import { ChipMenu, type ChipOption } from "../components/chip-menu.js"
import { CodeChip } from "../components/code-chip.js"
import { Pill } from "../components/pill.js"
import { CommandMenu } from "./command-menu.js"
import { MentionMenu } from "./mention-menu.js"

/** Cap the number of attached images so the prompt payload stays sane. */
const MAX_ATTACHMENTS = 8

/** Read an image `File` into a base64 `Attachment` (null if it isn't an image). */
const readAttachment = (file: File, id: string): Promise<Attachment | null> =>
  new Promise((resolve) => {
    if (!file.type.startsWith("image/")) {
      resolve(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      const comma = result.indexOf(",")
      const data = comma >= 0 ? result.slice(comma + 1) : ""
      resolve(data ? { id, name: file.name || "pasted-image.png", mediaType: file.type, data } : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })

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
  busy = false,
  placeholder = "Message Claude…",
  className
}: {
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void
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
  /**
   * The agent is producing a turn — sends are queued (processed once it's free)
   * rather than blocked, so the composer stays live and the button reads "Queue".
   */
  busy?: boolean
  placeholder?: string
  className?: string
}) {
  const modeOptions = allowPlan ? [...MODE_OPTIONS, PLAN_OPTION] : MODE_OPTIONS
  const [value, setValue] = useState("")
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [attachments, setAttachments] = useState<ReadonlyArray<Attachment>>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachIdRef = useRef(0)

  // Read dropped/pasted/picked image files into base64 attachments (capped).
  const addFiles = async (files: ReadonlyArray<File>) => {
    const read = await Promise.all(
      files.map((f) => readAttachment(f, `att_${(attachIdRef.current += 1)}`))
    )
    const next = read.filter((a): a is Attachment => a !== null)
    if (next.length > 0) setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS))
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id))

  // Auto-grow the textarea to fit its content (a multiline prompt expands the
  // composer instead of scrolling internally), capped by the CSS `max-h` — past
  // which it scrolls. Runs after each value change (including the reset on send).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [value])

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
    if ((text.length === 0 && attachments.length === 0) || paused) return
    onSend?.(text, attachments)
    setValue("")
    setAttachments([])
    setMenu(null)
  }

  // Pasting an image (e.g. a screenshot) attaches it instead of dropping a blob.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"))
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
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
        onDragOver={(e) => {
          if (paused) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false)
          if (paused) return
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))
          if (files.length === 0) return
          e.preventDefault()
          void addFiles(files)
        }}
        className={cn(
          "flex flex-col gap-[11px] rounded-xl border border-line bg-sunken px-[13px] py-2.5 transition-colors",
          paused && "opacity-70",
          dragging && "border-cyan/60 bg-cyan/5"
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
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentThumb
                key={a.id}
                attachment={a}
                onRemove={() => removeAttachment(a.id)}
                className="size-[58px]"
              />
            ))}
            {attachments.length < MAX_ATTACHMENTS && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                className="flex size-[58px] flex-none flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-line text-dim outline-none transition-colors hover:border-line-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus size={15} />
                <span className="text-[8.5px]">Add</span>
              </button>
            )}
          </div>
        )}
        <textarea
          ref={ref}
          value={value}
          rows={1}
          disabled={paused}
          placeholder={
            paused
              ? "Reply, or answer the prompt above…"
              : busy
                ? "Queue a message while the agent works…"
                : placeholder
          }
          onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-64 min-h-[22px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-text-body outline-none placeholder:text-dim"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []))
            e.target.value = ""
          }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={paused}
            title="Attach an image"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-cyan outline-none transition-colors hover:bg-surface disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ImagePlus size={14} />
          </button>
          <ChipMenu
            value={model ?? models[0]?.id ?? ""}
            options={models.map((m) => ({ value: m.id, label: m.label }))}
            onSelect={onSetModel}
            disabled={models.length === 0}
          />
          <ChipMenu value={mode} options={modeOptions} onSelect={onSetMode} />
          <span className="font-mono text-[11px] text-line-strong">/ · @ · paste image</span>
          <div className="flex-1" />
          {paused ? (
            <Pill tone="yellow" dot>
              paused for approval
            </Pill>
          ) : (
            <Button variant="primary" size="sm" onClick={send}>
              {busy ? "Queue ↵" : "Send ↵"}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
