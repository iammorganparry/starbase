/**
 * The bounds guard for the browser preview's native `WebContentsView`.
 *
 * Its own module, not a constant inside `browser-preview-view.tsx`, for one
 * practical reason: that file imports `rpc-client`, which touches `window` at
 * module scope, so a unit test of this arithmetic would need a DOM environment
 * to assert four inequalities. Pure logic that has been wrong twice deserves to
 * be testable without dragging the renderer's whole graph in.
 */

/**
 * The line between a DEGENERATE rect and a small-but-real one.
 *
 * Deliberately tiny, and it has to be. The previous value here was 200×150,
 * which the bottom dock can never reach: its minimum height is 180px
 * (`browser-preview.tsx` HEIGHT.min), of which the address bar takes 36 and the
 * two borders take 2, leaving a **142px** view region. Dragging the dock to its
 * own minimum therefore parked the rect permanently under the floor — not "one
 * frame later", forever — so `setBounds` stopped firing and the native view kept
 * its last, larger bounds, painting over the conversation above the dock and
 * ignoring every later x/y layout shift until the dock was dragged back past
 * ~186px.
 *
 * The question this guard is actually asking is "is the placeholder laid out at
 * all?", not "is it big enough to be worth showing". A hidden, unmounted or
 * mid-transition element measures 0×0; nothing legitimate measures 8×8. So the
 * floor sits far below every reachable steady state, and a genuinely small dock
 * gets a genuinely small native view.
 */
export const MIN_NATIVE_BOUNDS = { width: 8, height: 8 } as const

/** Whether a measured rect is worth handing to the native `WebContentsView`. */
export const isPaintableRect = (r: { readonly width: number; readonly height: number }): boolean =>
  Number.isFinite(r.width) &&
  Number.isFinite(r.height) &&
  r.width >= MIN_NATIVE_BOUNDS.width &&
  r.height >= MIN_NATIVE_BOUNDS.height
