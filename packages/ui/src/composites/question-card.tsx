import * as React from "react"
import { ArrowLeft, Check, CircleHelp } from "lucide-react"
import type { QuestionAnswer, QuestionRequest } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Eyebrow } from "../components/eyebrow.js"
import { Kbd } from "../components/kbd.js"

/**
 * The docked AskUserQuestion card — the SDK's structured multiple-choice flow,
 * rendered in the composer slot (it replaces the chat input while a question is
 * pending). Walks through `request.questions` one at a time; each question is a
 * set of clickable option rows (radio for single-select, checkbox for multi) plus
 * an auto-provided "Other" free-text row. Pure presentational: props in, one
 * `QuestionAnswer` per question out. Keyboard-driven (1–9 pick/toggle, O other,
 * ←/→ navigate, ↵ next/submit).
 */
export function QuestionCard({
  request,
  onSubmit,
  onCancel,
  submitting = false
}: {
  request: QuestionRequest
  /** One answer per question, in order. */
  onSubmit: (answers: readonly QuestionAnswer[]) => void
  /** Skip / dismiss the whole question group. */
  onCancel?: () => void
  /** Show a spinner on the submit button while the answers are in flight. */
  submitting?: boolean
}) {
  const questions = request.questions
  const n = questions.length
  const [qi, setQi] = React.useState(0)
  // Selected option labels per question (excludes "Other"); single-select holds ≤1.
  const [selected, setSelected] = React.useState<Record<number, ReadonlyArray<string>>>({})
  // Free-text "Other" answer per question.
  const [other, setOther] = React.useState<Record<number, string>>({})
  const otherRef = React.useRef<HTMLInputElement>(null)

  const q = questions[qi]!
  const sel = selected[qi] ?? []
  const otherText = other[qi] ?? ""
  const otherActive = otherText.trim() !== ""
  const answered = sel.length > 0 || otherActive
  const isLast = qi === n - 1

  const pickOption = (label: string) => {
    if (q.multiSelect) {
      setSelected((prev) => {
        const cur = prev[qi] ?? []
        return {
          ...prev,
          [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
        }
      })
    } else {
      // Single-select: options and "Other" are mutually exclusive.
      setSelected((prev) => ({ ...prev, [qi]: [label] }))
      setOther((prev) => ({ ...prev, [qi]: "" }))
    }
  }

  const setOtherText = (text: string) => {
    setOther((prev) => ({ ...prev, [qi]: text }))
    if (!q.multiSelect && text.trim() !== "") {
      setSelected((prev) => (prev[qi]?.length ? { ...prev, [qi]: [] } : prev))
    }
  }

  const goBack = () => setQi((i) => Math.max(0, i - 1))

  const submit = () => {
    const answers: ReadonlyArray<QuestionAnswer> = questions.map((_, i) => {
      const o = (other[i] ?? "").trim()
      return { selected: selected[i] ?? [], other: o === "" ? null : o }
    })
    onSubmit(answers)
  }

  const goNext = () => {
    if (!answered || submitting) return
    if (isLast) submit()
    else setQi((i) => i + 1)
  }

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement
      const inOther = active === otherRef.current
      const onButton = active instanceof HTMLButtonElement

      if (e.key === "Enter") {
        // Let a focused button fire its own click instead of double-advancing.
        if (onButton) return
        e.preventDefault()
        goNext()
        return
      }
      // While typing a custom answer, only Enter is a shortcut.
      if (inOther) return

      if (e.key === "ArrowLeft") {
        e.preventDefault()
        goBack()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        goNext()
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault()
        otherRef.current?.focus()
      } else if (/^[1-9]$/.test(e.key)) {
        const opt = q.options[Number(e.key) - 1]
        if (opt) {
          e.preventDefault()
          pickOption(opt.label)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // Re-subscribe when the question or its selections change so the closure is fresh.
  }, [qi, selected, other, submitting])

  const hint = `1–9 ${q.multiSelect ? "toggle" : "pick"} · O other · ↵ next`

  return (
    <div className="animate-slide-in overflow-hidden rounded-lg border border-line bg-panel">
      {/* Header: icon · eyebrow · question count · progress dots */}
      <div className="flex items-center gap-[9px] border-b border-hairline px-[14px] py-2.5">
        <CircleHelp size={14} className="flex-none text-blue" />
        <Eyebrow className="flex-1 text-muted-foreground">Claude needs your input</Eyebrow>
        <span className="font-mono text-[10.5px] text-dim">
          Question {qi + 1} of {n}
        </span>
        <div className="flex items-center gap-[5px]">
          {questions.map((_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === qi ? "bg-blue" : i < qi ? "bg-blue/40" : "bg-line"
              )}
            />
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="px-[15px] pb-1 pt-[15px]">
        <div className="flex items-center gap-2">
          <span className="text-[15.5px] font-semibold text-text-bright">{q.question}</span>
          {q.multiSelect && (
            <Badge tone="purple" size="xs">
              select all that apply
            </Badge>
          )}
        </div>

        <div className="mt-[18px] flex flex-col gap-[7px]">
          {q.options.map((opt, i) => {
            const on = sel.includes(opt.label)
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => pickOption(opt.label)}
                className={cn(
                  "flex w-full items-start gap-[11px] rounded-[7px] border px-3 py-[11px] text-left transition-colors",
                  on ? "border-blue/55 bg-blue/10" : "border-line bg-sunken hover:border-line-strong"
                )}
              >
                <KeyBadge active={on}>{i + 1}</KeyBadge>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      "text-[13.5px] font-medium",
                      on ? "text-text-bright" : "text-text"
                    )}
                  >
                    {opt.label}
                  </span>
                  <span className="text-[11.5px] leading-snug text-dim">{opt.description}</span>
                </span>
                <Indicator selected={on} multi={q.multiSelect} />
              </button>
            )
          })}

          {/* Auto-provided "Other" free-text row. */}
          <div
            onClick={() => otherRef.current?.focus()}
            className={cn(
              "flex cursor-text items-center gap-[11px] rounded-[7px] border px-3 py-2.5 transition-colors",
              otherActive ? "border-blue/55 bg-blue/10" : "border-line bg-sunken"
            )}
          >
            <KeyBadge active={otherActive}>O</KeyBadge>
            <span className="flex-none text-[13.5px] font-medium text-text">Other</span>
            <input
              ref={otherRef}
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="Type a custom answer…"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-text-body outline-none placeholder:text-dim"
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-[9px] border-t border-hairline px-[14px] py-[11px]">
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={qi === 0} onClick={goBack}>
          <ArrowLeft size={13} />
          Back
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Skip
          </Button>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-dim">{hint}</span>
        <Button
          variant="primary"
          size="sm"
          className="gap-1.5"
          disabled={!answered || submitting}
          onClick={goNext}
        >
          {submitting && (
            <span className="size-3.5 animate-spin-fast rounded-full border-2 border-current/30 border-t-current" />
          )}
          {isLast ? "Submit" : "Next"}
          <Kbd onFill>↵</Kbd>
        </Button>
      </div>
    </div>
  )
}

/** The mono key badge (1–4 / O) at the head of each option row. */
function KeyBadge({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex size-[22px] flex-none items-center justify-center rounded-[5px] border font-mono text-[11px] font-semibold",
        active ? "border-blue bg-blue text-editor" : "border-line bg-transparent text-muted-foreground"
      )}
    >
      {children}
    </span>
  )
}

/** The trailing selection indicator — a circle (radio) for single, square for multi. */
function Indicator({ selected, multi }: { selected: boolean; multi: boolean }) {
  return (
    <span
      className={cn(
        "flex size-[18px] flex-none items-center justify-center border-[1.5px] transition-colors",
        multi ? "rounded-[5px]" : "rounded-full",
        selected ? "border-blue bg-blue text-editor" : "border-line bg-transparent"
      )}
    >
      {selected && <Check size={12} strokeWidth={3} />}
    </span>
  )
}
