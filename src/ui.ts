'use strict'

// Ported from the Applitools Figma plugin's ui.ts. The Eyes SDK config/
// upload logic below is unchanged from the Figma version — only the message
// bridge at the top (receiving from the plugin script) and bottom (posting
// back to it) differ, since Sketch's sketch-module-web-view bridge carries
// JSON-serializable messages over named channels instead of Figma's
// structured-clone postMessage/pluginMessage protocol.
//
// One real difference from the Figma version: eyes.applitools.com enforces a
// strict CORS origin allowlist that this webview can never satisfy (confirmed
// live — even a completely ordinary origin like https://example.com was
// rejected by the real /api/sessions/renderinfo endpoint from a normal Safari
// tab, so no origin this webview could claim for itself would ever pass).
// Rather than reimplementing the SDK's wire protocol elsewhere, the fix here
// is narrower: axios (which the SDK's ServerConnector is built on) supports a
// pluggable `adapter` — see bridgeAdapter() below. Every actual HTTP request
// the SDK makes gets routed through export-designs.js, which performs the
// real fetch from Sketch's native plugin-script context (not a browser, not
// subject to CORS at all). The SDK itself — Eyes, Configuration, Target,
// eyes.open()/check()/close() — runs completely unmodified; only the lowest
// transport layer is swapped out.

const {
  MatchLevel,
  AccessibilityLevel,
  AccessibilityGuidelinesVersion,
  Eyes,
  Target,
  Configuration,
  BatchInfo
} = require('@applitools/eyes-images')

const axios = require('axios')
const buildFullPath = require('axios/lib/core/buildFullPath')
const buildURL = require('axios/lib/helpers/buildURL')
const settle = require('axios/lib/core/settle')
const createError = require('axios/lib/core/createError')

const Messages = require('./bridge/messages')

const VERSION = '0.1.0';

function postToPlugin(type: string, payload?: object) {
  // Provided by sketch-module-web-view: sends a named-channel message back
  // to the plugin script's `webContents.on(type, handler)` listener.
  (window as any).postMessage(type, payload || {});
}

// ---------------------------------------------------------------------------
// axios transport bridge — see the file-level comment above for why this
// exists. This is a custom axios `adapter`: instead of performing the actual
// network I/O itself (like the stock xhr.js adapter does with
// XMLHttpRequest), it hands the fully-resolved request off to
// export-designs.js over the existing plugin<->webview bridge, and resolves/
// rejects the same way axios's own adapters do (via `settle`/`createError`),
// so the SDK's request/response interceptors — retries, the 202+Location
// long-running-task polling, apiKey/header injection — keep working
// completely transparently. None of that had to be reimplemented.
// ---------------------------------------------------------------------------

let requestSeq = 0;
const pendingHttpRequests: { [ id: string ]: { resolve: Function, reject: Function, config: any } } = {};

function bridgeAdapter(config: any) {
  return new Promise((resolve, reject) => {
    const id = `req-${++requestSeq}`;
    const fullPath = buildFullPath(config.baseURL, config.url);
    const fullUrl = buildURL(fullPath, config.params, config.paramsSerializer);

    let data = config.data;
    let isBinary = false;
    if (data && typeof data !== 'string') {
      // The screenshot upload (a PUT of raw PNG bytes to Azure Blob Storage)
      // is the one non-string body in this protocol — everything else is a
      // JSON string by the time axios's default transformRequest has run.
      // Sketch's bridge only carries JSON-safe values, so base64-encode it;
      // export-designs.js decodes it back to real bytes before the real fetch.
      isBinary = true;
      data = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
    }

    pendingHttpRequests[ id ] = { resolve, reject, config };

    postToPlugin(Messages.HTTP_REQUEST, {
      id,
      method: (config.method || 'get').toUpperCase(),
      url: fullUrl,
      headers: config.headers,
      data,
      isBinary,
    });
  });
}

axios.defaults.adapter = bridgeAdapter;

document.getElementById('save').onclick = (event) => {

  (<HTMLDivElement>document.getElementById('console')).style.display = 'inherit';
  window.scrollBy(0, 500);

  let apiKey = (<HTMLInputElement>document.getElementById('key')).value;
  let url = (<HTMLInputElement>document.getElementById('url')).value

  let resultsHref = <HTMLAnchorElement>document.getElementById("results-url");
  resultsHref.style.display = 'none';
  resultsHref.href = '';
  resultsHref.textContent = '';

  (<HTMLDivElement>document.getElementById('results-section')).style.display = 'none';
  (<HTMLDivElement>document.getElementById('baseline-list-section')).style.display = 'none';

  if (apiKey.length > 0) {
    document.getElementById('save').style.backgroundColor = "#5A5A5A";
    document.getElementById('save').style[ 'cursor' ] = "not-allowed";
    document.getElementById('save').onclick = null;
    document.getElementById('save').attributes[ 'onclick' ] = null;
    document.getElementById('save').attributes[ 'disabled' ] = 'disabled';

    var allComponents = (<HTMLInputElement>document.getElementById('everything')).checked;
    const widths = (<HTMLInputElement>document.getElementById('widths')).value;
    const arrWidths = parseWidths(widths)
    postToPlugin(Messages.SAVE, { everything: allComponents, applitoolsApiKey: apiKey, serverUrl: url, arrWidths: arrWidths });
  }
  else {
    postToPlugin(Messages.KEY_OR_URL_ERROR);
  }
}

document.getElementById('cancel').onclick = () => {
  console.log("User Cancelled")
  postToPlugin(Messages.CANCEL);
}

let batchUrls: any[] = [];
let results: { [ key: string ]: any } = {};
let statusCounter: { [ key: string ]: number } = {};

// Called directly by export-designs.js via webContents.executeJavaScript(),
// in place of Figma's `onmessage = async event => { ... event.data.pluginMessage }`.
(window as any).receiveFromPlugin = async function (message: any) {
  if (message.type === Messages.HTTP_RESPONSE) {
    const pending = pendingHttpRequests[ message.id ];
    if (!pending) return;
    delete pendingHttpRequests[ message.id ];

    if (message.error) {
      pending.reject(createError(message.error, pending.config, message.code || null, null));
      return;
    }

    settle(pending.resolve, pending.reject, {
      data: message.data,
      status: message.status,
      statusText: message.statusText || '',
      headers: message.headers || {},
      config: pending.config,
      request: null,
    });
    return;
  }

  if (message.type === Messages.SETTINGS) {
    if (message.applitoolsApiKey) {
      (<HTMLInputElement>document.getElementById('key')).value = message.applitoolsApiKey
    }
    if (message.serverUrl) {
      (<HTMLInputElement>document.getElementById('url')).value = message.serverUrl
    }
    return
  }

  if (message.type === Messages.KEY_OR_URL_ERROR) {
    console.log("Error: Please enter your Applitools Server Url and Api Key!");
    return
  }

  if (message.type !== Messages.DESIGNS) {
    return
  }

  if (message.dupResults && message.dupResults.designs.length) {
    console.log("duplicates found: " + message.dupResults.designs.length);
    console.log("Frame names must be unique for each resolution/viewport.");
    for (let result of message.dupResults.designs) {
      console.log(`Skipping duplicate frame: ${result.name}, width ${result.width}, height ${result.height}`);
    }
  }
  if (message.results && message.results.scanSummary) {
    console.log(`Scanned layers: ${message.results.scanSummary}`);
  }

  if (!message.results || message.results.designs.length === 0) {
    console.log(
      "No exportable frames found — nothing was uploaded. Check the 'Scanned layers' line above: " +
      "only top-level Artboards/Frames are exported by default, unless 'Include Components' is on."
    );
    return
  }

  if (message.results) {
    console.log("Designs Collected");
    const baselineList = [];
    let projectName = `${message.results.project}`

    try {
      const tresults = await upload(message.results, baselineList, projectName);
      let isError = tresults.some(test => test instanceof Error);

      if (isError) {
        console.log('Error uploading to Applitools');
        tresults.filter(test => test instanceof Error).forEach((error: any) => {
          console.log(`\n${error.message}\n`);
        });
      } else {

        batchUrls = tresults.map(test => test._appUrls._batch).filter((item, i, ar) => ar.indexOf(item) === i)

        results = {};
        statusCounter = {};

        tresults.forEach((test, index) => {
          results[ `${index}` ] = {
            appName: test._appName,
            testName: test._name,
            viewportSize: test._hostDisplaySize.toString(),
            hostApp: test._hostApp,
            hostOS: test._hostOS,
            baselineEnvName: test._serverConnector._configuration._baselineEnvName,
            status: test._status,
          };
        });

        tresults.map(test => test._status).forEach(function (obj) {
          var key = JSON.stringify(obj)
          statusCounter[ key ] = (statusCounter[ key ] || 0) + 1
        })

        const cleanedStatusCounter = Object.fromEntries(
          Object.entries(statusCounter).map(([ key, value ]) => [ key.replace(/["\\]/g, ''), value ])
        );

        const detailedResult = Object.entries(results).map(([ index, details ]) => {
          const detailsString = Object.entries(details)
            .map(([ key, value ]) => `${key}: '${value}'`)
            .join('\n');
          return `${parseInt(index) + 1}. \n${detailsString}\n`; // Add the index (1-based)
        }).join('\n');

        console.log(`\nBatch Url: ${batchUrls.join('')}\n`);
        console.log(`Test Results Summary: ${JSON.stringify(cleanedStatusCounter)}\n`);
        console.log(`Detailed Test Results:\n${detailedResult}`);

        let resultsHref = document.getElementById("opendashboard");
        resultsHref.setAttribute('onclick', "window.open('" + batchUrls.join('') + "','_blank')");

        let baseList = <HTMLUListElement>document.getElementById('baseline-list');
        baselineList.forEach(function (obj) {
          var li = document.createElement('li');     // create li element.
          li.innerHTML = obj;      // assigning text to li using array value.
          baseList.appendChild(li);
        });

        (<HTMLDivElement>document.getElementById('results-section')).style.display = 'inherit';
        (<HTMLDivElement>document.getElementById('baseline-list-section')).style.display = 'inherit';

        postToPlugin(Messages.UPLOAD_COMPLETE);

        window.scrollBy(0, 500);
      }
    } catch (error) {
      console.log(error);
    } finally {
      // (<HTMLButtonElement>document.getElementById('save')).disabled = false;
      // document.getElementById('save').removeAttribute('disabled');
      //(<HTMLButtonElement>document.getElementById('save')).removeAttribute('disabled')
      //(<HTMLDivElement>document.getElementById('save')).removeAttribute('disabled');
    }
  }
}

function parseWidths(widths) {
  if (widths && widths.length > 0) {
    try {
      return widths.split(',').map(element => {
        if (isNaN(element)) {
          return null;
        } else {
          return Number(element);
        }
      });
    } catch (error) {
      console.log('Unable to parse widths... skipping exporting extra images');
    }
  }
  return [];
}

async function upload(results, baselineList, projectName) {
  console.log('Uploading to Applitools');
  const config = new Configuration();

  config.setApiKey((<HTMLInputElement>document.getElementById('key')).value);

  var serverUrl = (<HTMLInputElement>document.getElementById('url')).value
  if (serverUrl) {
    config.setServerUrl(serverUrl);
  }

  var setMatchLevel = (<HTMLInputElement>document.getElementById('matchLevel')).value
  if (setMatchLevel === null || setMatchLevel === "") { }
  else
    config.setMatchLevel(eval('MatchLevel.' + setMatchLevel));

  var saveFailedTests = (<HTMLInputElement>document.getElementById('saveFailedTests')).checked;
  config.setSaveFailedTests(saveFailedTests);

  var setIgnoreDisplacements = (<HTMLInputElement>document.getElementById('ignoreDisplacements')).checked;
  config.setIgnoreDisplacements(setIgnoreDisplacements);

  var contrastLevel = (<HTMLInputElement>document.getElementById('contrastLevel')).value

  if (contrastLevel === null || contrastLevel === "") { }
  else {
    var aLevel = contrastLevel.split(' ')[ 0 ];
    var wcag = contrastLevel.split(' ')[ 1 ];
    config.setAccessibilityValidation({
      level: eval('AccessibilityLevel.' + aLevel),
      guidelinesVersion: eval('AccessibilityGuidelinesVersion.WCAG_' + wcag)
    });
  }

  let sketchAgentString = "sketch-plugin/" + VERSION;

  console.log(`\nBatch Name: ${projectName}`);
  console.log(`Application Name: ${projectName}\n`);

  const batchInfo = new BatchInfo(projectName);

  var shouldSetNotifyOnCompletion = (<HTMLInputElement>document.getElementById('setNotifyOnCompletion')).checked;
  batchInfo.setNotifyOnCompletion(shouldSetNotifyOnCompletion);

  config.setBatch(batchInfo);
  config.setAgentId(sketchAgentString);

  return await Promise.all(

    await results.designs.map(async (design) => {
      let testResults;
      let testName = `${design.name}`
      let width;
      let height;

      const eyes = new Eyes()

      try {
        eyes.setConfiguration(config);

        // NOTE: eyes.setProxy() configures axios's Node-level proxy agent,
        // which has no effect now — the actual network I/O happens via
        // bridgeAdapter() -> export-designs.js's native fetch, which has no
        // proxy-configuration equivalent. Left here so the setting doesn't
        // silently vanish from the form, but it's a known no-op.
        var proxyUrl = (<HTMLInputElement>document.getElementById('proxy')).value
        if (proxyUrl) {
          console.log("Note: the Proxy URL setting has no effect — see the comment above this line.")
        }

        width = Math.round(Number(design.width));
        height = Math.round(Number(design.height));

        const userInput = (document.getElementById('baselineEnv') as HTMLInputElement)?.value?.trim();
        const baselineEnvName = userInput ? userInput : `${testName}_${width}`;

        eyes.setBaselineEnvName(baselineEnvName);

        const os = (<HTMLInputElement>document.getElementById('os')).value;
        const browser = (<HTMLInputElement>document.getElementById('browser')).value;

        eyes.setHostApp(browser)
        eyes.setHostOS(os)

        baselineList.push(`Test Name: ${testName}<br>Baseline Environment Name: ${baselineEnvName}`);
        await eyes.open(projectName, testName, { width: width, height: height });
        // design.bytesBase64 crosses the plugin<->webview bridge as a base64
        // string (Sketch's executeJavaScript bridge only carries JSON-safe
        // values, unlike Figma's structured-clone postMessage which could
        // pass a Uint8Array directly) — decode back to a Buffer here.
        await eyes.check(testName, Target.image(Buffer.from(design.bytesBase64, 'base64')));

        testResults = await eyes.close(false);

      } catch (error) {
        console.log(`\n${error.message}\n`);
        await eyes.abortIfNotClosed();
        testResults = error;
      }

      return testResults;

    })
  )
}
