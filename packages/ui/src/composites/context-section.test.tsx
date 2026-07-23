import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CliInfo, ContextConfig, ProvidersConfig } from "@starbase/core"
import { SettingsView } from "./settings-view.js"

afterEach(cleanup)

const GH_UNAVAILABLE = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

const cli = (over: Partial<CliInfo>): CliInfo => ({
  kind: "claude",
  label: "Claude Code",
  binPath: "/usr/local/bin/claude",
  version: "1.0.0",
  available: true,
  contextReporting: true,
  ...over
})

const CLIS: ReadonlyArray<CliInfo> = [
  cli({}),
  cli({ kind: "codex", label: "Codex CLI" }),
  cli({ kind: "cursor", label: "Cursor Agent", contextReporting: false }),
  cli({ kind: "opencode", label: "opencode" })
]

const open = (
  props: {
    context?: ContextConfig | null
    providers?: ProvidersConfig
    onSaveContext?: (c: ContextConfig) => void
    onSaveProvider?: ReturnType<typeof vi.fn>
    contextSessions?: React.ComponentProps<typeof SettingsView>["contextSessions"]
  } = {}
) => {
  render(
    <SettingsView
      clis={CLIS}
      ghStatus={GH_UNAVAILABLE}
      onSaveProvider={props.onSaveProvider ?? vi.fn()}
      loadModels={async () => []}
      context={props.context ?? null}
      providers={props.providers}
      onSaveContext={props.onSaveContext}
      contextSessions={props.contextSessions}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: /Context/ }))
}

/**
 * Settings → Context is where every token lever lives. The tests are mostly
 * about the numbers being shown TOGETHER and in terms the user can act on —
 * a budget with no sense of what sessions actually use is just a slider.
 */
describe("Settings → Context", () => {
  it("ships with auto-compaction on and the maximum quality-band budget", () => {
    open()
    expect(screen.getByLabelText("Working-set budget")).toHaveProperty("value", "500000")
    expect(screen.getByText("500k tokens")).toBeDefined()
  })

  it("saves a new budget as the slider moves", () => {
    const onSaveContext = vi.fn()
    open({ onSaveContext })
    fireEvent.change(screen.getByLabelText("Working-set budget"), { target: { value: "360000" } })
    expect(onSaveContext).toHaveBeenCalledWith({ auto: true, budgetTokens: 360_000 })
  })

  it("saves the master switch", () => {
    const onSaveContext = vi.fn()
    open({ onSaveContext })
    fireEvent.click(screen.getByRole("switch"))
    expect(onSaveContext).toHaveBeenCalledWith({ auto: false, budgetTokens: 500_000 })
  })

  it("constrains the budget to the usable quality band", () => {
    open()
    const slider = screen.getByLabelText("Working-set budget")
    expect(slider).toHaveProperty("min", "256000")
    expect(slider).toHaveProperty("max", "500000")
  })

  /**
   * The lever only makes sense alongside its consequence. The current Claude
   * default is a 1M model, so it reaches the 500k quality cap; Codex reaches its
   * smaller window's safety margin instead.
   */
  it("translates the budget into a per-harness trigger point", () => {
    open()
    expect(screen.getByText(/apply to each harness's default model/)).toBeDefined()
    expect(screen.getByText("500k of 1M")).toBeDefined()
    expect(screen.getByText("194k of 258k")).toBeDefined()
  })

  it("recomputes the trigger points when the budget moves", () => {
    open()
    fireEvent.change(screen.getByLabelText("Working-set budget"), { target: { value: "256000" } })
    // The configured 256k budget now binds before Claude's 1M window.
    expect(screen.getByText("256k of 1M")).toBeDefined()
    expect(screen.getByText("256k tokens")).toBeDefined()
  })

  it("uses the provider's configured model for the preview", () => {
    open({
      providers: {
        claude: { enabled: true, defaultMode: "accept-edits", defaultModel: "claude-opus-4-1" }
      }
    })
    expect(screen.getByText("150k of 200k")).toBeDefined()
  })

  it("falls back to the harness default when the configured model is empty", () => {
    open({
      providers: {
        claude: { enabled: true, defaultMode: "accept-edits", defaultModel: "" }
      }
    })
    expect(screen.getByText("500k of 1M")).toBeDefined()
  })

  it("names harnesses that cannot be measured instead of hiding them", () => {
    open()
    expect(screen.getByText("Cursor Agent")).toBeDefined()
    expect(screen.getByText("reports no usage")).toBeDefined()
    // …and it gets no window override, which would be a dead control: with no
    // usage reported there is nothing to measure a declared window against.
    expect(screen.queryByLabelText("Cursor Agent context window")).toBeNull()
  })

  /**
   * The user's second question after "what is this" is "what will it cost me".
   * The answer — nothing beyond the plan they already pay for — is stated
   * outright rather than left to be inferred.
   */
  it("says summaries run on the signed-in CLI at no extra cost", () => {
    open()
    expect(screen.getByText(/no API key/)).toBeDefined()
    expect(screen.getByText(/cheapest tier/)).toBeDefined()
  })

  it("shows which model summarises for each harness", () => {
    open()
    // The cheap tier, not the session's model.
    expect(screen.getAllByText("haiku").length).toBeGreaterThan(0)
  })

  it("reassures that the transcript is never truncated", () => {
    open()
    expect(screen.getByText(/transcript is never truncated/)).toBeDefined()
  })

  it("lists live sessions against the budget when there are any", () => {
    open({
      contextSessions: [
        {
          id: "s1",
          title: "Rate limiting",
          cli: "claude",
          snapshot: {
            sessionId: "s1",
            tokens: 150_000,
            window: 200_000,
            budget: 300_000,
            triggerAt: 170_000,
            phase: "idle",
            preparing: false,
            digestReady: false,
            lastCompactedAt: null,
            compactions: 0,
            stalled: false
          }
        }
      ]
    })
    expect(screen.getByText("Rate limiting")).toBeDefined()
    expect(screen.getByText("150k")).toBeDefined()
  })

  // opencode resolves models from the user's own credentials across ~167
  // providers, so there is no honest window to infer — this input is the only
  // route to auto-compaction for it, and it has to be findable.
  it("offers a window override for harnesses whose window cannot be inferred", () => {
    open()
    expect(screen.getByLabelText("opencode context window")).toBeDefined()
    // Claude's window IS known, so it must not be asked for.
    expect(screen.queryByLabelText("Claude Code context window")).toBeNull()
  })

  it("saves a window override", () => {
    const onSaveProvider = vi.fn()
    open({ onSaveProvider })
    const input = screen.getByLabelText("opencode context window")
    fireEvent.blur(input, { target: { value: "200000" } })
    expect(onSaveProvider).toHaveBeenCalledWith(
      "opencode",
      expect.objectContaining({ contextWindow: 200_000 })
    )
  })

  it("clears the override when emptied rather than storing a zero", () => {
    const onSaveProvider = vi.fn()
    open({ onSaveProvider })
    fireEvent.blur(screen.getByLabelText("opencode context window"), { target: { value: "" } })
    expect(onSaveProvider).toHaveBeenCalledWith(
      "opencode",
      expect.objectContaining({ contextWindow: undefined })
    )
  })
})
