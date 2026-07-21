import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { TabBar, type TabKey } from "./tab-bar.js"

afterEach(cleanup)

const TABS: ReadonlyArray<TabKey> = ["conversation", "plan", "pr", "review"]

const noop = () => {}

const renderAt = (width: number, extra: Partial<React.ComponentProps<typeof TabBar>> = {}) =>
  render(
    <WidthTierValue width={width}>
      <TabBar
        tabs={TABS}
        active="review"
        onChange={noop}
        onClosePane={noop}
        onToggleSplit={noop}
        onToggleBrowser={noop}
        onMovePaneLeft={noop}
        onMovePaneRight={noop}
        {...extra}
      />
    </WidthTierValue>
  )

describe("TabBar at width", () => {
  it("shows every tab label when the pane is wide", () => {
    renderAt(1200)
    expect(screen.getByText("Conversation")).toBeTruthy()
    expect(screen.getByText("Pull Request")).toBeTruthy()
    expect(screen.getByText("Code Review")).toBeTruthy()
  })

  it("keeps the ACTIVE tab's label when the rest go icon-only", () => {
    renderAt(600)
    // Losing every label leaves a row of near-identical glyphs with no answer to
    // "what am I looking at" — the one question a tab bar exists to answer.
    expect(screen.getByText("Code Review")).toBeTruthy()
    expect(screen.queryByText("Pull Request")).toBeNull()
  })

  it("keeps every tab reachable by name once the labels are hidden", () => {
    renderAt(600)
    // The aria-label survives the text being dropped, so a screen reader and a
    // by-name lookup both still find the tab.
    expect(screen.getByRole("button", { name: "Pull Request" })).toBeTruthy()
  })

  it("folds the pane actions into a menu below the mid tier", () => {
    renderAt(420)
    expect(screen.queryByTestId("move-pane-left")).toBeNull()
    expect(screen.queryByTestId("toggle-browser")).toBeNull()
    expect(screen.getByTestId("pane-actions-menu")).toBeTruthy()
  })

  it("never collapses close-pane — the one control you need BECAUSE the pane is narrow", () => {
    renderAt(320)
    expect(screen.getByTestId("close-pane")).toBeTruthy()
  })

  it("still fires the collapsed actions from the menu", () => {
    const onMovePaneLeft = vi.fn()
    renderAt(420, { onMovePaneLeft })
    fireEvent.pointerDown(
      screen.getByTestId("pane-actions-menu"),
      new PointerEvent("pointerdown", { bubbles: true, ctrlKey: false, button: 0 })
    )
    fireEvent.click(screen.getByLabelText("Move pane left"))
    expect(onMovePaneLeft).toHaveBeenCalledOnce()
  })

  it("renders no overflow menu when there is nothing to collapse into it", () => {
    render(
      <WidthTierValue width={420}>
        <TabBar tabs={TABS} active="conversation" onChange={noop} />
      </WidthTierValue>
    )
    expect(screen.queryByTestId("pane-actions-menu")).toBeNull()
  })
})
