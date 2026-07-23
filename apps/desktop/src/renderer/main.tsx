import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { THEME_STYLE_ID } from "@starbase/core"
import "./index.css"
import { App } from "./App.js"
import { queryClient } from "./query-client.js"

/**
 * Paint the operator's theme before React exists.
 *
 * `window.starbase.initialThemeCss` was fetched synchronously by the preload,
 * so it is already here — no await, no round trip, nothing for the browser to
 * paint around. Injected before `createRoot` because everything after that
 * point is at least one frame too late: React would mount, `ThemeProvider`
 * would run its layout effect, and in between the document would have painted
 * once from the One Dark fallback in `globals.css`. On a light theme that is a
 * full dark flash, on every launch.
 *
 * `ThemeProvider` then adopts this same element by id and takes over. Because
 * both sides generate the text from `CSS_VAR_BY_TOKEN`, the handover produces
 * byte-identical CSS and is invisible.
 */
const bootThemeCss = window.starbase?.initialThemeCss
if (bootThemeCss) {
  const style = document.createElement("style")
  style.id = THEME_STYLE_ID
  style.textContent = bootThemeCss
  document.head.appendChild(style)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
