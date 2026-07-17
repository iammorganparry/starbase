import type { CliKind, Skill } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Ref } from "effect"
import { NO_CAPABILITIES, probeClaudeCapabilities, SCRIPTED_COMMANDS } from "./claude-commands.js"
import type { ClaudeCapabilities } from "./claude-commands.js"
import { isScriptedEnv } from "./scripted.js"

/** What harness a `list` request is scoped to, and where to scan for skills. */
export interface SkillSpec {
  readonly cli: CliKind
  /** The real home dir, scanned for GLOBAL skills at `<home>/.claude/skills`. */
  readonly homeDir: string | null
  /** The session's worktree, scanned for PROJECT skills; null when none. */
  readonly worktreePath: string | null
  /** The harness binary, so its own command list can be read from it. */
  readonly binPath?: string | null
}

/**
 * A one-line gloss for the CLI's own built-in commands.
 *
 * Descriptions only — never existence. Which commands exist comes from the
 * harness (`ClaudeCapabilities.commands`), so nothing here can conjure a command
 * that isn't real; an entry for a command the CLI dropped simply goes unused, and
 * a built-in we haven't glossed still lists, just without a description. That
 * split is the whole point: the previous hardcoded list decided BOTH, and so
 * offered `/test` and `/commit`, which this harness has never had.
 */
const BUILTIN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  agents: "Manage sub-agents",
  clear: "Clear the conversation",
  compact: "Compact the conversation to free context",
  config: "Open the config panel",
  context: "Show what's using the context window",
  doctor: "Diagnose the installation",
  effort: "Set the reasoning effort",
  goal: "Set the goal for this session",
  init: "Write a CLAUDE.md for this codebase",
  insights: "Show usage insights",
  mcp: "Manage MCP servers",
  model: "Change the model",
  recap: "Recap the session so far",
  rename: "Rename the conversation",
  "security-review": "Review the pending changes for vulnerabilities",
  usage: "Show usage and limits"
}

const field = (content: string, key: string): string | null =>
  content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null

const baseName = (entry: string): string => entry.replace(/\.(md|skill)$/i, "")

type ScanEnv = FileSystem.FileSystem | Path.Path

/**
 * Scan one `.claude/skills` directory. Each entry is either a skill directory
 * (with a `SKILL.md`), or a bare `*.md` / `*.skill` file. Symlinked skills are
 * followed (`fs.stat`, not `lstat`). The display name prefers the `name:`
 * frontmatter, falling back to the entry name.
 */
const scanSkillsDir = (dir: string): Effect.Effect<ReadonlyArray<Skill>, never, ScanEnv> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return []

    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))

    return yield* Effect.forEach(
      entries.filter((e) => !e.startsWith(".")),
      (entry) =>
        Effect.gen(function* () {
          const full = path.join(dir, entry)
          const stat = yield* fs.stat(full).pipe(Effect.option)
          const isDir = stat._tag === "Some" && stat.value.type === "Directory"
          // Skip files that aren't skill definitions.
          if (!isDir && !/\.(md|skill)$/i.test(entry)) return null
          const mdPath = isDir ? path.join(full, "SKILL.md") : full
          const content = yield* fs.readFileString(mdPath).pipe(Effect.orElseSucceed(() => ""))
          const skill: Skill = {
            name: `/${field(content, "name") ?? baseName(entry)}`,
            description: field(content, "description") ?? "Skill",
            source: "skill"
          }
          return skill
        }),
      { concurrency: 8 }
    ).pipe(Effect.map((results) => results.filter((s): s is Skill => s !== null)))
  })

const byName = (a: Skill, b: Skill): number => a.name.localeCompare(b.name)

/**
 * Reports the skills/slash-commands the selected harness exposes for the `/`
 * menu.
 *
 * For Claude the list of what EXISTS comes from the CLI itself, which announces
 * its whole surface on startup — its built-ins (`/goal`, `/init`, `/compact`),
 * file-based skills, and plugin commands alike. Descriptions are layered on
 * afterwards from the skills directories' frontmatter (`~/.claude/skills` global,
 * `<worktree>/.claude/skills` project — project wins), since the CLI reports
 * names only.
 *
 * The probe is cached per harness for the process lifetime: it costs a CLI
 * startup, and the answer only changes when the operator installs something.
 *
 * Other harnesses report nothing until their own reporters land. That's
 * deliberate: they used to be handed a hardcoded list of five commands, most of
 * which no harness has ever had, and an empty menu is at least true.
 */
export class SkillsService extends Effect.Service<SkillsService>()("@starbase/SkillsService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const cache = yield* Ref.make(new Map<string, ClaudeCapabilities>())

    /**
     * The CLI's own surface, probed once per binary.
     *
     * Requires a discovered binary. Without one there's nothing to ask — and
     * insisting on it keeps the probe out of anywhere that hasn't opted in by
     * resolving a path, so a unit test never spawns a CLI to list skills.
     */
    const capabilities = (
      binPath: string | null,
      cwd: string | null
    ): Effect.Effect<ClaudeCapabilities> =>
      Effect.gen(function* () {
        if (binPath === null) return NO_CAPABILITIES
        const hit = (yield* Ref.get(cache)).get(binPath)
        if (hit) return hit
        const probed = yield* probeClaudeCapabilities(binPath, cwd)
        // Don't cache a miss: a probe that failed because the CLI was busy or
        // mid-upgrade should be retried, not remembered as "no commands".
        if (probed.commands.length > 0) yield* Ref.update(cache, (m) => new Map(m).set(binPath, probed))
        return probed
      })

    const list = (spec: SkillSpec): Effect.Effect<ReadonlyArray<Skill>, never, ScanEnv> =>
      Effect.gen(function* () {
        if (spec.cli !== "claude") return []
        const path = yield* Path.Path

        // Global first, then project, so a project skill overrides a global one.
        const dirs = [
          spec.homeDir ? path.join(spec.homeDir, ".claude", "skills") : null,
          spec.worktreePath ? path.join(spec.worktreePath, ".claude", "skills") : null
        ].filter((d): d is string => d !== null)

        const scanned = yield* Effect.forEach(dirs, scanSkillsDir)
        const described = new Map<string, Skill>()
        for (const skill of scanned.flat()) described.set(skill.name, skill)

        // Under the scripted harness there is no CLI to ask — asking would spawn
        // the operator's real `claude`, which is the one thing that switch
        // forbids. Answer for the fake instead: its built-ins, plus the skills
        // just scanned off disk (a real CLI announces those alongside its own,
        // so the fake reporting them is a faithful stand-in, not an invention).
        const scriptedSkills = [...described.keys()].map((name) => name.replace(/^\//, ""))
        const caps = isScriptedEnv()
          ? {
              commands: [...SCRIPTED_COMMANDS, ...scriptedSkills],
              skills: scriptedSkills
            }
          : yield* capabilities(spec.binPath ?? null, spec.worktreePath)

        // No answer from the CLI (not installed, still booting, probe failed) —
        // fall back to what's on disk, so the menu degrades to the skills we can
        // see rather than to nothing.
        if (caps.commands.length === 0) return [...described.values()].sort(byName)

        const isSkill = new Set(caps.skills)
        return caps.commands
          .map((command): Skill => {
            const name = `/${command}`
            const local = described.get(name)
            return {
              name,
              // Prefer the skill's own frontmatter; fall back to our gloss for
              // the CLI's built-ins; else say nothing rather than invent.
              description: local?.description ?? BUILTIN_DESCRIPTIONS[command] ?? "",
              source: isSkill.has(command) ? "skill" : "command"
            }
          })
          .sort(byName)
      })

    return { list }
  })
}) {}
