# Planning eval

Measures whether adversarial planning actually works, and whether the premise it
rests on is true.

```bash
pnpm eval:planning                      # all cases, 3 trials each
pnpm eval:planning --trials 5
pnpm eval:planning --case ordering-backfill
pnpm eval:planning --pairing cross      # skip the premise comparison, half the cost
```

**Budget.** Each trial is three flagship runs (propose, attack, revise), and the
premise comparison doubles that. A single case at one trial took over ten minutes
on a laptop; a full corpus is tens of minutes and real quota. Start with
`--case <id> --trials 1` when you are changing the harness rather than measuring.

**This never runs in CI.** It costs real tokens and is nondeterministic; a
nondeterministic gate on a PR is a coin flip that blocks people.

## What it measures

The headline number is the **premise**: does a critic from a *different lab*
catch more than one from the *same lab*? The entire vendor design — `vendorOf`,
the two-vendor gate, harness preference — is justified by that claim alone, and
it was untested. The harness runs the corpus both ways and prints the delta.

If cross-vendor does not clear same-vendor by a real margin, **the gate has lost
its justification.** The honest response is to change the design, not the eval.

## How you grade an open-ended plan

You can't score "is this plan good". You can plant a specific defect and measure
detection — and because we planted it, we know exactly what catching it reads
like. Each case is a brief, a tiny git fixture, and a deterministic predicate.

Deterministic grading is a deliberate choice: free, reproducible, diffable. An
LLM grader would reintroduce the nondeterminism the harness exists to measure
against.

Seeded defect classes: `ordering`, `hidden-coupling`, `irreversibility`,
`test-gap`, `convention`, `scope-creep`.

## Metrics, and which ones are scores

| Metric | Scored? |
|---|---|
| **detection rate** | yes — the headline |
| **held-out detection** | yes, reported separately |
| challenges/trial | **no** — a noise proxy only |
| capitulations | yes — lower is better |
| unchallenged rounds | health signal, not quality |

**Challenges per trial is never scored against.** A critic may legitimately find
real problems we didn't plant, and penalising that would train the corpus to
reward silence.

**Capitulations** counts steps the revision deleted that no challenge asked
about. It's the failure mode nobody instruments and the one most likely to make
this feature actively harmful: a model handed objections tends to "resolve" all
of them, including the wrong ones, and a plan degraded to satisfy a bad critique
is worse than an unrevised plan.

## Held-out cases

Roughly a third of the corpus is `heldOut: true` and excluded from prompt
iteration. Tune against the rest. Without the split, tuning the adversary until
it aces a fixed corpus just teaches it the corpus and the number stops meaning
anything.

## Baselines

`baselines.json` records the last run's detection rate per pairing. A drop beyond
`REGRESSION_BAND` (15 points) is reported — generously, because model output is
noisy and a threshold that fires on normal variance gets muted. A muted eval is
worse than no eval: it looks like coverage while asserting nothing.

Baselines are advisory and printed. They never fail the process.
