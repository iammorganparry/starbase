import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Markdown } from "./markdown.js"

afterEach(cleanup)

const md = () => document.querySelector(".sb-md") as HTMLElement
const settled = () => waitFor(() => expect(md().textContent?.length ?? 0).toBeGreaterThan(0))

/**
 * These guard a regression that shipped silently once already: passing
 * `remarkPlugins` / `rehypePlugins` to Streamdown REPLACES its defaults instead
 * of extending them, which drops rehype-raw (Streamdown then rewrites all raw
 * HTML to literal text) and remark-gfm (killing tables/strikethrough/task
 * lists). Neither failure is loud — the component still renders, just wrongly —
 * so every assertion below is about the DOM actually produced.
 *
 * The HTML fragments are the real shapes GitHub review bots emit; they're taken
 * from Greptile's comments on starbase#36.
 */
describe("Markdown raw HTML (rehype-raw must survive)", () => {
  it("renders <details>/<summary> as real elements rather than literal text", async () => {
    render(
      <Markdown>{`<details><summary>Prompt To Fix With AI</summary>

inner body

</details>`}</Markdown>
    )
    await waitFor(() => expect(md().querySelector("details")).not.toBeNull())
    expect(md().querySelector("summary")?.textContent).toContain("Prompt To Fix With AI")
    // The exact failure mode: tags leaking through as visible source text.
    expect(md().textContent).not.toContain("<summary>")
  })

  it("renders a <picture>/<source srcset> themed badge", async () => {
    render(
      <Markdown>{`<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg"><img alt="Fix in Claude Code" src="https://example.com/light.svg"></picture>`}</Markdown>
    )
    await waitFor(() => expect(md().querySelector("picture")).not.toBeNull())
    // `srcset` is the one attribute the sanitize schema's global list lacks, so
    // it only survives because ALLOWED_TAGS names it.
    expect(md().querySelector("source")?.getAttribute("srcset")).toBe("https://example.com/dark.svg")
    expect(screen.getByAltText("Fix in Claude Code")).toBeDefined()
  })
})

describe("Markdown image attributes (ALLOWED_TAGS must not clobber defaults)", () => {
  it("keeps src and align on a severity badge", async () => {
    render(
      <Markdown>{`<img alt="P1" src="https://example.com/p1.svg" align="top"> **Prefilled draft lost**`}</Markdown>
    )
    await waitFor(() => expect(screen.getByAltText("P1")).toBeDefined())
    const img = screen.getByAltText("P1")
    // Regression: listing `img` in ALLOWED_TAGS replaces its default attribute
    // list, dropping `src`; rehype-harden then renders "[Image blocked: P1]".
    expect(img.getAttribute("src")).toBe("https://example.com/p1.svg")
    expect(img.getAttribute("align")).toBe("top")
    expect(md().textContent).not.toContain("[Image blocked")
    // Streamdown renders bold as a styled span, not a <strong> element.
    expect(md().querySelector("[data-streamdown='strong']")?.textContent).toBe("Prefilled draft lost")
  })

  it("unwraps a no-op <a href='#'> wrapper instead of stamping [blocked]", async () => {
    render(<Markdown>{`<a href="#"><img alt="P1" src="https://example.com/p1.svg"></a> after`}</Markdown>)
    await waitFor(() => expect(screen.getByAltText("P1")).toBeDefined())
    // rehype-harden cannot parse a bare "#" href and marks the link unsafe.
    expect(md().textContent).not.toContain("[blocked]")
    expect(md().querySelector("span[title^='Blocked URL']")).toBeNull()
  })

  it("unwraps a no-op anchor that carries other attributes too", async () => {
    render(
      <Markdown>{`<a rel="nofollow" href="#" class="badge"><img alt="P1" src="https://example.com/p1.svg"></a>`}</Markdown>
    )
    await waitFor(() => expect(screen.getByAltText("P1")).toBeDefined())
    expect(md().textContent).not.toContain("[blocked]")
  })

  it("leaves a real link alone even when an attribute merely contains href=\"#\"", async () => {
    render(<Markdown>{`<a href="https://example.com" data-href="#">real link</a>`}</Markdown>)
    await settled()
    // Unwrapping this would silently strip a working link.
    expect(md().textContent).toContain("real link")
    expect(md().querySelector("[data-streamdown='link']")).not.toBeNull()
  })
})

describe("Markdown GFM (remark-gfm must survive)", () => {
  it("renders a GFM table", async () => {
    render(<Markdown>{`| a | b |\n| --- | --- |\n| 1 | 2 |`}</Markdown>)
    await waitFor(() => expect(md().querySelector("table")).not.toBeNull())
    expect(md().querySelectorAll("th")).toHaveLength(2)
  })

  it("renders GFM strikethrough", async () => {
    render(<Markdown>{`~~gone~~`}</Markdown>)
    await waitFor(() => expect(md().querySelector("del")).not.toBeNull())
  })
})

describe("Markdown sanitization (rehype-sanitize must survive)", () => {
  it("strips a <script> tag even though raw HTML is enabled", async () => {
    render(<Markdown>{`<script>window.pwned = 1</script>safe`}</Markdown>)
    await waitFor(() => expect(md().textContent).toContain("safe"))
    expect(md().querySelector("script")).toBeNull()
  })

  it("drops a javascript: href", async () => {
    render(<Markdown>{`<a href="javascript:alert(1)">click</a>`}</Markdown>)
    await settled()
    expect(md().querySelector("a[href^='javascript:']")).toBeNull()
  })
})

describe("Markdown math (the plugin we rewired onto plugins.math)", () => {
  it("still renders KaTeX", async () => {
    render(<Markdown>{`$x^2$`}</Markdown>)
    await waitFor(() => expect(md().querySelector(".katex")).not.toBeNull())
  })
})
