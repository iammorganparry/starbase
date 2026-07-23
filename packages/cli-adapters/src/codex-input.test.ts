import { access, readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { stageCodexInput, toCodexAppServerInput } from "./codex-input.js"

describe("stageCodexInput", () => {
  it("keeps an image-free prompt as a plain string", async () => {
    const staged = await stageCodexInput("inspect the code", [])
    expect(staged.input).toBe("inspect the code")
    await expect(staged.cleanup()).resolves.toBeUndefined()
  })

  it("stages private image files for structured Codex input and removes them", async () => {
    const staged = await stageCodexInput("match this screenshot", [
      {
        id: "shot",
        name: "screen.png",
        mediaType: "image/png",
        data: Buffer.from("image bytes").toString("base64")
      }
    ])
    expect(staged.input).toHaveLength(2)
    if (typeof staged.input === "string") throw new Error("expected structured input")
    expect(staged.input[0]).toStrictEqual({ type: "text", text: "match this screenshot" })
    const image = staged.input[1]
    if (image?.type !== "local_image") throw new Error("expected a local image")
    await expect(readFile(image.path, "utf8")).resolves.toBe("image bytes")

    await staged.cleanup()
    await expect(access(image.path)).rejects.toThrow()
  })
})

describe("toCodexAppServerInput", () => {
  it("adds the app-server text metadata and translates local image casing", () => {
    expect(
      toCodexAppServerInput([
        { type: "text", text: "inspect this" },
        { type: "local_image", path: "/tmp/example.png" }
      ])
    ).toStrictEqual([
      { type: "text", text: "inspect this", text_elements: [] },
      { type: "localImage", path: "/tmp/example.png" }
    ])
  })
})
