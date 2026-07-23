---
"@starbase/desktop": minor
---

VS Code-compatible colour themes.

Nine themes ship built in — One Dark Pro (the default), Dark Modern, Light
Modern, Monokai, Abyss, Tomorrow Night Blue, Solarized Dark, Solarized Light and
High Contrast Dark. Pick one in Settings › Themes, where every entry previews
itself in its own colours rather than just naming itself.

Bring your own: any VS Code theme JSON works. Paste one from a marketplace
extension into the import box, or drop a file into `~/starbase/themes/`. Edit
that file in your own editor and the app repaints as you save. Keys Starbase does
not use are preserved, so the file stays usable in VS Code.

Duplicate any theme to get an editable copy with a colour picker for the values
that carry a theme's character — surfaces, the text ramp, the accent ramp.

The whole app follows the theme, including the terminal and diff syntax
highlighting, and it is painted correctly on the very first frame rather than
flashing dark before catching up. Choosing One Dark Pro is pixel-identical to
how the app looked before.
