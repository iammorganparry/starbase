import * as React from "react"
import type {
  CliInfo,
  CliKind,
  GhStatus,
  GitConfig,
  GithubConfig,
  McpServer,
  NotificationsConfig,
  McpServerStatus,
  ModelOption,
  OpencodeProviderInfo,
  OpencodeProviderSource,
  OutputStyle,
  PermissionMode,
  ProviderConfig,
  ProvidersConfig,
  ProviderModels,
  HarnessBilling,
  ReasoningEffort,
  ContextConfig,
  ContextSnapshot
} from "@starbase/core"
import {
  BUDGET_RANGE,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_REVIEW_MODEL,
  NOTIFICATIONS_DEFAULT,
  contextWindowFor,
  digestModelFor,
  reviewModelFor,
  triggerAt
} from "@starbase/core"
import { ContextMeter } from "./context-meter.js"
import {
  ChevronRight,
  Cpu,
  Keyboard,
  RotateCcw,
  Server,
  ShieldCheck,
  Gauge,
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
import { ORCHESTRATOR_DEFAULT } from "@starbase/core"
import { GigaplanSettings } from "./gigaplan-settings.js"
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
import { McpServerRow, mcpServerMeta, statusForServer } from "./mcp-server-row.js"
import { ProviderCard } from "./provider-card.js"

// ── Section registry ─────────────────────────────────────────────────────────

type SectionKey =
  | "general"
  | "providers"
  | "context"
  | "gigaplan"
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
  { key: "general", label: "General", icon: <SlidersHorizontal size={14} />, ready: true },
  { key: "providers", label: "Providers", icon: <Cpu size={14} />, ready: true },
  { key: "context", label: "Context", icon: <Gauge size={14} />, ready: true },
  { key: "gigaplan", label: "Gigaplan", icon: <Sparkles size={14} />, ready: true },
  { key: "agents", label: "Agents & skills", icon: <Sparkles size={14} />, ready: false },
  { key: "permissions", label: "Permissions", icon: <ShieldCheck size={14} />, ready: false },
  { key: "mcp", label: "MCP servers", icon: <Server size={14} />, ready: true },
  { key: "github", label: "GitHub", icon: <GithubMark size={14} />, ready: true },
  { key: "keybindings", label: "Keybindings", icon: <Keyboard size={14} />, ready: false }
]

// ── Provider lever option sets (labels ← design E10) ─────────────────────────

/**
 * Gigaplan is deliberately absent: this sets the mode NEW sessions start in, and
 * defaulting every new session to a mode that spends minutes and real money on
 * its first message would be indefensible. It is chosen per session, from the
 * composer's chip.
 */
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

/** How many unconfigured providers the browse list renders before asking for a narrower search. */
const BROWSE_LIMIT = 8

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
  /**
   * Why a save didn't land, or null. Keeps the key in the box so it can be
   * retried — the write failing is the one case the row itself can't show.
   */
  const [saveError, setSaveError] = React.useState<string | null>(null)
  /** Whether the rest of opencode's registry is open for browsing. */
  const [browsing, setBrowsing] = React.useState(false)
  const [filter, setFilter] = React.useState("")

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
    setSaveError(null)
    try {
      // The write can fail (opencode unreachable, its credential store
      // unwritable). Closing the form on `false` would tell the operator their
      // key landed when it didn't — they'd go hunting for a provider that never
      // got configured. Keep the input open, with what they typed still in it,
      // and say so.
      const ok = await onSetAuth(providerId, key.trim())
      if (!ok) {
        setSaveError("opencode didn't store the key. Check that it runs in your terminal.")
        return
      }
      setEditing(null)
      setKey("")
      // Re-read rather than patch local state: only opencode can say whether the
      // key actually RESOLVED the provider (and how many models it unlocked) —
      // it doesn't validate on write, so a stored key is not yet a working one.
      // The row's source badge and model count are the honest answer.
      refresh()
    } catch {
      setSaveError("Couldn't reach opencode to store the key.")
    } finally {
      setSaving(false)
    }
  }

  const row = (p: OpencodeProviderInfo) => (
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
        {p.source !== null && (
          <span className="ml-auto font-mono text-[10px] text-dim">
            {p.modelCount} {p.modelCount === 1 ? "model" : "models"}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing(editing === p.id ? null : p.id)
            setKey("")
            setSaveError(null)
          }}
          className={cn(
            "rounded border border-hairline px-1.5 py-px text-[10.5px] text-muted-foreground hover:text-text-bright",
            p.source === null && "ml-auto"
          )}
        >
          {/*
            Keyed on whether the provider resolves AT ALL, not on how. A provider
            live from an env var already HAS a key — offering to "Add" one next to
            a green dot and an "environment" badge reads as though none is present.
          */}
          {p.source === null ? "Add key" : "Replace key"}
        </button>
      </div>
      {/* Name the env var rather than making them go and find it. */}
      {p.source === null && p.env.length > 0 && (
        <span className="font-mono text-[10px] text-dim">or export {p.env.join(" / ")}</span>
      )}
      {editing === p.id && (
        <>
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              value={key}
              autoFocus
              onChange={(e) => {
                setKey(e.target.value)
                // Editing is the retry — don't keep shouting about the last attempt.
                setSaveError(null)
              }}
              placeholder={`${p.id} API key`}
              className={cn(
                "min-w-0 flex-1 rounded border bg-black/20 px-2 py-1 font-mono text-[11px] text-text-bright outline-none",
                saveError === null
                  ? "border-hairline focus:border-line-strong"
                  : "border-red/50 focus:border-red"
              )}
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
          {saveError !== null && <span className="text-[10.5px] text-red">{saveError}</span>}
        </>
      )}
    </div>
  )

  // Connected providers are the page's subject; the rest of opencode's registry
  // (~165 of them, most obscure) is a catalogue to search, not a list to read —
  // so it stays behind a disclosure and a filter.
  const connected = (providers ?? []).filter((p) => p.source !== null)
  const available = (providers ?? []).filter((p) => p.source === null)
  const needle = filter.trim().toLowerCase()
  const matches = needle
    ? available.filter((p) => p.name.toLowerCase().includes(needle) || p.id.includes(needle))
    : available

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
          <>
            {connected.length === 0 ? (
              <span className="py-1 text-[11.5px] text-dim">
                No providers configured yet — add a key below, or export one of their environment
                variables.
              </span>
            ) : (
              connected.map(row)
            )}

            {available.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setBrowsing((b) => !b)
                    setFilter("")
                  }}
                  className="mt-0.5 flex items-center gap-1.5 self-start text-[11px] text-muted-foreground hover:text-text-bright"
                >
                  <ChevronRight
                    size={12}
                    className={cn("transition-transform", browsing && "rotate-90")}
                  />
                  Add a provider
                  <span className="font-mono text-[10px] text-dim">({available.length})</span>
                </button>

                {browsing && (
                  <>
                    <input
                      value={filter}
                      autoFocus
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search providers…"
                      className="rounded border border-hairline bg-black/20 px-2 py-1 text-[11.5px] text-text-bright outline-none focus:border-line-strong"
                    />
                    {matches.length === 0 ? (
                      <span className="py-1 text-[11.5px] text-dim">
                        No provider matches “{filter}”.
                      </span>
                    ) : (
                      /*
                        Capped: opencode knows ~167 providers, and rendering the
                        tail of that list helps nobody — searching does. The count
                        below says what's hidden rather than pretending this is all.
                      */
                      matches.slice(0, BROWSE_LIMIT).map(row)
                    )}
                    {matches.length > BROWSE_LIMIT && (
                      <span className="text-[10.5px] text-dim">
                        {matches.length - BROWSE_LIMIT} more — keep typing to narrow.
                      </span>
                    )}
                  </>
                )}
              </>
            )}
          </>
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
  /** Every installed harness + its models, for the Gigaplan orchestrator picker. */
  catalog?: ReadonlyArray<ProviderModels>
  /** The configured orchestrator harness+model, or null for the default. */
  orchestrator?: { readonly cli: CliKind; readonly model: string } | null
  /** Persist the orchestrator's harness+model. */
  onSaveOrchestrator?: (cli: CliKind, model: string) => void
  /** Why Gigaplan can't run on this host, when it can't. */
  gigaplanUnavailableReason?: string | null
  /** What each installed harness is charged to. */
  billing?: ReadonlyArray<HarnessBilling>
  /** Load the selectable models for a CLI (live discovery). */
  loadModels: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  /** opencode's resolved providers + credential origins (opencode only). */
  loadOpencodeProviders?: () => Promise<ReadonlyArray<OpencodeProviderInfo>>
  /** Store an API key in opencode's own credential file (opencode only). */
  onSetOpencodeAuth?: (providerId: string, key: string) => Promise<boolean>
  /**
   * MCP servers the given harness will load. Settings has no session, so this is
   * user scope only — project `.mcp.json` needs a worktree, which only the composer has.
   */
  loadMcpServers?: (cli: CliKind) => Promise<ReadonlyArray<McpServer>>
  /** Live status for those servers; `refresh` re-probes rather than reading the cache. */
  loadMcpStatus?: (cli: CliKind, refresh: boolean) => Promise<ReadonlyArray<McpServerStatus>>
  /** Auto-compaction levers (master switch + working-set budget). */
  context?: ContextConfig | null
  onSaveContext?: (config: ContextConfig) => void
  /**
   * Live context readings per open session, so the budget slider can be set
   * against what sessions are ACTUALLY using rather than in the abstract.
   */
  contextSessions?: ReadonlyArray<{
    id: string
    title: string
    cli: CliKind
    snapshot: ContextSnapshot
  }>
  // GitHub section (reused from the old settings modal).
  ghStatus: GhStatus
  github?: GithubConfig | null
  git?: GitConfig | null
  rechecking?: boolean
  onRecheck?: () => void
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
  /** Desktop-notification prefs; absent means the defaults, not "off". */
  notifications?: NotificationsConfig | null
  onSaveNotifications?: (config: NotificationsConfig) => void | Promise<void>
  /** Whether plan mode runs commands unattended; absent means on. */
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => void | Promise<void>
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
  catalog,
  orchestrator,
  onSaveOrchestrator,
  gigaplanUnavailableReason,
  billing,
  loadModels,
  loadOpencodeProviders,
  onSetOpencodeAuth,
  loadMcpServers,
  loadMcpStatus,
  context,
  onSaveContext,
  contextSessions,
  ghStatus,
  github,
  git,
  rechecking,
  onRecheck,
  onSaveGithub,
  onSaveGit,
  notifications,
  onSaveNotifications,
  planAutoRun,
  onSavePlanAutoRun,
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

      {section === "general" ? (
        <GeneralSection
          notifications={notifications}
          onSaveNotifications={onSaveNotifications}
          planAutoRun={planAutoRun}
          onSavePlanAutoRun={onSavePlanAutoRun}
        />
      ) : section === "providers" ? (
        <ProvidersSection
          clis={clis}
          providers={providers ?? undefined}
          onSaveProvider={onSaveProvider}
          loadModels={loadModels}
          loadOpencodeProviders={loadOpencodeProviders}
          onSetOpencodeAuth={onSetOpencodeAuth}
        />
      ) : section === "context" ? (
        <ContextSection
          clis={clis}
          context={context}
          providers={providers ?? undefined}
          sessions={contextSessions}
          onSaveContext={onSaveContext}
          onSaveProvider={onSaveProvider}
        />
      ) : section === "gigaplan" ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
          <GigaplanSettings
            catalog={catalog ?? []}
            orchestrator={orchestrator ?? null}
            defaultOrchestrator={ORCHESTRATOR_DEFAULT}
            onChange={onSaveOrchestrator ?? (() => {})}
            unavailableReason={gigaplanUnavailableReason ?? null}
            billing={billing}
          />
        </div>
      ) : section === "mcp" ? (
        <McpSection clis={clis} loadMcpServers={loadMcpServers} loadMcpStatus={loadMcpStatus} />
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


// ── Context section (auto-compaction levers) ─────────────────────────────────

/** "300k" / "1M" — the budget slider's tick labels. */
const fmtK = (n: number): string =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`

/**
 * Settings → Context.
 *
 * Every token lever in one place, because the numbers only make sense together:
 * a budget is meaningless without knowing what the sessions are actually using,
 * and the digest model is meaningless without knowing it runs on the user's own
 * subscription. Showing them apart would make each look arbitrary.
 */
function ContextSection({
  clis,
  context,
  providers,
  sessions,
  onSaveContext,
  onSaveProvider
}: {
  clis: ReadonlyArray<CliInfo>
  context?: ContextConfig | null
  providers?: ProvidersConfig
  sessions?: ReadonlyArray<{ id: string; title: string; cli: CliKind; snapshot: ContextSnapshot }>
  onSaveContext?: (config: ContextConfig) => void
  onSaveProvider?: (cli: CliKind, config: ProviderConfig) => void
}) {
  const [draft, setDraft] = React.useState<ContextConfig>(context ?? DEFAULT_CONTEXT_CONFIG)
  React.useEffect(() => setDraft(context ?? DEFAULT_CONTEXT_CONFIG), [context])

  const save = (next: ContextConfig) => {
    setDraft(next)
    onSaveContext?.(next)
  }

  const measurable = clis.filter((c) => c.available && c.contextReporting)
  const unmeasurable = clis.filter((c) => c.available && !c.contextReporting)

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor">
      <div className="flex max-w-[560px] flex-col gap-4 p-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <Gauge size={14} className="text-text-bright" />
          <span className="text-[13px] font-semibold text-text-bright">Context</span>
        </div>

        <Callout tone="blue">
          Long conversations lose accuracy well before they hit a model&apos;s limit.
          Starbase summarises a session in the background once it outgrows the
          budget below, then quietly continues from that summary — your transcript
          is never truncated.
        </Callout>

        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Compact sessions automatically"
            description="Summarise and reseed in the background when a session outgrows its budget. Off returns Starbase to relying on each harness's own limit."
            checked={draft.auto}
            onChange={(auto) => save({ ...draft, auto })}
          />
        </div>

        {/* ── The budget ── */}
        <div className={draft.auto ? "" : "pointer-events-none opacity-50"}>
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium text-text-body">Working-set budget</span>
            <span className="font-mono text-[12px] tabular-nums text-text-bright">
              {fmtK(draft.budgetTokens)} tokens
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
            How much conversation a session carries before it is compacted. Lower
            keeps answers sharper; higher keeps more raw history in play.
          </p>
          <input
            type="range"
            min={BUDGET_RANGE.min}
            max={BUDGET_RANGE.max}
            step={8_000}
            value={draft.budgetTokens}
            disabled={!draft.auto}
            onChange={(e) => save({ ...draft, budgetTokens: Number(e.target.value) })}
            aria-label="Working-set budget"
            className="mt-2.5 w-full accent-blue"
          />
          <div className="flex justify-between font-mono text-[10px] text-dim">
            <span>{fmtK(BUDGET_RANGE.min)}</span>
            <span>sharper ← → more history</span>
            <span>{fmtK(BUDGET_RANGE.max)}</span>
          </div>
        </div>

        {/* ── What that means per harness ── */}
        <div className="rounded-lg border border-line bg-sunken p-3">
          <Eyebrow>Compacts at</Eyebrow>
          <p className="mb-2 mt-1 text-[11px] leading-[1.5] text-muted-foreground">
            A model whose window is smaller than the budget compacts earlier, so it
            never reaches its own hard limit.
          </p>
          <div className="space-y-1">
            {measurable.map((cli) => (
              <div key={cli.kind} className="flex items-center justify-between">
                <span className="text-[12px] text-text-body">{cli.label}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {(() => {
                    const w = contextWindowFor(cli.kind, null, providers?.[cli.kind]?.contextWindow)
                    return w === null
                      ? "set a window below"
                      : `${fmtK(triggerAt(w, draft.budgetTokens))} of ${fmtK(w)}`
                  })()}
                </span>
              </div>
            ))}
            {unmeasurable.map((cli) => (
              <div key={cli.kind} className="flex items-center justify-between">
                <span className="text-[12px] text-text-body">{cli.label}</span>
                <span className="font-mono text-[11px] text-dim">reports no usage</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Live sessions ── */}
        {sessions !== undefined && sessions.length > 0 && (
          <div className="rounded-lg border border-line bg-sunken p-3">
            <Eyebrow>Your sessions right now</Eyebrow>
            <div className="mt-1.5 space-y-1.5">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-body">{s.title}</span>
                  {s.snapshot.triggerAt === null ? (
                    <span className="font-mono text-[10.5px] text-dim">not measurable</span>
                  ) : (
                    <ContextMeter
                      tokens={s.snapshot.tokens}
                      triggerAt={s.snapshot.triggerAt}
                      phase={s.snapshot.phase}
                      preparing={s.snapshot.preparing}
                      digestReady={s.snapshot.digestReady}
                      stalled={s.snapshot.stalled}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── The digest model ── */}
        <div>
          <div className="text-[12.5px] font-medium text-text-body">Summarised by</div>
          <p className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
            Summaries run through the CLI you have already signed in to, on its
            cheapest tier — no API key, and nothing billed outside your existing
            plan. This is the same &quot;background model&quot; used for side tasks.
          </p>
          <div className="mt-2 space-y-2">
            {measurable.map((cli) => {
              const provider = providers?.[cli.kind]
              return (
                <div key={cli.kind} className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-text-body">{cli.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {digestModelFor(cli.kind, provider?.backgroundModel)}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-[10.5px] text-dim">
            Change these under Providers → Background model.
          </p>
        </div>

        {/* ── Window override ── */}
        {onSaveProvider && (
          <div>
            <div className="text-[12.5px] font-medium text-text-body">Context window override</div>
            <p className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
              Starbase infers each model&apos;s window, but opencode resolves models
              from your own credentials across many providers, so there is no
              reliable default. Set one here to enable auto-compaction for it.
            </p>
            <div className="mt-2 space-y-2">
              {clis
                // Only harnesses that DO report usage but whose window we cannot
                // infer. Offering this for Cursor would be a dead control: it
                // reports no context at all, so a declared window still leaves
                // nothing to measure against.
                .filter(
                  (c) => c.available && c.contextReporting && contextWindowFor(c.kind, null) === null
                )
                .map((cli) => {
                  const provider = providers?.[cli.kind]
                  return (
                    <div key={cli.kind} className="flex items-center justify-between gap-3">
                      <span className="text-[12px] text-text-body">{cli.label}</span>
                      <input
                        type="number"
                        min={0}
                        step={1000}
                        placeholder="unknown"
                        aria-label={`${cli.label} context window`}
                        defaultValue={provider?.contextWindow ?? ""}
                        onBlur={(e) => {
                          const raw = Number(e.target.value)
                          onSaveProvider(cli.kind, {
                            enabled: provider?.enabled ?? true,
                            defaultMode: provider?.defaultMode ?? "accept-edits",
                            ...provider,
                            ...(Number.isFinite(raw) && raw > 0
                              ? { contextWindow: raw }
                              : { contextWindow: undefined })
                          })
                        }}
                        className="w-[128px] rounded-md border border-line bg-editor px-2 py-1 text-right font-mono text-[11px] tabular-nums text-text-body"
                      />
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </div>
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

/**
 * Settings → General. Today that means desktop notifications.
 *
 * Per-kind toggles rather than one switch, because the kinds are not equally
 * interruptive: an operator who mutes "finished" (frequent, rarely urgent) must
 * not thereby lose "needs input", which is the one whose absence actually costs
 * them a stalled agent. Sound is separate again — it interrupts a room.
 *
 * Saves on every toggle. There is no Save button because there is nothing to
 * review: each switch is independently meaningful and instantly reversible.
 */
function GeneralSection({
  notifications,
  onSaveNotifications,
  planAutoRun,
  onSavePlanAutoRun
}: {
  notifications?: NotificationsConfig | null
  onSaveNotifications?: (config: NotificationsConfig) => void | Promise<void>
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => void | Promise<void>
}) {
  // Absent means ON, matching `PLAN_AUTO_RUN_DEFAULT` in the domain.
  const [planDraft, setPlanDraft] = React.useState<boolean>(planAutoRun ?? true)
  React.useEffect(() => setPlanDraft(planAutoRun ?? true), [planAutoRun])
  // Absent config means the DEFAULTS, not silence — an operator who never opened
  // this pane should still be told when an agent needs them.
  const [draft, setDraft] = React.useState<NotificationsConfig>(
    notifications ?? NOTIFICATIONS_DEFAULT
  )
  React.useEffect(() => {
    if (notifications) setDraft(notifications)
  }, [notifications])

  const set = (patch: Partial<NotificationsConfig>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    void onSaveNotifications?.(next)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="mb-1 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">Planning</span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Run commands while planning"
            description="Plan mode can't edit files, so its commands only read — git log, ripgrep, gh pr view. Leave this on and planning runs uninterrupted; switch it off to approve each command."
            checked={planDraft}
            onChange={(next) => {
              setPlanDraft(next)
              void onSavePlanAutoRun?.(next)
            }}
          />
        </div>

        <div className="mb-1 mt-6 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">Notifications</span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Desktop notifications"
            description="Tell me when a session needs me or stops, while Starbase is in the background."
            checked={draft.enabled}
            onChange={(enabled) => set({ enabled })}
          />
          <ToggleRow
            label="Needs input"
            description="An agent is blocked waiting on your approval or an answer."
            checked={draft.needsInput}
            disabled={!draft.enabled}
            onChange={(needsInput) => set({ needsInput })}
          />
          <ToggleRow
            label="Run finished"
            description="An agent completed its turn."
            checked={draft.done}
            disabled={!draft.enabled}
            onChange={(done) => set({ done })}
          />
          <ToggleRow
            label="Run failed"
            description="An agent's run ended in an error."
            checked={draft.failed}
            disabled={!draft.enabled}
            onChange={(failed) => set({ failed })}
          />
          <ToggleRow
            label="Pull request resolved"
            description="A session's pull request was merged or closed on GitHub."
            checked={draft.pr}
            disabled={!draft.enabled}
            onChange={(pr) => set({ pr })}
          />
          <ToggleRow
            label="Play a sound"
            description="Use the system notification sound instead of showing them silently."
            checked={draft.sound}
            disabled={!draft.enabled}
            onChange={(sound) => set({ sound })}
          />
        </div>
        <p className="mt-4 text-[11px] leading-[1.6] text-muted-foreground">
          Notifications are suppressed for the session you already have open and focused —
          you can see that one for yourself.
        </p>
      </div>
    </div>
  )
}

/**
 * Settings → MCP servers.
 *
 * Reads the selected harness's OWN config — Starbase defines no MCP format of its
 * own, so this is a mirror, not a store, and there is nothing here to save.
 *
 * SCOPE: Settings has no session and therefore no worktree, so it can only show
 * user-scope servers. A project's `.mcp.json` lives against a worktree and is shown
 * in the composer's MCP dialog instead. The note in the header says so, because the
 * nav footer's "user scope" claim would otherwise read as a limitation of Starbase
 * rather than of this screen.
 */
function McpSection({
  clis,
  loadMcpServers,
  loadMcpStatus
}: {
  clis: ReadonlyArray<CliInfo>
  loadMcpServers?: (cli: CliKind) => Promise<ReadonlyArray<McpServer>>
  loadMcpStatus?: (cli: CliKind, refresh: boolean) => Promise<ReadonlyArray<McpServerStatus>>
}) {
  const [selected, setSelected] = React.useState<CliKind>(clis[0]?.kind ?? "claude")
  // null = still loading; [] = the harness genuinely has nothing configured.
  const [servers, setServers] = React.useState<ReadonlyArray<McpServer> | null>(null)
  const [statuses, setStatuses] = React.useState<ReadonlyArray<McpServerStatus>>([])
  const [probing, setProbing] = React.useState(false)
  /** Read inside late callbacks — `selected` there is captured at call time. */
  const selectedRef = React.useRef(selected)
  React.useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  // Guarded so a late response for a harness the user has since switched away
  // from can't overwrite the current list (same shape as GithubSection's models).
  React.useEffect(() => {
    if (!loadMcpServers) return
    let stale = false
    setServers(null)
    setStatuses([])
    void loadMcpServers(selected)
      .then((next) => {
        if (!stale) setServers(next)
      })
      .catch(() => {
        if (!stale) setServers([])
      })
    return () => {
      stale = true
    }
  }, [selected, loadMcpServers])

  /**
   * Probing spawns the servers' own commands, so it is never automatic — the
   * operator asks for it. Until then rows show their configured state only.
   */
  const probe = React.useCallback(
    (refresh: boolean) => {
      if (!loadMcpStatus) return
      // Guard the response against a harness switch mid-flight, exactly as the
      // servers effect does. Without this, claude's statuses land against codex's
      // list and the button flips to "Recheck" for a harness never probed.
      const probedCli = selected
      setProbing(true)
      void loadMcpStatus(selected, refresh)
        .then((next) => setStatuses((held) => (probedCli === selectedRef.current ? next : held)))
        .catch(() => setStatuses((held) => (probedCli === selectedRef.current ? [] : held)))
        .finally(() => setProbing(false))
    },
    [selected, loadMcpStatus]
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor">
      <div className="flex max-w-[560px] flex-col gap-4 p-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <Server size={14} className="text-text-bright" />
          <span className="text-[13px] font-semibold text-text-bright">MCP servers</span>
        </div>

        <Callout tone="blue">
          Starbase reads each harness&apos;s own MCP config — edit it where the harness
          expects it, and the change shows up here. This screen shows{" "}
          <span className="font-mono text-text">user scope</span> only; a repo&apos;s project
          servers appear in a session&apos;s MCP status dialog.
        </Callout>

        {clis.length > 1 && (
          <SegmentedControl
            value={selected}
            onChange={(kind) => setSelected(kind as CliKind)}
            items={clis.map((c) => ({ value: c.kind, label: PROVIDER_LABEL[c.kind] ?? c.kind }))}
          />
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-dim">
            Configured for {selected}
          </span>
          {loadMcpStatus && servers !== null && servers.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => probe(statuses.length > 0)}
              disabled={probing}
            >
              {probing ? "Checking…" : statuses.length > 0 ? "Recheck" : "Check status"}
            </Button>
          )}
        </div>

        {servers === null ? (
          <span className="py-2 text-[11.5px] text-dim">Reading {selected}&apos;s config…</span>
        ) : servers.length === 0 ? (
          <span className="py-2 text-[11.5px] text-dim">
            {selected} has no MCP servers configured. Add one where {selected} expects it and it
            will appear here.
          </span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {servers.map((server) => {
              const status = statusForServer(server, statuses)
              return (
                <McpServerRow
                  key={`${server.scope}:${server.name}`}
                  name={server.name}
                  transport={server.transport}
                  enabled={server.enabled}
                  state={status?.state}
                  meta={mcpServerMeta(server, status, { includeScope: true })}
                />
              )
            })}
          </div>
        )}
      </div>
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
