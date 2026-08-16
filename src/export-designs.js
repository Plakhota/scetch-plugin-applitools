import sketch from 'sketch'
import { createFiber } from 'sketch/async'
import path from 'path'
import BrowserWindow from 'sketch-module-web-view'
import Messages from './bridge/messages'

const WEBVIEW_IDENTIFIER = 'applitools.export-designs.webview'
const API_KEY_SETTING = 'applitoolsApiKey'
const SERVER_URL_SETTING = 'serverUrl'
const DEFAULT_SERVER_URL = 'https://eyes.applitools.com'

// NOTE: `fs` is NOT available in this Sketch version's plugin script context
// ("fs is not a core package" — a native Obj-C exception, uncatchable by JS
// try/catch, confirmed via a real run), despite Sketch's own docs listing it
// as preinstalled. Do not require('fs')/require('os') here again — it will
// crash the whole command, not just this feature.
//
// Instead, relay everything through console.log, which Sketch does support
// and which skpm-build already routes to `npx skpm log -f`. To capture a
// persistent log file, redirect that stream yourself:
//   npx skpm log -f > dump.log 2>&1
function appendLog(line) {
  console.log(line)
}

// Sketch tears down this script's JS context as soon as onExportDesigns()
// returns, so a fiber is required to keep it alive while the user fills in
// the webview form and clicks Export/Cancel (both fire asynchronously,
// arbitrarily long after this function has already returned), and while any
// in-flight HTTP_REQUEST bridge calls (see performHttpRequest() below) are
// still pending.
export function onExportDesigns(context) {
  const fiber = createFiber()
  const document = sketch.getSelectedDocument()
  const page = document.selectedPage

  // sketch-module-web-view tracks open windows by identifier (in
  // NSThread.mainThread().threadDictionary()) and reuses an existing one for
  // the same identifier — but if a previous window was torn down abnormally
  // (e.g. the plugin crashed mid-run) rather than via its normal close path,
  // that registry can end up out of sync with the real WebKit-level state:
  // the tracked panel reference is gone, so a brand-new WKWebView gets
  // created, but the OS-level script message handler ('__skpm_sketchBridge')
  // from the orphaned old one is still registered, and WKUserContentController
  // throws rather than allowing a duplicate. This is native Cocoa/WebKit
  // process state, not something our JS can clean up — the fix is quitting
  // and relaunching Sketch. Catch it here so the user gets a clear,
  // guaranteed-visible message instead of a silent crash with no window.
  let browserWindow
  try {
    browserWindow = new BrowserWindow({
      identifier: WEBVIEW_IDENTIFIER,
      width: 520,
      height: 760,
      show: true,
      title: 'Applitools',
      resizable: true,
    })
  } catch (e) {
    sketch.UI.message(
      'Applitools: a previous plugin window is stuck. Please fully quit and reopen Sketch, then try again.'
    )
    fiber.cleanup()
    return
  }

  const webContents = browserWindow.webContents

  function send(payload) {
    webContents.executeJavaScript(
      `window.receiveFromPlugin(${JSON.stringify(payload)})`
    )
  }

  webContents.on('did-finish-load', () => {
    send({
      type: Messages.SETTINGS,
      applitoolsApiKey: sketch.Settings.settingForKey(API_KEY_SETTING) || '',
      serverUrl: sketch.Settings.settingForKey(SERVER_URL_SETTING) || DEFAULT_SERVER_URL,
    })
  })

  // browserWindow.close() (used by both the native red traffic-light button
  // and, previously, our own Cancel handler) round-trips through the native
  // windowShouldClose: delegate (sketch-module-web-view's set-delegates.js)
  // before actually closing — confirmed via a real repro that this can get
  // stuck (window never closes, via either path) specifically after the
  // underlying Sketch document window has already been closed while this
  // panel was still open. Intercept every close attempt and redirect to
  // destroy(), which calls NSWindow's close() directly, skipping that
  // round-trip entirely. We don't need the cancelable-close semantics this
  // hook normally exists for (e.g. "unsaved changes" warnings), so it's safe
  // to always take the more forceful path here, regardless of how the close
  // was triggered.
  browserWindow.on('close', (event) => {
    event.preventDefault()
    browserWindow.destroy()
  })

  webContents.on(Messages.CANCEL, () => {
    appendLog('[bridge] CANCEL received — destroying browserWindow')
    browserWindow.destroy()
  })

  webContents.on(Messages.SAVE, (payload) => {
    const { everything, applitoolsApiKey, serverUrl, arrWidths } = payload || {}

    if (!applitoolsApiKey || !serverUrl) {
      send({ type: Messages.KEY_OR_URL_ERROR })
      return
    }

    sketch.Settings.setSettingForKey(API_KEY_SETTING, applitoolsApiKey)
    sketch.Settings.setSettingForKey(SERVER_URL_SETTING, serverUrl)

    sketch.UI.message('Getting Designs…')

    const { results, dupResults } = collectDesigns(document, page, everything, arrWidths)

    if (dupResults.designs.length > 0) {
      sketch.UI.message(
        `Skipped ${dupResults.designs.length} duplicate frame(s) — names must be unique per resolution.`
      )
    }

    sketch.UI.message('Uploading Designs to Applitools…')
    send({ type: Messages.DESIGNS, results, dupResults })
  })

  webContents.on(Messages.UPLOAD_COMPLETE, () => {
    sketch.UI.message('Upload Complete!')
  })

  // Relayed from the webview's console.log shim (src/ui.html) — this is how
  // both our own upload-flow logs and the Eyes SDK's own verbose
  // ConsoleLogHandler output (APPLITOOLS_SHOW_LOGS=true) end up in
  // `npx skpm log -f` (redirect that to a file yourself if you want a
  // persistent log — see README).
  webContents.on(Messages.LOG, (payload) => {
    appendLog((payload && payload.message) || '')
  })

  // See the file-level comment above performHttpRequest() for why this
  // exists: the webview's axios adapter (src/ui.ts) forwards every request
  // the Eyes SDK makes to here instead of using the browser's own fetch/XHR.
  webContents.on(Messages.HTTP_REQUEST, (payload) => {
    performHttpRequest(payload || {}).then((response) => {
      send({ type: Messages.HTTP_RESPONSE, ...response })
    })
  })

  browserWindow.once('closed', () => {
    fiber.cleanup()
  })

  browserWindow.loadURL('ui.html')
}

function getProjectName(document) {
  if (document && document.path) {
    // document.path can come back as a percent-encoded file:// style string
    // (e.g. "Welcome%20to%20Sketch.sketchcloud" for a Sketch Cloud/example
    // document) rather than a plain filesystem path — decode first, then
    // strip whatever extension is actually present instead of assuming ".sketch".
    let decoded = document.path
    try {
      decoded = decodeURIComponent(decoded)
    } catch (e) {
      // not percent-encoded; use as-is
    }
    const base = path.basename(decoded)
    const ext = path.extname(base)
    return ext ? base.slice(0, -ext.length) : base
  }
  return 'Untitled'
}

// A top-level layer counts as an exportable "frame" if it's a legacy Artboard
// (Sketch keeps this populated for top-level containers even after the
// 2025.1 Artboard -> Frame/Graphic rename), a current-day Frame, or shows up
// in the page's current canvas-level frame list.
const FRAME_TYPES = ['Artboard', 'Frame']

function isCanvasLevelFrame(layer, page) {
  if (!layer) return false
  if (FRAME_TYPES.includes(layer.type)) return true
  if (page && Array.isArray(page.canvasLevelFrames)) {
    return page.canvasLevelFrames.some((frame) => frame.id === layer.id)
  }
  return false
}

function collectDesigns(document, page, everything, arrWidths) {
  const projectName = getProjectName(document)
  const results = { project: projectName, designs: [] }
  const dupResults = { project: projectName, designs: [] }

  const selected = page.selectedLayers && page.selectedLayers.layers
  const usingSelection = Boolean(selected && selected.length > 0)
  const nodes = usingSelection ? selected : page.layers

  // Surfaced both via skpm log (main-script console) and echoed back to the
  // webview's on-page console, since "nothing got uploaded" is otherwise
  // silent — if layer.type here doesn't match FRAME_TYPES for your Sketch
  // version, that's exactly why 0 designs get collected.
  const scanSummary = nodes.map((layer) => `${layer.name} (${layer.type})`).join(', ') || '(none)'
  appendLog(
    `Scanning ${nodes.length} ${usingSelection ? 'selected' : 'top-level'} layer(s): ${scanSummary}`
  )
  sketch.UI.message(`Scanning ${nodes.length} layer(s)…`)

  for (const layer of nodes) {
    if (everything || isCanvasLevelFrame(layer, page)) {
      exportLayer(layer, results, dupResults, arrWidths)
    }
  }

  results.scanSummary = scanSummary
  return { results, dupResults }
}

function exportLayer(layer, results, dupResults, arrWidths) {
  const { id, name } = layer
  const width = Math.round(layer.frame.width)
  const height = Math.round(layer.frame.height)

  const found = results.designs.some(
    (design) => design.name === name && design.width === width && design.height === height
  )

  if (found) {
    dupResults.designs.push({ id, name, width, height })
    return
  }

  const viewportArr = [{ width, height }]
  if (arrWidths && arrWidths.length > 0) {
    for (const extraWidth of arrWidths) {
      if (!extraWidth) continue
      const calculatedHeight = Math.round(extraWidth * (height / width))
      viewportArr.push({ width: extraWidth, height: calculatedHeight })
    }
  }

  for (const viewport of viewportArr) {
    // NOTE: unverified against a real Sketch runtime — output:false is
    // documented to return export bytes in memory (no disk write), but the
    // exact return type (Node Buffer vs Uint8Array vs NSData wrapper) isn't
    // confirmed here. toBase64() below is defensive; re-check this the first
    // time this actually runs inside Sketch.
    const exported = sketch.export(layer, {
      formats: 'png',
      output: false,
      size: `${viewport.width}w`,
    })

    results.designs.push({
      id,
      name,
      width: viewport.width,
      height: viewport.height,
      bytesBase64: toBase64(exported),
    })
  }
}

function toBase64(data) {
  if (typeof data === 'string') {
    return data
  }
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    return Buffer.from(data).toString('base64')
  }
  let binary = ''
  const bytes = new Uint8Array(data)
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// Generic HTTP transport bridge for the webview's axios instance.
//
// The Eyes SDK (@applitools/eyes-images) runs entirely, unmodified, in the
// webview (src/ui.ts) — real Eyes/Configuration/Target objects, real
// eyes.open()/check()/close() calls. The one problem: eyes.applitools.com
// enforces a strict CORS origin allowlist that no page loaded in this
// webview can ever satisfy (confirmed live: even a completely ordinary
// origin like https://example.com was rejected by the real
// /api/sessions/renderinfo endpoint from a normal Safari tab — this isn't a
// "local page" quirk, it's a real allowlist).
//
// Rather than reimplementing the SDK's wire protocol, ui.ts overrides
// axios's `adapter` (a documented, public extension point — see
// bridgeAdapter() there) so every HTTP call the SDK makes is handed off to
// here instead of the browser's own fetch/XHR. This context is Sketch's
// native plugin-script environment, not a browser, so it isn't subject to
// CORS at all: `fetch` here is provided by sketch-polyfill-fetch (via
// @skpm/builder, auto-injected for plugin-command bundles), backed by real
// NSURLSession. All of the SDK's own request/response interceptor logic
// (headers, retries, the 202+Location long-running-task polling) keeps
// running unmodified inside axios in the webview — this function only ever
// needs to perform one request and hand back the raw response.
// ---------------------------------------------------------------------------

async function performHttpRequest({ id, method, url, headers, data, isBinary }) {
  try {
    const body = isBinary ? Buffer.from(data, 'base64') : data
    const options = { method, headers: headers || {} }
    if (body !== undefined && body !== null && body !== '' && method !== 'GET' && method !== 'HEAD') {
      options.body = body
    }

    const response = await fetch(url, options)

    let text = ''
    try {
      text = await response.text()
    } catch (e) {
      // sketch-polyfill-fetch's text() rejects with "Couldn't parse body"
      // for ANY empty response body — it can't distinguish a genuinely
      // empty (but valid) body from a decode failure. Treat that as "no
      // body", not fatal; response.status/ok are still accurate.
      text = ''
    }

    const responseHeaders = {}
    response.headers.entries().forEach(([key, value]) => {
      responseHeaders[key] = value
    })

    return {
      id,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data: text,
    }
  } catch (error) {
    return { id, error: error.message }
  }
}
