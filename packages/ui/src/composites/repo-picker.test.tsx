import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Repo } from "@starbase/core"
import { RepoPicker } from "./repo-picker.js"

const repo = (name: string, path = `/code/${name}`): Repo => ({ name, path }) as Repo

const REPOS = [
  repo("gtm-grid"),
  repo("starbase"),
  repo("trigify-app"),
  repo("athena"),
  repo("avatarz"),
  repo("buffet-line"),
  repo("claude-code")
]

const STARRED = ["/code/gtm-grid", "/code/starbase", "/code/trigify-app"]

afterEach(cleanup)

const open = async () => {
  await userEvent.click(screen.getByTestId("repo-picker-trigger"))
  return waitFor(() => screen.getByPlaceholderText("Search repos…"))
}

describe("RepoPicker", () => {
  it("shows the selected repo's name on the trigger", () => {
    render(<RepoPicker repos={REPOS} value="/code/athena" onChange={() => {}} />)
    expect(screen.getByTestId("repo-picker-trigger").textContent).toContain("athena")
  })

  it("splits starred repos into their own section above the rest", async () => {
    render(<RepoPicker repos={REPOS} value="" onChange={() => {}} starredRepos={STARRED} />)
    await open()
    expect(screen.getByText("Starred")).toBeTruthy()
    expect(screen.getByText("All repos")).toBeTruthy()
  })

  it("filters as you type", async () => {
    render(<RepoPicker repos={REPOS} value="" onChange={() => {}} starredRepos={STARRED} />)
    const input = await open()
    await userEvent.type(input, "av")
    expect(screen.queryByText("avatarz")).toBeTruthy()
    expect(screen.queryByText("athena")).toBeNull()
    expect(screen.queryByText("starbase")).toBeNull()
  })

  it("hides a section that filters down to nothing", async () => {
    render(<RepoPicker repos={REPOS} value="" onChange={() => {}} starredRepos={STARRED} />)
    const input = await open()
    // Only unstarred repos match, so the Starred heading must go with them.
    await userEvent.type(input, "athena")
    expect(screen.queryByText("Starred")).toBeNull()
    expect(screen.queryByText("athena")).toBeTruthy()
  })

  it("matches on the path too, so two checkouts of one repo are separable", async () => {
    const repos = [repo("starbase", "/code/starbase"), repo("starbase", "/work/starbase")]
    render(<RepoPicker repos={repos} value="" onChange={() => {}} />)
    const input = await open()
    await userEvent.type(input, "/work")
    expect(screen.getAllByText("starbase")).toHaveLength(1)
  })

  it("says so when nothing matches, rather than showing a blank menu", async () => {
    render(<RepoPicker repos={REPOS} value="" onChange={() => {}} />)
    const input = await open()
    await userEvent.type(input, "zzzz")
    expect(screen.getByText("No repos match")).toBeTruthy()
  })

  it("selects the top match on Enter, so filtering is type-then-Enter", async () => {
    const onChange = vi.fn()
    render(<RepoPicker repos={REPOS} value="" onChange={onChange} />)
    const input = await open()
    await userEvent.type(input, "buffet{Enter}")
    expect(onChange).toHaveBeenCalledWith("/code/buffet-line")
  })

  it("selects a repo when its row is clicked", async () => {
    const onChange = vi.fn()
    render(<RepoPicker repos={REPOS} value="" onChange={onChange} />)
    await open()
    await userEvent.click(screen.getByText("avatarz"))
    expect(onChange).toHaveBeenCalledWith("/code/avatarz")
  })

  it("stars a repo without selecting it or closing the menu", async () => {
    const onChange = vi.fn()
    const onToggleStar = vi.fn()
    render(
      <RepoPicker repos={REPOS} value="" onChange={onChange} starredRepos={[]} onToggleStar={onToggleStar} />
    )
    await open()
    // Every row has a star; the first is "gtm-grid" in the unstarred list.
    await userEvent.click(screen.getAllByLabelText("Star repo")[0]!)
    expect(onToggleStar).toHaveBeenCalledWith("/code/gtm-grid")
    // The tap must not have committed a selection…
    expect(onChange).not.toHaveBeenCalled()
    // …nor closed the menu out from under the operator.
    expect(screen.queryByPlaceholderText("Search repos…")).toBeTruthy()
  })

  it("is inert with no repos to choose from", async () => {
    render(<RepoPicker repos={[]} value="" onChange={() => {}} />)
    const trigger = screen.getByTestId("repo-picker-trigger")
    expect(trigger.textContent).toContain("No repositories")
    await userEvent.click(trigger)
    expect(screen.queryByPlaceholderText("Search repos…")).toBeNull()
  })
})
