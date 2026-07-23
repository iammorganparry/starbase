import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FileSystem, Path } from "@effect/platform"
import { DEFAULT_THEME_ID } from "@starbase/core"
import { BUILTIN_THEME_IDS } from "@starbase/themes"
import { Chunk, Effect, Fiber, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ThemeService } from "./themes.js"
import { failureOf, runExit, withTempRoot } from "./test-support.js"

/**
 * ThemeService is run against a real temp `~/starbase` with real files, so a
 * theme actually round-trips through disk. Assertions are on observable
 * outcomes — what `list()` returns, what ends up in the directory, how a
 * malformed file surfaces — never on how the JSON is parsed.
 */
describe("ThemeService", () => {
  let temp: ReturnType<typeof withTempRoot>
  beforeEach(() => {
    temp = withTempRoot()
  })
  afterEach(() => temp.cleanup())

  // `Path.Path` as well as `FileSystem`: ThemeService joins `themesDir` with a
  // filename, so its environment is wider than ConfigService's.
  const provided = <A, E>(
    effect: Effect.Effect<A, E, ThemeService | AppPaths | FileSystem.FileSystem | Path.Path>
  ) => runExit(effect.pipe(Effect.provide(ThemeService.Default)), temp.layer)

  const themesDir = () => join(temp.root, "themes")

  const writeTheme = (id: string, body: unknown) => {
    mkdirSync(themesDir(), { recursive: true })
    writeFileSync(join(themesDir(), `${id}.json`), JSON.stringify(body, null, 2))
  }

  const VALID_THEME = {
    name: "My Theme",
    type: "dark",
    colors: { "editor.background": "#101014", "terminal.ansiBlue": "#5599ff" }
  }

  describe("list", () => {
    it("returns every built-in before the user has any themes", async () => {
      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.themes.map((t) => t.id)).toEqual([...BUILTIN_THEME_IDS])
      expect(exit.value.skipped).toEqual([])
    })

    it("includes resolved tokens so the picker can preview without a second call", async () => {
      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      const oneDark = exit.value.themes.find((t) => t.id === DEFAULT_THEME_ID)!
      expect(oneDark.tokens.editor.toLowerCase()).toBe("#282c34")
      expect(oneDark.kind).toBe("dark")
      expect(oneDark.source).toBe("builtin")
    })

    it("picks up a user theme and marks where it came from", async () => {
      writeTheme("my-theme", VALID_THEME)
      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return

      const mine = exit.value.themes.find((t) => t.id === "my-theme")
      expect(mine?.name).toBe("My Theme")
      expect(mine?.source).toBe("user")
      expect(mine?.path).toBe(join(themesDir(), "my-theme.json"))
    })

    /**
     * The reason listing has no error channel. One bad file in the directory
     * must not empty the picker — the operator needs to keep switching themes
     * AND be told which file is broken, and an error channel can only do the
     * second.
     */
    it("skips a malformed file, names it, and still returns everything else", async () => {
      mkdirSync(themesDir(), { recursive: true })
      writeFileSync(join(themesDir(), "broken.json"), "{ this is not json")
      writeTheme("my-theme", VALID_THEME)

      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return

      expect(exit.value.themes.some((t) => t.id === "my-theme")).toBe(true)
      expect(exit.value.themes.length).toBe(BUILTIN_THEME_IDS.length + 1)
      expect(exit.value.skipped).toHaveLength(1)
      expect(exit.value.skipped[0]?.path).toContain("broken.json")
    })

    it("skips a file that is JSON but not a theme", async () => {
      writeTheme("not-a-theme", { hello: "world" })
      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.skipped).toHaveLength(1)
      expect(exit.value.themes.some((t) => t.id === "not-a-theme")).toBe(false)
    })

    it("ignores non-JSON files in the directory", async () => {
      mkdirSync(themesDir(), { recursive: true })
      writeFileSync(join(themesDir(), "README.md"), "notes to self")

      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.skipped).toEqual([])
      expect(exit.value.themes.map((t) => t.id)).toEqual([...BUILTIN_THEME_IDS])
    })

    /**
     * Shadowing is the escape hatch for people who would rather edit a file
     * than use the colour picker, and it lets a built-in be corrected locally
     * without waiting for a release. It replaces IN PLACE because the preset
     * order is deliberate — a locally-corrected Monokai should stay where
     * Monokai was, not jump to the end of the grid.
     */
    it("lets a user file shadow a built-in without moving it in the list", async () => {
      writeTheme("monokai", { name: "My Monokai", type: "dark", colors: { "editor.background": "#000000" } })

      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return

      const ids = exit.value.themes.map((t) => t.id)
      expect(ids).toEqual([...BUILTIN_THEME_IDS])
      expect(ids.indexOf("monokai")).toBe(BUILTIN_THEME_IDS.indexOf("monokai"))

      const monokai = exit.value.themes.find((t) => t.id === "monokai")!
      expect(monokai.source).toBe("user")
      expect(monokai.name).toBe("My Monokai")
    })

    it("appends genuinely new user themes after the presets", async () => {
      writeTheme("zzz-mine", VALID_THEME)
      const exit = await provided(ThemeService.list())
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.themes.at(-1)?.id).toBe("zzz-mine")
    })
  })

  describe("resolve", () => {
    it("returns the default when nothing has been chosen", async () => {
      const exit = await provided(ThemeService.resolve(undefined))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.id).toBe(DEFAULT_THEME_ID)
      expect(exit.value.fellBack).toBe(false)
    })

    /**
     * The active id can name a theme the user has since deleted. Neither that
     * nor a corrupt file is a reason to launch into an unstyled window, so both
     * resolve to One Dark Pro — which is bundled and therefore always available.
     * `fellBack` is what lets the UI say so instead of silently changing colour.
     */
    it("falls back to the default when the chosen theme is gone, and says so", async () => {
      const exit = await provided(ThemeService.resolve("deleted-theme"))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.id).toBe(DEFAULT_THEME_ID)
      expect(exit.value.fellBack).toBe(true)
    })

    it("does not report a fallback when the default itself is what was asked for", async () => {
      const exit = await provided(ThemeService.resolve(DEFAULT_THEME_ID))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.fellBack).toBe(false)
    })

    it("prefers a user file over the built-in of the same id", async () => {
      writeTheme("monokai", { name: "My Monokai", type: "dark", colors: { "editor.background": "#010203" } })
      const exit = await provided(ThemeService.resolve("monokai"))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.theme.name).toBe("My Monokai")
    })
  })

  describe("save", () => {
    it("writes a theme that reads back identically", async () => {
      const exit = await provided(
        Effect.gen(function* () {
          yield* ThemeService.save("mine", VALID_THEME as never)
          return yield* ThemeService.get("mine")
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value?.name).toBe("My Theme")
      expect(exit.value?.colors?.["editor.background"]).toBe("#101014")
    })

    /**
     * Built-ins staying immutable is what guarantees the fallback in `resolve`
     * always has something to fall back TO. It is also why `duplicate` exists.
     */
    it("refuses to overwrite a built-in and says what to do instead", async () => {
      const exit = await provided(ThemeService.save("monokai", VALID_THEME as never))
      const failure = failureOf(exit)
      expect(failure?._tag).toBe("ThemeError")
      expect(failure?.message).toContain("Duplicate it")
    })

    /**
     * The file exists to be hand-edited — that is half the point of it being a
     * file rather than a config section — and a 900-key colour table on one
     * line is not hand-editable.
     */
    it("writes indented JSON, because the file is meant to be edited by hand", async () => {
      await provided(ThemeService.save("mine", VALID_THEME as never))
      const raw = readFileSync(join(themesDir(), "mine.json"), "utf8")
      expect(raw).toContain("\n  ")
      expect(raw.endsWith("\n")).toBe(true)
    })

    it("creates the themes directory on first write", async () => {
      const exit = await provided(ThemeService.save("mine", VALID_THEME as never))
      expect(exit._tag).toBe("Success")
      expect(readFileSync(join(themesDir(), "mine.json"), "utf8").length).toBeGreaterThan(0)
    })
  })

  describe("remove", () => {
    it("deletes a user theme", async () => {
      writeTheme("mine", VALID_THEME)
      const exit = await provided(
        Effect.gen(function* () {
          yield* ThemeService.remove("mine")
          return yield* ThemeService.list()
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.themes.some((t) => t.id === "mine")).toBe(false)
    })

    it("refuses to delete a built-in", async () => {
      const exit = await provided(ThemeService.remove("monokai"))
      expect(failureOf(exit)?._tag).toBe("ThemeError")
    })

    /** Already gone is the outcome the caller asked for. */
    it("treats deleting a theme that is not there as success", async () => {
      const exit = await provided(ThemeService.remove("never-existed"))
      expect(exit._tag).toBe("Success")
    })
  })

  describe("path confinement", () => {
    it("refuses to save outside the themes directory", async () => {
      const exit = await provided(ThemeService.save("../config", VALID_THEME as never))

      expect(failureOf(exit)?._tag).toBe("ThemeError")
      expect(existsSync(join(temp.root, "config.json"))).toBe(false)
    })

    it("refuses an absolute path as a theme id", async () => {
      const outside = join(temp.root, "outside")
      const exit = await provided(ThemeService.save(outside, VALID_THEME as never))

      expect(failureOf(exit)?._tag).toBe("ThemeError")
      expect(existsSync(`${outside}.json`)).toBe(false)
    })

    it("refuses to delete outside the themes directory", async () => {
      mkdirSync(temp.root, { recursive: true })
      const sessionsFile = join(temp.root, "sessions.json")
      writeFileSync(sessionsFile, "keep me")

      const exit = await provided(ThemeService.remove("../sessions"))

      expect(failureOf(exit)?._tag).toBe("ThemeError")
      expect(readFileSync(sessionsFile, "utf8")).toBe("keep me")
    })

    it("does not read a traversed path as a theme", async () => {
      mkdirSync(temp.root, { recursive: true })
      writeFileSync(join(temp.root, "config.json"), JSON.stringify(VALID_THEME))

      const exit = await provided(ThemeService.get("../config"))

      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value).toBeNull()
    })
  })

  describe("duplicate", () => {
    /**
     * The only path from "I like this but…" to an editable file, since built-ins
     * refuse writes.
     */
    it("turns a built-in into an editable user theme", async () => {
      const exit = await provided(
        Effect.gen(function* () {
          const copy = yield* ThemeService.duplicate("monokai")
          const saved = yield* ThemeService.save(copy.id, { name: "Edited", type: "dark" } as never)
          return { copy, saved }
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.copy.source).toBe("user")
      expect(exit.value.copy.name).toBe("Monokai (Copy)")
      expect(exit.value.saved.id).toBe(exit.value.copy.id)
    })

    /** The id is derived from the name so the file is guessable from the picker. */
    it("derives a filename from the new name", async () => {
      const exit = await provided(ThemeService.duplicate("monokai", "Midnight Ranch"))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.id).toBe("midnight-ranch")
      expect(readFileSync(join(themesDir(), "midnight-ranch.json"), "utf8")).toContain("Midnight Ranch")
    })

    it("never overwrites an existing theme when a name repeats", async () => {
      const exit = await provided(
        Effect.gen(function* () {
          const first = yield* ThemeService.duplicate("monokai", "Mine")
          const second = yield* ThemeService.duplicate("monokai", "Mine")
          return [first.id, second.id]
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value).toEqual(["mine", "mine-2"])
    })

    it("never collides with a built-in id", async () => {
      const exit = await provided(ThemeService.duplicate("monokai", "Monokai"))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.id).toBe("monokai-2")
    })

    it("fails when the source theme is gone", async () => {
      const exit = await provided(ThemeService.duplicate("no-such-theme"))
      expect(failureOf(exit)?._tag).toBe("ThemeError")
    })
  })

  describe("importJson", () => {
    it("accepts pasted VS Code theme JSON", async () => {
      const exit = await provided(
        ThemeService.importJson(JSON.stringify({ ...VALID_THEME, name: "Pasted" }))
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.id).toBe("pasted")
      expect(exit.value.source).toBe("user")
    })

    it("keeps keys Starbase does not model, so the file stays usable in VS Code", async () => {
      const exit = await provided(
        Effect.gen(function* () {
          yield* ThemeService.importJson(
            JSON.stringify({ ...VALID_THEME, name: "Rich", semanticTokenColors: { newOperator: "#d33682" } })
          )
          return yield* ThemeService.get("rich")
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value?.semanticTokenColors).toEqual({ newOperator: "#d33682" })
    })

    /**
     * The realistic input is a theme copied out of a marketplace extension and
     * the realistic failure is one bad key in nine hundred, so the message has
     * to name the key.
     *
     * Effect's default `Error.message` leads with the full expected schema
     * signature — a 400-character type expression — so truncating it gave every
     * failure the identical prefix `(parseJson <-> { readonly name: string; …`.
     * A theme missing `type` and a theme with a numeric colour produced
     * byte-identical errors. Hence `ArrayFormatter`.
     */
    it("names the missing key rather than dumping the schema", async () => {
      const exit = await provided(ThemeService.importJson('{"name": "No Type"}'))
      const failure = failureOf(exit)
      expect(failure?._tag).toBe("ThemeError")
      expect(failure?.message).toContain("type")
      expect(failure?.message).toContain("missing")
      expect(failure?.message).not.toContain("parseJson")
    })

    it("names the offending path when a colour has the wrong type", async () => {
      const exit = await provided(
        ThemeService.importJson('{"name":"X","type":"dark","colors":{"editor.background":5}}')
      )
      expect(failureOf(exit)?.message).toContain("colors.editor.background")
    })

    /** A wall of issues is as unactionable as none — someone pasted a package.json. */
    it("caps how many issues it reports", async () => {
      const exit = await provided(
        ThemeService.importJson(JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }))
      )
      const failure = failureOf(exit)
      expect(failure?._tag).toBe("ThemeError")
      expect(failure?.message.length).toBeLessThanOrEqual(262)
    })

    it("rejects text that is not JSON at all", async () => {
      const exit = await provided(ThemeService.importJson("just some words"))
      expect(failureOf(exit)?._tag).toBe("ThemeError")
    })

    it("lets the caller rename on import", async () => {
      const exit = await provided(
        ThemeService.importJson(JSON.stringify(VALID_THEME), "Renamed On Import")
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.id).toBe("renamed-on-import")
      expect(exit.value.name).toBe("Renamed On Import")
    })
  })

  /**
   * Live reload against a REAL filesystem watcher, because that is the only
   * thing that proves the feature. A fake emitter would pass while `fs.watch`
   * silently never fires on the platform, which is precisely the failure worth
   * catching — the whole point of storing themes as files is that an operator
   * can edit one in their own editor and see it land.
   */
  describe("watch", () => {
    /**
     * `Stream.unwrap(Effect.map(ThemeService, …))`, NOT the generated accessor.
     *
     * An `Effect` is itself a `Stream` of one element, so `ThemeService.watch()`
     * — which the accessor turns into `Effect<Stream<ThemeCatalog>>` — type-checks
     * where a `Stream<ThemeCatalog>` is wanted and silently yields a stream whose
     * single element is the real stream. Every assertion then reads a property
     * off a Stream and gets `undefined`. This is the same shape `Review.watch`
     * uses in `main/rpc.ts`, for the same reason.
     */
    const firstCatalogAfter = (act: () => void) =>
      provided(
        Effect.gen(function* () {
          const stream = Stream.unwrap(Effect.map(ThemeService, (t) => t.watch())).pipe(
            Stream.take(1),
            Stream.runCollect
          )
          const fiber = yield* Effect.fork(stream)
          // Let the watcher attach before the change it is meant to notice.
          yield* Effect.sleep("150 millis")
          yield* Effect.sync(act)
          const chunks = yield* Fiber.join(fiber)
          return Chunk.toReadonlyArray(chunks)[0]
        }).pipe(Effect.timeout("5 seconds"))
      )

    it("re-emits the catalog when a theme file appears", async () => {
      const exit = await firstCatalogAfter(() => writeTheme("dropped-in", VALID_THEME))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value?.themes.some((t) => t.id === "dropped-in")).toBe(true)
    })

    it("re-emits when an existing theme is edited outside the app", async () => {
      writeTheme("mine", VALID_THEME)
      const exit = await firstCatalogAfter(() =>
        writeTheme("mine", { ...VALID_THEME, name: "Edited Elsewhere" })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value?.themes.find((t) => t.id === "mine")?.name).toBe("Edited Elsewhere")
    })

    /**
     * A half-written file must degrade to `skipped`, not to a thrown stream.
     * Editors write in stages, so this state is reached routinely mid-save —
     * a watcher that dies on it takes live reload with it after one keystroke.
     */
    it("reports a broken file as skipped instead of failing the stream", async () => {
      const exit = await firstCatalogAfter(() => {
        mkdirSync(themesDir(), { recursive: true })
        writeFileSync(join(themesDir(), "half-written.json"), '{"name": "Half')
      })
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value?.skipped.some((s) => s.path.includes("half-written"))).toBe(true)
    })

    /**
     * The directory does not exist until the first duplicate or import, and
     * that first write is exactly the moment live reload has to work — if the
     * watcher only attaches to a pre-existing directory, the operator's first
     * ever theme needs an app restart to show up.
     */
    it("does not require the themes directory to exist beforehand", async () => {
      const exit = await firstCatalogAfter(() => writeTheme("first-ever", VALID_THEME))
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value?.themes.some((t) => t.id === "first-ever")).toBe(true)
    })
  })
})
