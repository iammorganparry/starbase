/**
 * Docker-style friendly names for untitled sessions — `<adjective>-<name>`, e.g.
 * "hopeful-einstein". Replaces the old "untitled-session-<stamp>" slug so a
 * session's worktree/branch reads nicely (`starbase/hopeful-einstein`) before the
 * agent auto-titles it. All tokens are lowercase single words, so the result is a
 * valid kebab slug / branch / filesystem name with no extra sanitising.
 */

const ADJECTIVES = [
  "amber", "ancient", "autumn", "bold", "brave", "bright", "calm", "clever",
  "cosmic", "crimson", "crisp", "curious", "daring", "dawn", "eager", "electric",
  "elegant", "fierce", "frosty", "gentle", "gilded", "golden", "happy", "hidden",
  "hopeful", "jolly", "keen", "lively", "lucid", "lunar", "mellow", "mighty",
  "nimble", "noble", "polished", "proud", "quiet", "rapid", "restless", "royal",
  "serene", "silent", "silver", "solar", "spry", "stellar", "sturdy", "sunny",
  "swift", "tidal", "vivid", "wandering", "wild", "witty", "zesty"
] as const

const NAMES = [
  "einstein", "curie", "tesla", "newton", "darwin", "turing", "lovelace",
  "hopper", "bohr", "hawking", "galileo", "kepler", "faraday", "maxwell",
  "feynman", "noether", "ramanujan", "euler", "gauss", "planck", "pasteur",
  "franklin", "mendel", "fermi", "dirac", "hypatia", "archimedes", "pythagoras",
  "copernicus", "sagan", "goodall", "carson", "borg", "ritchie", "torvalds",
  "kernighan", "knuth", "liskov", "dijkstra", "wozniak", "engelbart", "berners",
  "shannon", "babbage", "boole", "hamilton", "johnson", "meitner", "rutherford",
  "volta", "watt", "kelvin", "joule", "hertz", "ohm"
] as const

/**
 * A friendly name from a numeric seed — `<adjective>-<name>`. Deterministic given
 * the seed (no `Math.random`), so callers hold the impurity: they pass a
 * time-derived seed and vary it (`seed + i`) to try fresh names and skip the rare
 * collision. The two pools are indexed independently so nearby seeds still differ.
 */
export const creativeName = (seed: number): string => {
  const s = Math.abs(Math.trunc(seed))
  const adjective = ADJECTIVES[s % ADJECTIVES.length]!
  const name = NAMES[Math.trunc(s / ADJECTIVES.length) % NAMES.length]!
  return `${adjective}-${name}`
}

/**
 * The first friendly name (starting from `seed`) not already taken by `used`,
 * falling back to a stamped name only if every attempt in a generous window
 * collides — so the common case is a clean, unstamped `starbase/hopeful-einstein`.
 */
export const freeCreativeName = (
  used: ReadonlySet<string>,
  seed: number,
  stampedFallback: string
): string => {
  for (let i = 0; i < 50; i++) {
    const candidate = creativeName(seed + i * 7919) // 7919 is prime → good spread
    if (!used.has(candidate)) return candidate
  }
  return stampedFallback
}
