import { Buffer } from "node:buffer"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Attachment } from "@starbase/core"
import type { Input, UserInput } from "@openai/codex-sdk"

const extensionFor = (mediaType: string): string => {
  switch (mediaType.toLowerCase()) {
    case "image/jpeg":
      return "jpg"
    case "image/gif":
      return "gif"
    case "image/webp":
      return "webp"
    default:
      return "png"
  }
}

export interface StagedCodexInput {
  readonly input: Input
  readonly cleanup: () => Promise<void>
}

export type CodexAppServerInput =
  | { readonly type: "text"; readonly text: string; readonly text_elements: ReadonlyArray<never> }
  | { readonly type: "localImage"; readonly path: string }

/** Translate the SDK input shape into app-server v2's UserInput shape. */
export const toCodexAppServerInput = (input: Input): ReadonlyArray<CodexAppServerInput> => {
  if (typeof input === "string") {
    return [{ type: "text", text: input, text_elements: [] }]
  }
  return input.map((item): CodexAppServerInput => {
    if (item.type === "text") {
      return { type: "text", text: item.text, text_elements: [] }
    }
    if (item.type === "local_image") {
      return { type: "localImage", path: item.path }
    }
    return { type: "text", text: "", text_elements: [] }
  })
}

/**
 * Materialize Starbase's durable base64 attachments for Codex.
 *
 * Both transports accept local image paths. A private temporary directory keeps
 * transcript data out of the worktree and is removed whether the turn succeeds,
 * fails, or is interrupted.
 */
export const stageCodexInput = async (
  prompt: string,
  images: ReadonlyArray<Attachment>
): Promise<StagedCodexInput> => {
  if (images.length === 0) {
    return { input: prompt, cleanup: () => Promise.resolve() }
  }

  const directory = await mkdtemp(join(tmpdir(), "starbase-codex-images-"))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  try {
    const input: Array<UserInput> = []
    if (prompt.length > 0) input.push({ type: "text", text: prompt })
    const stagedImages: Array<UserInput> = await Promise.all(
      images.map(async (image, index): Promise<UserInput> => {
        const path = join(directory, `${index}.${extensionFor(image.mediaType)}`)
        await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 })
        return { type: "local_image", path }
      })
    )
    input.push(...stagedImages)
    return { input, cleanup }
  } catch (cause) {
    await cleanup()
    throw cause
  }
}
