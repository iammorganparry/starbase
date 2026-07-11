import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SkillsService } from "./skills.js"
import { mkTemp } from "./test-support.js"
import { NodeContext } from "@effect/platform-node"

/**
 * Skills feed the `/` menu. Behaviours that matter: every harness gets the
 * built-in commands; the Claude reporter also surfaces project-local skills from
 * a real `.claude/skills` directory (with parsed descriptions); a non-Claude
 * harness reports only built-ins. Real temp filesystem.
 */

let temp: ReturnType<typeof mkTemp>
beforeEach(() => {
  temp = mkTemp("starbase-skills-")
})
afterEach(() => temp.cleanup())

const run = <A>(effect: Effect.Effect<A, never, SkillsService | NodeContext.NodeContext>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(SkillsService.Default, NodeContext.layer)))
  )

describe("SkillsService", () => {
  it("returns only built-in commands when there is no worktree", async () => {
    const skills = await run(SkillsService.list({ cli: "claude", worktreePath: null }))
    expect(skills.every((s) => s.source === "command")).toBe(true)
    expect(skills.some((s) => s.name === "/plan")).toBe(true)
  })

  it("surfaces project-local Claude skills with their descriptions", async () => {
    const skillsDir = join(temp.dir, ".claude", "skills", "deploy")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(
      join(skillsDir, "SKILL.md"),
      "---\nname: deploy\ndescription: Ship the app to production\n---\n# Deploy\n"
    )
    const skills = await run(SkillsService.list({ cli: "claude", worktreePath: temp.dir }))
    const deploy = skills.find((s) => s.name === "/deploy")
    expect(deploy).toBeDefined()
    expect(deploy!.source).toBe("skill")
    expect(deploy!.description).toBe("Ship the app to production")
    // Built-ins are still present alongside project skills.
    expect(skills.some((s) => s.name === "/review")).toBe(true)
  })

  it("reports only built-ins for a non-Claude harness", async () => {
    mkdirSync(join(temp.dir, ".claude", "skills", "deploy"), { recursive: true })
    const skills = await run(SkillsService.list({ cli: "codex", worktreePath: temp.dir }))
    expect(skills.every((s) => s.source === "command")).toBe(true)
  })
})
