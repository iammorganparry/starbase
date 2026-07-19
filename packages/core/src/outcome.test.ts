import { Schema, SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import type { Outcome } from "./outcome.js"
import { dayOf, Outcome as OutcomeSchema, sizeBucketFor } from "./outcome.js"

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  id: "o1",
  repoKey: "9f2c1b7e",
  taskKind: "schema",
  cli: "codex",
  vendor: "openai",
  model: "gpt-5.6-sol",
  signals: {
    findingsCritical: 0,
    findingsMajor: 1,
    findingsMinor: 2,
    findingsNit: 0,
    ciPassed: true,
    merged: true,
    filesReverted: 0,
    planRevisions: 1
  },
  sizeBucket: "m",
  confidence: "exact",
  score: 1.5,
  occurredOn: "2026-07-18",
  ...over
})

/**
 * Field names whose value is an id WE mint, not prose. Everything else that is a
 * string must be a closed literal.
 */
const MINTED_IDS = new Set(["id", "repoKey", "model", "vendor", "occurredOn"])

/** The declared string fields of a struct that are NOT closed literals. */
const openStringFields = (ast: SchemaAST.AST, path = ""): ReadonlyArray<string> => {
  if (ast._tag === "TypeLiteral") {
    return ast.propertySignatures.flatMap((p) =>
      openStringFields(p.type, path ? `${path}.${String(p.name)}` : String(p.name))
    )
  }
  if (ast._tag === "Union") {
    // A union of string literals is closed — that's the shape we want.
    if (ast.types.every((t) => t._tag === "Literal")) return []
    return ast.types.flatMap((t) => openStringFields(t, path))
  }
  if (ast._tag === "Refinement" || ast._tag === "Transformation") return []
  if (ast._tag === "StringKeyword") {
    const leaf = path.split(".").pop() ?? path
    return MINTED_IDS.has(leaf) ? [] : [path]
  }
  return []
}

describe("Outcome — safe by construction", () => {
  it("has no free-text field", () => {
    // Not paranoia, forward-looking: outcomes are local today, but the moment
    // anything exports or pools them, prose is what leaks. Step titles are
    // model-written and routinely carry proprietary detail. Making the shape
    // safe by construction means a future sharing feature cannot leak by
    // omission — you would have to add a field, and this test would stop you.
    expect(openStringFields(OutcomeSchema.ast)).toEqual([])
  })

  it("round-trips", () => {
    const o = outcome()
    expect(Schema.decodeUnknownSync(OutcomeSchema)(Schema.encodeSync(OutcomeSchema)(o))).toStrictEqual(o)
  })

  it("keeps 'no CI ran' distinct from 'CI failed'", () => {
    // Folding null into false would score an unbuilt PR as a broken one.
    expect(Schema.decodeUnknownSync(OutcomeSchema)(
      Schema.encodeSync(OutcomeSchema)(outcome({ signals: { ...outcome().signals, ciPassed: null } }))
    ).signals.ciPassed).toBeNull()
  })

  it("keeps 'still open' distinct from 'closed unmerged'", () => {
    const still = outcome({ signals: { ...outcome().signals, merged: null } })
    expect(Schema.decodeUnknownSync(OutcomeSchema)(Schema.encodeSync(OutcomeSchema)(still)).signals.merged).toBeNull()
  })

  it("rejects a task kind outside the closed vocabulary", () => {
    expect(() =>
      Schema.decodeUnknownSync(OutcomeSchema)({ ...outcome(), taskKind: "frontend-ish" })
    ).toThrow()
  })
})

describe("sizeBucketFor", () => {
  it("buckets rather than recording line counts", () => {
    // Raw counts near-uniquely fingerprint a change; a bucket carries the signal
    // with none of the identity.
    expect(sizeBucketFor(3)).toBe("xs")
    expect(sizeBucketFor(40)).toBe("s")
    expect(sizeBucketFor(150)).toBe("m")
    expect(sizeBucketFor(400)).toBe("l")
    expect(sizeBucketFor(5000)).toBe("xl")
  })

  it("is monotonic", () => {
    const order = ["xs", "s", "m", "l", "xl"]
    const seen = [0, 10, 11, 50, 51, 200, 201, 600, 601].map((n) => order.indexOf(sizeBucketFor(n)))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})

describe("dayOf", () => {
  it("records day precision only", () => {
    // A timestamp plus commit cadence fingerprints a person.
    expect(dayOf(new Date("2026-07-18T13:45:12.345Z"))).toBe("2026-07-18")
  })
})
