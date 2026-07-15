import { describe, expect, it } from "vitest"
import { isHttpUrl, toRect } from "./browser-preview.js"

/**
 * The pure guards behind BrowserPreviewService — URL validation (the pane only
 * loads http/https localhost dev servers) and bounds normalization (Electron's
 * `setBounds` needs integers, and negative sizes must clamp to 0). The
 * WebContentsView lifecycle itself needs a live Electron main process, so it's
 * exercised by the Playwright e2e (previews.spec.ts), not here.
 */
describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("http://localhost:3000")).toBe(true)
    expect(isHttpUrl("https://example.com/app")).toBe(true)
    expect(isHttpUrl("http://127.0.0.1:5173/")).toBe(true)
  })

  it("rejects non-http(s) schemes and garbage", () => {
    expect(isHttpUrl("file:///etc/passwd")).toBe(false)
    expect(isHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isHttpUrl("ftp://host/file")).toBe(false)
    expect(isHttpUrl("about:blank")).toBe(false)
    expect(isHttpUrl("localhost:3000")).toBe(false) // no scheme → not a valid URL
    expect(isHttpUrl("")).toBe(false)
    expect(isHttpUrl("not a url")).toBe(false)
  })
})

describe("toRect", () => {
  it("rounds fractional pixels to integers", () => {
    expect(toRect({ x: 10.4, y: 20.6, width: 100.5, height: 200.2 })).toEqual({
      x: 10,
      y: 21,
      width: 101,
      height: 200
    })
  })

  it("clamps negative width/height to 0 (never a negative-size view)", () => {
    expect(toRect({ x: -5, y: -1, width: -20, height: -3 })).toEqual({
      x: -5,
      y: -1,
      width: 0,
      height: 0
    })
  })
})
