import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ConfigError,
  GitError,
  SessionNotFoundError,
  WorkspaceNotConfiguredError
} from "./errors.js"

/**
 * These `Schema.TaggedError`s cross the RPC boundary, so the behaviour that
 * matters is: they carry a discriminating `_tag`, expose their fields, and
 * survive encode → decode intact (that's how the renderer receives them).
 */

describe("GitError", () => {
  it("carries its tag and message", () => {
    const err = new GitError({ message: "worktree add failed" })
    expect(err._tag).toBe("GitError")
    expect(err.message).toBe("worktree add failed")
  })

  it("round-trips through the RPC wire schema", () => {
    const err = new GitError({ message: "boom" })
    const decoded = Schema.decodeUnknownSync(GitError)(Schema.encodeSync(GitError)(err))
    expect(decoded._tag).toBe("GitError")
    expect(decoded.message).toBe("boom")
  })
})

describe("ConfigError", () => {
  it("round-trips with its message", () => {
    const err = new ConfigError({ message: "Config file is malformed" })
    const decoded = Schema.decodeUnknownSync(ConfigError)(Schema.encodeSync(ConfigError)(err))
    expect(decoded._tag).toBe("ConfigError")
    expect(decoded.message).toBe("Config file is malformed")
  })
})

describe("SessionNotFoundError", () => {
  it("carries the requested session id", () => {
    const err = new SessionNotFoundError({ sessionId: "s_missing" })
    const decoded = Schema.decodeUnknownSync(SessionNotFoundError)(
      Schema.encodeSync(SessionNotFoundError)(err)
    )
    expect(decoded._tag).toBe("SessionNotFoundError")
    expect(decoded.sessionId).toBe("s_missing")
  })
})

describe("WorkspaceNotConfiguredError", () => {
  it("is a distinct empty-payload tagged error", () => {
    const err = new WorkspaceNotConfiguredError()
    expect(err._tag).toBe("WorkspaceNotConfiguredError")
    const decoded = Schema.decodeUnknownSync(WorkspaceNotConfiguredError)(
      Schema.encodeSync(WorkspaceNotConfiguredError)(err)
    )
    expect(decoded._tag).toBe("WorkspaceNotConfiguredError")
  })
})
