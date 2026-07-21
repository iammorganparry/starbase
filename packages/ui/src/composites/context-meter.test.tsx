import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ContextMeter } from "./context-meter.js"

afterEach(cleanup)

/**
 * The meter's job is to make the QUALITY BUDGET legible, not the hard window.
 * Every test here is really about that distinction.
 */
describe("ContextMeter", () => {
  it("measures against the compaction trigger, not the model's ceiling", () => {
    // A 1M-window model at 300k. Against the window this is 30% — against the
    // point where quality goes, it is full. Full is the honest reading.
    const { container } = render(<ContextMeter tokens={300_000} triggerAt={300_000} />)
    const bar = container.querySelector("span[style]") as HTMLElement
    expect(bar.style.width).toBe("100%")
  })

  it("fills proportionally below the trigger", () => {
    const { container } = render(<ContextMeter tokens={85_000} triggerAt={170_000} />)
    const bar = container.querySelector("span[style]") as HTMLElement
    expect(bar.style.width).toBe("50%")
  })

  it("never overflows past full when the session runs over", () => {
    const { container } = render(<ContextMeter tokens={900_000} triggerAt={300_000} />)
    const bar = container.querySelector("span[style]") as HTMLElement
    expect(bar.style.width).toBe("100%")
  })

  /**
   * An empty bar reads as "plenty of room left", which is the opposite of the
   * truth for a harness we cannot measure at all. Rendering nothing is honest.
   */
  it("renders nothing when the harness cannot report context", () => {
    const { container } = render(<ContextMeter tokens={100_000} triggerAt={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing before the first reading", () => {
    const { container } = render(<ContextMeter tokens={0} triggerAt={170_000} />)
    expect(container.firstChild).toBeNull()
  })

  it("says a compaction is coming once over the trigger", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} phase="prepare" />)
    expect(screen.getByText("compacting soon")).toBeDefined()
  })

  /**
   * The promise the meter used to break.
   *
   * `triggerAt` is computed the moment the model's window is known, but
   * compaction also requires auto-compaction to be ON and the harness to report
   * usage — so a session can sit far past its trigger with `phase: "unknown"`
   * and never compact. Labelling off `tokens / triggerAt` made the meter say
   * "compacting soon" forever on exactly those sessions.
   */
  it("does not promise a compaction that will never come", () => {
    render(<ContextMeter tokens={472_200} triggerAt={300_000} phase="unknown" />)
    expect(screen.queryByText("compacting soon")).toBeNull()
    expect(screen.getByText("context")).toBeDefined()
  })

  it("says so when auto-compaction is off for the session", () => {
    const { container } = render(
      <ContextMeter tokens={472_200} triggerAt={300_000} phase="unknown" />
    )
    expect((container.firstChild as HTMLElement).getAttribute("title")).toContain(
      "automatic compaction is off"
    )
  })

  /**
   * After the retry ceiling the manager stops forking digest fibers entirely.
   * Both this and a healthy pre-compaction session leave `preparing: false`, so
   * without `stalled` the meter cannot tell "a digest is coming" from "no digest
   * is ever coming" — and it defaulted to promising one.
   */
  it("reports a session that has given up rather than promising a compaction", () => {
    render(<ContextMeter tokens={472_200} triggerAt={300_000} phase="prepare" stalled />)
    expect(screen.queryByText("compacting soon")).toBeNull()
    expect(screen.getByText("compaction failed")).toBeDefined()
  })

  it("offers a retry on a stalled session", () => {
    const { container } = render(
      <ContextMeter tokens={472_200} triggerAt={300_000} phase="prepare" stalled />
    )
    expect((container.firstChild as HTMLElement).getAttribute("title")).toContain("try again")
  })

  // An in-flight summary is still the truth even on a session that had
  // previously given up — a manual "Compact now" clears the failure count.
  it("prefers the in-flight state over a stale stall", () => {
    render(<ContextMeter tokens={472_200} triggerAt={300_000} phase="prepare" stalled preparing />)
    expect(screen.getByText("compacting…")).toBeDefined()
  })

  it("says the next turn will reseed once a digest is ready", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} digestReady />)
    expect(screen.getByText("compacts next turn")).toBeDefined()
  })

  /**
   * A held swap is still holding a ready digest, so the two states arrive
   * together. Labelling off `digestReady` alone would promise "compacts next
   * turn" for several turns running and never deliver — which is the same
   * "reads as stuck" failure that "compacting…" was added to fix.
   */
  it("says a compaction is held when the session is mid-task", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} digestReady held />)
    expect(screen.getByText("compaction held")).toBeDefined()
    expect(screen.queryByText("compacts next turn")).toBeNull()
  })

  it("names what is in flight on hover, so the hold is not a mystery", () => {
    render(
      <ContextMeter
        tokens={310_000}
        triggerAt={300_000}
        digestReady
        held
        heldReason="a plan is still executing"
      />
    )
    expect(screen.getByTitle(/a plan is still executing/)).toBeDefined()
  })

  // A summary genuinely in flight outranks a hold: the hold applies to the
  // PREVIOUS digest, and "compacting…" is the state the user cannot cause.
  it("prefers an in-flight summary over a hold", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} preparing held />)
    expect(screen.getByText("compacting…")).toBeDefined()
  })

  /**
   * The state that was missing, and the one the user cannot cause themselves.
   * An automatic compaction takes as long as a summary takes; with no word for
   * it the meter sat on "compacting soon" throughout, which reads as stuck.
   */
  it("says a summary is being built while one is in flight", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} preparing />)
    expect(screen.getByText("compacting…")).toBeDefined()
  })

  it("shows compacting even when the session is still inside its budget", () => {
    // A manual "Compact now" runs well below the trigger — the label has to come
    // from the actual state, not from how full the bar is.
    render(<ContextMeter tokens={50_000} triggerAt={300_000} preparing />)
    expect(screen.getByText("compacting…")).toBeDefined()
  })

  it("pulses only while a summary is genuinely in flight", () => {
    const { container: busy } = render(<ContextMeter tokens={50_000} triggerAt={300_000} preparing />)
    expect(busy.innerHTML).toContain("animate-pulse")
    cleanup()
    const { container: done } = render(
      <ContextMeter tokens={50_000} triggerAt={300_000} digestReady />
    )
    expect(done.innerHTML).not.toContain("animate-pulse")
  })

  // A compaction already under way cannot be started again, so the meter stops
  // being a button rather than offering one that does nothing.
  it("is not clickable while compacting", () => {
    render(<ContextMeter tokens={50_000} triggerAt={300_000} preparing onCompactNow={() => {}} />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("explains the in-flight state on hover", () => {
    const { container } = render(<ContextMeter tokens={50_000} triggerAt={300_000} preparing />)
    expect((container.firstChild as HTMLElement).getAttribute("title")).toContain(
      "summarising in the background"
    )
  })

  // Crossing the trigger is the system WORKING — a digest is being prepared and
  // the next turn will be cheaper. Red would train the user to intervene in
  // something that handles itself.
  it("never uses an alarm colour, even when full", () => {
    const { container } = render(<ContextMeter tokens={900_000} triggerAt={300_000} />)
    expect(container.innerHTML).not.toContain("red")
  })

  it("explains the numbers on hover", () => {
    const { container } = render(<ContextMeter tokens={150_000} triggerAt={170_000} />)
    const title = (container.firstChild as HTMLElement).getAttribute("title")
    expect(title).toContain("150,000")
    expect(title).toContain("170,000")
    expect(title).toContain("compacts")
  })
})
