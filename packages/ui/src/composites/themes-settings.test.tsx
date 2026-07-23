import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ThemeSummary, VsCodeTheme } from "@starbase/core"
import { BUILTIN_THEMES, toTokens } from "@starbase/themes"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ThemesSettings } from "./themes-settings.js"

afterEach(cleanup)

const summaryOf = (id: string, source: "builtin" | "user" = "builtin"): ThemeSummary => {
  const builtin = BUILTIN_THEMES.find((b) => b.id === id)!
  const tokens = toTokens(builtin.theme)
  return {
    id,
    name: builtin.theme.name,
    kind: tokens.kind,
    source,
    ...(source === "user" ? { path: `/home/me/starbase/themes/${id}.json` } : {}),
    tokens
  }
}

const THEMES = [
  summaryOf("one-dark-pro"),
  summaryOf("light-modern"),
  summaryOf("high-contrast-dark"),
  summaryOf("monokai", "user")
]

const noop = {
  onSelect: () => {},
  onDuplicate: async () => THEMES[3]!,
  onDelete: async () => {},
  onImport: async () => THEMES[3]!,
  loadTheme: async (): Promise<VsCodeTheme | null> => null,
  onSave: async () => undefined
}

const renderThemes = (overrides: Partial<React.ComponentProps<typeof ThemesSettings>> = {}) =>
  render(<ThemesSettings themes={THEMES} activeId="one-dark-pro" {...noop} {...overrides} />)

describe("ThemesSettings — the grid", () => {
  it("shows every installed theme", () => {
    renderThemes()
    for (const theme of THEMES) {
      expect(screen.getByText(theme.name)).toBeTruthy()
    }
  })

  /**
   * Grouped by ground because that is the first cut anyone makes — someone
   * looking for a light theme is not browsing, they are filtering.
   */
  it("groups by ground", () => {
    renderThemes()
    expect(screen.getByText("Dark")).toBeTruthy()
    expect(screen.getByText("Light")).toBeTruthy()
    expect(screen.getByText("High contrast")).toBeTruthy()
  })

  it("marks the active theme", () => {
    renderThemes()
    expect(screen.getByRole("button", { name: "Use the One Dark Pro theme" })).toHaveProperty(
      "ariaPressed",
      "true"
    )
    expect(screen.getByRole("button", { name: "Use the Monokai theme" })).toHaveProperty(
      "ariaPressed",
      "false"
    )
  })

  it("applies a theme when its preview is clicked", () => {
    const onSelect = vi.fn()
    renderThemes({ onSelect })
    fireEvent.click(screen.getByRole("button", { name: "Use the Monokai theme" }))
    expect(onSelect).toHaveBeenCalledWith("monokai")
  })

  /**
   * Built-ins are immutable — `ThemeService.save` refuses their ids — which is
   * what guarantees the fallback always has something to fall back to. So the
   * only route to editing one is a duplicate, and the button says so rather
   * than forking silently behind an "Edit" label.
   */
  it("offers built-ins duplication but not deletion or direct editing", () => {
    renderThemes()
    expect(screen.getByRole("button", { name: "Duplicate & edit One Dark Pro" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Delete One Dark Pro" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit One Dark Pro" })).toBeNull()
  })

  it("offers user themes editing, deletion and reveal", () => {
    renderThemes({ onReveal: () => {} })
    expect(screen.getByRole("button", { name: "Edit Monokai" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Delete Monokai" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reveal Monokai in file manager" })).toBeTruthy()
  })

  it("reveals a user theme's file at its real path", () => {
    const onReveal = vi.fn()
    renderThemes({ onReveal })
    fireEvent.click(screen.getByRole("button", { name: "Reveal Monokai in file manager" }))
    expect(onReveal).toHaveBeenCalledWith("/home/me/starbase/themes/monokai.json")
  })
})

describe("ThemesSettings — broken theme files", () => {
  /**
   * A theme file that will not parse is otherwise INVISIBLE: it simply does not
   * appear in the grid, and the operator concludes the app ignored their file.
   * Naming the file and the failing key is the difference between a two-second
   * fix and giving up on user themes entirely.
   */
  it("names the files that could not be read, and why", () => {
    renderThemes({
      skipped: [{ path: "/home/me/starbase/themes/broken.json", message: "type: is missing" }]
    })
    expect(screen.getByText(/1 theme file could not be read/)).toBeTruthy()
    expect(screen.getByText(/broken\.json — type: is missing/)).toBeTruthy()
  })

  it("still shows every theme that did load", () => {
    renderThemes({ skipped: [{ path: "/x/broken.json", message: "bad" }] })
    expect(screen.getByText("One Dark Pro")).toBeTruthy()
    expect(screen.getByText("Monokai")).toBeTruthy()
  })

  it("says nothing when every file read cleanly", () => {
    renderThemes()
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })
})

describe("ThemesSettings — import", () => {
  it("imports pasted JSON and switches to it", async () => {
    const onImport = vi.fn(async (_json: string) => summaryOf("monokai", "user"))
    const onSelect = vi.fn()
    renderThemes({ onImport, onSelect })

    fireEvent.click(screen.getByRole("button", { name: /Import from VS Code/ }))
    fireEvent.change(screen.getByLabelText("VS Code theme JSON"), {
      target: { value: '{"name":"Pasted","type":"dark"}' }
    })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => expect(onImport).toHaveBeenCalled())
    expect(onImport.mock.calls[0]?.[0]).toContain("Pasted")
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("monokai"))
  })

  it("will not import an empty box", () => {
    renderThemes()
    fireEvent.click(screen.getByRole("button", { name: /Import from VS Code/ }))
    expect(screen.getByRole("button", { name: "Import" })).toHaveProperty("disabled", true)
  })

  /**
   * The service's message already names the offending key — that is the whole
   * reason `describeDecodeFailure` uses `ArrayFormatter`. Replacing it with a
   * generic failure here would throw away the only actionable detail.
   */
  it("shows the service's own explanation when an import fails", async () => {
    const onImport = vi.fn(async (_json: string) => {
      throw new Error("Not a VS Code theme: type: is missing")
    })
    renderThemes({ onImport })

    fireEvent.click(screen.getByRole("button", { name: /Import from VS Code/ }))
    fireEvent.change(screen.getByLabelText("VS Code theme JSON"), { target: { value: "{}" } })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => expect(screen.getByText(/type: is missing/)).toBeTruthy())
  })
})

describe("ThemesSettings — the editor", () => {
  const editable: VsCodeTheme = {
    name: "Monokai",
    type: "dark",
    colors: { "editor.background": "#272822" }
  }

  it("opens on a user theme and shows its colours", async () => {
    renderThemes({ loadTheme: async () => editable })
    fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))

    await waitFor(() => expect(screen.getByLabelText("Editor colour")).toBeTruthy())
    expect(screen.getByLabelText("Editor colour")).toHaveProperty("value", "#272822")
  })

  it("normalizes shorthand hex for the native colour input", async () => {
    renderThemes({
      loadTheme: async () => ({
        ...editable,
        colors: { "editor.background": "#abc" }
      })
    })
    fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))

    await waitFor(() => expect(screen.getByLabelText("Editor colour")).toBeTruthy())
    expect(screen.getByLabelText("Editor colour")).toHaveProperty("value", "#aabbcc")
  })

  it("does not reload an in-progress edit when callback identities change", async () => {
    const firstLoad = vi.fn(async () => editable)
    const secondLoad = vi.fn(async () => editable)
    const { rerender } = render(
      <ThemesSettings
        themes={THEMES}
        activeId="one-dark-pro"
        {...noop}
        loadTheme={firstLoad}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))
    await waitFor(() => expect(screen.getByLabelText("Editor colour")).toBeTruthy())

    rerender(
      <ThemesSettings
        themes={THEMES}
        activeId="one-dark-pro"
        {...noop}
        loadTheme={secondLoad}
      />
    )

    expect(firstLoad).toHaveBeenCalledTimes(1)
    expect(secondLoad).not.toHaveBeenCalled()
  })

  /**
   * Most keys in most themes are unset. A picker defaulting to black would tell
   * the operator their sidebar is black when it is actually a derived grey —
   * so unset keys show what they currently RESOLVE to, and editing starts from
   * there instead of jumping.
   */
  it("shows the resolved value for a key the theme never set", async () => {
    renderThemes({ loadTheme: async () => editable })
    fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))

    await waitFor(() => expect(screen.getByLabelText("Sidebar colour")).toBeTruthy())
    const monokai = THEMES[3]!.tokens
    expect(screen.getByLabelText("Sidebar colour")).toHaveProperty(
      "value",
      monokai.panel.toLowerCase()
    )
  })

  /**
   * A native colour input fires `change` continuously while dragging. Saving
   * per event would rewrite the file dozens of times a second, and each write
   * wakes the directory watcher, which re-reads every theme and repaints the
   * app — a repaint storm from one slider drag.
   */
  it("debounces a drag into a single save", async () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn(async (_id: string, _theme: VsCodeTheme) => undefined)
      render(
        <ThemesSettings themes={THEMES} activeId="one-dark-pro" {...noop} onSave={onSave} loadTheme={async () => editable} />
      )
      fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))
      await vi.waitFor(() => expect(screen.queryByLabelText("Editor colour")).toBeTruthy())

      const input = screen.getByLabelText("Editor colour")
      for (const value of ["#111111", "#222222", "#333333"]) {
        fireEvent.change(input, { target: { value } })
      }
      expect(onSave).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0]?.[1].colors?.["editor.background"]).toBe("#333333")
    } finally {
      vi.useRealTimers()
    }
  })

  it("flushes the latest pending edit when the editor closes", async () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn(async (_id: string, _theme: VsCodeTheme) => undefined)
      render(
        <ThemesSettings
          themes={THEMES}
          activeId="one-dark-pro"
          {...noop}
          onSave={onSave}
          loadTheme={async () => editable}
        />
      )
      fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))
      await vi.waitFor(() => expect(screen.queryByLabelText("Editor colour")).toBeTruthy())

      fireEvent.change(screen.getByLabelText("Editor colour"), {
        target: { value: "#445566" }
      })
      fireEvent.click(screen.getByRole("button", { name: "Back to themes" }))

      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0]?.[1].colors?.["editor.background"]).toBe("#445566")
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes the edit under its VS Code key, so the file stays portable", async () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn(async (_id: string, _theme: VsCodeTheme) => undefined)
      render(
        <ThemesSettings themes={THEMES} activeId="one-dark-pro" {...noop} onSave={onSave} loadTheme={async () => editable} />
      )
      fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))
      await vi.waitFor(() => expect(screen.queryByLabelText("Blue colour")).toBeTruthy())

      fireEvent.change(screen.getByLabelText("Blue colour"), { target: { value: "#5599ff" } })
      await vi.advanceTimersByTimeAsync(250)

      const saved = onSave.mock.calls[0]![1]
      expect(saved.colors?.["terminal.ansiBlue"]).toBe("#5599ff")
      // The key it did NOT set must survive — this is a merge, not a replace.
      expect(saved.colors?.["editor.background"]).toBe("#272822")
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns to the grid when done", async () => {
    renderThemes({ loadTheme: async () => editable })
    fireEvent.click(screen.getByRole("button", { name: "Edit Monokai" }))
    await waitFor(() => expect(screen.getByLabelText("Editor colour")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Back to themes" }))
    expect(screen.getByText("One Dark Pro")).toBeTruthy()
  })
})
