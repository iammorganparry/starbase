/**
 * The planning eval harness.
 *
 * Runs the seeded corpus through real models and answers two questions:
 *
 *  1. Does the adversary catch planted defects, and has that got worse?
 *  2. **Does a critic from a DIFFERENT lab beat one from the same lab?**
 *
 * (2) is the point. The whole vendor design — `vendorOf`, the two-vendor gate,
 * harness preference — rests on the claim that a same-lab critic shares the
 * proposer's blind spots. That claim is plausible, widely repeated, and was
 * untested here. This harness is built so it can EMBARRASS the design: if
 * cross-vendor doesn't clear same-vendor by a real margin, the gate has lost its
 * justification and the honest response is to change the design, not the eval.
 *
 * Never runs in CI. It costs real tokens and is nondeterministic; a
 * nondeterministic gate on a PR is a coin flip that blocks people.
 *
 *   pnpm eval:planning              # all cases, default trials
 *   pnpm eval:planning --trials 5
 *   pnpm eval:planning --case ordering-backfill
 *   pnpm eval:planning --pairing cross    # skip the premise comparison, half the cost
 *
 * Budget: each trial is three flagship runs (propose, attack, revise), and the
 * premise comparison doubles that. A full corpus is tens of minutes.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import {
  AdversarialPlanService,
  chooseRoles,
  DiscoveryService,
  HarnessCliAdapterLive,
  ModelsService
} from "@starbase/cli-adapters"
import type { PlanRound, VendorReach } from "@starbase/core"
import { reachableVendors } from "@starbase/core"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import type { EvalCase } from "./case.js"
import { CORPUS } from "./corpus.js"
import { gradeTrial, isRegression, summarise } from "./grade.js"
import type { PairSummary, TrialResult } from "./grade.js"

const BASELINES = join(import.meta.dirname, "baselines.json")

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/** Materialise a case's fixture as a real git repo the roles can actually read. */
const makeFixture = (evalCase: EvalCase): { path: string; cleanup: () => void } => {
  const path = mkdtempSync(join(tmpdir(), `starbase-eval-${evalCase.id}-`))
  for (const [rel, contents] of Object.entries(evalCase.fixture)) {
    const file = join(path, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], { cwd: path, stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "eval@starbase.local")
  git("config", "user.name", "Starbase Eval")
  git("add", "-A")
  git("commit", "-qm", "fixture")
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

const AppLayer = Layer.mergeAll(
  AdversarialPlanService.Default,
  DiscoveryService.Default,
  ModelsService.Default,
  HarnessCliAdapterLive,
  NodeContext.layer
)

/** Run one case once against a fixed proposer/adversary pairing. */
const runTrial = (
  evalCase: EvalCase,
  vendors: ReadonlyArray<VendorReach>,
  trial: number
): Effect.Effect<TrialResult | null, never, never> =>
  Effect.gen(function* () {
    const fixture = makeFixture(evalCase)
    try {
      const clis = yield* DiscoveryService.list()
      const service = yield* AdversarialPlanService
      let round: PlanRound | null = null
      yield* service
        .run({
          sessionId: `eval_${evalCase.id}_${trial}`,
          repo: "eval/fixture",
          branch: "main",
          cwd: fixture.path,
          brief: evalCase.brief,
          vendors,
          binPathFor: (cli) => clis.find((c) => c.kind === cli)?.binPath ?? null,
          assignAgents: false,
          onRound: (r) =>
            Effect.sync(() => {
              round = r
            })
        })
        .pipe(Stream.runDrain, Effect.ignore)
      return round === null ? null : gradeTrial(evalCase, round)
    } finally {
      fixture.cleanup()
    }
  }).pipe(Effect.provide(AppLayer), Effect.orElseSucceed(() => null))

/** Force both roles onto one lab, to test the premise the design rests on. */
const sameVendor = (vendors: ReadonlyArray<VendorReach>): ReadonlyArray<VendorReach> | null => {
  const first = vendors[0]
  if (!first || first.models.length < 2) return null
  // Two DIFFERENT models from the same lab, so the comparison is "same lab" and
  // not "literally the same model talking to itself".
  return [
    { ...first, models: [first.models[0]!] },
    { ...first, vendor: `${first.vendor} (2)`, models: [first.models[1]!] }
  ]
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`

const report = (s: PairSummary): void => {
  console.log(
    `  ${s.pair.padEnd(28)} detect ${pct(s.detectionRate).padStart(4)}` +
      `  held-out ${pct(s.heldOutDetectionRate).padStart(4)}` +
      `  challenges/trial ${s.meanChallenges.toFixed(1)}` +
      `  capitulations ${s.meanCapitulations.toFixed(2)}` +
      (s.unchallenged > 0 ? `  UNCHALLENGED ${s.unchallenged}` : "")
  )
}

const main = async () => {
  const trials = Number(arg("trials") ?? 3)
  const only = arg("case")
  const cases = only ? CORPUS.filter((c) => c.id === only) : CORPUS
  if (cases.length === 0) {
    console.error(`No such case: ${only}`)
    process.exit(1)
  }

  const vendors = await Effect.runPromise(
    Effect.gen(function* () {
      const clis = yield* DiscoveryService.list()
      const catalog = yield* ModelsService.catalog(clis)
      return reachableVendors(catalog)
    }).pipe(Effect.provide(AppLayer))
  )

  // Refuse rather than measure something meaningless. A one-vendor run cannot
  // compare cross-vendor to same-vendor, which is the only reason this exists.
  if (chooseRoles(vendors) === null) {
    console.error(
      `Need two reachable model providers; found ${vendors.length}` +
        (vendors[0] ? ` (${vendors[0].vendor})` : "") +
        ".\nInstall a second harness, or add a provider key, then re-run."
    )
    process.exit(1)
  }

  const heldOut = new Set(cases.filter((c) => c.heldOut).map((c) => c.id))
  // Each trial is three flagship runs, and measuring the premise doubles that —
  // a full corpus is tens of minutes and real quota. `--pairing cross` halves it
  // when you only want a detection number and not the premise comparison.
  const wanted = arg("pairing")
  const same = sameVendor(vendors)
  const pairings: ReadonlyArray<{ label: string; vendors: ReadonlyArray<VendorReach> }> = [
    ...(wanted === "same" ? [] : [{ label: "cross-vendor", vendors }]),
    ...(wanted === "cross" || same === null ? [] : [{ label: "same-vendor", vendors: same }])
  ]

  console.log(`\nPlanning eval — ${cases.length} cases x ${trials} trials\n`)
  const summaries: PairSummary[] = []
  for (const pairing of pairings) {
    const roles = chooseRoles(pairing.vendors)
    const label = roles ? `${pairing.label} (${roles.proposer.vendor}→${roles.adversary.vendor})` : pairing.label
    const results: TrialResult[] = []
    for (const evalCase of cases) {
      for (let t = 0; t < trials; t++) {
        const result = await Effect.runPromise(runTrial(evalCase, pairing.vendors, t))
        if (result) results.push(result)
        process.stdout.write(".")
      }
    }
    process.stdout.write("\n")
    summaries.push(summarise(label, results, heldOut))
  }

  console.log("")
  summaries.forEach(report)

  const crossSummary = summaries.find((s) => s.pair.startsWith("cross-vendor"))
  const sameSummary = summaries.find((s) => s.pair.startsWith("same-vendor"))
  if (crossSummary && sameSummary) {
    const delta = crossSummary.detectionRate - sameSummary.detectionRate
    console.log(`\n  PREMISE: cross-vendor beats same-vendor by ${pct(delta)}`)
    if (delta <= 0) {
      console.log(
        "  ⚠ The premise did NOT hold. The two-vendor gate has lost its justification —\n" +
          "    revisit the design rather than the eval."
      )
    }
  } else {
    console.log("\n  PREMISE: not measured — both pairings are needed for the comparison.")
  }

  // Baselines are advisory and printed, never a process failure: this is a tool
  // for thinking with, not a gate.
  const baselines = JSON.parse(readFileSync(BASELINES, "utf8")) as Record<string, number>
  for (const s of summaries) {
    const prior = baselines[s.pair]
    if (prior !== undefined && isRegression(s.detectionRate, prior)) {
      console.log(`\n  ⚠ REGRESSION on ${s.pair}: ${pct(prior)} → ${pct(s.detectionRate)}`)
    }
  }
  writeFileSync(
    BASELINES,
    `${JSON.stringify(Object.fromEntries(summaries.map((s) => [s.pair, s.detectionRate])), null, 2)}\n`
  )
  console.log("")
}

void main()
