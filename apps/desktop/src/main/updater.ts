/**
 * Self-update via electron-updater, reading the GitHub Releases feed configured
 * in electron-builder.yml (the `latest*.yml` channel files). Only meaningful in a
 * packaged build — the caller guards on `app.isPackaged`.
 *
 * `autoDownload` is off: the user is asked before we pull the update, and again
 * before we restart to install it. Checks on launch and every two hours.
 */
import { dialog } from "electron"
import electronUpdater from "electron-updater"

const { autoUpdater } = electronUpdater

const TWO_HOURS = 2 * 60 * 60 * 1000

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("update-available", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `Starbase ${info.version} is available.`,
      detail: "Download it now? You can keep working while it downloads."
    })
    if (response === 0) void autoUpdater.downloadUpdate()
  })

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Starbase ${info.version} has been downloaded.`,
      detail: "Restart to install the update."
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on("error", (error) => {
    console.error("[updater]", error)
  })

  const check = () =>
    autoUpdater.checkForUpdates().catch((error) => console.error("[updater] check failed", error))

  void check()
  setInterval(() => void check(), TWO_HOURS)
}
