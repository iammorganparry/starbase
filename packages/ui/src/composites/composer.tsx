import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Attachment, CliKind, PermissionMode, ProviderModels, Skill } from "@starbase/core"
import { ImagePlus, Plus } from "lucide-react"
import { cn } from "../lib/cn.js"
import { modeAccent } from "../tokens.js"
import { AttachmentThumb } from "../components/attachment-thumb.js"
import { Button } from "../components/button.js"
import { ChipMenu, type ChipOption } from "../components/chip-menu.js"
import { CodeChip } from "../components/code-chip.js"
import { Pill } from "../components/pill.js"
import { PROVIDER_LABEL } from "../components/provider-icon.js"
import { StatusDot } from "../components/status-dot.js"
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
/**
 * Gigaplan — the orchestrated mode.
 *
 * Offered only where it can actually run: it needs two independent model
 * providers, because the whole point is that a rival lab attacks the plan. On a
 * one-provider host it is left out rather than shown broken, and the readiness
 * reason is surfaced beside the chip instead.
 */
const GIGAPLAN_OPTION: ChipOption<PermissionMode> = { value: "gigaplan", label: "Gigaplan" }
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
  onStop,
  cli,
  model,
  catalog = [],
  onSetHarness,
  mode = "accept-edits",
  onSetMode,
  allowPlan = false,
  adversarialPlanning,
  onPlanAdversarially,
  mcp,
  onOpenMcp,
  paused = false,
  busy = false,
  placeholder,
  initialValue,
  value: controlledValue,
  onValueChange,
  attachments: controlledAttachments,
  onAttachmentsChange,
  className
}: {
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void
  /** Halt the running agent. Given one, the button becomes Stop while `busy`. */
  onStop?: () => void
  /** Seed the draft once on mount (e.g. a task prefilled from a linked issue). */
  initialValue?: string
  /**
   * Lift the draft text out of this component. The app passes this so a draft
   * survives a session switch — which UNMOUNTS the composer (the pane is keyed by
   * session id), destroying any local state. Omit it and the composer stays
   * happily uncontrolled (stories, Storybook).
   */
  value?: string
  onValueChange?: (value: string) => void
  /** Lift the attachments out too — same reasoning as `value`. */
  attachments?: ReadonlyArray<Attachment>
  onAttachmentsChange?: (attachments: ReadonlyArray<Attachment>) => void
  /** The session's current harness (which section of the menu is checked). */
  cli?: CliKind
  /** Current harness model id (shown in the model chip). */
  model?: string
  /** Installed harnesses and their models — the model chip's sectioned menu. */
  catalog?: ReadonlyArray<ProviderModels>
  /** Picking a model implies its harness, so both travel together. */
  onSetHarness?: (cli: CliKind, model: string) => void
  /** Current HITL mode (shown in the mode chip; Shift+Tab cycles it). */
  mode?: PermissionMode
  onSetMode?: (mode: PermissionMode) => void
  /** Offer the Plan mode option (Claude sessions only). */
  allowPlan?: boolean
  /**
   * Whether an adversarial planning round can run here, and why not when it
   * can't. Absent means the caller doesn't offer the feature at all; present
   * with `ready: false` renders the entry DISABLED carrying its reason, rather
   * than hiding it — a silently missing control teaches the operator nothing,
   * and "you need a second provider" is the one message that would.
   */
  adversarialPlanning?: { readonly ready: boolean; readonly reason: string | null }
  /** Start a round for the composer's current text. */
  onPlanAdversarially?: (brief: string) => void
  /**
   * MCP status for this session, or undefined until it arrives. The chip stays
   * HIDDEN while undefined rather than rendering "0 servers" — the status lands a
   * beat after mount, same as the model catalogue, and a momentary "no MCP" would
   * be a lie about the operator's setup.
   */
  mcp?: { readonly total: number; readonly failed: number; readonly probed: boolean }
  /** Open the MCP status dialog. */
  onOpenMcp?: () => void
  paused?: boolean
  /**
   * The agent is producing a turn — sends are queued (processed once it's free)
   * rather than blocked, so the composer stays live and the button reads "Queue".
   */
  busy?: boolean
  /** Overrides the default "Message <harness>…" prompt. */
  placeholder?: string
  className?: string
}) {
  /**
   * Whether Gigaplan is driving this turn.
   *
   * While it is, the model is its decision — taken per step from the plan it had
   * reviewed — so the model picker comes off the composer rather than sitting
   * there being silently overridden. Changing mode brings it straight back,
   * which is why this is derived from `mode` and never stored.
   */
  const orchestrated = mode === "gigaplan"
  const modeOptions = [
    ...MODE_OPTIONS,
    ...(allowPlan ? [PLAN_OPTION] : []),
    ...(adversarialPlanning?.ready === true ? [GIGAPLAN_OPTION] : [])
  ]
  const accent = modeAccent[mode]

  // Menu values are `<cli>:<modelId>`, not a bare model id: ids aren't unique
  // across harnesses (`gpt-5` is offered by both codex and cursor), and the
  // provider has to survive the round trip so selecting a model can switch
  // harness in one go.
  const modelGroups = useMemo(
    () =>
      catalog.map((p) => ({
        label: p.label,
        options: p.models.map((m) => ({ value: `${p.cli}:${m.id}`, label: m.label }))
      })),
    [catalog]
  )
  // Prefer the exact harness+model pair; if the session's model isn't in the
  // catalogue (stale id, or discovery replaced the list), fall back to the first
  // model of its harness so the chip shows a real label instead of a raw id.
  // Last resort is the bare model id — the catalogue arrives a beat after mount,
  // and the chip must read "opus" in the meantime, never blank or "claude:opus".
  const exact = modelGroups.flatMap((g) => g.options).find((o) => o.value === `${cli}:${model}`)
  const harnessDefault = catalog.find((p) => p.cli === cli)?.models[0]
  const modelValue =
    exact?.value ?? (harnessDefault ? `${cli}:${harnessDefault.id}` : (model ?? ""))
  // Follows the harness — the prompt used to be hardwired to "Message Claude…",
  // which now visibly lies the moment the operator switches provider.
  const prompt = placeholder ?? `Message ${PROVIDER_LABEL[cli ?? "claude"]}…`

  // Controlled when the host passes `value`/`attachments` (the app, so drafts
  // outlive the pane's unmount); otherwise these locals own the draft. Seeded once
  // from `initialValue` — note that only ever applies in the UNCONTROLLED case, so
  // the lazy initializer can't go stale under a controlled host.
  const [internalValue, setInternalValue] = useState(() => initialValue ?? "")
  const [internalAttachments, setInternalAttachments] = useState<ReadonlyArray<Attachment>>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  // Shims, so every call site below reads/writes exactly as it did when this was
  // plain local state — including the `setAttachments(prev => …)` updater form.
  const value = controlledValue ?? internalValue
  const attachments = controlledAttachments ?? internalAttachments

  // An updater must see the LATEST draft, not the one captured when this render
  // ran — two `addFiles` in flight at once (paste, paste again before the first
  // FileReader resolves) would otherwise both merge into the same stale array and
  // the first batch would vanish. These refs are written through on every set, so
  // calls that land in the same tick chain instead of racing.
  const valueRef = useRef(value)
  const attachmentsRef = useRef(attachments)
  valueRef.current = value
  attachmentsRef.current = attachments

  const setValue = (next: string | ((prev: string) => string)) => {
    const resolved = typeof next === "function" ? next(valueRef.current) : next
    valueRef.current = resolved
    if (controlledValue === undefined) setInternalValue(resolved)
    onValueChange?.(resolved)
  }
  const setAttachments = (
    next: ReadonlyArray<Attachment> | ((prev: ReadonlyArray<Attachment>) => ReadonlyArray<Attachment>)
  ) => {
    const resolved = typeof next === "function" ? next(attachmentsRef.current) : next
    attachmentsRef.current = resolved
    if (controlledAttachments === undefined) setInternalAttachments(resolved)
    onAttachmentsChange?.(resolved)
  }
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachIdRef = useRef(0)

  // Read dropped/pasted/picked image files into base64 attachments (capped).
  const addFiles = async (files: ReadonlyArray<File>) => {
    // The single choke point for every route in — button, paste and drop. The
    // button is disabled in Gigaplan, but paste and drop never touch it, so
    // guarding only the control would still let a dragged screenshot through to
    // a round that cannot carry it.
    if (orchestrated) return
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
        // Reflects the active HITL mode so the per-mode theming is inspectable
        // (and assertable in e2e) — the visual accent is derived from it.
        data-mode={mode}
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
          "flex flex-col gap-[11px] rounded-xl border bg-sunken px-[13px] py-2.5 transition-colors",
          // "Nightlight": the active mode tints the composer border/background and
          // casts an ambient glow, so the current HITL mode is legible at a glance.
          accent.border,
          accent.bg,
          accent.glow,
          paused && "opacity-70",
          // A drag-over always wins visually (cyan), and drops the mode glow.
          dragging && "border-cyan/60 bg-cyan/5 shadow-none"
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
            {attachments.length < MAX_ATTACHMENTS && !orchestrated && (
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
                : prompt
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
{/* Disabled in Gigaplan, not silently ignored. `Plan.adversarial` takes
              only a brief — its payload has no images — so an attachment made
              here would be dropped on the way to the round while still
              rendering in the transcript, which reads as "the model saw my
              screenshot" when it did not. Better to refuse the gesture and say
              why than to accept it and discard it. */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={paused || orchestrated}
            /* The NAME stays constant while the tooltip explains. Letting the
               explanation be the accessible name made this button answer to
               "Gigaplan" — the mode chip's name — so a by-name lookup matched
               two controls. What a control IS shouldn't change with why it's
               unavailable. */
            aria-label="Attach an image"
            title={
              orchestrated
                ? "Planning rounds work from the written brief — images aren't sent"
                : "Attach an image"
            }
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-cyan outline-none transition-colors hover:bg-surface disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ImagePlus size={14} />
          </button>
          {/* Gone while Gigaplan is driving: it assigns a model per step from
              the plan it had reviewed, so a model chip here would be a control
              that is silently overridden. It returns the moment the mode
              changes — nothing about the operator's own choice is discarded. */}
          {!orchestrated && (
          <ChipMenu
            value={modelValue}
            groups={modelGroups}
            /* The model list grows with every harness installed and every model
               a provider ships — long enough to hunt through. The mode chip
               below is four fixed options, so it stays plain. */
            searchable
            searchPlaceholder="Search models…"
            emptyLabel="No models match"
            onSelect={(value) => {
              // Split on the FIRST colon only — the harness is one token, but a
              // model id could in principle contain one.
              const separator = value.indexOf(":")
              if (separator < 0) return
              onSetHarness?.(value.slice(0, separator) as CliKind, value.slice(separator + 1))
            }}
            disabled={modelGroups.length === 0}
          />
          )}
          {/* Gigaplan is selected on a host that cannot orchestrate. Saying so
              beats silently degrading to a normal turn, which looks exactly
              like the feature being broken. Reachable because the mode can be
              persisted from a machine that DID have two providers. */}
          {orchestrated && adversarialPlanning?.ready === false && (
            <span
              title={adversarialPlanning.reason ?? undefined}
              className="rounded-full border border-yellow/40 px-2 py-0.5 font-mono text-[10px] tracking-[0.3px] text-yellow"
            >
              needs a second provider
            </span>
          )}
          <ChipMenu
            value={mode}
            options={modeOptions}
            onSelect={onSetMode}
            className={cn("w-[112px] justify-between", accent.chip)}
          />
          {mcp !== undefined && mcp.total > 0 && (
            <button
              type="button"
              onClick={onOpenMcp}
              title="MCP server status"
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-text"
            >
              {/* Neutral until a probe has actually run — a green dot before we've
                  checked anything would claim a health we don't know. */}
              <StatusDot
                tone={!mcp.probed ? "bg-line-strong" : mcp.failed > 0 ? "bg-yellow" : "bg-green"}
                size={6}
                glow={false}
              />
              {mcp.probed && mcp.failed > 0 ? `${mcp.failed} of ${mcp.total} MCP down` : `${mcp.total} MCP`}
            </button>
          )}
          <span className="font-mono text-[11px] text-line-strong">/ · @ · paste image</span>
          <div className="flex-1" />
          {paused ? (
            <Pill tone="yellow" dot>
              paused for approval
            </Pill>
          ) : busy && onStop ? (
            /* While the agent works, the button halts it. Queueing doesn't go
               away — it moves to the keyboard: ↵ still queues a follow-up, which
               is what the placeholder advertises. No "⎋" hint here: Escape only
               fires while the composer is UNfocused, so it wouldn't work from
               where the cursor is when you're reading this button. */
            <Button variant="danger" size="sm" onClick={onStop}>
              Stop
            </Button>
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
