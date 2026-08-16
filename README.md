# applitools-sketch-plugin

A Sketch plugin that exports selected artboards (or all top-level frames) as
PNGs at one or more responsive widths and uploads them to Applitools Eyes as
visual tests. Built to match the existing
[Applitools Figma plugin](https://github.com/applitools/figma-plugin-applitools)
feature-for-feature — see [FDE-11](https://applitools.atlassian.net/browse/FDE-11).

Menu: **Plugins → Applitools → Export Designs**.

## How it works

- `src/export-designs.js` runs in Sketch's native plugin script context. It
  reads the current selection (or all top-level Artboards/Frames if nothing
  is selected), exports each as a PNG at its native width plus any additional
  widths you configure, and opens a settings window.
- `src/ui.ts` / `src/ui.html` run inside that settings window (a real WebView
  via [`sketch-module-web-view`](https://github.com/BohemianCoding/sketch-module-web-view))
  and do the actual `@applitools/eyes-images` SDK work — `Configuration`,
  `Eyes`, `Target`, `eyes.open()`/`check()`/`close()`.
- Since `eyes.applitools.com` rejects requests from a Sketch webview's origin
  (a CORS restriction), the SDK's outgoing HTTP calls are routed through
  `export-designs.js` via a custom axios adapter (`bridgeAdapter()` in
  `ui.ts`, `performHttpRequest()` in `export-designs.js`), which performs the
  real network call from the native script context instead.

## Build

```
npm install
npm run build   # builds resources/ui.html, then the .sketchplugin bundle
```

`npm install`'s `postinstall` hook runs the build and `skpm-link`, which
symlinks the built plugin into Sketch's Plugins folder
(`~/Library/Application Support/com.bohemiancoding.sketch3/Plugins/`) so it's
available in Sketch immediately.

- macOS only (Sketch has no Windows/Linux build).
- A free 30-day Sketch trial gives full plugin API access — no paid license
  needed for development.
- No Sketch developer account or approval process is needed to build/side-load
  a plugin locally.

### Dev loop

- `npm run watch:ui` — rebuild `resources/ui.html` on save (settings form /
  Eyes SDK calls in `src/ui.ts`).
- `npm run watch` — rebuild `export-designs.js` on save (skpm's watcher).
- Re-run **Applitools → Export Designs** in Sketch after each change to test.
- Debug the main script via `npx skpm log -f` in a terminal.
- Debug the webview directly through Safari's Develop menu (attach to the
  running WKWebView for real Web Inspector access).

## Distributing to end users

To hand the built plugin to someone without them needing this repo or
Node.js at all, see [`artifacts/INSTALL.md`](artifacts/INSTALL.md).

## Backlog

See [`TODO.md`](TODO.md) for deferred/known-incomplete items.
