// Shared message-type constants for the command-script <-> webview bridge.
// Kept as a plain CommonJS module so it can be required unchanged from both
// export-designs.js (skpm/babel) and ui.ts (webpack/ts-loader).
module.exports = {
  SAVE: 'SAVE',
  CANCEL: 'CANCEL',
  UPLOAD_COMPLETE: 'UPLOAD_COMPLETE',
  KEY_OR_URL_ERROR: 'KEY_OR_URL_ERROR',
  DESIGNS: 'DESIGNS',
  SETTINGS: 'SETTINGS',
  LOG: 'LOG',
  // Generic HTTP transport bridge: the webview's axios instance (used
  // internally by @applitools/eyes-images) has its `adapter` overridden (see
  // src/ui.ts) to send every request through here instead of the browser's
  // own fetch/XHR, because eyes.applitools.com's CORS allowlist rejects
  // requests from this webview regardless of origin. export-designs.js
  // performs the real fetch (native, not subject to CORS) and sends the raw
  // response back for axios to resolve normally.
  HTTP_REQUEST: 'HTTP_REQUEST',
  HTTP_RESPONSE: 'HTTP_RESPONSE',
}
