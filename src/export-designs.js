import sketch from 'sketch'
import { createFiber } from 'sketch/async'
import path from 'path'
import BrowserWindow from 'sketch-module-web-view'
import Messages from './bridge/messages'

const WEBVIEW_IDENTIFIER = 'applitools.export-designs.webview'
const API_KEY_SETTING = 'applitoolsApiKey'
const SERVER_URL_SETTING = 'serverUrl'
const DEFAULT_SERVER_URL = 'https://eyes.applitools.com'

// Sketch tears down this script's JS context as soon as onExportDesigns()
// returns, so a fiber is required to keep it alive while the user fills in
// the webview form and clicks Export/Cancel (both fire asynchronously,
// arbitrarily long after this function has already returned).
export function onExportDesigns(context) {
  const fiber = createFiber()
  const document = sketch.getSelectedDocument()
  const page = document.selectedPage

  const browserWindow = new BrowserWindow({
    identifier: WEBVIEW_IDENTIFIER,
    width: 520,
    height: 760,
    show: true,
    title: 'Applitools',
    resizable: true,
  })

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

  webContents.on(Messages.CANCEL, () => {
    browserWindow.close()
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

  browserWindow.once('closed', () => {
    fiber.cleanup()
  })

  // Sketch's plugin script context has no Node __dirname/module system, so
  // resource paths inside the .sketchplugin bundle have to be resolved via
  // Sketch's own API: context.plugin.urlForResourceNamed() looks up a file
  // in Contents/Resources/ (where skpm-build copies resources/ui.html per
  // the "skpm.assets" glob in package.json) and hands back a usable file URL.
  const uiURL = context.plugin.urlForResourceNamed('ui.html').absoluteString()
  browserWindow.loadURL(uiURL)
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
  console.log(
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
