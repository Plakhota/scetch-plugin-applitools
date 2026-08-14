# applitools-sketch-plugin

Sketch plugin that exports selected artboards (or all top-level frames) as
PNGs at one or more responsive widths and uploads them to Applitools Eyes as
visual tests, using `@applitools/eyes-images`. Built to match the existing
[Applitools Figma plugin](https://github.com/applitools/figma-plugin-applitools)
feature-for-feature — see [FDE-11](https://applitools.atlassian.net/browse/FDE-11).

An earlier, abandoned attempt exists at
[bmurmistro/applitools-plugin-for-sketch](https://github.com/bmurmistro/applitools-plugin-for-sketch)
(targets Sketch ≥49, no webview, never finished wiring up the Eyes SDK calls).
This plugin is a from-scratch rebuild against Sketch's current plugin API, not
a port of that code.

## How it works

- **`src/export-designs.js`** runs in Sketch's own plugin script context.
  It reads the current selection (or all top-level frames if nothing is
  selected), exports each as a PNG via `sketch.export()` at the frame's native
  width plus any additional widths you configure, and opens a settings
  window.
- **`src/ui.ts` / `src/ui.html`** run inside that settings window, which is a
  real WebView (via [`sketch-module-web-view`](https://github.com/BohemianCoding/sketch-module-web-view)),
  and do all of the actual `@applitools/eyes-images` SDK/network work — API
  key, server URL, match level, accessibility validation, proxy, baseline
  overrides, etc. This mirrors the Figma plugin's split (sandboxed
  export/selection logic vs. an iframe with network access) since Sketch's
  main script context lacks the Node built-ins (`Buffer`, `crypto`, `zlib`,
  `http(s)`) the Eyes SDK needs, while the WebView is a full WebKit page where
  the same polyfill setup the Figma plugin already uses works unmodified.
- Exported PNG bytes cross the plugin-script ↔ webview bridge base64-encoded
  (Sketch's bridge only carries JSON-safe values, unlike Figma's
  structured-clone `postMessage`).

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
