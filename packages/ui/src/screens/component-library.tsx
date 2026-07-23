import type { ReactNode } from "react"
import type { Session } from "@starbase/core"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"
import { StatusDot } from "../components/status-dot.js"
import { Pill } from "../components/pill.js"
import { Eyebrow, ClaudeGlyph } from "../components/eyebrow.js"
import { Avatar } from "../components/avatar.js"
import { DiffStat } from "../components/diff-stat.js"
import { Toggle } from "../components/toggle.js"
import { Spinner, Skeleton } from "../components/loading.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { Callout } from "../components/callout.js"
import { ToolCall } from "../composites/tool-call.js"
import { ThoughtBlock } from "../composites/thought-block.js"
import { PhaseNode } from "../composites/phase-node.js"
import { AgentCard } from "../composites/agent-card.js"
import { ApprovalGate } from "../composites/approval-gate.js"
import { SlashCommandRow } from "../composites/slash-command-row.js"
import { McpServerRow } from "../composites/mcp-server-row.js"
import { SessionRow } from "../composites/session-row.js"
import { Composer } from "../composites/composer.js"
import { DiffHunk } from "../diff/diff-hunk.js"

/*
 * The swatch ribbons name TOKENS, not hexes — this gallery is the one screen
 * that has to repaint with the theme, or it documents One Dark Pro forever
 * rather than whatever is actually active.
 */
const SURFACES = ["editor", "panel", "sunken", "surface", "border"]
const ACCENTS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange"]

const demoSession: Session = {
  id: "demo",
  repo: "trigify/api",
  branch: "feat/oauth",
  title: "Refactor auth flow",
  status: "thinking",
  cli: "claude",
  diff: { added: 313, removed: 23 },
  prNumber: 482,
  costUsd: 1.24,
  tokens: 218000,
  updatedAt: "2026-07-11T09:41:00.000Z"
}

/** Implements Component Library.dc.html — the living design-system gallery. */
export function ComponentLibrary() {
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-8 bg-canvas px-14 py-13 text-text">
      {/* Header */}
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <span className="flex size-[26px] items-center justify-center rounded-md bg-blue text-[14px] text-editor">
            ✦
          </span>
          <span className="text-[22px] font-bold tracking-[-.2px] text-text-bright">
            Starbase component library
          </span>
          <Badge tone="count">One Dark Pro</Badge>
        </div>
        <p className="m-0 max-w-[640px] text-[13.5px] leading-[1.6] text-muted-foreground">
          Atoms compose into molecules; molecules compose into the screens. shadcn primitives at the
          base, styled to the One Dark style guide. Radii are editor-tight (rows/cards 5, chips 4,
          gutters 3, callouts 7).
        </p>
      </header>

      {/* Tokens ribbon */}
      <div className="flex flex-wrap gap-6 rounded-lg border border-line bg-panel px-[18px] py-4">
        <Ribbon label="Surfaces">
          {SURFACES.map((c) => (
            <span key={c} title={`--sb-${c}`} className="size-[30px] rounded-md border border-line" style={{ background: `var(--sb-${c})` }} />
          ))}
        </Ribbon>
        <Ribbon label="Text ramp">
          {["text-text-bright", "text-text", "text-muted-foreground", "text-dim", "text-line-strong"].map((c) => (
            <span key={c} className={`text-[15px] ${c}`}>
              Ab
            </span>
          ))}
        </Ribbon>
        <Ribbon label="Accents">
          {ACCENTS.map((c) => (
            <span key={c} title={`--sb-${c}`} className="size-[30px] rounded-md" style={{ background: `var(--sb-${c})` }} />
          ))}
        </Ribbon>
        <Ribbon label="Type">
          <span className="text-[15px] text-text-bright">Hanken Grotesk</span>
          <span className="font-mono text-[13px] text-text">JetBrains Mono</span>
        </Ribbon>
      </div>

      {/* Atoms */}
      <SectionTitle title="Atoms" hint="the smallest reusable pieces" />
      <Grid>
        <Spec title="StatusDot">
          <Row><StatusDot status="thinking" /> thinking</Row>
          <Row><StatusDot status="needs-input" /> needs input</Row>
          <Row><StatusDot status="done" /> success</Row>
          <Row><StatusDot tone="bg-red" glow={false} /> error</Row>
          <Row><StatusDot status="idle" /> idle</Row>
        </Spec>
        <Spec title="Kbd">
          <div className="flex flex-wrap gap-1.5">
            <Kbd>⌘K</Kbd> <Kbd>↵</Kbd> <Kbd>esc</Kbd> <Kbd>⌥↵</Kbd> <Kbd onFill>↵ on fill</Kbd>
          </div>
        </Spec>
        <Spec title="Tag / Chip">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="count" size="xs">count 4</Badge>
            <Badge tone="blue">blue</Badge>
            <Badge tone="yellow">yellow</Badge>
            <Badge tone="green">green</Badge>
            <Badge tone="red">red</Badge>
            <Badge tone="purple">purple</Badge>
          </div>
        </Spec>
        <Spec title="Pill">
          <div className="flex flex-wrap gap-2">
            <Pill tone="yellow" pulse>Running</Pill>
            <Pill tone="green">Connected</Pill>
            <Pill tone="blue" dot={false}>Awaiting</Pill>
            <Pill tone="red">Error</Pill>
          </div>
        </Spec>
        <Spec title="Button">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary <Kbd onFill>↵</Kbd></Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
        </Spec>
        <Spec title="Eyebrow">
          <Eyebrow>You</Eyebrow>
          <Eyebrow accent icon={<ClaudeGlyph />}>Claude</Eyebrow>
          <Eyebrow>Section header</Eyebrow>
        </Spec>
        <Spec title="Avatar">
          <div className="flex items-center gap-2.5">
            <Avatar initial="C" tone="blue" />
            <Avatar initial="D" tone="orange" />
            <Avatar initial="Y" tone="dim" />
            <Avatar initial="C" tone="blue" size={20} />
          </div>
        </Spec>
        <Spec title="DiffStat">
          <div className="flex items-center gap-3.5 font-mono text-[12px]">
            <DiffStat added={313} removed={23} />
            <DiffStat added={9} removed={1} />
            <DiffStat added={37} />
          </div>
        </Spec>
        <Spec title="Toggle">
          <div className="flex items-center gap-4">
            <Toggle defaultChecked />
            <Toggle />
          </div>
        </Spec>
        <Spec title="Loading">
          <div className="flex items-center gap-4">
            <Spinner />
            <Skeleton className="flex-1" />
          </div>
        </Spec>
      </Grid>

      {/* Molecules */}
      <SectionTitle title="Molecules" hint="atoms composed into working parts" />
      <Grid>
        <Spec title="SegmentedControl">
          <SegmentedControl
            value="progress"
            items={[
              { value: "progress", label: "Progress" },
              { value: "changes", label: "Changes" },
              { value: "report", label: "Report", disabled: true }
            ]}
          />
        </Spec>
        <Spec title="ToolCall">
          <ToolCall status="success" name="Read" target="billing.ts" meta="142" />
          <ToolCall status="running" name="Grep" target="TODO" />
          <ToolCall status="error" name="Bash" target="build" meta="exit 1" />
        </Spec>
        <Spec title="ThoughtBlock">
          <ThoughtBlock seconds={6} defaultOpen>
            Reasoning summary, dim &amp; collapsible.
          </ThoughtBlock>
        </Spec>
        <Spec title="PhaseNode">
          <PhaseNode index="02" title="Audit" state="active" hint="viewing" counts="5✓ 6● 1✗" />
          <PhaseNode index="03" title="Verify" state="pending" />
        </Spec>
        <Spec title="AgentCard">
          <AgentCard file="billing.ts" state="working" tokens="31k" status="reading middleware…" />
          <AgentCard file="api-keys.ts" state="flagged" status="⚠ 2 findings" />
        </Spec>
        <Spec title="Callout">
          <Callout tone="yellow">Large workflow — 26 agents.</Callout>
          <Callout tone="green">Verified by a reviewer.</Callout>
        </Spec>
        <Spec title="ApprovalGate" wide>
          <ApprovalGate
            kind="command"
            title="Approval needed · run a command"
            detail="Not in your allowlist. Agents never run shell commands until you allow."
            command="npm test -- billing"
            allowLabel="npm test"
            status="pending"
          />
        </Spec>
        <Spec title="SlashCommandRow">
          <SlashCommandRow name="review" description="Review the current diff" badge="built-in" active />
          <SlashCommandRow
            name="deep-research"
            description="Cross-checked research"
            glyph="✦"
            glyphTone="purple"
            badge="workflow"
            badgeTone="purple"
          />
        </Spec>
        <Spec title="McpServerRow">
          <McpServerRow name="Linear" transport="stdio" meta="6 tools · project" />
        </Spec>
        <Spec title="SessionRow">
          <SessionRow session={demoSession} active />
        </Spec>
        <Spec title="DiffHunk" wide>
          <DiffHunk
            path="billing.ts"
            added={2}
            removed={1}
            lines={[
              { type: "del", ln: 88, content: "router.post('/refund', h)" },
              { type: "add", ln: 88, content: "router.post('/refund', requireAuth, h)" }
            ]}
          />
        </Spec>
        <Spec title="Composer" wide>
          <Composer />
        </Spec>
      </Grid>
    </div>
  )
}

function Ribbon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  )
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[15px] font-semibold text-text-bright">{title}</span>
      <span className="text-[12px] text-dim">{hint}</span>
    </div>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-4">{children}</div>
}

function Spec({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <div
      className="flex flex-col rounded-lg border border-line bg-panel"
      style={{ width: wide ? 456 : 332 }}
    >
      <div className="flex items-center gap-2 border-b border-hairline px-[13px] py-2.5">
        <span className="flex-1 text-[12.5px] font-semibold text-text-bright">{title}</span>
        <Badge tone="cyan" size="xs">component</Badge>
      </div>
      <div className="flex flex-col gap-2.5 px-[13px] py-4">{children}</div>
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 text-[12px] text-muted-foreground">{children}</div>
}
