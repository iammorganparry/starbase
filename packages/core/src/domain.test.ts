import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CreateSessionInput,
  GhStatus,
  Repo,
  Session,
  WorkspaceConfig
} from "./domain.js"

/**
 * These schemas back persistence (config.json, sessions.json) and the RPC wire
 * format, so the behaviour that matters is: valid data decodes, `null` is
 * accepted where the domain allows absence, encode→decode is identity, and
 * invalid literals are rejected (not silently coerced). We assert those
 * outcomes — never the schema's internal structure.
 */

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input)

describe("WorkspaceConfig", () => {
  it("decodes a configured workspace", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: "/Users/me/repos",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("accepts a null reposDir (first-run, before setup)", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects a config missing createdAt", () => {
    const result = decode(WorkspaceConfig, { reposDir: "/repos" })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips through encode → decode unchanged", () => {
    const config: WorkspaceConfig = { reposDir: "/repos", createdAt: "2026-07-11T10:00:00.000Z" }
    const roundTripped = Schema.decodeUnknownSync(WorkspaceConfig)(
      Schema.encodeSync(WorkspaceConfig)(config)
    )
    expect(roundTripped).toStrictEqual(config)
  })

  // autoBabysitPr is optional so pre-existing persisted github blocks (3 fields)
  // keep decoding after the field was added. Both shapes must be accepted.
  it("decodes a github config WITHOUT autoBabysitPr (back-compat)", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: "/repos",
      createdAt: "2026-07-11T10:00:00.000Z",
      github: { enabled: true, autoCreatePr: false, autoDetectPr: true }
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("decodes a github config WITH autoBabysitPr", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: "/repos",
      createdAt: "2026-07-11T10:00:00.000Z",
      github: { enabled: true, autoCreatePr: false, autoDetectPr: true, autoBabysitPr: false }
    })
    expect(Either.isRight(result)).toBe(true)
  })
})

describe("Session", () => {
  const base: Session = {
    id: "s_fix-login_abc",
    repo: "trigify-app",
    branch: "starbase/fix-login",
    title: "Fix login",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T10:00:00.000Z"
  }

  it("decodes a session without the optional worktree fields", () => {
    expect(Either.isRight(decode(Session, base))).toBe(true)
  })

  it("round-trips the optional worktreePath / baseBranch / mode / model when present", () => {
    const withWorktree: Session = {
      ...base,
      worktreePath: "/Users/me/starbase/worktrees/trigify-app/fix-login",
      baseBranch: "main",
      mode: "auto",
      model: "opus"
    }
    const roundTripped = Schema.decodeUnknownSync(Session)(
      Schema.encodeSync(Session)(withWorktree)
    )
    expect(roundTripped).toStrictEqual(withWorktree)
  })

  it("rejects an unknown status", () => {
    expect(Either.isLeft(decode(Session, { ...base, status: "exploding" }))).toBe(true)
  })

  it("rejects an unknown cli kind", () => {
    expect(Either.isLeft(decode(Session, { ...base, cli: "copilot" }))).toBe(true)
  })
})

describe("Repo", () => {
  it("accepts null for every optional-origin field (repo with no remote)", () => {
    const result = decode(Repo, {
      name: "athena",
      path: "/Users/me/repos/athena",
      defaultBranch: null,
      currentBranch: null,
      remoteUrl: null,
      githubSlug: null
    })
    expect(Either.isRight(result)).toBe(true)
  })
})

describe("CreateSessionInput", () => {
  it("decodes a valid create request", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/Users/me/repos/trigify-app",
      repoName: "trigify-app",
      title: "Refactor auth",
      cli: "codex",
      baseBranch: "main"
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects an invalid cli kind", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/x",
      repoName: "x",
      title: "t",
      cli: "nope",
      baseBranch: "main"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("GhStatus", () => {
  it("decodes an authenticated status", () => {
    const result = decode(GhStatus, {
      available: true,
      authenticated: true,
      login: "octocat",
      host: "github.com",
      version: "2.68.1"
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("decodes an unavailable status (all nulls)", () => {
    const result = decode(GhStatus, {
      available: false,
      authenticated: false,
      login: null,
      host: null,
      version: null
    })
    expect(Either.isRight(result)).toBe(true)
  })
})
