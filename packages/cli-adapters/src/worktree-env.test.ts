import { delimiter } from "node:path"
import { describe, expect, it } from "vitest"
import { worktreeEnv } from "./worktree-env.js"

/**
 * The environment recorded from a real agent session on 2026-07-20, trimmed to
 * the variables that matter. Starbase had been launched with
 * `pnpm --filter @starbase/desktop dev` from `/Users/dev/repos/starbase`, and
 * every one of these reached a session working in an unrelated worktree.
 */
const LEAKED = {
  HOME: "/Users/dev",
  PATH: [
    "/Users/dev/repos/starbase/apps/desktop/node_modules/.bin",
    "/Users/dev/repos/starbase/node_modules/.bin",
    "/opt/homebrew/bin",
    "/usr/bin"
  ].join(delimiter),
  NODE_PATH: "/Users/dev/Library/pnpm/global/5/.pnpm/pnpm@10.7.0/node_modules",
  PNPM_SCRIPT_SRC_DIR: "/Users/dev/repos/starbase/apps/desktop",
  npm_config_node_linker: "hoisted",
  npm_config_shamefully_hoist: "true",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_lifecycle_event: "dev",
  npm_package_name: "@starbase/desktop",
  npm_execpath: "/Users/dev/Library/pnpm/global/5/.pnpm/pnpm@10.7.0/bin/pnpm.cjs"
}

const WORKTREE = "/Users/dev/starbase/worktrees/acme/feature"

describe("worktreeEnv", () => {
  it("strips the linker settings that silently override a worktree's own .npmrc", () => {
    const env = worktreeEnv(LEAKED, WORKTREE)

    expect(env.npm_config_node_linker).toBeUndefined()
    expect(env.npm_config_shamefully_hoist).toBeUndefined()
  })

  it("strips every npm_config_ variable, since each one is a leaked .npmrc setting", () => {
    const env = worktreeEnv(LEAKED, WORKTREE)

    expect(Object.keys(env).filter((k) => k.startsWith("npm_config_"))).toEqual([])
  })

  it("strips the launching script's identity and pnpm's own module path", () => {
    const env = worktreeEnv(LEAKED, WORKTREE)

    expect(env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.npm_lifecycle_event).toBeUndefined()
    expect(env.npm_package_name).toBeUndefined()
    expect(env.npm_execpath).toBeUndefined()
  })

  it("drops the origin repo's .bin from PATH so its binaries cannot shadow the session's", () => {
    const entries = worktreeEnv(LEAKED, WORKTREE).PATH!.split(delimiter)

    expect(entries).not.toContain("/Users/dev/repos/starbase/node_modules/.bin")
    expect(entries).not.toContain("/Users/dev/repos/starbase/apps/desktop/node_modules/.bin")
  })

  it("keeps ordinary PATH entries, which are the operator's own toolchain", () => {
    const entries = worktreeEnv(LEAKED, WORKTREE).PATH!.split(delimiter)

    expect(entries).toEqual(["/opt/homebrew/bin", "/usr/bin"])
  })

  it("keeps the worktree's OWN .bin — that is the session's tooling, not a leak", () => {
    const own = `${WORKTREE}/node_modules/.bin`
    const nested = `${WORKTREE}/apps/desktop/node_modules/.bin`
    const env = worktreeEnv(
      { ...LEAKED, PATH: [own, nested, "/usr/bin"].join(delimiter) },
      WORKTREE
    )

    expect(env.PATH!.split(delimiter)).toEqual([own, nested, "/usr/bin"])
  })

  it("treats every .bin as foreign when the child has no worktree of its own", () => {
    const env = worktreeEnv(
      { ...LEAKED, PATH: [`${WORKTREE}/node_modules/.bin`, "/usr/bin"].join(delimiter) },
      undefined
    )

    expect(env.PATH!.split(delimiter)).toEqual(["/usr/bin"])
  })

  it("does not mistake a sibling worktree with a shared name prefix for our own", () => {
    // `/…/acme/feature-old` starts with `/…/acme/feature` as a STRING but is a
    // different checkout. A prefix test rather than a path test would keep it.
    const sibling = `${WORKTREE}-old/node_modules/.bin`
    const env = worktreeEnv({ ...LEAKED, PATH: [sibling, "/usr/bin"].join(delimiter) }, WORKTREE)

    expect(env.PATH!.split(delimiter)).toEqual(["/usr/bin"])
  })

  /**
   * pnpm only ever publishes the lowercase form, so an uppercase
   * `NPM_CONFIG_*` is not launcher leakage — it is npm's documented way to set
   * config from the environment, and what corporate profiles and Dockerfiles
   * use. Stripping it broke private registries asymmetrically: the integrated
   * terminal is a LOGIN shell and re-sources the profile, so it kept working
   * while the agent's non-login child did not.
   */
  it("keeps uppercase NPM_CONFIG_ vars, which are user intent rather than leakage", () => {
    const env = worktreeEnv(
      {
        ...LEAKED,
        NPM_CONFIG_REGISTRY: "https://artifactory.corp/api/npm/npm-virtual/",
        "NPM_CONFIG_//artifactory.corp/:_authToken": "corp-token"
      },
      WORKTREE
    )

    expect(env.NPM_CONFIG_REGISTRY).toBe("https://artifactory.corp/api/npm/npm-virtual/")
    expect(env["NPM_CONFIG_//artifactory.corp/:_authToken"]).toBe("corp-token")
    // …while the lowercase form pnpm actually exports is still stripped.
    expect(env.npm_config_registry).toBeUndefined()
  })

  it("leaves credentials and ordinary variables untouched", () => {
    // Registry auth lives in ~/.npmrc, which the child reads directly — so
    // stripping npm_config_* must not be able to sign anyone out.
    const env = worktreeEnv({ ...LEAKED, ANTHROPIC_API_KEY: "sk-test" }, WORKTREE)

    expect(env.HOME).toBe("/Users/dev")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test")
  })

  it("drops undefined values so the result is a valid spawn environment", () => {
    const env = worktreeEnv({ HOME: "/Users/dev", EMPTY: undefined }, WORKTREE)

    expect(env).not.toHaveProperty("EMPTY")
    expect(env.HOME).toBe("/Users/dev")
  })

  it("returns a copy, never a mutation of the input", () => {
    const input = { ...LEAKED }
    worktreeEnv(input, WORKTREE)

    expect(input.npm_config_node_linker).toBe("hoisted")
  })

  it("survives an environment with no PATH at all", () => {
    const env = worktreeEnv({ HOME: "/Users/dev", npm_config_registry: "x" }, WORKTREE)

    // Asserting on the RESULT, not merely that nothing threw: a `not.toThrow()`
    // here would also pass if the function silently returned nothing useful.
    expect(env).not.toHaveProperty("PATH")
    expect(env.HOME).toBe("/Users/dev")
    expect(env.npm_config_registry).toBeUndefined()
  })

  /**
   * A blank worktree must mean "no worktree", never "the current directory".
   *
   * `resolve("")` is the process cwd — the checkout Starbase was launched from
   * — so treating `""` as a worktree would mark the LAUNCHER's own `.bin` as
   * ours and keep it, reinstating the leak. Three of the call sites pass
   * `spec.cwd ?? undefined`, which converts null but not `""`.
   */
  it("treats a blank worktree as no worktree, not as the process cwd", () => {
    const launcherBin = `${process.cwd()}/node_modules/.bin`
    const env = worktreeEnv({ ...LEAKED, PATH: [launcherBin, "/usr/bin"].join(delimiter) }, "")

    expect(env.PATH!.split(delimiter)).toEqual(["/usr/bin"])
  })
})
