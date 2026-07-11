import type { CliInfo } from "@starbase/core"
import { FolderOpen, Plus } from "lucide-react"
import { StatusDot } from "../components/status-dot.js"

/**
 * First-run / no-active-session empty state (design: "First Run Empty State").
 * A breathing spark hero, the pitch, the primary New-session CTA (+ optional
 * "Open a repo"), the agents discovered on this machine, and a shortcut hint
 * bar. Replaces the Storybook-only seeded demo so a fresh install lands clean.
 */
export function EmptyConversation({
  clis = [],
  version,
  onNewSession,
  onOpenRepo
}: {
  clis?: ReadonlyArray<CliInfo>
  version?: string
  onNewSession?: () => void
  onOpenRepo?: () => void
}) {
  const available = clis.filter((c) => c.available)
  return (
    <div className="flex flex-1 flex-col bg-editor">
      <div className="flex flex-1 flex-col items-center justify-center px-10">
        <div className="flex max-w-[452px] flex-col items-center text-center">
          <span className="mb-[26px] flex size-14 items-center justify-center rounded-[14px] border border-blue/30 bg-blue/10">
            <span className="animate-breathe font-mono text-[26px] font-semibold text-blue">✦</span>
          </span>

          <h1 className="m-0 mb-3 text-[20px] font-semibold tracking-[-0.2px] text-text-bright">
            Start your first session
          </h1>
          <p className="m-0 mb-7 text-[14px] leading-[1.6] text-text-body">
            Point an agent at a repo and it works on its own branch — tracking the diff, checks, and
            pull request as it goes. Run as many at once as you like.
          </p>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onNewSession}
              className="flex items-center gap-2 rounded-md bg-blue px-4 py-[9px] text-[13px] font-semibold text-editor outline-none transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus size={15} />
              New session
              <span className="ml-0.5 rounded-[3px] bg-editor/30 px-1.5 py-px font-mono text-[10px]">
                ⌘N
              </span>
            </button>
            {onOpenRepo && (
              <button
                type="button"
                onClick={onOpenRepo}
                className="flex items-center gap-2 rounded-md border border-line px-3.5 py-[9px] text-[13px] text-text-body outline-none transition-colors hover:bg-surface hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderOpen size={15} />
                Open a repo
              </button>
            )}
          </div>

          {available.length > 0 && (
            <div className="mt-11 flex w-full flex-col items-center gap-3.5 border-t border-hairline pt-[26px]">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
                Agents detected on this machine
              </span>
              <div className="flex flex-wrap justify-center gap-2.5">
                {available.map((cli) => (
                  <span
                    key={cli.kind}
                    title={`${cli.binPath ?? ""}${cli.version ? ` · ${cli.version}` : ""}`}
                    className="flex items-center gap-[7px] rounded-md border border-line bg-panel px-2.5 py-[5px] font-mono text-[11px] text-text-body"
                  >
                    <StatusDot tone="bg-green" size={6} glow={false} />
                    {cli.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Keyboard hint bar */}
      <div className="flex h-[38px] flex-none items-center gap-5 border-t border-hairline bg-panel px-[18px] text-[11px] text-dim">
        <Shortcut keys="⌘N" label="New session" />
        <Shortcut keys="⌘K" label="Command palette" />
        <Shortcut keys="⌘," label="Settings" />
        <div className="flex-1" />
        <span className="font-mono">{version ? `Starbase v${version}` : "Starbase"}</span>
      </div>
    </div>
  )
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-[7px]">
      <span className="rounded-[3px] border border-line px-1.5 py-px font-mono text-muted-foreground">
        {keys}
      </span>
      {label}
    </span>
  )
}
