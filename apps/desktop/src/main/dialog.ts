/**
 * The native folder picker, exposed as an Effect service so an RPC handler can
 * call it. Lives in the main process because `dialog.showOpenDialog` is
 * Electron-only; the renderer reaches it through the `Setup.chooseReposDir` RPC.
 */
import { dialog } from "electron"
import { Context, Effect, Layer } from "effect"

export interface DialogServiceShape {
  /** Open a directory picker; resolves to the chosen absolute path or null. */
  readonly chooseDirectory: () => Effect.Effect<string | null>
}

export class DialogService extends Context.Tag("@starbase/DialogService")<
  DialogService,
  DialogServiceShape
>() {}

export const DialogServiceLive = Layer.succeed(DialogService, {
  chooseDirectory: () =>
    Effect.promise(() =>
      dialog.showOpenDialog({
        title: "Choose your repos folder",
        message: "Select the directory that contains your git repositories.",
        properties: ["openDirectory", "createDirectory"]
      })
    ).pipe(
      Effect.map((result) =>
        result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null)
      )
    )
})
