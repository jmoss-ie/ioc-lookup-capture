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
  adjustExportSeq,
  captureSectionToCase,
  setExportHold,
  addExportFilterHosts,
  setExportFilterOn,
} from "./bg/exportRenamer.js";
import { setWaitingBadge } from "./bg/badge.js";
import { CODE_VERSION } from "./common/version.js";

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
      // codeVersion: what this background code is, for the pages' out-of-date check (common/version.js).
      loadState().then((state) => sendResponse({ ...state, codeVersion: CODE_VERSION }));
      return true;

    case "GET_RUN":
      getRunView().then((view) => sendResponse({ view }));
      return true;

    case "CLEAR_RUN":
      clearRunView().then(() => sendResponse({ ok: true }));
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

    case "EXPORT_ADJUST_SEQ":
      return respond(adjustExportSeq(message.caseRef, message.delta), sendResponse);

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
//
// The popup closes whenever you click into another window — for instance the
// lookup window, to solve a captcha — and a batch carries on without it. So
// the batch's progress is kept here, and a popup opened later re-attaches:
// it shows the rows so far and, while a job waits on its bot check, Capture
// now and Skip. The last batch's rows are also kept in chrome.storage.session
// (cleared when the browser closes), so its outcome can be seen afterwards.

const RUN_VIEW_KEY = "lastRun";
let run = null; // the current or most recent batch

function newRun(mode, jobs) {
  return {
    mode,
    startedAt: Date.now(),
    finishedAt: null,
    rows: jobs.map((j) => ({ label: `${j.site.name} — ${j.indicator}`, siteName: j.site.name, status: "pending" })),
    waiting: null, // { index, mode, reason }
    manifestPath: null,
    failed: null,
    ports: new Set(),
    stop: false,
    action: null, // Capture now / Skip, pressed while waiting
  };
}

function viewOf(r) {
  return {
    mode: r.mode,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    rows: r.rows,
    waiting: r.waiting,
    manifestPath: r.manifestPath,
    failed: r.failed,
  };
}

async function saveView(r) {
  try {
    await chrome.storage.session.set({ [RUN_VIEW_KEY]: viewOf(r) });
  } catch {
    /* session storage unavailable: the in-memory copy still serves a running batch */
  }
}

async function getRunView() {
  if (run) return viewOf(run);
  try {
    return (await chrome.storage.session.get(RUN_VIEW_KEY))[RUN_VIEW_KEY] || null;
  } catch {
    return null;
  }
}

async function clearRunView() {
  if (run && !run.finishedAt) return; // never hide a batch that's still going
  run = null;
  try {
    await chrome.storage.session.remove(RUN_VIEW_KEY);
  } catch {
    /* nothing to clear */
  }
}

function broadcast(r, message) {
  for (const p of r.ports) {
    try {
      p.postMessage(message);
    } catch {
      r.ports.delete(p);
    }
  }
}

/** Keep the batch's rows in step with its progress events. */
function applyProgress(r, evt) {
  const row = r.rows[evt.index];
  if (evt.type === "start" && row) row.status = "running";
  else if (evt.type === "waiting" && row) {
    row.status = "waiting";
    r.waiting = { index: evt.index, mode: evt.mode, reason: evt.reason };
    r.action = null; // a press from before this wait doesn't count
    setWaitingBadge({ siteName: row.siteName, mode: evt.mode });
  } else if (evt.type === "resumed" && row) {
    row.status = "running";
    r.waiting = null;
    setWaitingBadge(null);
  } else if (evt.type === "done" && row) row.status = "ok";
  else if (evt.type === "error" && row) {
    row.status = "fail";
    row.error = evt.error;
  } else if (evt.type === "stopped" && row) row.status = "stopped";
}

function startRun(port, msg) {
  if (run && !run.finishedAt) {
    port.postMessage({
      type: "RUN_FAILED",
      error: "A batch is already running. Wait for it to finish, or press Stop first.",
    });
    return;
  }
  const r = newRun(msg.type === "START_REVIEW" ? "review" : "capture", msg.jobs || []);
  run = r;
  r.ports.add(port);
  saveView(r);
  const runFn = r.mode === "review" ? runReview : runCapture;
  runFn({
    jobs: msg.jobs,
    settings: msg.settings,
    caseRef: msg.caseRef,
    currentWindowId: msg.currentWindowId,
    shouldStop: () => r.stop,
    waitControl: {
      take: () => {
        const action = r.action;
        r.action = null;
        return action;
      },
      stopped: () => r.stop,
    },
    onProgress: (evt) => {
      applyProgress(r, evt);
      broadcast(r, { type: "PROGRESS", evt });
      saveView(r);
    },
  })
    .then((final) => {
      r.finishedAt = Date.now();
      r.manifestPath = (final && final.manifestPath) || null;
      broadcast(r, { type: "RUN_COMPLETE", final });
    })
    .catch((err) => {
      r.finishedAt = Date.now();
      r.failed = String((err && err.message) || err);
      broadcast(r, { type: "RUN_FAILED", error: r.failed });
    })
    .finally(() => {
      r.waiting = null;
      setWaitingBadge(null);
      saveView(r);
    });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "capture") return;

  port.onDisconnect.addListener(() => {
    if (run) run.ports.delete(port);
  });

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "START_CAPTURE" || msg.type === "START_REVIEW") {
      startRun(port, msg);
    } else if (msg.type === "ATTACH") {
      // A popup opened while a batch is running: send it the batch so far, then its progress.
      if (run && !run.finishedAt) run.ports.add(port);
      port.postMessage({ type: "RUN_VIEW", view: run ? viewOf(run) : null });
    } else if (msg.type === "STOP") {
      if (run && !run.finishedAt) run.stop = true; // also ends a wait (bg/challengeWait.js)
    } else if (msg.type === "WAIT_ACTION") {
      if (run && run.waiting && (msg.action === "capture" || msg.action === "skip")) run.action = msg.action;
    }
  });
});
