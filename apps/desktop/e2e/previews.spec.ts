import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Rich in-chat previews, end to end against the built app. A persisted transcript
 * carries LaTeX + a fenced html block, so the assertions cover what the operator
 * actually sees:
 *  - `$…$` / `$$…$$` render as KaTeX (a `.katex` node), not raw dollar-math;
 *  - an html block defaults to the plain-text Code view and, on opt-in, renders a
 *    sandboxed Preview iframe;
 *  - the browser-preview pane toggles open and its address bar drives navigation.
 *
 * The browser preview is a native `WebContentsView` (out of the DOM, like the
 * xterm canvas in terminal.spec.ts), so we assert on the pane's React chrome
 * (the address bar), never on the loaded page's pixels.
 */

const RICH_MARKDOWN = [
  "Inline math $E = mc^2$ and a display equation:",
  "",
  "$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$",
  "",
  "And some HTML:",
  "",
  "```html",
  "<h1>Hello preview</h1>",
  "```",
  ""
].join("\n")

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "starbase/refactor",
    title: "Refactor auth flow",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("renders LaTeX + an opt-in HTML preview, and drives the browser pane", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    transcripts: {
      s_seeded: [
        {
          id: "a_rich",
          role: "assistant",
          streaming: false,
          createdAt: "2026-07-11T00:00:00.000Z",
          parts: [{ _tag: "Text", text: RICH_MARKDOWN }]
        }
      ]
    }
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // LaTeX: KaTeX mounts a `.katex` node — the raw "$E = mc^2$" is never shown.
  await expect(window.locator(".katex").first()).toBeVisible({ timeout: 10_000 })

  // HTML block defaults to the Code view (transcript stays plain text).
  const preview = window.getByRole("tab", { name: /Preview/ })
  await expect(window.getByRole("tab", { name: /Code/ })).toBeVisible()
  await expect(window.locator('iframe[title="HTML preview"]')).toHaveCount(0)

  // Opting into Preview mounts the sandboxed iframe.
  await preview.click()
  await expect(window.locator('iframe[title="HTML preview"]')).toBeVisible()

  // Browser pane: toggle it open from the tab-bar control, then navigate. The
  // WebContentsView is out-of-DOM, so we assert on the address bar (in DOM).
  await window.getByRole("button", { name: "Browser preview" }).click()
  const url = window.getByLabel("Preview URL")
  await expect(url).toBeVisible()
  await url.fill("http://localhost:4321")
  await url.press("Enter")
  await expect(url).toHaveValue("http://localhost:4321")
})
