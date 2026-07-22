import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { startTeeStream, teeLogPath, teeRewrite } from "./bash-tee.js"
import { capOutput } from "./output-cap.js"

describe("teeLogPath", () => {
  it("names a deterministic file under the given dir, keyed by the tool-use id", () => {
    expect(teeLogPath("toolu_abc123", "/tmp/x")).toBe("/tmp/x/starbase-tee-toolu_abc123.log")
  })

  it("strips characters that could escape the temp dir or break the shell", () => {
    // A `/` or `..` in the id must not walk out of the temp dir.
    expect(teeLogPath("../../etc/passwd", "/tmp/x")).toBe("/tmp/x/starbase-tee-______etc_passwd.log")
    expect(teeLogPath("a b;c", "/tmp/x")).toBe("/tmp/x/starbase-tee-a_b_c.log")
  })

  it("is stable across calls, so the watcher and the cleanup name the same file", () => {
    expect(teeLogPath("t1", "/d")).toBe(teeLogPath("t1", "/d"))
  })
})

describe("teeRewrite", () => {
  it("groups the whole command so a compound tees as one unit, and preserves the exit code", () => {
    expect(teeRewrite("a && b", "/tmp/x.log")).toBe(
      "{\na && b\n} 2>&1 | tee '/tmp/x.log'\n( exit ${PIPESTATUS[0]} )"
    )
  })

  it("merges stderr into the teed stream, so the card shows both", () => {
    // The `2>&1` sits on the group, before the pipe — so stderr is captured too.
    expect(teeRewrite("pnpm test", "/l")).toContain("} 2>&1 | tee ")
  })

  it("restores the command's real status rather than tee's success", () => {
    expect(teeRewrite("false", "/l")).toContain("( exit ${PIPESTATUS[0]} )")
  })

  it("single-quotes the log path and escapes an embedded quote", () => {
    expect(teeRewrite("x", "/tmp/o'brien.log")).toContain("tee '/tmp/o'\\''brien.log'")
  })

  it("delimits the group with newlines, so a command ending in a comment still runs", () => {
    // With `;` as the delimiter, `cmd # note ;` would comment out the closing brace.
    const rewritten = teeRewrite("echo hi # a note", "/l")
    expect(rewritten.startsWith("{\necho hi # a note\n}")).toBe(true)
  })
})

describe("startTeeStream", () => {
  it("serialises slow polls and reads a growing log in bounded chunks", async () => {
    let size = 256 * 1024
    let active = 0
    let maxActive = 0
    let largestRead = 0
    let opens = 0
    let stream: ReturnType<typeof startTeeStream> | undefined

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tee poll did not produce two snapshots")), 1_000)
      stream = startTeeStream(
        "slow-log",
        "pnpm test",
        () => {
          size += 64 * 1024
          if (opens < 2) return
          clearTimeout(timeout)
          stream?.stop()
          resolve()
        },
        {
          pollMs: 1,
          io: {
            prepare: () => {},
            size: async () => size,
            open: async () => {
              opens += 1
              active += 1
              maxActive = Math.max(maxActive, active)
              return {
                read: async (_offset, length) => {
                  largestRead = Math.max(largestRead, length)
                  // Longer than the poll interval: an interval-based poller would
                  // pile up reads here; a serial poller waits before scheduling.
                  await new Promise((r) => setTimeout(r, 10))
                  return Buffer.alloc(length, 65)
                },
                close: async () => {
                  active -= 1
                }
              }
            },
            remove: async () => {}
          }
        }
      )
    })

    stream?.stop()
    expect(opens).toBeGreaterThanOrEqual(2)
    expect(maxActive).toBe(1)
    expect(largestRead).toBeLessThanOrEqual(64 * 1024)
  })

  it("matches the shared output cap when a UTF-8 character crosses a read boundary", async () => {
    const text = `${"a".repeat(64 * 1024 - 1)}🙂${"z".repeat(10_000)}`
    const bytes = Buffer.from(text)
    let stream: ReturnType<typeof startTeeStream> | undefined

    const snapshot = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tee poll produced no snapshot")), 1_000)
      stream = startTeeStream(
        "utf8-log",
        "pnpm test",
        (value) => {
          clearTimeout(timeout)
          stream?.stop()
          resolve(value)
        },
        {
          pollMs: 1,
          io: {
            prepare: () => {},
            size: async () => bytes.length,
            open: async () => ({
              read: async (offset, length) => bytes.subarray(offset, offset + length),
              close: async () => {}
            }),
            remove: async () => {}
          }
        }
      )
    })

    expect(snapshot).toBe(capOutput(text))
  })

  it("reconstructs below-cap output across polls and resets after truncation", async () => {
    let bytes = Buffer.from("first")
    const snapshots: string[] = []
    let stream: ReturnType<typeof startTeeStream> | undefined

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tee poll produced no reset snapshot")), 1_000)
      stream = startTeeStream(
        "reset-log",
        "pnpm test",
        (value) => {
          snapshots.push(value)
          if (snapshots.length === 1) bytes = Buffer.from("first second")
          if (snapshots.length === 2) bytes = Buffer.from("new")
          if (snapshots.length !== 3) return
          clearTimeout(timeout)
          resolve()
        },
        {
          pollMs: 1,
          io: {
            prepare: () => {},
            size: async () => bytes.length,
            open: async () => ({
              read: async (offset, length) => bytes.subarray(offset, offset + length),
              close: async () => {}
            }),
            remove: async () => {}
          }
        }
      )
    })

    stream?.stop()
    expect(snapshots).toEqual(["first", "first second", "new"])
    expect(snapshots).toEqual(snapshots.map(capOutput))
  })

  it("does not emit an unchanged snapshot for an incomplete UTF-8 character", async () => {
    let bytes = Buffer.from([0xf0])
    const snapshots: string[] = []
    let stream: ReturnType<typeof startTeeStream> | undefined

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tee poll did not decode completed UTF-8")), 1_000)
      stream = startTeeStream(
        "partial-utf8",
        "pnpm test",
        (value) => {
          snapshots.push(value)
          clearTimeout(timeout)
          resolve()
        },
        {
          pollMs: 1,
          io: {
            prepare: () => {},
            size: async () => bytes.length,
            open: async () => ({
              read: async (offset, length) => bytes.subarray(offset, offset + length),
              close: async () => {}
            }),
            remove: async () => {}
          }
        }
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    bytes = Buffer.from("🙂")
    await completed
    stream?.stop()
    expect(snapshots).toEqual(["🙂"])
  })

  it("waits for an active read handle to close before removing the log", async () => {
    const events: string[] = []
    let stream: ReturnType<typeof startTeeStream> | undefined

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tee cleanup did not finish")), 1_000)
      stream = startTeeStream("cleanup-log", "pnpm test", () => {}, {
        pollMs: 1,
        io: {
          prepare: () => {},
          size: async () => 1,
          open: async () => ({
            read: async () => {
              events.push("read")
              stream?.stop()
              await new Promise((done) => setTimeout(done, 10))
              return Buffer.from("x")
            },
            close: async () => {
              events.push("close")
            }
          }),
          remove: async () => {
            events.push("remove")
            clearTimeout(timeout)
            resolve()
          }
        }
      })
    })

    expect(events).toEqual(["read", "close", "remove"])
  })

  it("removes a stale log before the first poll can observe it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-tee-stale-"))
    const file = teeLogPath("reused-id", dir)
    const fresh = "new run output ".repeat(100)
    writeFileSync(file, "stale output")
    let stream: ReturnType<typeof startTeeStream> | undefined

    try {
      const snapshot = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("tee poll produced no snapshot")), 1_000)
        stream = startTeeStream(
          "reused-id",
          "pnpm test",
          (value) => {
            clearTimeout(timeout)
            resolve(value)
          },
          { dir, pollMs: 1 }
        )

        // Cleanup must finish before startTeeStream returns and the caller can
        // launch the rewritten command, even if its output immediately regrows.
        expect(existsSync(file)).toBe(false)
        writeFileSync(file, fresh)
      })

      expect(await snapshot).toBe(fresh)
    } finally {
      stream?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
