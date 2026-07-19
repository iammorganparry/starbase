import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AdversarialReview,
  CreateSessionInput,
  GhStatus,
  GithubConfig,
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
})

describe("GithubConfig", () => {
  // The review fields are optional precisely so this keeps passing: every
  // config.json written before the adversarial reviewer existed lacks them, and
  // a required field would make the whole workspace config fail to decode on
  // upgrade — i.e. the app would boot as if it had never been set up.
  it("decodes a config written before the review fields existed", () => {
    const result = decode(GithubConfig, {
      enabled: true,
      autoCreatePr: false,
      autoDetectPr: true
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("decodes a config carrying the review fields", () => {
    const result = decode(GithubConfig, {
      enabled: true,
      autoCreatePr: false,
      autoDetectPr: true,
      autoAdversarialReview: true,
      reviewCli: "claude",
      reviewModel: "claude-fable-5"
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects a reviewCli that is not a known harness", () => {
    const result = decode(GithubConfig, {
      enabled: true,
      autoCreatePr: false,
      autoDetectPr: true,
      reviewCli: "gemini"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("still decodes inside a WorkspaceConfig with a legacy github block", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: "/repos",
      createdAt: "2026-01-01T00:00:00.000Z",
      github: { enabled: true, autoCreatePr: false, autoDetectPr: true }
    })
    expect(Either.isRight(result)).toBe(true)
  })
})

describe("AdversarialReview", () => {
  const review: AdversarialReview = {
    sessionId: "s1",
    prNumber: 42,
    headSha: "abc123",
    cli: "claude",
    model: "claude-fable-5",
    createdAt: "2026-07-16T10:00:00.000Z",
    findings: [
      {
        id: "f1",
        path: "src/auth.ts",
        line: 12,
        endLine: null,
        severity: "critical",
        title: "Token compared with ==",
        rationale: "Timing-unsafe comparison lets an attacker probe the token byte by byte.",
        suggestion: "Use timingSafeEqual.",
        resolvedBy: null
      }
    ],
    note: null,
    routedAt: null,
    postedAt: null,
    postError: null
  }

  it("round-trips through encode → decode unchanged", () => {
    const roundTripped = Schema.decodeUnknownSync(AdversarialReview)(
      Schema.encodeSync(AdversarialReview)(review)
    )
    expect(roundTripped).toStrictEqual(review)
  })

  /**
   * The back-compat guard. `ReviewStore.readFile` folds a decode failure to null,
   * and a null read makes the auto-trigger run a fresh review — so if a review
   * written before these fields failed to decode, every existing session would
   * silently re-run the priciest model once. The defaults are what stop that.
   */
  it("decodes a review persisted before the routing fields existed", () => {
    const { routedAt, postedAt, postError, ...legacy } = review
    const result = decode(AdversarialReview, legacy)
    expect(result).toStrictEqual(
      Either.right({ ...legacy, routedAt: null, postedAt: null, postError: null })
    )
  })

  it("carries the routing stamps when they are set", () => {
    const result = decode(AdversarialReview, {
      ...review,
      routedAt: "2026-07-16T10:05:00.000Z",
      postedAt: "2026-07-16T10:05:01.000Z",
      postError: null
    })
    expect(Either.isRight(result)).toBe(true)
  })

  // A reviewer that refuses or emits prose still produces a review — findings
  // empty, note set. That is a success, not an error.
  it("decodes a review with no findings and a note", () => {
    const result = decode(AdversarialReview, {
      ...review,
      findings: [],
      note: "I could not review this diff."
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("accepts a finding not anchored to a file", () => {
    const result = decode(AdversarialReview, {
      ...review,
      findings: [{ ...review.findings[0], path: null, line: null, suggestion: null }]
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects a severity outside the known set", () => {
    const result = decode(AdversarialReview, {
      ...review,
      findings: [{ ...review.findings[0], severity: "blocker" }]
    })
    expect(Either.isLeft(result)).toBe(true)
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
