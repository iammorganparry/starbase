import { cleanup, render, screen } from "@testing-library/react"
import { CSS_VAR_BY_TOKEN } from "@starbase/core"
import type { ThemeTokens } from "@starbase/core"
import { BUILTIN_THEMES, toTokens } from "@starbase/themes"
import { afterEach, describe, expect, it } from "vitest"
import {
  ThemeProvider,
  themeCssText,
  useThemeCatalog,
  useThemeTokens
} from "./theme-provider.js"

afterEach(() => {
  cleanup()
  document.getElementById("starbase-theme")?.remove()
  document.documentElement.removeAttribute("data-theme-kind")
})

const themeFor = (id: string): ThemeTokens =>
  toTokens(BUILTIN_THEMES.find((b) => b.id === id)!.theme)

const oneDark = themeFor("one-dark-pro")
const lightModern = themeFor("light-modern")

const styleText = () => document.getElementById("starbase-theme")?.textContent ?? ""

describe("themeCssText", () => {
  it("emits every colour token as its CSS var", () => {
    const css = themeCssText(oneDark)
    for (const [token, cssVar] of Object.entries(CSS_VAR_BY_TOKEN)) {
      expect(css, cssVar).toContain(`${cssVar}: ${oneDark[token as keyof typeof CSS_VAR_BY_TOKEN]};`)
    }
  })

  /**
   * Without `color-scheme` the browser keeps theming its OWN chrome dark — the
   * caret in every input, native scrollbars, date pickers — so a light theme
   * ends up with a dark cursor blinking in a white composer.
   */
  it("tells the browser which ground to theme its own chrome for", () => {
    expect(themeCssText(lightModern)).toContain("color-scheme: light;")
    expect(themeCssText(oneDark)).toContain("color-scheme: dark;")
  })

  /** High contrast is dark-grounded; only `light` gets the light scheme. */
  it("treats high contrast as dark for the browser's chrome", () => {
    expect(themeCssText(themeFor("high-contrast-dark"))).toContain("color-scheme: dark;")
  })
})

describe("ThemeProvider", () => {
  it("writes the theme into one managed style element", () => {
    render(
      <ThemeProvider tokens={oneDark}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(document.querySelectorAll("#starbase-theme")).toHaveLength(1)
    expect(styleText()).toContain("--sb-editor: #282c34;")
  })

  /**
   * The reason this replaces the sheet's text rather than calling `setProperty`
   * per token. `setProperty` only ever ADDS, so a var the new theme does not
   * mention keeps the old theme's value — permanently, and through any number
   * of further switches. Here Solarized Light's editor must not still be One
   * Dark's `#282c34`.
   */
  it("leaves nothing behind from the previous theme on a switch", () => {
    const { rerender } = render(
      <ThemeProvider tokens={oneDark}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(styleText()).toContain("--sb-editor: #282c34;")

    rerender(
      <ThemeProvider tokens={lightModern}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(styleText()).not.toContain("#282c34")
    expect(styleText()).toContain(`--sb-editor: ${lightModern.editor};`)
    expect(document.querySelectorAll("#starbase-theme")).toHaveLength(1)
  })

  /**
   * A custom property cannot be used in a selector, so anything that needs to
   * BRANCH on the ground (rather than read a value) reads this attribute.
   */
  it("mirrors the ground onto a data attribute", () => {
    const { rerender } = render(
      <ThemeProvider tokens={oneDark}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(document.documentElement.dataset.themeKind).toBe("dark")

    rerender(
      <ThemeProvider tokens={lightModern}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(document.documentElement.dataset.themeKind).toBe("light")
  })

  /**
   * The boot path in `main.tsx` creates this element before React exists.
   * Creating a second one here would leave two sheets fighting on document
   * order, and which won would depend on mount timing.
   */
  it("adopts the pre-paint style element instead of adding another", () => {
    const boot = document.createElement("style")
    boot.id = "starbase-theme"
    boot.textContent = ":root { --sb-editor: #000000; }"
    document.head.appendChild(boot)

    render(
      <ThemeProvider tokens={oneDark}>
        <div>hi</div>
      </ThemeProvider>
    )

    expect(document.querySelectorAll("#starbase-theme")).toHaveLength(1)
    expect(styleText()).toContain("--sb-editor: #282c34;")
  })

  it("preserves the pre-paint theme until the async theme state is ready", () => {
    const bootCss = themeCssText(lightModern)
    const boot = document.createElement("style")
    boot.id = "starbase-theme"
    boot.textContent = bootCss
    document.head.appendChild(boot)

    const { rerender } = render(
      <ThemeProvider tokens={oneDark} applyToDocument={false}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(styleText()).toBe(bootCss)

    rerender(
      <ThemeProvider tokens={lightModern} applyToDocument>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(styleText()).toBe(bootCss)
  })

  it("is appended last, so it beats the fallback block in globals.css", () => {
    render(
      <ThemeProvider tokens={oneDark}>
        <div>hi</div>
      </ThemeProvider>
    )
    expect(document.head.lastElementChild?.id).toBe("starbase-theme")
  })
})

describe("useThemeTokens", () => {
  function Probe() {
    const tokens = useThemeTokens()
    return <span>{tokens.terminal.blue}</span>
  }

  /** xterm and shiki need the values as JS, not as CSS. */
  it("hands the resolved tokens to consumers that need values", () => {
    render(
      <ThemeProvider tokens={oneDark}>
        <Probe />
      </ThemeProvider>
    )
    expect(screen.getByText(oneDark.terminal.blue)).toBeTruthy()
  })

  /**
   * Throws rather than returning a One Dark default, because a silent default
   * is how a component ends up permanently dark on a light theme with nothing
   * on screen to say why.
   */
  it("refuses to guess outside a provider", () => {
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/)
  })
})

describe("useThemeCatalog", () => {
  function Probe() {
    const { activeId, catalog } = useThemeCatalog()
    return <span>{`${activeId}:${catalog?.skipped[0]?.message}`}</span>
  }

  it("hands settings the active id and skipped files from the provider", () => {
    render(
      <ThemeProvider
        tokens={oneDark}
        activeId="mine"
        catalog={{
          themes: [],
          skipped: [{ path: "/themes/broken.json", message: "type is missing" }]
        }}
      >
        <Probe />
      </ThemeProvider>
    )

    expect(screen.getByText("mine:type is missing")).toBeTruthy()
  })
})
