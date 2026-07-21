import type { Meta, StoryObj } from "@storybook/react-vite"
import { LookFor } from "../story-support.js"
import { ReviewDiff } from "../composites/review-diff.js"
import { DiffView } from "./diff-view.js"

const meta: Meta = { title: "Diff/Syntax Highlighting", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

/**
 * Deliberately dense: a keyword, a type annotation, a template literal, a
 * string, a comment, a number and a JSX tag all inside changed lines. If the
 * add/remove treatment were still a flat text colour, every one of these would
 * be the same green.
 */
const TS_DIFF = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "index 111..222 100644",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -28,12 +28,20 @@ export function session()",
  " import { Effect } from \"effect\"",
  " ",
  " export interface Session {",
  "-  readonly token: string",
  "+  readonly token: string | null",
  "+  /** Epoch millis; null while the token has never been minted. */",
  "+  readonly expiresAt: number | null",
  " }",
  " ",
  "-export const refresh = (s: Session) => mint(s)",
  "+export const refresh = (s: Session) =>",
  "+  Effect.gen(function* () {",
  "+    const next = yield* mint(s)",
  "+    yield* store.set(`token:${s.id}`, next)",
  "+    return { ...s, token: next, expiresAt: Date.now() + 3_600_000 }",
  "+  })",
  " ",
  " export const isExpired = (s: Session): boolean =>",
  "-  s.expiresAt < Date.now()",
  "+  s.expiresAt === null || s.expiresAt < Date.now()",
  ""
].join("\n")

const CSS_DIFF = [
  "diff --git a/src/globals.css b/src/globals.css",
  "index 333..444 100644",
  "--- a/src/globals.css",
  "+++ b/src/globals.css",
  "@@ -14,6 +14,11 @@",
  "   --sb-canvas: #16181d;",
  "-  --sb-panel: #21252b;",
  "+  --sb-panel: #21252b;",
  "+  --sb-hairline: rgba(255, 255, 255, 0.06);",
  "+}",
  "+",
  "+.sb-no-scrollbar {",
  "+  scrollbar-width: none;",
  " }",
  ""
].join("\n")

const JSON_DIFF = [
  "diff --git a/package.json b/package.json",
  "index 555..666 100644",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -8,6 +8,7 @@",
  '   "dependencies": {',
  '     "react": "^19.2.7",',
  '-    "motion": "^12.0.0"',
  '+    "motion": "^12.0.0",',
  '+    "shiki": "^4.3.1"',
  "   }",
  ""
].join("\n")

/**
 * The Code Review diff — the one you spend review time in.
 *
 * Before this, `text-green` / `text-red` were applied to the whole line, so the
 * background wash and the syntax colour were fighting over one channel and the
 * background won. Now the wash carries add/remove and the text carries meaning.
 */
export const ReviewDiffHighlighted: Story = {
  render: () => (
    <div className="min-h-screen bg-editor">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> added lines still green-washed, but{" "}
        <code>export</code>/<code>const</code> purple, strings green, types yellow, comments grey and
        numbers orange — inside the wash. Only the leading <code>+</code>/<code>−</code> sign is
        tinted. The <code>`token:${"{s.id}"}`</code> template literal should read as a string across
        its interpolation.
      </LookFor>
      <div className="p-6">
        <ReviewDiff
          path="src/auth/session.ts"
          diff={TS_DIFF}
          connected
          onAddDraft={() => {}}
          scroll={false}
        />
      </div>
    </div>
  )
}

/**
 * The Changes tab's virtualized renderer, over a changeset touching three
 * languages.
 *
 * The language is a property of the FILE, so this runs one grammar per file
 * rather than one for the changeset — handing the CSS to the TypeScript grammar
 * would produce confident nonsense.
 */
export const MultiLanguageChangeset: Story = {
  render: () => (
    <div className="h-screen bg-editor">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> TypeScript, CSS and JSON each
        highlighted by their own grammar. CSS custom properties and hex colours should not be
        coloured like TypeScript identifiers. Scroll — highlighting must survive virtualization
        rather than re-flashing as rows recycle.
      </LookFor>
      <div className="h-[calc(100vh-80px)]">
        <DiffView patch={`${TS_DIFF}\n${CSS_DIFF}\n${JSON_DIFF}`} />
      </div>
    </div>
  )
}

/**
 * A file whose language we don't bundle.
 *
 * The fallback is the pre-existing behaviour — plain text on a wash — and it has
 * to be exactly that, because it is also what every diff looks like for the
 * moment before its grammar finishes loading.
 */
export const UnknownLanguageFallback: Story = {
  render: () => (
    <div className="min-h-screen bg-editor">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> no highlighting and no error — just
        readable text on the add/remove wash, with the <code>+</code>/<code>−</code> signs still
        tinted. This is also the async window every highlighted diff passes through.
      </LookFor>
      <div className="p-6">
        <ReviewDiff
          path="vendor/legacy.zig"
          diff={TS_DIFF.replace("src/auth/session.ts", "vendor/legacy.zig")}
          connected
          onAddDraft={() => {}}
          scroll={false}
        />
      </div>
    </div>
  )
}
