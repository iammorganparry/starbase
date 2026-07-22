import { useEffect, useMemo, useRef, useState } from "react"
import type { Attachment, CliKind, PermissionMode, ProviderModels, Skill } from "@starbase/core"
import { ImagePlus, Plus } from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
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
/** Offered on any harness that can hold a plan turn — see `supportsPlanMode`. */
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
  autoFocus = false,
  focusKey,
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
  /** Offer the Plan mode option (harnesses that pass `supportsPlanMode`). */
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
  /**
   * Take the caret when this composer becomes the one on screen. The host passes
   * the focused pane's flag, so a split never has two composers fighting for it.
   */
  autoFocus?: boolean
  /**
   * What "became the one on screen" means — the session id. Refocusing is keyed
   * on this, so replacing a pane's session re-focuses even though the component
   * never unmounted.
   */
  focusKey?: string
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

  // The pane's tier (see `session-pane.tsx`). The composer sits in a 760px
  // reading column, so above `wide` it always has its full width; below it, the
  // column is the pane and every pixel is contested.
  const tier = useWidthTier()
  const roomy = atLeast(tier, "wide")

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
      files.map((f) => {
        // The counter is bumped as its own statement rather than inside the
        // template literal: an assignment in an expression position reads as a
        // comparison, and this one has a side effect per attachment.
        attachIdRef.current += 1
        return readAttachment(f, `att_${attachIdRef.current}`)
      })
    )
    const next = read.filter((a): a is Attachment => a !== null)
    if (next.length > 0) setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS))
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id))

  // Opening a conversation puts the caret in its composer — the point of the app
  // is to type at an agent, so arriving anywhere else is a wasted keystroke.
  //
  // Deferred a frame because the pane mounts alongside the virtualized transcript,
  // which scrolls to the bottom on its first layout pass; focusing in the same
  // pass loses the caret to that scroll. Keyed on the session so replacing a
  // pane's session refocuses without an unmount, and gated on `autoFocus` so in a
  // split only the pane the operator is looking at takes it.
  useEffect(() => {
    if (!autoFocus) return
    const id = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [autoFocus, focusKey])

  // The textarea auto-grows in LAYOUT (`field-sizing: content`), not from a
  // measurement taken here — see the note on the element itself.
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
    // `data-testid` anchors the e2e geometry assertions: they measure where the
    // composer's OUTER box sits in its pane, which the textarea alone cannot
    // stand in for (the model / MCP / Send row hangs ~80px below it).
    <div data-testid="composer" className={cn("relative flex flex-col gap-2", className)}>
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
          /*
           * `field-sizing-content` — the height is a LAYOUT property, resolved
           * by the browser from the content at whatever width the composer
           * currently has, on every frame it changes.
           *
           * It replaces a `useLayoutEffect` that set `height: auto`, read
           * `scrollHeight` and wrote it back, keyed on `[value]`. That ran
           * exactly once per value change — and a pane MOUNTS about a pixel
           * wide, because `paneVariants.hidden` enters from `flexGrow: 0.001`.
           * At zero content width Chromium wraps the placeholder one glyph per
           * line, so "Message Claude…" measured ~315px, was written to
           * `style.height`, and stuck there (nothing re-measures — there is no
           * ResizeObserver) until the first keystroke re-ran the effect at the
           * real width. The composer opened at its `max-h` and snapped back as
           * you typed. The same staleness sat under every divider drag and
           * window resize; a measurement that has to be re-taken by hand is a
           * measurement that will be missed.
           *
           * `min-h` still guarantees one line, `max-h` still caps the growth,
           * and past the cap `overflow-y-auto` scrolls. Chromium 123+; this app
           * ships its own (Electron 43 → Chromium 140).
           */
          className="field-sizing-content max-h-64 min-h-[22px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-text-body outline-none placeholder:text-dim"
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
        {/*
          `flex-wrap` + `min-w-0`, and both are load-bearing.

          This row held eight controls with no wrap and no `min-w-0` anywhere in
          the file. Two of them (the model chip, the MCP status) carry
          variable-length text, and `Button` is `whitespace-nowrap`, so the row's
          min-content floor sat well past the composer's own border — the
          controls didn't degrade, they overflowed the rounded box and got
          clipped. Wrapping is the right failure mode here rather than scrolling:
          a composer toolbar is a set of unrelated controls, not a sequence, so a
          second line costs nothing but 26px of height.
        */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
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
            className="flex flex-none items-center gap-1 rounded-md px-1.5 py-1 text-cyan outline-none transition-colors hover:bg-surface disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
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
            // Capped rather than fixed: model ids are the longest string in this
            // row by a wide margin, and left uncapped one of them decides how
            // much room every other control gets.
            className={roomy ? "max-w-[220px]" : "max-w-[128px]"}
          />
          )}
          {/* Gigaplan is selected on a host that cannot orchestrate. Saying so
              beats silently degrading to a normal turn, which looks exactly
              like the feature being broken. Reachable because the mode can be
              persisted from a machine that DID have two providers. */}
          {orchestrated && adversarialPlanning?.ready === false && (
            <span
              title={adversarialPlanning.reason ?? undefined}
              className="flex-none rounded-full border border-yellow/40 px-2 py-0.5 font-mono text-[10px] tracking-[0.3px] text-yellow"
            >
              {/* The long form explains; the short form still points at the
                  problem, and the `title` above carries the full reason either
                  way. Wrapping this five-word pill onto its own line would push
                  Send off screen for a message that is advisory, not blocking. */}
              {roomy ? "needs a second provider" : "needs 2nd provider"}
            </span>
          )}
          <ChipMenu
            value={mode}
            options={modeOptions}
            onSelect={onSetMode}
            // A stable width prevents the toolbar jumping when a mode hides the
            // model chip (Gigaplan). Flex shrinking plus the chip's `min-w-0`
            // still lets this yield inside a genuinely narrow pane.
            className={cn("w-[112px] justify-between", accent.chip)}
          />
          {mcp !== undefined && mcp.total > 0 && (
            <button
              type="button"
              onClick={onOpenMcp}
              // The NAME stays constant while the label shortens — same rule the
              // attach button above states: what a control IS shouldn't change
              // with what it's currently reporting. Keeping it fixed is also
              // what lets a by-name lookup find this chip at any width.
              title="MCP server status"
              className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-sunken px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-text"
            >
              {/* Neutral until a probe has actually run — a green dot before we've
                  checked anything would claim a health we don't know. */}
              <StatusDot
                tone={!mcp.probed ? "bg-line-strong" : mcp.failed > 0 ? "bg-yellow" : "bg-green"}
                size={6}
                glow={false}
              />
              {/* Narrow drops the prose, not the information: "1/3 MCP" still
                  says how many are down, and the yellow dot beside it still says
                  that some are. Only the eight characters of " of " and " down"
                  go, which is the difference between fitting and wrapping. */}
              {mcp.probed && mcp.failed > 0
                ? roomy
                  ? `${mcp.failed} of ${mcp.total} MCP down`
                  : `${mcp.failed}/${mcp.total} MCP`
                : `${mcp.total} MCP`}
            </button>
          )}
          {/* Pure decoration, and the first thing to go: it costs ~120px, has no
              affordance, and both hints it names are already discoverable by
              typing the character it's telling you to type. Below `wide` it
              would wrap to "paste" on its own line and shove the chips around. */}
          {roomy && (
            <span className="flex-none font-mono text-[11px] text-line-strong">
              / · @ · paste image
            </span>
          )}
          {/* `min-w-[8px]` so the spacer still exists after a wrap — a bare
              `flex-1` on a wrapped line collapses to nothing and the send button
              ends up butted against the last chip. */}
          <div className="min-w-[8px] flex-1" />
          {/* The send/stop control is `flex-none` and LAST in DOM order, which
              together decide what a squeeze does: the row wraps the chips above
              it and the primary action keeps its full size on the trailing line,
              rather than being the thing pushed past the border. */}
          <span className="flex-none">
          {paused ? (
            <Pill tone="yellow" dot>
              {roomy ? "paused for approval" : "paused"}
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
          </span>
        </div>
      </div>
    </div>
  )
}
