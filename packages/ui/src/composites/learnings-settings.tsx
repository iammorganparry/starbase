import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Toggle } from "../components/toggle.js"

/**
 * What Starbase has learned, what it stores, and who it tells.
 *
 * The organising principle: nobody should have to read the source to know what
 * is being collected. Everything here is stated concretely — the actual on-disk
 * paths, the actual field names that leave the machine, the actual organisation
 * — because a vague reassurance ("we only collect anonymous usage data") is
 * indistinguishable from a lie to the person reading it.
 */

/**
 * Exactly the fields a shared record carries.
 *
 * Cross-checked against `toContribution` by test: a promise about data that has
 * drifted from the code is worse than no promise, so adding a field to the wire
 * shape fails the build until this list names it too.
 */
export const SHARED_FIELDS: ReadonlyArray<{ name: string; what: string }> = [
  { name: "repoKey", what: "a hash of this repo's first commit — never its name" },
  { name: "taskKind", what: "which of eight kinds of work it was" },
  { name: "cli", what: "which harness ran it" },
  { name: "vendor", what: "which lab the model came from" },
  { name: "model", what: "the model id" },
  { name: "findingsCritical", what: "how many critical review findings" },
  { name: "findingsMajor", what: "how many major review findings" },
  { name: "findingsMinor", what: "how many minor review findings" },
  { name: "findingsNit", what: "how many nits" },
  { name: "ciPassed", what: "whether CI passed, or null if it never ran" },
  { name: "merged", what: "whether it merged, or null if still open" },
  { name: "filesReverted", what: "how many files you reverted" },
  { name: "planRevisions", what: "how many times the plan went back" },
  { name: "sizeBucket", what: "how big the change was, bucketed — never a line count" },
  { name: "score", what: "the computed score" },
  { name: "occurredOn", what: "the date, to the day — never a timestamp" },
  { name: "id", what: "the session id, so a retry cannot double-count" }
]

/** What is never shared, stated positively so it can be checked. */
const NEVER_SHARED = [
  "repository names",
  "branch names",
  "file paths",
  "step or session titles",
  "prompts, plans, or diffs",
  "pull request numbers",
  "wall-clock timestamps"
]

export interface LearningToggles {
  readonly enabled: boolean
  readonly sharing: boolean
  readonly evalJudge: boolean
}

/**
 * Apply one toggle, keeping the dependants honest.
 *
 * Extracted and pure because this is the fail-closed rule, not decoration:
 * turning the master switch off must turn the dependent switches off with it, or
 * the operator is left looking at a control that appears on while doing nothing
 * — and a stale `true` would come back to life the moment learning was
 * re-enabled.
 */
export const applyToggle = (
  current: LearningToggles,
  change: Partial<LearningToggles>
): LearningToggles => {
  const next = { ...current, ...change }
  if (!next.enabled) return { enabled: false, sharing: false, evalJudge: false }
  return next
}

export interface LearnedCell {
  readonly repoKey: string
  readonly taskKind: string
  readonly model: string
  readonly observations: number
  /** Which level of the hierarchy answered — "prior" means no evidence yet. */
  readonly level: string
  readonly estimate: number
}

export interface LearningsSettingsProps {
  readonly enabled: boolean
  readonly sharing: boolean
  readonly evalJudge: boolean
  readonly onChange: (next: LearningToggles) => void
  /** The organisation sharing is scoped to, by NAME. Null when not in one. */
  readonly organisationName: string | null
  /** Absolute paths this feature writes to, so the claim is checkable. */
  readonly storagePaths: ReadonlyArray<string>
  readonly learned: ReadonlyArray<LearnedCell>
  readonly onPurge: () => void
  readonly className?: string
}

const Row = ({
  title,
  description,
  checked,
  disabled,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) => (
  <div className={cn("flex items-start gap-3 py-2.5", disabled && "opacity-50")}>
    <Toggle checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <div className="min-w-0">
      <p className="text-[13px] text-text">{title}</p>
      <p className="mt-0.5 text-[12px] text-text-body">{description}</p>
    </div>
  </div>
)

export function LearningsSettings({
  enabled,
  sharing,
  evalJudge,
  onChange,
  organisationName,
  storagePaths,
  learned,
  onPurge,
  className
}: LearningsSettingsProps) {
  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <section>
        <Row
          title="Learn from my finished work"
          description="Score completed sessions from review findings, CI, merges and reverts, so Starbase can suggest which agent suits which kind of task in each repo. Off by default — nothing is read or written until you turn this on."
          checked={enabled}
          onChange={(v) => onChange(applyToggle({ enabled, sharing, evalJudge }, { enabled: v }))}
        />
        <Row
          title={
            organisationName
              ? `Share learnings with ${organisationName}`
              : "Share learnings with my team"
          }
          description={
            organisationName
              ? "Pool evidence with teammates working on the same repositories. Only the fields listed below are sent, and only for outcomes we could attribute confidently."
              : "You are not in an organisation, so there is nobody to share with yet."
          }
          checked={sharing}
          // Both switches, and the disabled state makes the dependency visible
          // rather than silently ignoring a toggle the operator just moved.
          disabled={!enabled || organisationName === null}
          onChange={(v) => onChange(applyToggle({ enabled, sharing, evalJudge }, { sharing: v }))}
        />
        <Row
          title="Let a small model judge quality"
          description="Runs a cheap model over finished work to score what CI and review cannot see. This is the only part that spends — it uses your subscription — so it is capped per day and runs only while you are idle."
          checked={evalJudge}
          disabled={!enabled}
          onChange={(v) => onChange(applyToggle({ enabled, sharing, evalJudge }, { evalJudge: v }))}
        />
      </section>

      <section>
        <h3 className="text-[12px] font-semibold text-text">Where it is stored</h3>
        <ul className="mt-1.5 flex list-none flex-col gap-0.5 p-0">
          {storagePaths.map((p) => (
            <li key={p} className="font-mono text-[11px] text-text-body">
              {p}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="text-[12px] font-semibold text-text">What a shared record contains</h3>
        <ul className="mt-1.5 flex list-none flex-col gap-0.5 p-0">
          {SHARED_FIELDS.map((f) => (
            <li key={f.name} className="text-[11.5px] text-text-body">
              <span className="font-mono text-[11px] text-text">{f.name}</span> — {f.what}
            </li>
          ))}
        </ul>
        <Callout tone="blue" className="mt-2">
          <span className="text-[11.5px]">Never sent: {NEVER_SHARED.join(", ")}.</span>
        </Callout>
      </section>

      <section>
        <h3 className="text-[12px] font-semibold text-text">What it has learned</h3>
        {learned.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            Nothing yet. Recommendations will come from the curated starting beliefs until this
            fills in.
          </p>
        ) : (
          <table className="mt-1.5 w-full text-left text-[11.5px]">
            <thead>
              <tr className="text-muted-foreground">
                <th className="font-normal">Work</th>
                <th className="font-normal">Model</th>
                <th className="font-normal">Score</th>
                <th className="font-normal">Based on</th>
              </tr>
            </thead>
            <tbody>
              {learned.map((c) => (
                <tr key={`${c.repoKey}:${c.taskKind}:${c.model}`} className="text-text-body">
                  <td>{c.taskKind}</td>
                  <td className="font-mono text-[11px]">{c.model}</td>
                  <td>{Math.round(c.estimate * 100)}</td>
                  <td className="text-muted-foreground">
                    {/* A prior is a starting belief, not a measurement, and must
                        never render as though it were one. */}
                    {c.level === "prior"
                      ? "a starting belief, no evidence yet"
                      : `${c.observations} ${c.observations === 1 ? "task" : "tasks"} (${c.level})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <Button variant="danger" onClick={onPurge}>
          Delete everything Starbase has learned
        </Button>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Removes the local record and every outcome you contributed. Teammates' contributions are
          untouched.
        </p>
      </section>
    </div>
  )
}
