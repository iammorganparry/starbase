/**
 * CLI wrapper around `rebuildTranscript` — restore a session's Starbase
 * transcript from the Claude harness's own JSONL log.
 *
 * All conversion logic lives in `src/main/transcript-backfill.ts` (and is unit
 * tested there); this file is only argument handling, file I/O and safety rails.
 *
 * Usage, from `apps/desktop`:
 *   pnpm exec tsx scripts/backfill-transcript.ts <sessionId> [--write] [--force]
 *
 * Dry-run by default: reports what it would restore and verifies the result
 * decodes against the `Message` schema. `--write` persists; `--force` allows
 * replacing a transcript that already has content (the old one is kept as .bak).
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Message as MessageSchema } from "@starbase/core"
import { harnessLogPath, rebuildTranscript } from "../src/main/transcript-backfill.js"

const STARBASE_HOME = process.env.STARBASE_HOME ?? join(homedir(), "starbase")

const main = async () => {
  const [sessionId, ...flags] = process.argv.slice(2)
  if (!sessionId) throw new Error("usage: backfill-transcript.ts <sessionId> [--write] [--force]")
  const write = flags.includes("--write")
  const force = flags.includes("--force")

  const sessions = JSON.parse(readFileSync(join(STARBASE_HOME, "sessions.json"), "utf8")) as Array<{
    id: string
    cli?: string
    resumeId?: string
    worktreePath?: string
  }>
  const session = sessions.find((s) => s.id === sessionId)
  if (!session) throw new Error(`no session ${sessionId} in sessions.json`)
  if (session.cli !== "claude") {
    throw new Error(`session ${sessionId} ran on "${session.cli}"; only claude logs are mapped`)
  }
  if (!session.resumeId) throw new Error(`session ${sessionId} has no resumeId — nothing to recover from`)
  if (!session.worktreePath) throw new Error(`session ${sessionId} has no worktreePath`)

  const jsonl = harnessLogPath(session.worktreePath, session.resumeId)
  if (!existsSync(jsonl)) throw new Error(`no harness log at ${jsonl}`)

  const target = join(STARBASE_HOME, "transcripts", `${sessionId}.json`)
  const existingBytes = existsSync(target) ? statSync(target).size : 0
  if (existingBytes > 0 && !force) {
    throw new Error(`${target} already has ${existingBytes} bytes — pass --force to replace it`)
  }

  const messages = rebuildTranscript(sessionId, readFileSync(jsonl, "utf8"))

  // Decode against the real schema before writing. `TranscriptStore.readAll`
  // silently yields an EMPTY transcript on a decode failure, so an invalid
  // backfill would look exactly like the data loss being repaired. Fail loudly.
  const decoded = await Effect.runPromise(
    Schema.decodeUnknown(Schema.Array(MessageSchema))(JSON.parse(JSON.stringify(messages)))
  )

  const parts = decoded.flatMap((m) => m.parts)
  const counts = ["Text", "Thinking", "Tool", "Image", "Gate", "Question", "Plan"]
    .map((t) => `${parts.filter((p) => p._tag === t).length} ${t}`)
    .join(", ")
  console.log(`session      ${sessionId}`)
  console.log(`source       ${jsonl}`)
  console.log(
    `messages     ${decoded.length} (${decoded.filter((m) => m.role === "user").length} user, ${decoded.filter((m) => m.role === "assistant").length} assistant)`
  )
  console.log(`parts        ${parts.length} total — ${counts}`)
  console.log(`schema       OK (decodes as Message[])`)

  if (!write) {
    console.log(`\ndry run — pass --write to persist to ${target}`)
    return
  }
  if (existingBytes > 0) {
    renameSync(target, `${target}.bak`)
    console.log(`backed up existing transcript → ${target}.bak`)
  }
  // Same tmp+rename the store now uses, for the same reason.
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(messages, null, 2))
  renameSync(tmp, target)
  console.log(`\nwrote ${statSync(target).size} bytes → ${target}`)
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
})
