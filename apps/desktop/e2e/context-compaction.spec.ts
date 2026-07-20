import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Auto-compaction, end to end against the built app.
 *
 * The unit suites already prove the policy and the swap. What only this can
 * prove is that the whole loop survives the REAL boundaries: `ContextSnapshot`
 * and `ContextDigest` encoding across Electron IPC, the meter reading a live
 * snapshot, and the compaction marker rendering in a real transcript.
 *
 * Driven through "Compact now" rather than by inflating a session past the
 * budget: the scripted adapter reports a fixed 42k, and a test that faked its
 * way past the threshold would be testing the fake rather than the feature.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_ctx",
    repo: "widget",
    branch: "starbase/context",
    title: "Long running session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-19T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto"
  }
]

test("compacts a session and keeps its history intact", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  const composer = window.getByPlaceholder("Message Claude…")
  await expect(composer).toBeVisible()

  // ── A first turn, so there is a conversation worth summarising ──
  await composer.click()
  await composer.pressSequentially("Add rate limiting to the refund endpoint.")
  await composer.press("Enter")

  // Wait for the turn to settle — the meter only appears once usage is reported.
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })

  // ── The meter reads a live snapshot across the RPC boundary ──
  const meter = window.getByRole("button", { name: "Compact now" })
  await expect(meter).toBeVisible({ timeout: 20_000 })
  // 42.1k is the scripted adapter's reported context size. Seeing it here proves
  // the Usage event reached the renderer AND that `Context.state` resolved a
  // trigger point — the meter renders nothing without one.
  await expect(meter).toContainText("42.1k")

  // ── Compact ──
  await meter.click()

  // The widget must SAY a compaction is happening — the state the user cannot
  // cause themselves and previously had no word for. It resolves to "compacts
  // next turn" once the summary lands.
  await expect(window.getByText(/compacting…|compacts next turn/)).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("compacts next turn")).toBeVisible({ timeout: 20_000 })

  // ── The next turn runs on the reseeded conversation ──
  await composer.click()
  await composer.pressSequentially("What did we decide about the token bucket?")
  await composer.press("Enter")

  // The marker lands in the transcript, above the reply that ran on it.
  await expect(window.getByText("Context compacted")).toBeVisible({ timeout: 20_000 })

  // ── What the user is left with ──
  // The earlier turn is STILL THERE. This is the property that distinguishes
  // this from `/compact`: the model's working set shrank, the user's record
  // did not.
  await expect(window.getByText("Add rate limiting to the refund endpoint.")).toBeVisible()

  // And the summary is inspectable, so the drop in the meter is explicable.
  await window.getByText("Context compacted").click()
  await expect(window.getByText(/full history above is unchanged/)).toBeVisible()
  await expect(window.getByText(/token bucket/).first()).toBeVisible()
})

/**
 * The regression guard for the streamed-digest bug.
 *
 * A real harness streams its summary token by token, so the manager collects the
 * reply as many `Assistant` deltas and reassembles them. It once joined those
 * fragments with "\n" instead of "": a newline injected inside a JSON string
 * value made the reply invalid JSON, `parseDigest` returned null, and EVERY real
 * digest failed — the session showed "compaction failed" and never compacted.
 *
 * Unit tests missed it because the fake adapters emit the reply as ONE event,
 * where the separator is a no-op. This test only means anything because the
 * scripted digest now streams in chunks (see `scriptedRun` in adapter.ts), so a
 * boundary lands mid-string exactly as it does in production. If the join
 * regresses, the digest fails to parse and every assertion below times out.
 */
test("reassembles a digest that arrives as streamed deltas", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  const composer = window.getByPlaceholder("Message Claude…")
  await expect(composer).toBeVisible()

  await composer.click()
  await composer.pressSequentially("Add rate limiting to the refund endpoint.")
  await composer.press("Enter")
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })

  const meter = window.getByRole("button", { name: "Compact now" })
  await expect(meter).toBeVisible({ timeout: 20_000 })
  await meter.click()

  // The digest PARSED. With the "\n" join this never happens: the reply is
  // invalid JSON, the manager fails, and the meter reads "compaction failed".
  await expect(window.getByText("compacts next turn")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("compaction failed")).toHaveCount(0)

  // Apply the swap, then inspect the summary the manager reassembled.
  await composer.click()
  await composer.pressSequentially("What did we decide about the token bucket?")
  await composer.press("Enter")
  await expect(window.getByText("Context compacted")).toBeVisible({ timeout: 20_000 })
  await window.getByText("Context compacted").click()

  // Multi-word strings that the chunker split ACROSS delta boundaries, rendered
  // intact. Any of these surviving whole proves the fragments were concatenated
  // faithfully — a "\n" join would have corrupted the JSON before it ever parsed.
  await expect(
    window.getByText("Reused the token bucket in lib/ratelimit.ts rather than adding a dependency")
  ).toBeVisible()
  await expect(window.getByText("The 429 test still needs writing")).toBeVisible()
  await expect(window.getByText("Prefers Effect over raw async")).toBeVisible()
})

test("exposes the token levers in Settings", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: /Context/ }).click()

  // The budget, and — the part that makes it meaningful — what it means per
  // harness. A 200k Claude compacts at its safety margin, not at the budget.
  await expect(window.getByText("300k tokens")).toBeVisible()
  await expect(window.getByText("170k of 200k")).toBeVisible()

  // The cost answer, stated rather than implied.
  await expect(window.getByText(/no API key/)).toBeVisible()
})
