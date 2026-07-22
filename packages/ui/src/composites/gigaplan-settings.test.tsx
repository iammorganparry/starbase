import type { HarnessBilling } from "@starbase/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GigaplanSettings } from "./gigaplan-settings.js"

// This project configures no testing-library setup file, so nothing unmounts
// between tests and the jsdom document accumulates. That is why the older
// composite tests reach for `getAllByText(...).length > 0` — a workaround which
// also makes it impossible to assert that something is ABSENT, since a previous
// test's DOM is still there. Cleaning up explicitly keeps the negative
// assertions below meaningful.
afterEach(cleanup)

const props = {
  catalog: [
    { cli: "claude" as const, label: "Claude Code", models: [{ id: "opus", label: "opus" }] },
    { cli: "codex" as const, label: "Codex CLI", models: [{ id: "gpt-5.6-sol", label: "sol" }] }
  ],
  orchestrator: null,
  defaultOrchestrator: { cli: "claude" as const, model: "opus" },
  onChange: vi.fn()
}

const billing = (over: Partial<HarnessBilling>[]): ReadonlyArray<HarnessBilling> =>
  over.map((o) => ({ cli: "claude", path: "subscription", keyWithheld: false, ...o }) as HarnessBilling)

describe("GigaplanSettings", () => {
  it("states the default rather than leaving it implicit", () => {
    // Nobody should read the source to learn what Gigaplan runs on out of the box.
    render(<GigaplanSettings {...props} />)
    expect(screen.getByText(/Using the default \(claude · opus\)/)).toBeTruthy()
  })

  it("explains itself when the host cannot orchestrate, rather than hiding", () => {
    render(<GigaplanSettings {...props} unavailableReason="Needs a second provider." />)
    expect(screen.getByText("Needs a second provider.")).toBeTruthy()
  })

  it("defaults legacy config to shadow and can opt the workspace into active mode", () => {
    const onRoutingChange = vi.fn()
    render(<GigaplanSettings {...props} onRoutingChange={onRoutingChange} />)
    expect(screen.getByRole("tab", { name: "Shadow" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText(/OpenRouter's rolling task-usage rankings/)).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: "Active" }))
    expect(onRoutingChange).toHaveBeenCalledWith({ mode: "active", overrides: [] })
  })

  it("keeps a stale override visible and labels it unavailable", () => {
    render(
      <GigaplanSettings
        {...props}
        routing={{
          mode: "shadow",
          overrides: [
            { taskKind: "schema", routes: [{ cli: "codex", model: "retired-model" }] }
          ]
        }}
      />
    )
    expect(screen.getByText("codex/retired-model unavailable")).toBeTruthy()
  })
})

describe("the billing panel", () => {
  it("names a plan and a metered key differently", () => {
    // The distinction IS the feature. "Charged to something" would be useless.
    render(
      <GigaplanSettings
        {...props}
        billing={billing([{ cli: "claude" }, { cli: "codex", path: "api-key" }])}
      />
    )
    expect(screen.getByText("your plan")).toBeTruthy()
    expect(screen.getByText("API key — metered")).toBeTruthy()
  })

  it("says so when a key was ignored in favour of the plan", () => {
    // The case that silently cost money. Acting on it without saying so would
    // leave the operator just as blind, only luckier.
    render(<GigaplanSettings {...props} billing={billing([{ cli: "codex", keyWithheld: true }])} />)
    expect(screen.getByText(/API key in your environment was ignored/)).toBeTruthy()
  })

  it("does not claim a key was ignored when none was there", () => {
    render(<GigaplanSettings {...props} billing={billing([{ cli: "claude" }])} />)
    expect(screen.queryByText(/was ignored/)).toBeNull()
  })

  it("distinguishes 'not signed in' from 'on a plan'", () => {
    // An unauthenticated harness will fail at run time; reporting it as covered
    // would be a lie the operator only discovers mid-run.
    render(<GigaplanSettings {...props} billing={billing([{ cli: "codex", path: "unknown" }])} />)
    expect(screen.getByText("not signed in")).toBeTruthy()
  })

  it("shows nothing at all before the probe returns", () => {
    // An empty panel would read as "no harnesses billed", which is false.
    render(<GigaplanSettings {...props} />)
    expect(screen.queryByText(/What this is charged to/)).toBeNull()
  })
})
