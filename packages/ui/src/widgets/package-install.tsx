import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { DiffStat } from "../components/diff-stat.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel, scrapeDuration } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W3 — an install: what moved in the dependency tree, and whether the lockfile moved with it. */

const MANAGERS = /^(pnpm|npm|yarn|bun)$/
const INSTALL_SUBS = /^(install|i|add|remove|rm|uninstall|ci|update|up)$/

/** How many dependency rows before the list becomes a wall. The rest collapse to "+N more". */
const ROW_CAP = 5

export interface InstalledPackage {
  name: string
  /** Null when the manager printed a bare name — a link, or an alias. */
  version: string | null
  change: "add" | "remove"
}

export interface PackageInstallProps {
  command: string
  status: ToolCallStatus
  resolved: number | null
  reused: number | null
  downloaded: number | null
  added: number
  removed: number
  /**
   * The per-package list. Empty is normal, not a failure: npm prints counts and
   * no names at all, and the widget still has something true to say.
   */
  packages: ReadonlyArray<InstalledPackage>
  duration: string | null
  /** True/false when the manager said so; null when it said nothing either way. */
  lockfileUpdated: boolean | null
}

/**
 * pnpm's `Progress: resolved 412, reused 400, downloaded 12, added 12, done`.
 *
 * pnpm rewrites this line as it works, so a captured log holds many of them at
 * increasing counts. The last one is the finished tally — take that, not the
 * first, or the widget reports a snapshot of the middle of the install.
 */
const progressLine = (out: string) => {
  const lines = [...out.matchAll(/^.*\bProgress:.*$/gm)]
  const last = lines[lines.length - 1]?.[0]
  if (!last) return null
  const field = (word: string) => {
    const m = new RegExp(`\\b${word}\\s+(\\d+)`).exec(last)
    return m?.[1] ? Number(m[1]) : null
  }
  return {
    resolved: field("resolved"),
    reused: field("reused"),
    downloaded: field("downloaded"),
    added: field("added")
  }
}

/** pnpm's `Packages: +12 -3` — the only place pnpm states a removal count. */
const packagesLine = (out: string) => {
  const m = /^\s*Packages:\s*(?:\+(\d+))?\s*(?:-(\d+))?\s*$/m.exec(out)
  if (!m || (!m[1] && !m[2])) return null
  return { added: m[1] ? Number(m[1]) : 0, removed: m[2] ? Number(m[2]) : 0 }
}

/**
 * npm's one-liner: `added 12 packages, removed 3 packages, and audited 412
 * packages in 6s`.
 *
 * Each clause is optional and npm reorders them, so match each independently
 * rather than trying to spell the whole sentence.
 */
const npmSummary = (out: string) => {
  const field = (word: string) => {
    const m = new RegExp(`\\b${word}\\s+(\\d+)\\s+packages?\\b`).exec(out)
    return m?.[1] ? Number(m[1]) : null
  }
  const added = field("added")
  const removed = field("removed")
  // `audited N` is npm's count of the whole resolved tree — the same fact pnpm
  // calls `resolved`, under a different name.
  const audited = field("audited")
  const changed = field("changed")
  if (added === null && removed === null && audited === null && changed === null) return null
  return { added, removed, audited }
}

/**
 * `+ zod 3.23.8` / `- jest 29.7.0` under a `dependencies:` heading.
 *
 * Not anchored to the line end: pnpm suffixes notes (`(5.5.2 is available)`,
 * `deprecated`) that would otherwise drop the package entirely. pnpm's own
 * `++++++---` progress bar can't match — it has no space after the sign.
 */
const DEP_ROW = /^([+-])\s+(\S+)(?:\s+(\S+))?/gm

const depRows = (out: string): InstalledPackage[] =>
  [...out.matchAll(DEP_ROW)].map((m) => ({
    name: m[2]!,
    version: m[3] ?? null,
    change: m[1] === "+" ? "add" : "remove"
  }))

/**
 * Lockfile state, when it's stated.
 *
 * Null is a real answer — `pnpm add` says nothing about the lockfile, and the
 * footer would rather omit the note than guess at it.
 */
const lockfileState = (out: string): boolean | null => {
  if (/lockfile is up to date|lockfile is up-to-date/i.test(out)) return false
  if (/updating lockfile|lockfile\b[^\n]*\b(updated|written)/i.test(out)) return true
  return null
}

export const parsePackageInstall = (ctx: ParseContext): PackageInstallProps | null => {
  const out = ctx.output
  // Nothing printed yet: there is no delta to show. The plain card carries it
  // until the manager says something.
  if (!out) return null

  const progress = progressLine(out)
  const packages = packagesLine(out)
  const npm = npmSummary(out)
  const rows = depRows(out)

  // Neither a tally nor a single dependency row — this isn't an install log we
  // recognise (a lockfile conflict, a registry 403). Decline.
  if (!progress && !packages && !npm && rows.length === 0) return null

  const countOf = (change: InstalledPackage["change"]) => rows.filter((r) => r.change === change).length

  return {
    command: ctx.command.primary,
    status: ctx.status,
    resolved: progress?.resolved ?? npm?.audited ?? null,
    reused: progress?.reused ?? null,
    downloaded: progress?.downloaded ?? null,
    // The tallies outrank the rows: pnpm lists only your direct dependencies but
    // counts the whole transitive install, and the bigger number is the true one.
    added: packages?.added ?? progress?.added ?? npm?.added ?? countOf("add"),
    removed: packages?.removed ?? npm?.removed ?? countOf("remove"),
    packages: rows,
    duration: scrapeDuration(out),
    lockfileUpdated: lockfileState(out)
  }
}

const lockfileNote = (state: boolean | null) =>
  state === null ? null : state ? "lockfile updated" : "lockfile unchanged"

export function PackageInstallWidget(p: PackageInstallProps) {
  const running = p.status === "running"
  const shown = p.packages.slice(0, ROW_CAP)
  const extra = p.packages.length - shown.length
  const note = lockfileNote(p.lockfileUpdated)

  const progress: Array<[string, number]> = []
  if (p.resolved !== null) progress.push(["resolved", p.resolved])
  if (p.reused !== null) progress.push(["reused", p.reused])
  if (p.downloaded !== null) progress.push(["downloaded", p.downloaded])

  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      headerMeta={
        running ? <span className="text-yellow">installing…</span> : <span className="text-dim">{p.duration}</span>
      }
      footer={
        <span className="flex items-center gap-1.5">
          <span className={p.status === "error" ? "text-red" : running ? "text-yellow" : "text-green"}>
            {p.status === "error" ? "Failed" : running ? "Installing" : "Done"}
          </span>
          {p.added + p.removed > 0 && (
            <>
              <span className="text-dim">·</span>
              <DiffStat added={p.added} removed={p.removed} className="text-[11px]" />
            </>
          )}
          {note && (
            <>
              <span className="text-dim">·</span>
              <span className="text-dim">{note}</span>
            </>
          )}
        </span>
      }
      footerMeta={exitLabel(p.status) ?? undefined}
    >
      <WidgetBody>
        {progress.length > 0 && (
          <div className="font-mono text-[11.5px] text-muted-foreground">
            <span className="text-green">✓</span>{" "}
            {progress.map(([label, value], i) => (
              <span key={label}>
                {i > 0 && " · "}
                {label} <span className="text-text-bright tabular-nums">{value}</span>
              </span>
            ))}
          </div>
        )}

        {shown.length > 0 && (
          <div className="flex flex-col gap-[5px] font-mono text-[12px]">
            {shown.map((pkg, i) => {
              const add = pkg.change === "add"
              return (
                <div key={`${i}-${pkg.name}`} className="flex items-center gap-2">
                  <span className={cn("w-2.5 flex-none text-center", add ? "text-green" : "text-red")}>
                    {add ? "+" : "−"}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", add ? "text-text-bright" : "text-muted-foreground")}>
                    {pkg.name}
                  </span>
                  {pkg.version && <span className="flex-none text-dim tabular-nums">{pkg.version}</span>}
                </div>
              )
            })}
            {extra > 0 && <span className="pl-[19px] font-mono text-[11px] text-dim">+{extra} more</span>}
          </div>
        )}
      </WidgetBody>
    </CommandWidget>
  )
}

export const packageInstallWidget = defineWidget<PackageInstallProps>({
  id: "package-install",
  match: (c) => MANAGERS.test(c.program) && c.sub !== null && INSTALL_SUBS.test(c.sub),
  parse: parsePackageInstall,
  render: (p) => <PackageInstallWidget {...p} />
})
