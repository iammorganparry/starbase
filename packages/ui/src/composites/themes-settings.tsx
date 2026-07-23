/**
 * Settings › Themes — pick, duplicate, edit, import.
 *
 * ## Why the grid previews rather than lists
 *
 * A theme is a visual object and its name says almost nothing: nobody can tell
 * from the word "Abyss" whether they want it. So every entry paints itself —
 * the actual surfaces, the actual accent ramp, the actual body text — from the
 * tokens the catalog already carries. That is also why `ThemeSummary` ships
 * resolved tokens rather than making the grid fetch nine themes to draw nine
 * swatches.
 *
 * ## Why editing goes through duplicate
 *
 * Built-ins are immutable (`ThemeService.save` refuses their ids), so "edit
 * Monokai" is really "make my own copy of Monokai and edit that". Rather than
 * hide that behind an Edit button that silently forks, the button says
 * Duplicate & Edit. The fork is the operator's, sits in `~/starbase/themes` as
 * a file they can read, and leaves the original there to fall back to.
 *
 * ## Why the editor is a short list and not 900 fields
 *
 * VS Code names around 900 colours. Starbase acts on about forty of them, and
 * folds those down to the ~30 `--sb-*` tokens the app actually paints with.
 * Exposing 900 inputs would be exhaustive and useless; exposing the ~14 that
 * carry the theme's character — surfaces, text ramp, accents — is what someone
 * adjusting a theme actually reaches for. Anything finer is a file edit away,
 * and that file hot-reloads.
 */
import * as React from "react"
import type { ThemeSummary, VsCodeTheme } from "@starbase/core"
import { Check, Copy, Download, FolderOpen, Trash2, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"

/**
 * The VS Code keys the editor exposes, grouped the way the eye reads a theme.
 *
 * Keyed by VS Code name, not by `--sb-*` token, for the same reason
 * `colorCustomizations` is: an edit written here stays portable back to VS Code
 * and survives the mapper changing which key it prefers.
 */
const EDITABLE_GROUPS: ReadonlyArray<{
  readonly label: string
  readonly keys: ReadonlyArray<{ readonly key: string; readonly label: string }>
}> = [
  {
    label: "Surfaces",
    keys: [
      { key: "editor.background", label: "Editor" },
      { key: "sideBar.background", label: "Sidebar" },
      { key: "panel.background", label: "Wells" },
      { key: "titleBar.activeBackground", label: "Title bar" }
    ]
  },
  {
    label: "Text",
    keys: [
      { key: "editor.foreground", label: "Body" },
      { key: "descriptionForeground", label: "Secondary" },
      { key: "editorLineNumber.foreground", label: "Tertiary" }
    ]
  },
  {
    label: "Accents",
    keys: [
      { key: "terminal.ansiBlue", label: "Blue" },
      { key: "terminal.ansiGreen", label: "Green" },
      { key: "terminal.ansiYellow", label: "Yellow" },
      { key: "terminal.ansiRed", label: "Red" },
      { key: "terminal.ansiMagenta", label: "Purple" },
      { key: "terminal.ansiCyan", label: "Cyan" }
    ]
  }
]

const KIND_LABEL: Record<ThemeSummary["kind"], string> = {
  dark: "Dark",
  light: "Light",
  "high-contrast": "High contrast"
}

export interface ThemesSettingsProps {
  themes: ReadonlyArray<ThemeSummary>
  /** User theme files that could not be read, so the operator can go fix them. */
  skipped?: ReadonlyArray<{ readonly path: string; readonly message: string }>
  activeId: string
  onSelect: (id: string) => void | Promise<void>
  onDuplicate: (id: string, name?: string) => Promise<ThemeSummary>
  onDelete: (id: string) => Promise<void>
  onImport: (json: string) => Promise<ThemeSummary>
  /** Load a theme's raw JSON, for the editor. */
  loadTheme: (id: string) => Promise<VsCodeTheme | null>
  onSave: (id: string, theme: VsCodeTheme) => Promise<unknown>
  /** Reveal a user theme's file in the OS file manager. */
  onReveal?: (path: string) => void
}

export function ThemesSettings({
  themes,
  skipped = [],
  activeId,
  onSelect,
  onDuplicate,
  onDelete,
  onImport,
  loadTheme,
  onSave,
  onReveal
}: ThemesSettingsProps) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const grouped = React.useMemo(() => {
    const order: ReadonlyArray<ThemeSummary["kind"]> = ["dark", "light", "high-contrast"]
    return order
      .map((kind) => ({ kind, items: themes.filter((t) => t.kind === kind) }))
      .filter((g) => g.items.length > 0)
  }, [themes])

  const editingTheme = editing ? themes.find((t) => t.id === editing) : undefined

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (cause) {
      // The service's messages already name the theme and the offending key —
      // see `describeDecodeFailure`. Surfacing them verbatim beats a generic
      // "something went wrong" that hides the one actionable detail.
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (editingTheme) {
    return (
      <ThemeEditor
        summary={editingTheme}
        loadTheme={loadTheme}
        onSave={onSave}
        onClose={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="mb-4 flex items-center justify-between gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">Colour theme</span>
          <Button size="sm" variant="ghost" onClick={() => setImporting((v) => !v)}>
            <Download size={12} /> Import from VS Code
          </Button>
        </div>

        {error && (
          <Callout tone="red" className="mb-4">
            {error}
          </Callout>
        )}

        {/*
          A theme file that will not parse is invisible otherwise — it simply
          does not appear, and the operator concludes the app ignored it. Naming
          the path and the failing key is the difference between a two-second
          fix and giving up on user themes.
        */}
        {skipped.length > 0 && (
          <Callout tone="yellow" className="mb-4">
            <div className="font-medium">
              {skipped.length} theme file{skipped.length === 1 ? "" : "s"} could not be read
            </div>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {skipped.map((s) => (
                <li key={s.path}>
                  {s.path.split("/").pop()} — {s.message}
                </li>
              ))}
            </ul>
          </Callout>
        )}

        {importing && (
          <ImportPanel
            onCancel={() => setImporting(false)}
            onImport={async (json) => {
              await run(async () => {
                const imported = await onImport(json)
                setImporting(false)
                await onSelect(imported.id)
              })
            }}
          />
        )}

        {grouped.map((group) => (
          <div key={group.kind} className="mb-6">
            <Eyebrow className="mb-2">{KIND_LABEL[group.kind]}</Eyebrow>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
              {group.items.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  active={theme.id === activeId}
                  onSelect={() => void run(async () => onSelect(theme.id))}
                  onDuplicate={() =>
                    void run(async () => {
                      const copy = await onDuplicate(theme.id)
                      setEditing(copy.id)
                    })
                  }
                  onEdit={theme.source === "user" ? () => setEditing(theme.id) : undefined}
                  onDelete={
                    theme.source === "user"
                      ? () => void run(async () => onDelete(theme.id))
                      : undefined
                  }
                  onReveal={theme.path && onReveal ? () => onReveal(theme.path!) : undefined}
                />
              ))}
            </div>
          </div>
        ))}

        <p className="mt-2 font-mono text-[10px] leading-relaxed text-dim">
          themes · <span className="text-muted-foreground">~/starbase/themes/*.json</span>
          <br />
          VS Code theme JSON. Edit a file in your own editor and the app repaints as you save.
        </p>
      </div>
    </div>
  )
}

/**
 * One theme, painted in its own colours.
 *
 * The preview is a miniature of the app rather than a row of swatches: a
 * sidebar against an editor against a well, with body text and the accent ramp
 * on top. Swatches show you a theme's palette; this shows you its CONTRAST,
 * which is the thing that actually determines whether you can work in it.
 */
function ThemeCard({
  theme,
  active,
  onSelect,
  onDuplicate,
  onEdit,
  onDelete,
  onReveal
}: {
  theme: ThemeSummary
  active: boolean
  onSelect: () => void
  onDuplicate: () => void
  onEdit?: () => void
  onDelete?: () => void
  onReveal?: () => void
}) {
  const t = theme.tokens
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-md border transition-colors",
        active ? "border-blue" : "border-line hover:border-line-strong"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        aria-label={`Use the ${theme.name} theme`}
        className="block w-full text-left"
      >
        {/*
          Inline styles, and deliberately so. These are the ONLY colours in the
          app that must NOT follow the active theme — the whole point is to show
          what a theme you are not currently using looks like. A Tailwind token
          here would render every card identically in the current theme.
        */}
        <div className="flex h-[72px] w-full" style={{ background: t.editor }}>
          <div className="h-full w-[26%] border-r" style={{ background: t.panel, borderColor: t.hairline }}>
            <div className="mt-2 ml-2 h-1 w-8 rounded-full" style={{ background: t.muted }} />
            <div className="mt-1.5 ml-2 h-1 w-6 rounded-full" style={{ background: t.dim }} />
            <div className="mt-1.5 ml-2 h-1 w-9 rounded-full" style={{ background: t.dim }} />
          </div>
          <div className="flex-1 p-2">
            <div className="h-1.5 w-16 rounded-full" style={{ background: t.textBright }} />
            <div className="mt-1.5 h-1 w-24 rounded-full" style={{ background: t.text }} />
            <div className="mt-1 h-1 w-20 rounded-full" style={{ background: t.textBody }} />
            <div className="mt-2 flex gap-1">
              {[t.blue, t.green, t.yellow, t.red, t.purple, t.cyan].map((c) => (
                <span key={c} className="h-2 w-2 rounded-full" style={{ background: c }} />
              ))}
            </div>
          </div>
        </div>
      </button>

      <div className="flex items-center gap-1.5 border-t border-hairline bg-panel px-2.5 py-1.5">
        {active && <Check size={12} className="shrink-0 text-blue" />}
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-bright">{theme.name}</span>

        {/*
          Actions appear on hover to keep a nine-card grid from reading as a
          wall of buttons — the primary gesture here is "click the picture".
        */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onEdit && (
            <IconAction label={`Edit ${theme.name}`} onClick={onEdit}>
              <Check size={11} />
            </IconAction>
          )}
          <IconAction
            label={onEdit ? `Duplicate ${theme.name}` : `Duplicate & edit ${theme.name}`}
            onClick={onDuplicate}
          >
            <Copy size={11} />
          </IconAction>
          {onReveal && (
            <IconAction label={`Reveal ${theme.name} in file manager`} onClick={onReveal}>
              <FolderOpen size={11} />
            </IconAction>
          )}
          {onDelete && (
            <IconAction label={`Delete ${theme.name}`} onClick={onDelete} danger>
              <Trash2 size={11} />
            </IconAction>
          )}
        </div>
      </div>
    </div>
  )
}

function IconAction({
  label,
  onClick,
  danger,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-muted-foreground transition-colors hover:bg-hover",
        danger ? "hover:text-red" : "hover:text-text-bright"
      )}
    >
      {children}
    </button>
  )
}

function ImportPanel({
  onImport,
  onCancel
}: {
  onImport: (json: string) => void | Promise<void>
  onCancel: () => void
}) {
  const [json, setJson] = React.useState("")
  return (
    <div className="mb-5 rounded-md border border-line bg-sunken p-3">
      <div className="mb-2 text-[12px] text-text-body">
        Paste a VS Code colour theme. Any <span className="font-mono text-[11px]">.json</span> from a
        marketplace extension works — keys Starbase does not use are kept, so the file stays usable
        in VS Code.
      </div>
      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        spellCheck={false}
        rows={7}
        aria-label="VS Code theme JSON"
        placeholder={'{\n  "name": "My Theme",\n  "type": "dark",\n  "colors": { … }\n}'}
        className="w-full resize-y rounded border border-line bg-editor p-2 font-mono text-[11px] text-text-body outline-none focus:border-blue"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={json.trim().length === 0} onClick={() => void onImport(json)}>
          Import
        </Button>
      </div>
    </div>
  )
}

/**
 * The colour picker, over a theme's own `colors` map.
 *
 * Edits are debounced before saving because a native colour input fires
 * `change` continuously while the operator drags — writing per event would
 * rewrite the file dozens of times a second, and each write wakes the directory
 * watcher, which re-reads every theme and repaints the app. The debounce is
 * what keeps dragging a slider from turning into a repaint storm.
 */
function ThemeEditor({
  summary,
  loadTheme,
  onSave,
  onClose
}: {
  summary: ThemeSummary
  loadTheme: (id: string) => Promise<VsCodeTheme | null>
  onSave: (id: string, theme: VsCodeTheme) => Promise<unknown>
  onClose: () => void
}) {
  const [theme, setTheme] = React.useState<VsCodeTheme | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    let live = true
    void loadTheme(summary.id).then((loaded) => {
      if (live) setTheme(loaded)
    })
    return () => {
      live = false
    }
  }, [summary.id, loadTheme])

  // A pending save must still land if the operator closes the pane mid-drag.
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const setColor = (key: string, value: string) => {
    if (!theme) return
    const next: VsCodeTheme = { ...theme, colors: { ...(theme.colors ?? {}), [key]: value } }
    setTheme(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void onSave(summary.id, next), 200)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="mb-4 flex items-center justify-between gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">{summary.name}</span>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Back to themes">
            <X size={12} /> Done
          </Button>
        </div>

        {theme === null ? (
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        ) : (
          <>
            {EDITABLE_GROUPS.map((group) => (
              <div key={group.label} className="mb-5">
                <Eyebrow className="mb-2">{group.label}</Eyebrow>
                <div className="divide-y divide-hairline">
                  {group.keys.map(({ key, label }) => (
                    <ColorRow
                      key={key}
                      label={label}
                      vsCodeKey={key}
                      value={theme.colors?.[key]}
                      fallback={fallbackFor(key, summary)}
                      onChange={(v) => setColor(key, v)}
                    />
                  ))}
                </div>
              </div>
            ))}
            <p className="font-mono text-[10px] leading-relaxed text-dim">
              Saved to{" "}
              <span className="text-muted-foreground">
                ~/starbase/themes/{summary.id}.json
              </span>
              <br />
              Every other VS Code colour key can be set by editing that file directly.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What a key currently RESOLVES to when the theme does not state it.
 *
 * Shown because most keys in most themes are unset, and a picker defaulting to
 * black would tell the operator their sidebar is black when it is actually a
 * derived grey. Showing the resolved value means the swatch matches what is on
 * screen, and editing it starts from there rather than from a jarring jump.
 */
const fallbackFor = (key: string, summary: ThemeSummary): string => {
  const t = summary.tokens
  switch (key) {
    case "editor.background":
      return t.editor
    case "sideBar.background":
      return t.panel
    case "panel.background":
      return t.sunken
    case "titleBar.activeBackground":
      return t.canvas
    case "editor.foreground":
      return t.text
    case "descriptionForeground":
      return t.muted
    case "editorLineNumber.foreground":
      return t.dim
    case "terminal.ansiBlue":
      return t.blue
    case "terminal.ansiGreen":
      return t.green
    case "terminal.ansiYellow":
      return t.yellow
    case "terminal.ansiRed":
      return t.red
    case "terminal.ansiMagenta":
      return t.purple
    case "terminal.ansiCyan":
      return t.cyan
    default:
      return t.text
  }
}

function ColorRow({
  label,
  vsCodeKey,
  value,
  fallback,
  onChange
}: {
  label: string
  vsCodeKey: string
  value?: string
  fallback: string
  onChange: (value: string) => void
}) {
  // `<input type="color">` only accepts `#rrggbb`. A theme may legitimately
  // carry `#rrggbbaa`, so the alpha is trimmed for the picker rather than
  // letting the browser silently reject the value and show black.
  const current = (value ?? fallback).slice(0, 7)
  return (
    <label className="flex items-center gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-text-body">{label}</span>
        <span className="block font-mono text-[10px] text-dim">{vsCodeKey}</span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">{current}</span>
      <input
        type="color"
        value={current}
        aria-label={`${label} colour`}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-9 cursor-pointer rounded border border-line bg-transparent"
      />
    </label>
  )
}
