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
}
