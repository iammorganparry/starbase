import { GitBranch } from "lucide-react"
import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { DiffStat } from "../components/diff-stat.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W9 — a commit and where it went: the subject, the diff, the remote it landed on. */

const GIT_SUBS =
  /^(commit|push|pull|merge|rebase|status|add|checkout|switch|tag|fetch)$/
/**
 * Of the git sub-commands we match, only commit and push print a summary worth
 * redrawing. `git status`, `git add`, `git fetch` and friends have no shape to
 * read, so they decline here and fall back to the plain card — matching them at
 * all is only so this widget, not a later one, gets the first refusal.
 */
const SUMMARISED_SUBS = /^(commit|push)$/

export interface CommitFile {
  path: string
  added: number
  removed: number
}

export interface GitPush {
  /** The destination as we can honestly name it: `origin/feat/oauth`, or the URL. */
  remote: string
  /** `3af12e9..9d4c1a2`. Null for a brand-new branch — there's no range yet. */
  range: string | null
}

export interface GitOpProps {
  command: string
  status: ToolCallStatus
  /** The adapter-reported exit meta (codex\'s real code), or null. */
  exit: string | null
  branch: string | null
  sha: string | null
  subject: string | null
  /** Per-file stats. Empty whenever the command didn't ask for them — see `commitFiles`. */
  files: ReadonlyArray<CommitFile>
  filesChanged: number | null
  insertions: number | null
  deletions: number | null
  push: GitPush | null
}

/** `[feat/oauth 3af12e9] fix: guard webhook payload` — also `[detached HEAD 3af12e9]`. */
const COMMIT_LINE = /^\[(.+?)\s+([0-9a-f]{7,40})\]\s*(.*)$/m

/** ` 3 files changed, 47 insertions(+), 12 deletions(-)` — clauses drop out when zero. */
const SHORTSTAT = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/m

/** `18\t4\tsrc/api/webhook.ts` — `--numstat`, the only exact per-file source. */
const NUMSTAT_ROW = /^(\d+)\t(\d+)\t(.+)$/gm

/** ` src/api/webhook.ts | 22 +++++++++---` — `--stat`'s histogram. */
const STAT_ROW = /^\s*(\S+)\s*\|\s*(\d+)\s+([+-]+)\s*$/gm

/**
 * Per-file added/removed counts, when the command asked for them.
 *
 * `git commit` alone prints none of this — the rows come from `--stat` or a
 * preceding `git diff --numstat`. Nothing is invented when they're absent; the
 * widget just drops the rows and keeps the summary line.
 *
 * `--stat` is only trusted when the `+`/`-` glyphs add up to the count beside
 * them. Past the terminal width git *scales* the bar, so the glyphs become a
 * proportion rather than a tally — and a scaled bar reading "+18 −4" would be a
 * number we made up.
 */
const commitFiles = (out: string): CommitFile[] => {
  const numstat = [...out.matchAll(NUMSTAT_ROW)].map((m) => ({
    added: Number(m[1]),
    removed: Number(m[2]),
    path: m[3]!.trim()
  }))
  if (numstat.length > 0) return numstat

  const files: CommitFile[] = []
  for (const m of out.matchAll(STAT_ROW)) {
    const total = Number(m[2])
    const bar = m[3]!
    const added = (bar.match(/\+/g) ?? []).length
    const removed = (bar.match(/-/g) ?? []).length
    if (added + removed !== total) continue
    files.push({ path: m[1]!, added, removed })
  }
  return files
}

/** `To github.com:trigify/starbase.git` — the header of a push summary. */
const TO_LINE = /^To\s+(\S+)\s*$/m

/**
 * `   3af12e9..9d4c1a2  feat/oauth -> feat/oauth`, or, first time out,
 * ` * [new branch]      feat/oauth -> feat/oauth`.
 */
const REF_LINE = /^\s*(?:\*\s+)?(?:\[new branch\]|([0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}))\s+(\S+)\s*->\s*(\S+)/m

/**
 * What to call the place the commits went.
 *
 * git only names the remote (`origin`) when it's told to — `git push` on its own
 * prints the URL and nothing else. So: take git's own `set up to track` line if
 * it's there, else pair the remote the command named with the branch git
 * reported, else fall back to the URL verbatim. We never assume `origin`; the
 * whole point of the line is that it says where the code actually is.
 */
const pushRemote = (out: string, raw: string, dst: string | null, url: string): string => {
  const tracked = /\bto track '([^']+)'/.exec(out)?.[1]
  if (tracked) return tracked
  // `git push -u origin feat/oauth` → the first bare word after `push`.
  const named = /\bgit\s+push\b((?:\s+-{1,2}[\w-]+)*)\s+([\w.@-]+)/.exec(raw)?.[2]
  if (named && dst) return `${named}/${dst}`
  return url
}

const parsePush = (out: string, raw: string): GitPush | null => {
  const url = TO_LINE.exec(out)?.[1]
  // No `To …` header means nothing was pushed — including "Everything
  // up-to-date", which is a push that moved no commits.
  if (!url) return null
  const ref = REF_LINE.exec(out)
  const dst = ref?.[3] ?? null
  return { remote: pushRemote(out, raw, dst, url), range: ref?.[1] ?? null }
}

export const parseGitOp = (ctx: ParseContext): GitOpProps | null => {
  const out = ctx.output
  if (!out) return null
  if (ctx.command.sub === null || !SUMMARISED_SUBS.test(ctx.command.sub)) return null

  const commit = COMMIT_LINE.exec(out)
  const push = parsePush(out, ctx.command.raw)
  // A rejected push, a pre-commit hook that bailed, `nothing to commit` — no
  // summary to redraw, so the plain card shows the real message instead.
  if (!commit && !push) return null

  const stat = SHORTSTAT.exec(out)
  const ref = REF_LINE.exec(out)

  return {
    /*
     * The raw command, not `primary`: `git commit -m … && git push` produces one
     * card summarising both halves, and `primary` is only the `git push` tail.
     */
    command: ctx.command.raw,
    status: ctx.status,
    exit: ctx.meta,
    branch: commit?.[1] ?? ref?.[2] ?? null,
    sha: commit?.[2] ?? null,
    subject: commit?.[3]?.trim() || null,
    files: commitFiles(out),
    filesChanged: stat?.[1] ? Number(stat[1]) : null,
    insertions: stat?.[2] ? Number(stat[2]) : 0,
    deletions: stat?.[3] ? Number(stat[3]) : 0,
    push
  }
}

export function GitOpWidget(p: GitOpProps) {
  const failed = p.status === "error"
  const running = p.status === "running"
  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      icon={
        <>
          <span className={failed ? "text-red" : running ? "text-yellow" : "text-green"}>{failed ? "✗" : "✓"}</span>
          <GitBranch size={14} className="flex-none text-muted-foreground" />
        </>
      }
      headerMeta={p.branch ? <span className="text-blue">{p.branch}</span> : undefined}
      footer={
        <span className={failed ? "text-red" : "text-green"}>
          {failed ? "failed" : p.push ? "pushed" : "committed"}
        </span>
      }
      footerMeta={
        p.push && !failed ? (
          /* A dim label, NOT a link: text-blue with a trailing arrow is this
             UI's link affordance (see the dev-server URL), and this pass has no
             handler — a control that looks clickable and isn't is worse than a
             plain note. Becomes a real action when there's something to open. */
          <span className="text-dim">pushed — ready for PR</span>
        ) : (
          (exitLabel(p.status, p.exit) ?? undefined)
        )
      }
    >
      <WidgetBody className="gap-2.5">
        {p.sha && (
          <div className="font-mono text-[11.5px] text-muted-foreground">
            <span className="text-dim">[</span>
            {p.branch && <span className="text-blue">{p.branch} </span>}
            <span className="text-yellow">{p.sha}</span>
            <span className="text-dim">]</span> {p.subject}
          </div>
        )}

        {p.files.length > 0 && (
          <div className="flex flex-col gap-1 font-mono text-[11.5px]">
            {p.files.map((f) => (
              <div key={f.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-text">{f.path}</span>
                <DiffStat added={f.added} removed={f.removed} className="flex-none text-[11.5px]" />
              </div>
            ))}
          </div>
        )}

        {p.filesChanged !== null && (
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-dim">
            <span>
              {p.filesChanged} {p.filesChanged === 1 ? "file" : "files"} changed ·
            </span>
            <DiffStat added={p.insertions ?? 0} removed={p.deletions ?? 0} className="text-[11px]" />
          </div>
        )}

        {p.push && (
          <div
            className={cn(
              "flex items-center gap-2 font-mono text-[11.5px]",
              // The commit is the event; the push is where it went. The rule
              // says so without another heading.
              (p.sha || p.files.length > 0) && "border-t border-line/25 pt-[9px]"
            )}
          >
            <span className="flex-none text-green">→</span>
            <span className="min-w-0 truncate text-muted-foreground">{p.push.remote}</span>
            {p.push.range && <span className="flex-none text-dim">{p.push.range}</span>}
          </div>
        )}
      </WidgetBody>
    </CommandWidget>
  )
}

export const gitOpWidget = defineWidget<GitOpProps>({
  id: "git-op",
  match: (c) => c.program === "git" && c.sub !== null && GIT_SUBS.test(c.sub),
  parse: parseGitOp,
  render: (p) => <GitOpWidget {...p} />
})
