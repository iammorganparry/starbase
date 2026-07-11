import type { Message } from "@starbase/core"

/**
 * Sample conversation + diff for the active session, mirroring the design.
 * Used until live session streaming is wired up.
 */
export const SEED_CONVERSATION: ReadonlyArray<Message> = [
  {
    id: "m1",
    role: "user",
    text: "Migrate the session middleware to the new token store and add refresh handling.",
    thinking: null,
    toolCalls: [],
    gate: null
  },
  {
    id: "m2",
    role: "assistant",
    text: "Swapped the store and added a refresh guard, then opened PR #482. A reviewer requested a change on the 401 path — addressing it now.",
    thinking:
      "The 401 path currently throws before the refresh guard runs. I'll reorder so a stale token triggers a refresh-and-retry instead of surfacing a 500.",
    toolCalls: [
      { id: "t1", name: "Edit", target: "src/auth/refresh.ts", summary: "add 401 retry path", diff: { added: 9, removed: 1 } }
    ],
    gate: {
      id: "g1",
      title: "Approve edit to src/auth/refresh.ts",
      detail:
        "The refresh guard now handles the 401 retry path so a stale token refreshes instead of 500ing. Approve to apply.",
      status: "pending"
    }
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
