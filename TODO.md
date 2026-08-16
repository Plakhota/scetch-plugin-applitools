# Backlog

Deferred items — not yet implemented, kept here for reference.

## Verify the `'Frame'` type path in `isCanvasLevelFrame()`

`src/export-designs.js`'s `FRAME_TYPES = ['Artboard', 'Frame']` was written to
handle both the legacy Artboard type and Sketch 2025.1's ("Athens")
Artboard→Frame rename. Every real test run so far has only exercised the
`'Artboard'` branch — the `'Frame'` branch has never actually been hit
against a real document that uses the new naming. Confirm this works (or
find out what the real top-level layer type is) the next time this runs
against a newer Sketch document/version.

## `eyes.setProxy()` is currently a no-op

Since the CORS fix moved actual network I/O to `export-designs.js`'s
`bridgeAdapter()`/`performHttpRequest()` (native `fetch`, not axios), calling
`eyes.setProxy(url)` in `src/ui.ts` no longer has any effect — it configures
axios's Node-level proxy agent, which the bridge bypasses entirely. If real
proxy support is needed, `performHttpRequest()` would need its own proxy
handling (Sketch/NSURLSession-level), which hasn't been investigated yet.

## Keep the plugin window always on top

`sketch-module-web-view`'s `BrowserWindow` constructor supports an
`alwaysOnTop: true` option (confirmed in
`node_modules/sketch-module-web-view/lib/index.js:154-156`, backed by
`setAlwaysOnTop()` in `browser-api.js:348`) — a one-line addition to the
`new BrowserWindow({...})` call in `src/export-designs.js` when this is
prioritized.

## Add `baselineEnvName` as a custom property on the Eyes test

For better visibility in the Applitools dashboard (beyond just being baked
into the baseline environment name string). `@applitools/eyes-sdk-core`'s
`Configuration` class already supports this —
`node_modules/@applitools/eyes-sdk-core/lib/config/Configuration.js:584`:
`addProperty(propertyName, propertyValue)` (there's also a bulk
`setProperties(...)`). These become part of `SessionStartInfo.properties`
sent to the server, so it's a first-class, supported field — just needs
wiring up: `config.addProperty('baselineEnvName', baselineEnvName)` near
where `eyes.setBaselineEnvName(baselineEnvName)` is already called in
`src/ui.ts`'s `upload()`.
