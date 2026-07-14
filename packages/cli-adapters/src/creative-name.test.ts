import { describe, expect, it } from "vitest"
import { creativeName, freeCreativeName } from "./creative-name.js"

/**
 * Friendly names slug a session's worktree/branch, so what matters is: the result
 * is always a valid `<adjective>-<name>` kebab token, it's deterministic per seed
 * (no `Math.random`, so tests are stable), and `freeCreativeName` skips names
 * already taken — falling back to the stamped name only when it can't find a free
 * one.
 */

describe("creativeName", () => {
  it("is a lowercase <adjective>-<name> kebab token", () => {
    expect(creativeName(0)).toMatch(/^[a-z]+-[a-z]+$/)
    expect(creativeName(123456789)).toMatch(/^[a-z]+-[a-z]+$/)
    expect(creativeName(-42)).toMatch(/^[a-z]+-[a-z]+$/) // negatives are handled
  })

  it("is deterministic for a given seed", () => {
    expect(creativeName(999)).toBe(creativeName(999))
  })

  it("varies across nearby seeds (independent adjective/name indexing)", () => {
    const names = new Set([0, 1, 2, 3, 4].map(creativeName))
    expect(names.size).toBeGreaterThan(1)
  })
})

describe("freeCreativeName", () => {
  it("returns the seed's name when it isn't taken", () => {
    expect(freeCreativeName(new Set(), 7, "fallback-1")).toBe(creativeName(7))
  })

  it("skips a taken name and returns the next free one", () => {
    const taken = new Set([creativeName(7)])
    const picked = freeCreativeName(taken, 7, "fallback-1")
    expect(picked).not.toBe(creativeName(7))
    expect(taken.has(picked)).toBe(false)
    expect(picked).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it("falls back to the stamped name only when every candidate collides", () => {
    // Saturate the 50-name search window from this seed so none are free.
    const seed = 100
    const taken = new Set(Array.from({ length: 50 }, (_, i) => creativeName(seed + i * 7919)))
    expect(freeCreativeName(taken, seed, "hopeful-einstein-abc123")).toBe("hopeful-einstein-abc123")
  })
})
