import type { CliKind, Skill } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"

/** What harness a `list` request is scoped to, and where to scan for skills. */
export interface SkillSpec {
  readonly cli: CliKind
  /** The real home dir, scanned for GLOBAL skills at `<home>/.claude/skills`. */
  readonly homeDir: string | null
  /** The session's worktree, scanned for PROJECT skills; null when none. */
  readonly worktreePath: string | null
}

/**
 * Built-in slash commands surfaced in every harness's `/` menu. Kept
 * harness-agnostic — real global/project skills are layered on top per harness.
 */
const BUILTIN_COMMANDS: ReadonlyArray<Skill> = [
  { name: "/plan", description: "Draft a plan before making edits", source: "command" },
  { name: "/review", description: "Review the current diff", source: "command" },
  { name: "/test", description: "Run the test suite", source: "command" },
  { name: "/commit", description: "Stage and commit the changes", source: "command" },
  { name: "/clear", description: "Clear the conversation", source: "command" }
]

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

/**
 * Reports the skills/slash-commands the selected harness exposes for the `/`
 * menu. For Claude it scans the operator's GLOBAL skills (`~/.claude/skills`)
 * and the session's PROJECT skills (`<worktree>/.claude/skills`), deduped by name
 * (project overrides global), plus the shared built-in commands. Other harnesses
 * report only their built-ins until their own reporters land.
 */
export class SkillsService extends Effect.Service<SkillsService>()("@starbase/SkillsService", {
  accessors: true,
  sync: () => ({
    list: (spec: SkillSpec): Effect.Effect<ReadonlyArray<Skill>, never, ScanEnv> =>
      Effect.gen(function* () {
        if (spec.cli !== "claude") return BUILTIN_COMMANDS
        const path = yield* Path.Path

        // Global first, then project, so a project skill overrides a global one.
        const dirs = [
          spec.homeDir ? path.join(spec.homeDir, ".claude", "skills") : null,
          spec.worktreePath ? path.join(spec.worktreePath, ".claude", "skills") : null
        ].filter((d): d is string => d !== null)

        const scanned = yield* Effect.forEach(dirs, scanSkillsDir)
        const byName = new Map<string, Skill>()
        for (const skill of scanned.flat()) byName.set(skill.name, skill)
        const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))

        return [...skills, ...BUILTIN_COMMANDS]
      })
  })
}) {}
