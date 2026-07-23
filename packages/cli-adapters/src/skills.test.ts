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

const writeSkill = (
  root: string,
  name: string,
  description: string,
  skillsDir = join(".claude", "skills")
) => {
  const dir = join(root, skillsDir, name)
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

  it("surfaces Codex user and project skills without leaking Claude skills", async () => {
    writeSkill(home.dir, "claude-only", "Claude only")
    writeSkill(home.dir, "audit", "Global audit", join(".agents", "skills"))
    writeSkill(home.dir, "deploy", "Global deploy", join(".agents", "skills"))
    writeSkill(repo.dir, "deploy", "Project deploy", join(".agents", "skills"))
    const skills = await run(
      SkillsService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir })
    )
    expect(skills.find((s) => s.name === "/deploy")?.description).toBe("Project deploy")
    expect(skills.map((s) => s.name)).toContain("/audit")
    expect(skills.map((s) => s.name)).not.toContain("/claude-only")
  })

  it("surfaces Codex system skills from ~/.codex/skills/.system", async () => {
    writeSkill(home.dir, "skill-creator", "Create skills", join(".codex", "skills", ".system"))
    const skills = await run(
      SkillsService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir })
    )
    expect(skills).toContainEqual({
      name: "/skill-creator",
      description: "Create skills",
      source: "skill"
    })
  })

  it("normalizes quoted names and folded descriptions from Codex frontmatter", async () => {
    const dir = join(home.dir, ".codex", "skills", ".system", "imagegen")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      '---\nname: "imagegen"\ndescription: >-\n  Generate or edit\n  raster images.\n---\n'
    )
    const skills = await run(
      SkillsService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir })
    )
    expect(skills).toContainEqual({
      name: "/imagegen",
      description: "Generate or edit raster images.",
      source: "skill"
    })
  })
})

/**
 * `STARBASE_SCRIPTED_AGENT` means "no real harness" — it is what makes the e2e
 * suite hermetic. The command probe missed that memo: it spawned the operator's
 * real `claude`, with their real login, on every launch. Slow, non-reproducible,
 * and dependent on which CLIs the host happens to have.
 *
 * These run with `binPath` SET, which is the whole point: the probe would
 * otherwise fire. A bogus path proves the guarantee — spawning it could only
 * fail, which would empty the menu of built-ins.
 */
describe("SkillsService — under the scripted harness", () => {
  const NOWHERE = "/nonexistent/claude"

  beforeEach(() => {
    process.env.STARBASE_SCRIPTED_AGENT = "1"
  })
  afterEach(() => {
    delete process.env.STARBASE_SCRIPTED_AGENT
  })

  it("answers for the fake harness instead of spawning the real one", async () => {
    const skills = await run(
      SkillsService.list({
        cli: "claude",
        homeDir: home.dir,
        worktreePath: repo.dir,
        binPath: NOWHERE
      })
    )
    // Probing `/nonexistent/claude` could only have failed, which would leave the
    // menu empty — so a built-in here proves we never tried.
    expect(skills.map((s) => s.name)).toContain("/plan")
    expect(skills.find((s) => s.name === "/plan")?.source).toBe("command")
  })

  it("still reports the skills on disk, as a real harness would", async () => {
    writeSkill(repo.dir, "deploy", "Ship it")
    const skills = await run(
      SkillsService.list({
        cli: "claude",
        homeDir: home.dir,
        worktreePath: repo.dir,
        binPath: NOWHERE
      })
    )
    // A real CLI announces file-based skills alongside its built-ins; the fake
    // has to as well, or the `/` menu loses every project skill under test.
    const deploy = skills.find((s) => s.name === "/deploy")
    expect(deploy).toStrictEqual({ name: "/deploy", description: "Ship it", source: "skill" })
    expect(skills.map((s) => s.name)).toContain("/compact")
  })
})
