import * as React from "react"
import type {
  CliInfo,
  CliKind,
  GhStatus,
  GitConfig,
  GithubConfig,
  ModelOption,
  OpencodeProviderInfo,
  OpencodeProviderSource,
  OutputStyle,
  PermissionMode,
  ProviderConfig,
  ProvidersConfig,
  ReasoningEffort
} from "@starbase/core"
import { DEFAULT_REVIEW_MODEL, reviewModelFor } from "@starbase/core"
import {
  Cpu,
  Keyboard,
  RotateCcw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { GithubMark } from "../components/github-mark.js"
import { ProviderIcon, PROVIDER_LABEL } from "../components/provider-icon.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/select.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import { ProviderCard } from "./provider-card.js"

// ── Section registry ─────────────────────────────────────────────────────────

type SectionKey =
  | "general"
  | "providers"
  | "agents"
  | "permissions"
  | "mcp"
  | "github"
  | "keybindings"

interface NavItem {
  key: SectionKey
  label: string
  icon: React.ReactNode
  /** Built sections; the rest render an informative stub. */
  ready: boolean
}

const NAV: ReadonlyArray<NavItem> = [
  { key: "general", label: "General", icon: <SlidersHorizontal size={14} />, ready: false },
  { key: "providers", label: "Providers", icon: <Cpu size={14} />, ready: true },
  { key: "agents", label: "Agents & skills", icon: <Sparkles size={14} />, ready: false },
  { key: "permissions", label: "Permissions", icon: <ShieldCheck size={14} />, ready: false },
  { key: "mcp", label: "MCP servers", icon: <Server size={14} />, ready: false },
  { key: "github", label: "GitHub", icon: <GithubMark size={14} />, ready: true },
  { key: "keybindings", label: "Keybindings", icon: <Keyboard size={14} />, ready: false }
]

// ── Provider lever option sets (labels ← design E10) ─────────────────────────

const MODE_ITEMS: ReadonlyArray<{ value: PermissionMode; label: string }> = [
  { value: "ask", label: "Ask each time" },
  { value: "accept-edits", label: "Accept edits" },
  { value: "plan", label: "Plan first" },
  { value: "auto", label: "Auto" }
]

const REASONING_ITEMS: ReadonlyArray<{ value: ReasoningEffort; label: string }> = [
  { value: "off", label: "Off" },
  { value: "think", label: "Think" },
  { value: "think-hard", label: "Think hard" },
  { value: "ultrathink", label: "Ultrathink" }
]

const OUTPUT_ITEMS: ReadonlyArray<{ value: OutputStyle; label: string }> = [
  { value: "default", label: "Default" },
  { value: "explanatory", label: "Explanatory" },
  { value: "concise", label: "Concise" }
]

const HARNESS_DEFAULT = "__default__"

const DEFAULT_PROVIDER: ProviderConfig = { enabled: true, defaultMode: "accept-edits" }

const providerOf = (providers: ProvidersConfig | undefined, cli: CliKind): ProviderConfig =>
  providers?.[cli] ?? DEFAULT_PROVIDER

/** The card's one-line `model · mode · reasoning` summary. */
function summarize(cli: CliKind, cfg: ProviderConfig, installed: boolean): string {
  if (!cfg.enabled) return "disabled"
  if (!installed) return "not installed"
  const modeLabel = MODE_ITEMS.find((m) => m.value === cfg.defaultMode)?.label ?? cfg.defaultMode
  const parts = [cfg.defaultModel ?? "harness default", modeLabel]
  const reasoning = REASONING_ITEMS.find((r) => r.value === cfg.reasoningEffort)?.label
  if (reasoning && cfg.reasoningEffort !== "off") parts.push(reasoning)
  return parts.join(" · ")
}

/**
 * How each opencode provider got its credential, phrased for a human.
 *
 * The point of showing this is restraint: opencode resolves providers from the
 * user's OWN setup, and Starbase writing over that silently would be a
 * betrayal of it. So we say where each key came from, and only offer to add one
 * where there isn't one already.
 */
const SOURCE_LABEL: Record<OpencodeProviderSource, string> = {
  env: "environment",
  api: "signed in",
  config: "opencode.json",
  custom: "built-in"
}

const SOURCE_HINT: Record<OpencodeProviderSource, string> = {
  env: "Resolved from an environment variable you set.",
  api: "A key stored in opencode's own credential file — usable outside Starbase too.",
  config: "Declared in your opencode.json.",
  custom: "Built into opencode."
}

/**
 * opencode's providers, and the key entry for them — the BYOK surface.
 *
 * Keys go to OPENCODE's credential store (`opencode auth login`'s file), never
 * to Starbase's `SecretStore`, which holds only the Starbase bearer token. So a
 * key added here works in a bare `opencode` shell, and one added there works
 * here. There is exactly one credential store and it is opencode's.
 */
function OpencodeProviders({
  loadProviders,
  onSetAuth
}: {
  loadProviders: () => Promise<ReadonlyArray<OpencodeProviderInfo>>
  onSetAuth: (providerId: string, key: string) => Promise<boolean>
}) {
  const [providers, setProviders] = React.useState<ReadonlyArray<OpencodeProviderInfo> | null>(null)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [key, setKey] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(() => {
    let live = true
    void loadProviders()
      .then((p) => live && setProviders(p))
      .catch(() => live && setProviders([]))
    return () => {
      live = false
    }
  }, [loadProviders])

  React.useEffect(() => refresh(), [refresh])

  const save = async (providerId: string) => {
    setSaving(true)
    try {
      await onSetAuth(providerId, key.trim())
      setEditing(null)
      setKey("")
      // Re-read rather than patch local state: only opencode can say whether the
      // key actually resolved the provider (and how many models it unlocked).
      refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Field label="Providers" flag="opencode auth">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          opencode brings its own providers. Keys are stored by opencode itself, so anything you
          add here also works in your terminal — and anything you added with{" "}
          <span className="font-mono text-dim">opencode auth login</span> already works here.
        </span>
        {providers === null ? (
          <span className="py-2 text-[11.5px] text-dim">Asking opencode…</span>
        ) : providers.length === 0 ? (
          <span className="py-2 text-[11.5px] text-dim">
            opencode reported no providers. Check that it runs in your terminal.
          </span>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="flex flex-col gap-1.5 rounded-md border border-hairline p-2.5">
              <div className="flex items-center gap-2">
                <StatusDot
                  tone={p.source === null ? "bg-line-strong" : "bg-green"}
                  size={6}
                  glow={p.source !== null}
                />
                <span className="text-[12px] font-medium text-text-bright">{p.name}</span>
                {p.source !== null && (
                  <span
                    title={SOURCE_HINT[p.source]}
                    className="rounded bg-black/25 px-1.5 py-px font-mono text-[9.5px] text-muted-foreground"
                  >
                    {SOURCE_LABEL[p.source]}
                  </span>
                )}
                <span className="ml-auto font-mono text-[10px] text-dim">
                  {p.modelCount} {p.modelCount === 1 ? "model" : "models"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(editing === p.id ? null : p.id)
                    setKey("")
                  }}
                  className="rounded border border-hairline px-1.5 py-px text-[10.5px] text-muted-foreground hover:text-text-bright"
                >
                  {p.source === "api" ? "Replace key" : "Add key"}
                </button>
              </div>
              {/* Name the env var rather than making them go and find it. */}
              {p.source === null && p.env.length > 0 && (
                <span className="font-mono text-[10px] text-dim">
                  or export {p.env.join(" / ")}
                </span>
              )}
              {editing === p.id && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="password"
                    value={key}
                    autoFocus
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={`${p.id} API key`}
                    className="min-w-0 flex-1 rounded border border-hairline bg-black/20 px-2 py-1 font-mono text-[11px] text-text-bright outline-none focus:border-line-strong"
                  />
                  <button
                    type="button"
                    disabled={key.trim().length === 0 || saving}
                    onClick={() => void save(p.id)}
                    className="rounded bg-blue/20 px-2 py-1 text-[10.5px] text-blue disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Field>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsViewProps {
  /** Discovered CLIs — every one becomes a provider card. */
  clis: ReadonlyArray<CliInfo>
  /** Persisted per-CLI provider defaults. */
  providers?: ProvidersConfig | null
  /** Persist one CLI's provider config. */
  onSaveProvider: (cli: CliKind, config: ProviderConfig) => Promise<void> | void
  /** Load the selectable models for a CLI (live discovery). */
  loadModels: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  /** opencode's resolved providers + credential origins (opencode only). */
  loadOpencodeProviders?: () => Promise<ReadonlyArray<OpencodeProviderInfo>>
  /** Store an API key in opencode's own credential file (opencode only). */
  onSetOpencodeAuth?: (providerId: string, key: string) => Promise<boolean>
  // GitHub section (reused from the old settings modal).
  ghStatus: GhStatus
  github?: GithubConfig | null
  git?: GitConfig | null
  rechecking?: boolean
  onRecheck?: () => void
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
  /** Close the view and return to the active session. */
  onClose?: () => void
}

/**
 * The dedicated Settings view (design E10) — a three-column shell: a section
 * nav, a provider list, and the selected provider's detail pane. Providers and
 * GitHub are functional; the other nav entries render a "coming soon" stub. It
 * fills the main pane (the sidebar stays), replacing the old modal.
 */
export function SettingsView({
  clis,
  providers,
  onSaveProvider,
  loadModels,
  loadOpencodeProviders,
  onSetOpencodeAuth,
  ghStatus,
  github,
  git,
  rechecking,
  onRecheck,
  onSaveGithub,
  onSaveGit,
  onClose
}: SettingsViewProps) {
  const [section, setSection] = React.useState<SectionKey>("providers")

  return (
    <div className="flex min-h-0 flex-1 bg-editor">
      {/* nav */}
      <nav className="flex w-[216px] flex-none flex-col gap-0.5 border-r border-hairline bg-panel p-2.5">
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1">
          <Eyebrow>Settings</Eyebrow>
          {onClose && (
            <button
              type="button"
              aria-label="Close settings"
              onClick={onClose}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-text"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            aria-current={section === item.key}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
              section === item.key
                ? "border border-blue/45 bg-surface font-semibold text-text-bright shadow-[0_0_0_3px_rgba(97,175,239,0.1)]"
                : "border border-transparent text-text-body hover:bg-surface/60"
            )}
          >
            <span className={cn(section === item.key ? "text-blue" : "text-muted-foreground")}>
              {item.icon}
            </span>
            <span className="flex-1 text-left">{item.label}</span>
            {item.key === "providers" && (
              <span className="rounded bg-white/5 px-1.5 py-px font-mono text-[9px] text-muted-foreground">
                {clis.length}
              </span>
            )}
          </button>
        ))}
        <div className="mt-auto rounded-md border border-line px-2.5 py-2 font-mono text-[10px] leading-relaxed text-dim">
          config · <span className="text-muted-foreground">~/starbase/config.json</span>
          <br />
          user scope
        </div>
      </nav>

      {section === "providers" ? (
        <ProvidersSection
          clis={clis}
          providers={providers ?? undefined}
          onSaveProvider={onSaveProvider}
          loadModels={loadModels}
          loadOpencodeProviders={loadOpencodeProviders}
          onSetOpencodeAuth={onSetOpencodeAuth}
        />
      ) : section === "github" ? (
        <GithubSection
          ghStatus={ghStatus}
          github={github}
          git={git}
          loadModels={loadModels}
          rechecking={rechecking}
          onRecheck={onRecheck}
          onSaveGithub={onSaveGithub}
          onSaveGit={onSaveGit}
        />
      ) : (
        <StubSection label={NAV.find((n) => n.key === section)?.label ?? "Settings"} />
      )}
    </div>
  )
}

// ── Providers section ────────────────────────────────────────────────────────

function ProvidersSection({
  clis,
  providers,
  onSaveProvider,
  loadModels,
  loadOpencodeProviders,
  onSetOpencodeAuth
}: {
  clis: ReadonlyArray<CliInfo>
  providers: ProvidersConfig | undefined
  onSaveProvider: (cli: CliKind, config: ProviderConfig) => Promise<void> | void
  loadModels: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  loadOpencodeProviders?: () => Promise<ReadonlyArray<OpencodeProviderInfo>>
  onSetOpencodeAuth?: (providerId: string, key: string) => Promise<boolean>
}) {
  const [selected, setSelected] = React.useState<CliKind>(clis[0]?.kind ?? "claude")
  const stored = providerOf(providers, selected)
  const [draft, setDraft] = React.useState<ProviderConfig>(stored)
  const [models, setModels] = React.useState<ReadonlyArray<ModelOption>>([])

  const selectedInfo = clis.find((c) => c.kind === selected)

  // Re-seed the draft whenever the selected provider (or its stored config) changes.
  React.useEffect(() => {
    setDraft(providerOf(providers, selected))
  }, [providers, selected])

  // Load the model list for the selected provider.
  React.useEffect(() => {
    let live = true
    void loadModels(selected)
      .then((m) => live && setModels(m))
      .catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [selected, loadModels])

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored)
  const patch = (next: Partial<ProviderConfig>) => setDraft((d) => ({ ...d, ...next }))

  return (
    <>
      {/* provider list */}
      <div className="flex w-[328px] flex-none flex-col border-r border-hairline">
        <div className="flex flex-none flex-col gap-1 p-4 pb-3">
          <span className="text-[15px] font-bold text-text-bright">Providers</span>
          <span className="text-[11.5px] leading-relaxed text-muted-foreground">
            Set the defaults each agent CLI starts a new session with. Sessions can override
            per-turn.
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 overflow-auto p-3 pt-1">
          {clis.map((c) => (
            <ProviderCard
              key={c.kind}
              cli={c.kind}
              label={c.label}
              summary={summarize(c.kind, providerOf(providers, c.kind), c.available)}
              enabled={providerOf(providers, c.kind).enabled}
              installed={c.available}
              selected={c.kind === selected}
              onSelect={() => setSelected(c.kind)}
            />
          ))}
        </div>
      </div>

      {/* detail */}
      <div className="flex min-w-0 flex-1 flex-col bg-editor">
        <div className="flex flex-1 flex-col gap-5 overflow-auto p-6">
          {/* header */}
          <div className="flex items-center gap-3">
            <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-black/20">
              <ProviderIcon cli={selected} size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-text-bright">
                {PROVIDER_LABEL[selected]}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-dim">
                <StatusDot
                  tone={selectedInfo?.available ? "bg-green" : "bg-line-strong"}
                  size={6}
                  glow={selectedInfo?.available}
                />
                {selectedInfo?.available
                  ? `ready${selectedInfo.version ? ` · v${selectedInfo.version}` : ""}`
                  : "not installed"}
                {selectedInfo?.binPath && (
                  <span className="truncate text-muted-foreground">· {selectedInfo.binPath}</span>
                )}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-muted-foreground">
              Enabled
              <Toggle
                checked={draft.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
                aria-label="Enable provider"
              />
            </label>
          </div>

          {/*
            An INSTALLED-but-unusable harness explains itself. Discovery reports
            a too-old opencode as unavailable, and without this the header just
            says "not installed" about a binary sitting right there on PATH.
          */}
          {selectedInfo?.note && <Callout tone="yellow">{selectedInfo.note}</Callout>}

          {/* opencode's own providers + keys (BYOK) */}
          {selected === "opencode" && loadOpencodeProviders && onSetOpencodeAuth && (
            <OpencodeProviders
              loadProviders={loadOpencodeProviders}
              onSetAuth={onSetOpencodeAuth}
            />
          )}

          {/* default model */}
          <Field label="Default model" flag="--model">
            <div className="grid grid-cols-3 gap-2">
              <ModelChoice
                label="Harness default"
                sub="the CLI's built-in pick"
                selected={draft.defaultModel == null}
                onSelect={() => patch({ defaultModel: undefined })}
              />
              {models.map((m) => (
                <ModelChoice
                  key={m.id}
                  label={m.label}
                  sub={m.id}
                  selected={draft.defaultModel === m.id}
                  onSelect={() => patch({ defaultModel: m.id })}
                />
              ))}
            </div>
          </Field>

          {/* background model */}
          <Row label="Background model" description="Small, fast model for summaries & side tasks">
            <ModelSelect
              value={draft.backgroundModel}
              models={models}
              onChange={(backgroundModel) => patch({ backgroundModel })}
            />
          </Row>

          {/* default mode */}
          <Field label="Default mode" flag="--permission-mode">
            <SegmentedControl
              items={MODE_ITEMS}
              value={draft.defaultMode}
              onChange={(defaultMode) => patch({ defaultMode })}
            />
            <span className="text-[11px] leading-relaxed text-dim">
              Plan first drafts a plan and waits for approval before running.{" "}
              <span className="text-yellow">Auto bypasses all permission prompts — use with care.</span>
            </span>
          </Field>

          {/* reasoning effort */}
          <Field label="Reasoning effort" flag="thinking budget">
            <SegmentedControl
              items={REASONING_ITEMS}
              value={draft.reasoningEffort ?? "off"}
              onChange={(reasoningEffort) => patch({ reasoningEffort })}
            />
          </Field>

          {/* output style */}
          <Field label="Output style" flag="tone & verbosity">
            <SegmentedControl
              items={OUTPUT_ITEMS}
              value={draft.outputStyle ?? "default"}
              onChange={(outputStyle) => patch({ outputStyle })}
            />
          </Field>
        </div>

        {/* footer */}
        <div className="flex flex-none items-center gap-2 border-t border-hairline px-6 py-3">
          <span className="font-mono text-[10.5px] text-dim">
            Saved to <span className="text-muted-foreground">~/starbase/config.json</span>
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => setDraft(stored)}
          >
            <RotateCcw size={12} />
            Reset
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty}
            onClick={() => void onSaveProvider(selected, draft)}
          >
            Save
          </Button>
        </div>
      </div>
    </>
  )
}

// ── Small building blocks ────────────────────────────────────────────────────

/** A labelled lever block with an optional mono flag hint on the right. */
function Field({
  label,
  flag,
  children
}: {
  label: string
  flag?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Eyebrow className="flex-1">{label}</Eyebrow>
        {flag && <span className="font-mono text-[9.5px] text-dim">{flag}</span>}
      </div>
      {children}
    </div>
  )
}

/** A label+description row with a trailing control (dropdowns). */
function Row({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-body">{label}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  )
}

/** A radio-style model card. */
function ModelChoice({
  label,
  sub,
  selected,
  onSelect
}: {
  label: string
  sub: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-0.5 rounded-md border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-blue/45 bg-surface shadow-[0_0_0_3px_rgba(97,175,239,0.1)]"
          : "border-line bg-sunken hover:bg-surface"
      )}
    >
      <span className="text-[12.5px] font-medium text-text-bright">{label}</span>
      <span className="truncate font-mono text-[9.5px] text-dim">{sub}</span>
    </button>
  )
}

function ModelSelect({
  value,
  models,
  onChange
}: {
  value: string | undefined
  models: ReadonlyArray<ModelOption>
  onChange: (value: string | undefined) => void
}) {
  return (
    <Select
      value={value ?? HARNESS_DEFAULT}
      onValueChange={(v) => onChange(v === HARNESS_DEFAULT ? undefined : v)}
    >
      <SelectTrigger className="w-[190px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={HARNESS_DEFAULT}>Harness default</SelectItem>
        {models.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function StubSection({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-editor text-center">
      <span className="text-[14px] font-semibold text-text-body">{label}</span>
      <span className="max-w-[280px] text-[12px] leading-relaxed text-muted-foreground">
        This section isn&apos;t wired up yet — it&apos;s coming in a later pass.
      </span>
    </div>
  )
}

// ── GitHub section (migrated from the old settings modal) ────────────────────

const DEFAULT_GITHUB: GithubConfig = { enabled: false, autoCreatePr: false, autoDetectPr: true }
const DEFAULT_GIT: GitConfig = { shareCheckedOutBranches: true }

/**
 * Harnesses that can run an adversarial review. Cursor has no headless path yet.
 *
 * NOT a `Record<CliKind, …>`, so adding a harness won't break the build here —
 * a new kind must be added by hand or it silently never appears as a reviewer.
 */
const REVIEW_CLIS: ReadonlyArray<{ id: CliKind; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "opencode" }
]

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-body">{label}</div>
        <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">{description}</div>
      </div>
      <Toggle checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

function GithubSection({
  ghStatus,
  github,
  git,
  rechecking,
  loadModels,
  onRecheck,
  onSaveGithub,
  onSaveGit
}: {
  ghStatus: GhStatus
  github?: GithubConfig | null
  git?: GitConfig | null
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  rechecking?: boolean
  onRecheck?: () => void
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
}) {
  const [draft, setDraft] = React.useState<GithubConfig>(github ?? DEFAULT_GITHUB)
  const [gitDraft, setGitDraft] = React.useState<GitConfig>(git ?? DEFAULT_GIT)
  const [reviewModels, setReviewModels] = React.useState<ReadonlyArray<ModelOption>>([])

  React.useEffect(() => setDraft(github ?? DEFAULT_GITHUB), [github])
  React.useEffect(() => setGitDraft(git ?? DEFAULT_GIT), [git])

  const connected = ghStatus.available && ghStatus.authenticated
  const reviewCli: CliKind = draft.reviewCli ?? "claude"
  const reviewModel = reviewModelFor(reviewCli, draft.reviewModel)

  // Live model discovery for the chosen review harness; falls back to the
  // curated list offline. Guarded so a late response for a harness the user has
  // since switched away from can't overwrite the current list.
  React.useEffect(() => {
    if (!loadModels) return
    let stale = false
    void loadModels(reviewCli)
      .then((models) => {
        if (!stale) setReviewModels(models)
      })
      .catch(() => {
        if (!stale) setReviewModels([])
      })
    return () => {
      stale = true
    }
  }, [reviewCli, loadModels])

  // The Select renders blank unless an option matches its value, and discovery
  // may not surface the default (offline / no API key) — so always include it.
  const modelOptions: ReadonlyArray<ModelOption> = reviewModels.some((m) => m.id === reviewModel)
    ? reviewModels
    : [{ id: reviewModel, label: reviewModel }, ...reviewModels]
  // Persist each toggle immediately so this section needs no separate Save.
  const setGithub = (next: GithubConfig) => {
    setDraft(next)
    onSaveGithub?.(next)
  }
  const setGitCfg = (next: GitConfig) => {
    setGitDraft(next)
    onSaveGit?.(next)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor">
      <div className="flex max-w-[560px] flex-col gap-4 p-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <GithubMark size={14} className="text-text-bright" />
          <span className="text-[13px] font-semibold text-text-bright">GitHub</span>
        </div>

        <div className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-3 py-2.5">
          <StatusDot
            tone={connected ? "bg-green" : ghStatus.available ? "bg-yellow" : "bg-line-strong"}
            size={8}
            glow={connected}
          />
          <div className="flex-1">
            <div className="text-[12.5px] font-medium text-text-body">
              {connected
                ? `Connected as @${ghStatus.login ?? "user"}`
                : ghStatus.available
                  ? "GitHub CLI not authenticated"
                  : "GitHub CLI not installed"}
            </div>
            {connected && ghStatus.host && (
              <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                {ghStatus.host}
                {ghStatus.version ? ` · gh ${ghStatus.version}` : ""}
              </div>
            )}
          </div>
          {onRecheck && (
            <Button variant="secondary" size="sm" onClick={onRecheck} disabled={rechecking}>
              Recheck
            </Button>
          )}
        </div>

        {!connected && (
          <Callout tone="blue">
            Sign in from your terminal with{" "}
            <span className="font-mono text-text">gh auth login</span>, then Recheck. Pull-request
            features need it.
          </Callout>
        )}

        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Enable pull-request features"
            description="Show the Pull Request & Code Review tabs and allow posting reviews to GitHub."
            checked={draft.enabled}
            onChange={(enabled) => setGithub({ ...draft, enabled })}
          />
          <ToggleRow
            label="Auto-detect pull requests"
            description="Link a PR automatically when one is already open on a session's branch."
            checked={draft.autoDetectPr}
            disabled={!draft.enabled}
            onChange={(autoDetectPr) => setGithub({ ...draft, autoDetectPr })}
          />
          <ToggleRow
            label="Auto-create pull requests"
            description="Open a PR automatically once a session's branch has pushable commits."
            checked={draft.autoCreatePr}
            disabled={!draft.enabled}
            onChange={(autoCreatePr) => setGithub({ ...draft, autoCreatePr })}
          />
        </div>

        {/* Adversarial review */}
        <div className="mt-1 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">Adversarial review</span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Auto-run on new commits"
            description="Review a pull request automatically when it opens and each time its head advances. Runs at most once per commit."
            checked={draft.autoAdversarialReview ?? false}
            disabled={!draft.enabled}
            onChange={(autoAdversarialReview) => setGithub({ ...draft, autoAdversarialReview })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium text-text-body">Reviewer</div>
          <div className="text-[11px] leading-[1.5] text-muted-foreground">
            The harness and model that argue against your pull requests. Reviews run read-only in
            the session&apos;s worktree and never modify the branch. Kept separate from Providers on
            purpose — reviewing a diff with a stronger model than the one that wrote it is the point.
          </div>
          <div className="flex gap-2 pt-0.5">
            <div className="w-[132px] flex-none">
              <Select
                value={reviewCli}
                disabled={!draft.enabled}
                onValueChange={(value) =>
                  // Drop the model id: it is meaningless on a different harness,
                  // so the new harness's default applies instead.
                  setGithub({ ...draft, reviewCli: value as CliKind, reviewModel: undefined })
                }
              >
                <SelectTrigger aria-label="Review harness">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_CLIS.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 flex-1">
              <Select
                value={reviewModel}
                disabled={!draft.enabled}
                onValueChange={(value) => setGithub({ ...draft, reviewModel: value })}
              >
                <SelectTrigger aria-label="Review model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.id === DEFAULT_REVIEW_MODEL[reviewCli] ? `${m.label} · default` : m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="mt-1 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">Git</span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Open PRs whose branch is checked out elsewhere"
            description="Start a session from a PR even when its branch is already checked out in another worktree. The worktrees then share the branch."
            checked={gitDraft.shareCheckedOutBranches}
            onChange={(shareCheckedOutBranches) => setGitCfg({ shareCheckedOutBranches })}
          />
        </div>
      </div>
    </div>
  )
}
