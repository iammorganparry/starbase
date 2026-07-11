import type { CliKind, Skill } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"

/** What harness a `list` request is scoped to, and where its worktree lives. */
export interface SkillSpec {
  readonly cli: CliKind
  /** The session's worktree, scanned for project-local skills; null when none. */
  readonly worktreePath: string | null
}

/**
 * Built-in slash commands surfaced in every harness's `/` menu. Kept
 * harness-agnostic — project-local skills are layered on top per harness.
 */
const BUILTIN_COMMANDS: ReadonlyArray<Skill> = [
  { name: "/plan", description: "Draft a plan before making edits", source: "command" },
  { name: "/review", description: "Review the current diff", source: "command" },
  { name: "/test", description: "Run the test suite", source: "command" },
  { name: "/commit", description: "Stage and commit the changes", source: "command" },
  { name: "/clear", description: "Clear the conversation", source: "command" }
]

/** Pull a `description:` out of SKILL.md frontmatter, else a sensible default. */
const parseDescription = (content: string): string => {
  const match = content.match(/^description:\s*(.+)$/m)
  return match?.[1]?.trim() ?? "Project skill"
}

const skillName = (entry: string): string => `/${entry.replace(/\.md$/i, "")}`

/**
 * Reports the skills/slash-commands the selected harness exposes for the `/`
 * menu. Harness-agnostic: every harness gets the shared built-in commands, and
 * the Claude reporter additionally scans the worktree's `.claude/skills` for
 * project-local skills (each subdirectory's SKILL.md, or a bare `*.md`). Other
 * harnesses report only their built-ins until their own reporters land.
 */
export class SkillsService extends Effect.Service<SkillsService>()("@starbase/SkillsService", {
  accessors: true,
  sync: () => ({
    list: (
      spec: SkillSpec
    ): Effect.Effect<ReadonlyArray<Skill>, never, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        if (spec.cli !== "claude" || spec.worktreePath === null) return BUILTIN_COMMANDS

        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.join(spec.worktreePath, ".claude", "skills")
        const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return BUILTIN_COMMANDS

        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))

        const scanned = yield* Effect.forEach(
          entries.filter((e) => !e.startsWith(".")),
          (entry) =>
            Effect.gen(function* () {
              const full = path.join(dir, entry)
              const stat = yield* fs.stat(full).pipe(Effect.option)
              const mdPath =
                stat._tag === "Some" && stat.value.type === "Directory"
                  ? path.join(full, "SKILL.md")
                  : full
              const content = yield* fs.readFileString(mdPath).pipe(Effect.orElseSucceed(() => ""))
              const skill: Skill = {
                name: skillName(entry),
                description: parseDescription(content),
                source: "skill"
              }
              return skill
            }),
          { concurrency: 8 }
        )

        return [...scanned, ...BUILTIN_COMMANDS]
      })
  })
}) {}
