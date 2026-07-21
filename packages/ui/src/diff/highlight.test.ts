import { describe, expect, it } from "vitest"
import { langForPath, tokenizeLines } from "./highlight.js"

describe("langForPath", () => {
  it("maps the extensions the app actually diffs", () => {
    expect(langForPath("src/auth/session.ts")).toBe("typescript")
    expect(langForPath("src/app/tab-bar.tsx")).toBe("tsx")
    expect(langForPath("packages/ui/package.json")).toBe("json")
    expect(langForPath("src/globals.css")).toBe("css")
    expect(langForPath("README.md")).toBe("markdown")
    expect(langForPath("scripts/build.sh")).toBe("shellscript")
  })

  it("reads dotfiles by NAME, not by their apparent extension", () => {
    // `".env".split(".").pop()` is "env" — an extension we don't map — so a
    // filename lookup that ran second would leave every .env diff unhighlighted.
    expect(langForPath(".env")).toBe("shellscript")
    expect(langForPath("apps/server/.env")).toBe("shellscript")
    expect(langForPath("Dockerfile")).toBe("docker")
    expect(langForPath("docker/Dockerfile")).toBe("docker")
  })

  it("returns null for a language we don't bundle, rather than guessing", () => {
    expect(langForPath("assets/logo.png")).toBeNull()
    expect(langForPath("LICENSE")).toBeNull()
    expect(langForPath("src/main.zig")).toBeNull()
  })

  it("is case-insensitive on the extension", () => {
    expect(langForPath("src/App.TSX")).toBe("tsx")
  })
})

describe("tokenizeLines", () => {
  it("returns one token array per input line", async () => {
    const lines = ["const a = 1", "const b = 'two'", "// three"]
    const tokens = await tokenizeLines(lines, "typescript")
    expect(tokens).not.toBeNull()
    expect(tokens!.length).toBe(lines.length)
  })

  it("colours a keyword differently from a string", async () => {
    // The whole point: the tokens carry the theme's own colours, so an added
    // line still reads as code rather than as a wall of green.
    const tokens = await tokenizeLines(["const a = 'x'"], "typescript")
    const colors = new Set(tokens![0]!.map((t) => t.color).filter(Boolean))
    expect(colors.size).toBeGreaterThan(1)
  })

  it("carries multi-line context, so a continued template literal stays a string", async () => {
    // This is why tokenizing happens over the whole body rather than per row:
    // line 2 is only a string BECAUSE of line 1.
    const tokens = await tokenizeLines(["const t = `line one", "still inside", "`"], "typescript")
    const [first, second] = tokens!
    const stringColor = first!.find((t) => t.text.includes("line one"))?.color
    expect(stringColor).toBeTruthy()
    expect(second!.some((t) => t.color === stringColor)).toBe(true)
  })

  it("pads to the input length so row N always maps to token N", async () => {
    // Shiki drops a trailing empty line; a caller indexing past the end would
    // otherwise render its last row plain for no visible reason.
    const lines = ["const a = 1", ""]
    const tokens = await tokenizeLines(lines, "typescript")
    expect(tokens!.length).toBe(2)
  })

  it("degrades to null rather than throwing on an unknown language", async () => {
    expect(await tokenizeLines(["anything"], "brainfuck")).toBeNull()
    expect(await tokenizeLines(["anything"], null)).toBeNull()
    expect(await tokenizeLines([], "typescript")).toBeNull()
  })
})
