# Installing the Applitools Sketch Plugin

This folder contains everything you need — you do **not** need this project's
source code, `node_modules`, or Node.js installed to use the plugin.

## Requirements

- macOS
- Sketch, version 97 or later

## Install

1. Unzip `applitools-sketch-plugin.zip` if you haven't already — you should
   end up with a folder named `applitools.sketchplugin`.
2. Double-click `applitools.sketchplugin`.
3. Sketch will show a prompt: **"Do you want to install the plugin
   'Applitools'?"** — click **Install**.

That's it. If Sketch was already open, no restart is needed — the plugin is
available immediately.

### Alternative install methods

- **Drag and drop**: drag `applitools.sketchplugin` onto the Sketch app icon
  (in the Dock or Applications folder).
- **Manual copy**: copy the `applitools.sketchplugin` folder into
  `~/Library/Application Support/com.bohemiancoding.sketch3/Plugins/`, then
  restart Sketch.

## Using the plugin

1. Open a Sketch document.
2. Select one or more Artboards you want to visually test — or select
   nothing to export every top-level Artboard/Frame on the current page.
3. Menu bar → **Plugins → Applitools → Export Designs**.
4. In the panel that opens:
   - Enter your **Applitools API Key**.
   - **Eyes Server URL** defaults to `https://eyes.applitools.com` (the
     public Applitools server) — change this if you're using a private/
     self-hosted Eyes server.
   - Optionally expand **Additional Settings** for match level, accessibility
     validation, baseline/environment overrides, additional responsive
     widths, etc.
5. Click **Export**. Progress and results (including a link to the
   Applitools batch/test results) appear in the panel.

Your API key and server URL are remembered between runs (stored via Sketch's
own settings storage), so you only need to enter them once.

## Uninstalling

Delete the plugin folder from Sketch's Plugins directory:

```
rm -rf ~/Library/Application\ Support/com.bohemiancoding.sketch3/Plugins/Applitools
```

Or, in Sketch: **Sketch → Preferences → Plugins**, find "Applitools" in the
list, and remove it from there if that view is available in your Sketch
version.

## Troubleshooting

- **Plugin doesn't appear in the Plugins menu**: fully quit and reopen
  Sketch — it only scans for new/changed plugins at launch.
- **Nothing uploads / "No exportable frames found"**: only Artboards/Frames
  export by default. If what you selected is a Group or other layer type,
  either wrap it in an Artboard, or check **Include Components** in
  Additional Settings to export any top-level layer regardless of type.
