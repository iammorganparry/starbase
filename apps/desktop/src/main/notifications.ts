/**
 * Desktop notifications — the channel that makes a parallel-agent workflow
 * survivable.
 *
 * The problem this exists for: with a dozen sessions running you cannot watch
 * them all, so an agent that stops to ask you something waits indefinitely and
 * one that finishes goes unnoticed. The notification is the only thing that
 * reaches an operator who is looking at a different session, or at a different
 * app entirely.
 *
 * Division of labour, and it matters: MAIN owns Electron's `Notification` API
 * and the window, so it decides whether the WINDOW is focused. The RENDERER
 * owns which session is on screen, so it decides whether THIS session is the
 * one the operator is already watching. Neither can answer alone, so the
 * renderer makes the call and this module is the delivery mechanism — see
 * `Notify.show` in the RPC contract.
 *
 * `shouldNotify` is pure so the suppression rules can be tested without
 * Electron, which is most of the behaviour worth defending.
 */
import type { NotificationKind, NotificationsConfig } from "@starbase/core"
import { NOTIFICATIONS_DEFAULT } from "@starbase/core"
import { BrowserWindow, Notification } from "electron"

/** IPC channel main uses to tell the renderer which session to open. */
export const NOTIFICATION_ACTIVATED_CHANNEL = "starbase/notification-activated"

/** Map a kind onto the per-kind toggle that governs it. */
const TOGGLE: Record<NotificationKind, keyof NotificationsConfig> = {
  "needs-input": "needsInput",
  done: "done",
  failed: "failed",
  pr: "pr"
}

export interface NotifyDecision {
  readonly kind: NotificationKind
  /** Is the Starbase window focused right now? */
  readonly windowFocused: boolean
  /**
   * Is this the session the operator currently has open? Only meaningful while
   * the window is focused — a session on screen behind another app is not being
   * watched.
   */
  readonly isActiveSession: boolean
  /** Absent config means the defaults, NOT silence. See `NOTIFICATIONS_DEFAULT`. */
  readonly config: NotificationsConfig | undefined
}

/**
 * Should this event raise an OS notification?
 *
 * Suppressed when the operator can already see the answer — that is the entire
 * design. A notification for the session filling their screen is noise, and
 * noise is how a notification channel gets muted wholesale, taking the alerts
 * that mattered with it.
 */
export const shouldNotify = ({
  kind,
  windowFocused,
  isActiveSession,
  config
}: NotifyDecision): boolean => {
  const prefs = config ?? NOTIFICATIONS_DEFAULT
  if (!prefs.enabled) return false
  if (!prefs[TOGGLE[kind]]) return false
  // The operator is looking straight at it. Anything else is telling someone
  // what they can already see.
  if (windowFocused && isActiveSession) return false
  return true
}

/**
 * Raise the notification and wire its click to focus the app on that session.
 *
 * Every failure path here is swallowed: notifications are unavailable on an
 * unconfigured Linux desktop and can be denied outright on macOS, and neither is
 * a reason to disturb — let alone fail — the agent run that triggered this.
 */
export const showNotification = (
  input: {
    readonly sessionId: string
    readonly kind: NotificationKind
    readonly title: string
    readonly body: string
  },
  config: NotificationsConfig | undefined,
  /** Injected in tests; defaults to the real focused-or-first window. */
  windowFor: () => BrowserWindow | null = () =>
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
): void => {
  try {
    if (!Notification.isSupported()) return
    const prefs = config ?? NOTIFICATIONS_DEFAULT
    const notification = new Notification({
      title: input.title,
      body: input.body,
      // `silent` is the inverse of the operator's "sound" preference. Sound is
      // opt-in because it interrupts a room rather than a screen.
      silent: !prefs.sound
    })
    notification.on("click", () => {
      const win = windowFor()
      if (win === null) return
      // Restore first: a minimised window cannot be focused, so skipping this
      // makes the click appear to do nothing — the one interaction the whole
      // feature promises.
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send(NOTIFICATION_ACTIVATED_CHANNEL, { sessionId: input.sessionId })
    })
    notification.show()
  } catch {
    // See the doc comment: never let the notifier break the run.
  }
}
