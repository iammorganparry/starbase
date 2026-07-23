import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ConversationView } from "./conversation-view.js"

afterEach(cleanup)

describe("ConversationView — live context", () => {
  it("shows the latest context reading while Codex is still active", () => {
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        cli="codex"
        busy
        tokens={120_000}
        contextTriggerAt={193_800}
        contextPhase="idle"
        runStartedAt={Date.now()}
        onStop={() => undefined}
      />
    )

    expect(screen.getByText("120k")).toBeDefined()
    expect(screen.getByText("context")).toBeDefined()
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined()
  })
})
