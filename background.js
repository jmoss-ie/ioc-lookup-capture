import { loadState, saveSettings, saveSites, DEFAULT_SETTINGS } from "./common/storage.js";
import { hasAllUrlsPermission, backendPermissionStatus, debuggerAvailable } from "./bg/permissions.js";
import { resolveBackend } from "./common/backends.js";
import { runCapture, runReview, runSelfTest } from "./bg/runner.js";
import { getOpenSessionCount, closeAllOpenSessions } from "./bg/windowTracking.js";
import {
  registerExportRenamerAtStartup,
  getExportStatus,
  armExportRenaming,
  disarmExportRenaming,
  setExportLabel,
  resetExportSeq,
  captureSectionToCase,
  setExportHold,
  addExportFilterHosts,
  setExportFilterOn,
} from "./bg/exportRenamer.js";

// Must run synchronously at the top level: a download can be what wakes this
// worker up while "Rename exports" is on (see bg/exportRenamer.js).
registerExportRenamerAtStartup();

/** Reply to a message with a promise's result, or { ok: false, error } if it rejects. */
function respond(promise, sendResponse) {
  promise
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  loadState().catch((err) => console.error("IOC Lookup Capture: init failed", err));
});

// --- Simple request/response messages -------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return undefined; // not for us

  switch (message.type) {
    case "GET_STATE":
      loadState().then(sendResponse);
      return true;

    case "SAVE_SETTINGS":
      saveSettings({ ...DEFAULT_SETTINGS, ...message.settings })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "SAVE_SITES":
      saveSites(message.sites)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "HAS_ALL_URLS_PERMISSION":
      hasAllUrlsPermission().then((granted) => sendResponse({ granted }));
      return true;

    case "GET_BACKEND_STATUS": {
      // Which backend a run would actually use with the saved settings, and
      // whether its runtime permissions are in place.
      const hasDebugger = debuggerAvailable();
      const backend = resolveBackend(message.captureBackend, { debuggerAvailable: hasDebugger });
      backendPermissionStatus(backend)
        .then(({ granted, missing }) =>
          sendResponse({ backend, debuggerAvailable: hasDebugger, granted, missing })
        )
        .catch((err) => sendResponse({ backend, debuggerAvailable: hasDebugger, granted: false, error: String(err) }));
      return true;
    }

    case "RUN_SELF_TEST":
      runSelfTest({ url: message.url, settings: message.settings })
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case "GET_OPEN_WINDOWS":
      getOpenSessionCount()
        .then((count) => sendResponse({ count }))
        .catch(() => sendResponse({ count: 0 }));
      return true;

    case "CLOSE_ALL_WINDOWS":
      closeAllOpenSessions()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    // --- Rename exports ---
    case "EXPORT_GET_STATUS":
      return respond(getExportStatus(), sendResponse);

    case "EXPORT_ARM":
      return respond(armExportRenaming(message.caseRef), sendResponse);

    case "EXPORT_DISARM":
      return respond(disarmExportRenaming(), sendResponse);

    case "EXPORT_SET_LABEL":
      return respond(setExportLabel(message.label), sendResponse);

    case "EXPORT_RESET_SEQ":
      return respond(resetExportSeq(message.caseRef), sendResponse);

    case "EXPORT_SET_HOLD":
      return respond(setExportHold(message.caseRef, message.on), sendResponse);

    case "EXPORT_FILTER_ADD":
      return respond(addExportFilterHosts(message.hosts), sendResponse);

    case "EXPORT_FILTER_SET_ON":
      return respond(setExportFilterOn(message.on), sendResponse);

    case "CAPTURE_SECTION":
      captureSectionToCase({ tabId: message.tabId, caseRef: message.caseRef })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) =>
          sendResponse({ ok: false, code: err && err.code, error: String((err && err.message) || err) })
        );
      return true;

    default:
      return undefined;
  }
});

// --- Long-running capture/review batch, streamed over a port ---------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "capture") return;

  let stopRequested = false;

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "STOP") {
      stopRequested = true;
      return;
    }
    if (msg.type === "START_CAPTURE" || msg.type === "START_REVIEW") {
      const runFn = msg.type === "START_REVIEW" ? runReview : runCapture;
      runFn({
        jobs: msg.jobs,
        settings: msg.settings,
        caseRef: msg.caseRef,
        currentWindowId: msg.currentWindowId,
        shouldStop: () => stopRequested,
        onProgress: (evt) => {
          try {
            port.postMessage({ type: "PROGRESS", evt });
          } catch {
            // Popup closed; the run continues regardless, just with nowhere to report to.
          }
        },
      })
        .then((final) => {
          try {
            port.postMessage({ type: "RUN_COMPLETE", final });
          } catch {
            /* popup gone */
          }
        })
        .catch((err) => {
          try {
            port.postMessage({ type: "RUN_FAILED", error: String((err && err.message) || err) });
          } catch {
            /* popup gone */
          }
        });
    }
  });
});
