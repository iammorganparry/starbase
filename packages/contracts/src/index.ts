import { CliInfo, Session } from "@starbase/core"
import { DiscoveryError, SessionNotFoundError } from "@starbase/core"
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

/**
 * The Starbase RPC surface — a single source of truth shared by the Electron
 * main process (which implements the handlers as Effect services) and the
 * renderer (which calls them through a typed `RpcClient`). Transport is Electron
 * IPC; serialization is JSON. See `apps/desktop/src/main/rpc` for the wiring.
 */
export class StarbaseRpcs extends RpcGroup.make(
  /** List every known coding CLI and whether it is installed on this host. */
  Rpc.make("Discovery.list", {
    success: Schema.Array(CliInfo),
    error: DiscoveryError
  }),

  /** List all agent sessions for the sidebar. */
  Rpc.make("Sessions.list", {
    success: Schema.Array(Session)
  }),

  /** Fetch one session by id. */
  Rpc.make("Sessions.get", {
    success: Session,
    error: SessionNotFoundError,
    payload: { id: Schema.String }
  })
) {}
