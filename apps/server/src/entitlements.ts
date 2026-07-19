import { Effect } from "effect"

/**
 * Whether an organisation may pool learnings.
 *
 * The single seam a team subscription will plug into. Today it is membership:
 * you are acting in an organisation, so you may contribute to and read from it.
 * When billing exists, the lookup goes HERE and nowhere else — which is the
 * point of naming it now rather than scattering `if (paid)` through the routes
 * later.
 *
 * Deliberately not built yet. The schema comment already anticipates billing
 * tables hanging off `user.id`; inventing a subscription model before there is a
 * product decision behind it would be speculation, and speculation in an
 * authorisation path is worse than speculation anywhere else.
 */
export const canShareLearnings = (
  organizationId: string | null | undefined
): Effect.Effect<boolean> =>
  Effect.succeed(typeof organizationId === "string" && organizationId.length > 0)
