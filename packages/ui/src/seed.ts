import type { Message } from "@starbase/core"

/**
 * Sample conversation + diff for the active session, mirroring the design.
 * Used until live session streaming is wired up.
 */
export const SEED_CONVERSATION: ReadonlyArray<Message> = [
  {
    id: "m1",
    role: "user",
    streaming: false,
    createdAt: "2026-07-11T10:00:00.000Z",
    parts: [
      { _tag: "Text", text: "Migrate the session middleware to the new token store and add refresh handling." }
    ]
  },
  {
    id: "m2",
    role: "assistant",
    streaming: false,
    createdAt: "2026-07-11T10:00:04.000Z",
    parts: [
      {
        _tag: "Thinking",
        text: "The 401 path currently throws before the refresh guard runs. I'll reorder so a stale token triggers a refresh-and-retry instead of surfacing a 500.",
        seconds: 5,
        streaming: false
      },
      {
        _tag: "Text",
        text: "Swapped the store and added a refresh guard, then opened PR #482. A reviewer requested a change on the 401 path — addressing it now."
      },
      {
        _tag: "Tool",
        tool: {
          id: "t1",
          name: "Edit",
          target: "src/auth/refresh.ts",
          status: "success",
          meta: null,
          diff: { added: 9, removed: 1 },
          preview: "27  + return refresh(session)"
        }
      },
      {
        _tag: "Gate",
        gate: {
          id: "g1",
          kind: "command",
          title: "Approval needed · run a command",
          detail:
            "Not in your allowlist. Agents never run shell commands until you allow — the edit above was applied under this mode.",
          command: "npm test -- auth",
          allowLabel: "npm test",
          status: "pending"
        }
      }
    ]
  }
]

/** A unified-diff patch that the virtualized `DiffView` parses & renders. */
export const SEED_PATCH = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 8a1c0f2..b3d9e77 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -11,7 +11,7 @@ import { cookies } from "./cookies"
-import { MemoryStore } from "./stores/memory"
+import { TokenStore } from "./stores/token"

 export function sessionMiddleware(req: Request) {
   const s = req.session
@@ -25,6 +25,9 @@ export function sessionMiddleware(req: Request) {
   const s = req.session
+  if (isExpired(s.token)) {
+    return refresh(s)
+  }
   return next()
 }
diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts
new file mode 100644
index 0000000..a77b912
--- /dev/null
+++ b/src/auth/refresh.ts
@@ -0,0 +1,9 @@
+export async function refresh(session: Session) {
+  const next = await tokenStore.rotate(session.token)
+  if (!next) {
+    throw new UnauthorizedError("refresh failed")
+  }
+  session.token = next
+  return retry(session.request)
+}
`
