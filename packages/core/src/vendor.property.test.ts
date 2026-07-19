import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CLI_KINDS } from "./domain.js"
import type { ProviderModels } from "./models.js"
import { normaliseRemote, repoKeyFromRoots } from "./repo-key.js"
import type { Hasher } from "./repo-key.js"
import { planningReadiness, reachableVendors, vendorOf } from "./vendor.js"

/**
 * Properties over the routing layer.
 *
 * These exist because `vendorOf` is fed model ids from live discovery — an
 * arbitrary catalogue we do not control and cannot enumerate. Example tests
 * cover the shapes we thought of; these cover the ones we did not.
 *
 * Run counts are capped deliberately. At fast-check's default of 100 these
 * properties burned enough CPU to starve the timing-sensitive suites running
 * alongside them (terminal coalescing, SIGKILL escalation, HITL gating) and made
 * them flake — a property test that destabilises unrelated tests costs more than
 * it finds. The shapes here are small and the counterexamples shallow, so a
 * lower count loses no real coverage.
 */
const RUNS = { numRuns: 50 }
const CHEAP_RUNS = { numRuns: 25 }

const arbCli = () => fc.constantFrom(...CLI_KINDS)

/** Model ids as they actually appear: bare, provider-qualified, gateway-nested. */
const arbModelId = () =>
  fc.oneof(
    fc.string(),
    fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a}/${b}`),
    fc.tuple(fc.string(), fc.string(), fc.string()).map(([a, b, c]) => `${a}/${b}/${c}`),
    fc.constantFrom(
      "opus",
      "gpt-5.6-sol",
      "openrouter/anthropic/claude-opus-4.5",
      "opencode/big-pickle",
      "anthropic/claude-opus-4.5"
    )
  )

const arbCatalog = (): fc.Arbitrary<ReadonlyArray<ProviderModels>> =>
  fc.array(
    fc.record({
      cli: arbCli(),
      label: fc.string(),
      models: fc.array(
        fc.record({ id: arbModelId(), label: fc.string() }),
        { maxLength: 6 }
      )
    }),
    { maxLength: 4 }
  )

describe("vendorOf — total", () => {
  it("never throws, for any harness and any model id", () => {
    fc.assert(
      fc.property(arbCli(), arbModelId(), (cli, model) => {
        expect(() => vendorOf(cli, model)).not.toThrow()
      }),
      RUNS
    )
  })

  it("never returns an empty string — null means 'cannot participate'", () => {
    // An empty vendor would silently group unrelated models into one lab.
    fc.assert(
      fc.property(arbCli(), arbModelId(), (cli, model) => {
        const v = vendorOf(cli, model)
        expect(v === null || v.length > 0).toBe(true)
      }),
      RUNS
    )
  })

  it("is deterministic", () => {
    fc.assert(
      fc.property(arbCli(), arbModelId(), (cli, model) => {
        expect(vendorOf(cli, model)).toBe(vendorOf(cli, model))
      }),
      RUNS
    )
  })

  it("never lets cursor participate, whatever model it claims", () => {
    fc.assert(
      fc.property(arbModelId(), (model) => {
        expect(vendorOf("cursor", model)).toBeNull()
      }),
      RUNS
    )
  })

  it("ignores the model id entirely for the native harnesses", () => {
    // claude and codex ARE their vendor; a stray id must not reroute them.
    fc.assert(
      fc.property(arbModelId(), (model) => {
        expect(vendorOf("claude", model)).toBe("anthropic")
        expect(vendorOf("codex", model)).toBe("openai")
      }),
      RUNS
    )
  })
})

describe("reachableVendors — invariants", () => {
  it("returns each vendor exactly once", () => {
    fc.assert(
      fc.property(arbCatalog(), (catalog) => {
        const vendors = reachableVendors(catalog).map((v) => v.vendor)
        expect(new Set(vendors).size).toBe(vendors.length)
      }),
      CHEAP_RUNS
    )
  })

  it("is sorted, so role assignment is reproducible across runs", () => {
    fc.assert(
      fc.property(arbCatalog(), (catalog) => {
        const vendors = reachableVendors(catalog).map((v) => v.vendor)
        expect(vendors).toEqual([...vendors].sort((a, b) => a.localeCompare(b)))
      }),
      CHEAP_RUNS
    )
  })

  it("only ever names a harness that was in the catalogue", () => {
    // The ranking must be structurally unable to suggest something uninstalled.
    fc.assert(
      fc.property(arbCatalog(), (catalog) => {
        const offered = new Set(catalog.map((p) => p.cli))
        for (const v of reachableVendors(catalog)) expect(offered.has(v.cli)).toBe(true)
      }),
      CHEAP_RUNS
    )
  })

  it("never returns a vendor with no models", () => {
    fc.assert(
      fc.property(arbCatalog(), (catalog) => {
        for (const v of reachableVendors(catalog)) expect(v.models.length).toBeGreaterThan(0)
      }),
      CHEAP_RUNS
    )
  })
})

describe("harness preference cannot change gating", () => {
  it("adding a gateway route to an already-reachable lab never changes readiness", () => {
    // This is the property the whole preference rule rests on: it decides HOW we
    // reach a lab, never how many labs exist, so it cannot flip the feature on
    // or off.
    fc.assert(
      fc.property(arbCatalog(), (catalog) => {
        const before = planningReadiness(catalog)
        const reachable = reachableVendors(catalog)
        if (reachable.length === 0) return
        // Offer every already-reachable lab a second time, through opencode.
        const duplicated: ProviderModels = {
          cli: "opencode",
          label: "opencode",
          models: reachable.map((v) => ({ id: `openrouter/${v.vendor}/x`, label: "x" }))
        }
        const after = planningReadiness([...catalog, duplicated])
        expect(after.ready).toBe(before.ready)
        expect(after.vendors.map((v) => v.vendor)).toEqual(before.vendors.map((v) => v.vendor))
      }),
      CHEAP_RUNS
    )
  })

  it("readiness is exactly 'two or more distinct vendors'", () => {
    fc.assert(
      fc.property(arbCatalog(), (catalog) => {
        const r = planningReadiness(catalog)
        expect(r.ready).toBe(r.vendors.length >= 2)
        // And an unavailable feature always explains itself.
        expect(r.ready ? r.reason === null : typeof r.reason === "string").toBe(true)
      }),
      CHEAP_RUNS
    )
  })
})

describe("repo key — invariants", () => {
  const hash: Hasher = (input) => {
    let h = 0
    for (const ch of input) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
    return (h >>> 0).toString(16).padStart(64, "0")
  }

  it("is independent of the order git reported the roots in", () => {
    // `git rev-list` does not guarantee an order across versions, and an
    // unstable pick would give two teammates different keys for one repo.
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 8, unit: fc.constantFrom(..."0123456789abcdef") }), { minLength: 1, maxLength: 4 }), (roots) => {
        expect(repoKeyFromRoots(roots, hash)).toStrictEqual(
          repoKeyFromRoots([...roots].reverse(), hash)
        )
      }),
      RUNS
    )
  })

  it("normalising a remote is idempotent", () => {
    fc.assert(
      // Hand-rolled rather than `fc.webUrl()`: that generator is expensive
      // enough to be the single slowest thing in the suite, and these are the
      // shapes a git remote actually takes.
      fc.property(
        fc.tuple(
          fc.constantFrom("https://", "http://", "ssh://", "git@", ""),
          fc.constantFrom("github.com", "gitlab.com", "git.internal:2222"),
          fc.constantFrom(":", "/"),
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.constantFrom(".git", "", "/")
        ).map(([scheme, host, sep, path, suffix]) => `${scheme}${host}${sep}${path}${suffix}`),
        (url) => {
          expect(normaliseRemote(normaliseRemote(url))).toBe(normaliseRemote(url))
        }
      ),
      RUNS
    )
  })
})
