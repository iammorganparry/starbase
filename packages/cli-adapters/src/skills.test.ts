import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SkillsService } from "./skills.js"
import { mkTemp } from "./test-support.js"
import { NodeContext } from "@effect/platform-node"

/**
 * Skills feed the `/` menu. Behaviours that matter: every harness gets the
 * built-in commands; the Claude reporter surfaces the operator's GLOBAL skills
 * (~/.claude/skills) AND the session's PROJECT skills (<worktree>/.claude/skills),
 * with a project skill overriding a global one of the same name; a non-Claude
 * harness reports only built-ins. Real temp filesystem.
 */

let home: ReturnType<typeof mkTemp>
let repo: ReturnType<typeof mkTemp>
beforeEach(() => {
  home = mkTemp("starbase-home-")
  repo = mkTemp("starbase-repo-")
})
afterEach(() => {
  home.cleanup()
  repo.cleanup()
})

const run = <A>(effect: Effect.Effect<A, never, SkillsService | NodeContext.NodeContext>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(SkillsService.Default, NodeContext.layer)))
  )

const writeSkill = (root: string, name: string, description: string) => {
  const dir = join(root, ".claude", "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`)
}

describe("SkillsService", () => {
  it("returns only built-in commands when there are no skill dirs", async () => {
    const skills = await run(SkillsService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(skills.every((s) => s.source === "command")).toBe(true)
    expect(skills.some((s) => s.name === "/plan")).toBe(true)
  })

  it("surfaces global skills from ~/.claude/skills", async () => {
    writeSkill(home.dir, "babysit-pr", "Babysit a PR to green")
    const skills = await run(SkillsService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    const skill = skills.find((s) => s.name === "/babysit-pr")
    expect(skill).toBeDefined()
    expect(skill!.source).toBe("skill")
    expect(skill!.description).toBe("Babysit a PR to green")
    // Built-ins still present alongside real skills.
    expect(skills.some((s) => s.name === "/review")).toBe(true)
  })

  it("merges global + project skills, with the project skill winning on a name clash", async () => {
    writeSkill(home.dir, "deploy", "Global deploy")
    writeSkill(home.dir, "audit", "Global audit")
    writeSkill(repo.dir, "deploy", "Project deploy") // same name → overrides global
    const skills = await run(SkillsService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(skills.filter((s) => s.name === "/deploy")).toHaveLength(1)
    expect(skills.find((s) => s.name === "/deploy")!.description).toBe("Project deploy")
    expect(skills.some((s) => s.name === "/audit")).toBe(true)
  })

  it("reports only built-ins for a non-Claude harness", async () => {
    writeSkill(home.dir, "deploy", "Global deploy")
    const skills = await run(SkillsService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir }))
    expect(skills.every((s) => s.source === "command")).toBe(true)
  })
})
