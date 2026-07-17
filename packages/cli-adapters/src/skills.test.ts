import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SkillsService } from "./skills.js"
import { mkTemp } from "./test-support.js"
import { NodeContext } from "@effect/platform-node"

/**
 * Skills feed the `/` menu, and the menu's promise is that everything in it
 * works. What exists is therefore the harness's word (it announces its whole
 * surface on startup), and only the DESCRIPTIONS come from anywhere else. These
 * cover the half that runs without a harness: scanning the operator's GLOBAL
 * skills (~/.claude/skills) and the session's PROJECT skills, with a project
 * skill overriding a global one of the same name. Real temp filesystem.
 *
 * `binPath` is left unset throughout, which is what keeps these hermetic: the
 * probe needs a discovered binary, so nothing here spawns a CLI.
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
  it("offers nothing when there are no skills and no harness to ask", async () => {
    const skills = await run(
      SkillsService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir })
    )
    // It used to answer with five hardcoded commands here — three of which
    // (/plan, /test, /commit) this harness has never had. Offering a command
    // that does nothing is worse than offering none.
    expect(skills).toStrictEqual([])
  })

  it("surfaces global skills from ~/.claude/skills", async () => {
    writeSkill(home.dir, "babysit-pr", "Babysit a PR to green")
    const skills = await run(
      SkillsService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir })
    )
    const skill = skills.find((s) => s.name === "/babysit-pr")
    expect(skill).toBeDefined()
    expect(skill!.source).toBe("skill")
    expect(skill!.description).toBe("Babysit a PR to green")
  })

  it("merges global + project skills, with the project skill winning on a name clash", async () => {
    writeSkill(home.dir, "deploy", "Global deploy")
    writeSkill(home.dir, "audit", "Global audit")
    writeSkill(repo.dir, "deploy", "Project deploy") // same name → overrides global
    const skills = await run(
      SkillsService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir })
    )
    expect(skills.filter((s) => s.name === "/deploy")).toHaveLength(1)
    expect(skills.find((s) => s.name === "/deploy")!.description).toBe("Project deploy")
    expect(skills.some((s) => s.name === "/audit")).toBe(true)
  })

  it("invents nothing for a harness that can't report yet", async () => {
    writeSkill(home.dir, "deploy", "Global deploy")
    const skills = await run(
      SkillsService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir })
    )
    // Codex doesn't read ~/.claude/skills, and we can't ask it what it has — so
    // the honest answer is nothing, not another harness's skills or a made-up list.
    expect(skills).toStrictEqual([])
  })
})
