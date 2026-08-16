# applitools-sketch-plugin

Sketch plugin that exports selected artboards (or all top-level frames) as
PNGs at one or more responsive widths and uploads them to Applitools Eyes as
visual tests. Built to match the existing
[Applitools Figma plugin](https://github.com/applitools/figma-plugin-applitools)
feature-for-feature — see [FDE-11](https://applitools.atlassian.net/browse/FDE-11).

An earlier, abandoned attempt exists at
[bmurmistro/applitools-plugin-for-sketch](https://github.com/bmurmistro/applitools-plugin-for-sketch)
(targets Sketch ≥49, no webview, never finished wiring up the Eyes SDK calls).
This plugin is a from-scratch rebuild against Sketch's current plugin API, not
a port of that code.

## How it works

- **`src/export-designs.js`** runs in Sketch's own native plugin script
  context. It reads the current selection (or all top-level frames if nothing
  is selected), exports each as a PNG via `sketch.export()` at the frame's
  native width plus any additional widths you configure, and opens a
  settings window.
- **`src/ui.ts` / `src/ui.html`** run inside that settings window, which is a
  real WebView (via [`sketch-module-web-view`](https://github.com/BohemianCoding/sketch-module-web-view)),
  and do all of the actual `@applitools/eyes-images` SDK work — `Configuration`,
  `Eyes`, `Target`, real `eyes.open()`/`eyes.check()`/`eyes.close()` calls —
  exactly the way the Figma plugin's iframe does. See below for the one
  difference from that plugin: how its outgoing HTTP requests actually reach
  `eyes.applitools.com`.
- Exported PNG bytes cross the plugin-script ↔ webview bridge base64-encoded
  (Sketch's bridge only carries JSON-safe values, unlike Figma's
  structured-clone `postMessage`).

### Why the SDK's network calls are routed through the plugin script

The obvious design — mirroring the Figma plugin exactly — would have the
settings webview's `@applitools/eyes-images` calls hit `eyes.applitools.com`
directly, the same way Figma's iframe does. That doesn't work as-is:
`eyes.applitools.com` enforces a strict CORS origin allowlist, and a Sketch
webview's origin (the default `file://`, or a spoofed HTTPS origin — both
were tried) is never on it. Confirmed live, from a real Safari console: a
request to the actual `/api/sessions/renderinfo` endpoint was rejected even
from a completely ordinary origin like `https://example.com` — this isn't a
"reject unknown local pages" quirk, it's a real allowlist, so no origin
string the plugin picks for itself will ever get through.

Rather than reimplementing the SDK's wire protocol elsewhere (a first attempt
at that — hand-rolling the `/api/sessions/*` calls directly in
`export-designs.js` — worked partially but is a much larger surface to keep
correct, and this project's whole point is to use the real SDK), the fix is
narrower: **axios** (which `@applitools/eyes-sdk-core`'s `ServerConnector` is
built on) supports a pluggable `adapter` — a documented, public extension
point. `src/ui.ts` sets `axios.defaults.adapter` to `bridgeAdapter()`, which
hands every outgoing request off to `export-designs.js` over the existing
plugin↔webview message bridge instead of using the browser's own fetch/XHR.
`export-designs.js`'s `performHttpRequest()` then performs the *actual*
network call via `fetch` (provided by
[`sketch-polyfill-fetch`](https://github.com/skpm/sketch-polyfill-fetch),
backed by native `NSURLSession`, via `@skpm/builder`'s plugin-command
bundling) — Sketch's native plugin-script context isn't a browser and isn't
subject to CORS at all — and sends the raw response back to resolve/reject
the same axios request via `settle()`/`createError()`, exactly like axios's
own `xhr.js` adapter would.

The payoff: the SDK itself — `Eyes`, `Configuration`, `Target`,
`eyes.open()`/`check()`/`close()`, and all of its own request/response
interceptor logic (headers, retries, the `202 + Location` long-running-task
protocol) — runs completely unmodified inside the webview. Only the lowest
transport layer is swapped out. One casualty: **`eyes.setProxy()` has no
effect**, since that configures axios's Node-level proxy agent, which the
bridge adapter bypasses entirely — `fetch`/`NSURLSession` has no equivalent
hook for it.

Because the JavaScriptCore engine behind Sketch's WKWebView doesn't honor
V8's `Error.captureStackTrace` hook the way `eyes-sdk-core`'s logger assumes,
a `patch-package` patch (`patches/@applitools+eyes-sdk-core+*.patch`) guards
that one call site — confirmed via a real crash trace during development,
not a guess.

## Setup

```
npm install
npm run build   # builds resources/ui.html, then the .sketchplugin bundle
```

`npm install`'s `postinstall` hook runs the build and `skpm-link`, which
symlinks the built plugin into Sketch's plugins folder
(`~/Library/Application Support/com.bohemiancoding.sketch3/Plugins/`) so it
shows up in Sketch immediately.

- macOS only (Sketch has no Windows/Linux build).
- No paid Sketch license is required for development — a free 30-day trial
  gives full plugin API access.
- No Sketch developer account or approval process is needed to build/side-load
  a plugin locally.

### Dev loop

- `npm run watch:ui` — rebuild `resources/ui.html` on save while iterating on
  the settings form / Eyes SDK calls.
- `npm run watch` — rebuild `export-designs.js` on save (skpm's watcher).
- Re-run "Applitools → Export Designs" in Sketch after each change to test.
- Debug the main script via `skpm log -f` in a terminal.
- Debug the webview directly through Safari's Develop menu (attach to the
  running WKWebView) — this is real Web Inspector access, unlike Figma's
  console-in-a-textarea workaround (which we kept in `ui.html` anyway since it
  was already there and costs nothing).

## Known gaps / unverified assumptions

This was built and statically compiled without a Sketch install available in
the dev environment that wrote it, so the following need hands-on
verification the first time this actually runs inside Sketch:

- **The `bridgeAdapter()`/`performHttpRequest()` axios transport bridge**
  (`src/ui.ts` and `src/export-designs.js`). This is the one piece that isn't
  just "the Figma plugin's code, ported" — axios's `adapter` extension point
  and `settle()`/`createError()` helpers are used per their documented
  contract, but this exact combination (SDK running in a WKWebView, actual
  I/O happening one bridge-hop away in a native script context) hasn't been
  exercised end-to-end outside this project. If uploads still fail, check
  both `npx skpm log -f` (for `[http]`-prefixed native fetch activity) and
  the webview's own console (for axios/SDK-level errors) to see which side
  of the bridge the problem is on.
- **`sketch-polyfill-fetch`'s empty-body handling.** Its `response.text()`
  rejects with `"Couldn't parse body"` for ANY empty response body (it can't
  tell a genuinely empty-but-valid body from a decode failure) —
  `performHttpRequest()` treats that specific rejection as "no body," not
  fatal, so a 2xx-with-empty-body response is still reported to axios
  correctly. Worth knowing if you see that string anywhere unexpected.
- **`sketch.export(layer, { output: false, size: '${w}w' })`'s return type**
  (`src/export-designs.js`'s `toBase64()`). Documented to return export bytes
  in memory, but whether that's a real Node `Buffer`, a `Uint8Array`, or
  something else isn't confirmed — `toBase64()` is defensive but may need
  adjusting.
- **The `sketch-module-web-view` bridge shapes** — `webContents.on(channel, handler)` /
  `window.postMessage(channel, payload)` — are per that package's documented
  API but not exercised against a running Sketch instance here.
- **Artboard/Frame selection filtering** (`isCanvasLevelFrame` in
  `export-designs.js`) checks both the legacy `Artboard` type and
  `page.canvasLevelFrames` to work across the Sketch 2025.1 "Athens"
  Artboard→Frame rename, but only one of those paths has been exercised in
  practice.
- Figma's `contentsOnly: false` export flag (uncropped-overflow export) has no
  confirmed Sketch equivalent and was dropped — see the plan notes for FDE-11
  if this turns out to matter.

## Repo layout

- `reference-archive/` — the Figma plugin, cloned for reference (gitignored).
- `old-sketch-plugin/` — the abandoned bmurmistro attempt, cloned for
  reference (gitignored).
