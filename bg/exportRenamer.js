// "Rename exports": while switched on for a case, every download started by
// a web page (a Sentinel/Log Analytics CSV or Open-in-Excel export, a
// Defender advanced-hunting export, ...) is renamed with the export filename
// template and saved under <base folder>/<case>/<exports subfolder>/, with a
// per-case sequence number so a five-query investigation sorts in order.
//
// Mechanism: chrome.downloads.onDeterminingFilename. Chromium hands every
// new download to that event and waits for each listener's suggest() before
// picking a filename. Rules this file is built around:
//
//   - suggest() must be called exactly once for every download the listener
//     sees, renamed or not, or that download sits waiting. Every path below
//     ends in suggest(), and a deadline calls it anyway if deciding stalls.
//   - Only the downloads of web pages are renamed. Downloads started by any
//     extension are left alone — except this extension's own, which get their
//     intended filename suggested back (see bg/ownDownloads.js for why).
//   - The listener is registered synchronously at service-worker startup (so
//     a download can wake the worker while renaming is on), then removed again
//     as soon as the worker has read that renaming is off — so while it's off,
//     downloads elsewhere in the browser don't involve this extension at all.

import { loadState } from "../common/storage.js";
import {
  buildExportPath,
  downloadHosts,
  isArmExpired,
  parseHostList,
  passesHostFilter,
  splitFilename,
} from "../common/exportNaming.js";
import { takeOwnDownload } from "./ownDownloads.js";

const KEYS = { arm: "exportArm", seq: "exportSeq", log: "exportLog" };
const LOG_LIMIT = 20;
const SUGGEST_DEADLINE_MS = 5000;
const MAX_LABEL_CHARS = 80;

// --- Serialize every read-modify-write of the renaming state -------------------------

let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// --- Listener attach/detach ------------------------------------------------------------

function attach() {
  if (!chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename)) {
    chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
  }
}

function detach() {
  if (chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename)) {
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
  }
}

async function updateBadge(armed) {
  try {
    await chrome.action.setBadgeText({ text: armed ? "ON" : "" });
    if (armed) await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
    await chrome.action.setTitle({
      title: armed ? `IOC Lookup Capture — renaming exports for ${armed.caseRef}` : "IOC Lookup Capture",
    });
  } catch (err) {
    console.warn("IOC Lookup Capture: badge update failed", err);
  }
}

/**
 * Call once, synchronously, at the top level of the service worker. Attaches
 * the listener straight away (so a download that woke the worker is seen),
 * then detaches it if renaming turns out to be off or to have timed out.
 */
export function registerExportRenamerAtStartup() {
  attach();
  withLock(async () => {
    const armed = await currentArmed();
    if (armed) attach();
    else detach();
    await updateBadge(armed);
  }).catch((err) => console.error("IOC Lookup Capture: export renaming startup check failed", err));
}

// --- State ---------------------------------------------------------------------------

/** The armed record, or null — switching renaming off first if it has timed out. Call under the lock. */
async function currentArmed() {
  const stored = await chrome.storage.local.get(KEYS.arm);
  const armed = stored[KEYS.arm] || null;
  if (!armed) return null;
  const { settings } = await loadState();
  if (isArmExpired(armed, Date.now(), settings.exportAutoStopMinutes)) {
    await chrome.storage.local.remove(KEYS.arm);
    await appendLog({ at: Date.now(), status: "stopped", caseRef: armed.caseRef, reason: "auto-stopped" });
    return null;
  }
  return armed;
}

async function appendLog(entry) {
  const stored = await chrome.storage.local.get(KEYS.log);
  const log = [entry, ...(stored[KEYS.log] || [])].slice(0, LOG_LIMIT);
  await chrome.storage.local.set({ [KEYS.log]: log });
}

/** Everything the popup shows. */
export function getExportStatus() {
  return withLock(async () => {
    const armed = await currentArmed();
    if (armed) attach();
    else detach();
    await updateBadge(armed);
    const stored = await chrome.storage.local.get([KEYS.seq, KEYS.log]);
    const { settings } = await loadState();
    return {
      armed,
      nextSeqByCase: stored[KEYS.seq] || {},
      log: stored[KEYS.log] || [],
      autoStopMinutes: settings.exportAutoStopMinutes,
      hostFilter: parseHostList(settings.exportHostFilter),
    };
  });
}

/** Switch renaming on for a case (or switch it to a different case). */
export function armExportRenaming(caseRef) {
  const ref = String(caseRef ?? "").trim();
  if (!ref) return Promise.reject(new Error("Enter a case reference first — exports are filed and numbered per case."));
  return withLock(async () => {
    const now = Date.now();
    const armed = { caseRef: ref, armedAt: now, lastActivityAt: now, pendingLabel: "" };
    await chrome.storage.local.set({ [KEYS.arm]: armed });
    await appendLog({ at: now, status: "started", caseRef: ref });
    attach();
    await updateBadge(armed);
  }).then(getExportStatus);
}

/** Switch renaming off. */
export function disarmExportRenaming() {
  return withLock(async () => {
    const stored = await chrome.storage.local.get(KEYS.arm);
    const armed = stored[KEYS.arm];
    await chrome.storage.local.remove(KEYS.arm);
    if (armed) await appendLog({ at: Date.now(), status: "stopped", caseRef: armed.caseRef });
    detach();
    await updateBadge(null);
  }).then(getExportStatus);
}

/** Set the one-off label used by the next renamed export (then cleared). */
export function setExportLabel(label) {
  return withLock(async () => {
    const stored = await chrome.storage.local.get(KEYS.arm);
    const armed = stored[KEYS.arm];
    if (!armed) return { ok: false };
    const pendingLabel = String(label ?? "").slice(0, MAX_LABEL_CHARS);
    await chrome.storage.local.set({ [KEYS.arm]: { ...armed, pendingLabel } });
    return { ok: true };
  });
}

/** Start a case's numbering again from 01. */
export function resetExportSeq(caseRef) {
  const ref = String(caseRef ?? "").trim();
  return withLock(async () => {
    const stored = await chrome.storage.local.get(KEYS.seq);
    const seqMap = { ...(stored[KEYS.seq] || {}) };
    delete seqMap[ref];
    await chrome.storage.local.set({ [KEYS.seq]: seqMap });
  }).then(getExportStatus);
}

// --- The listener ----------------------------------------------------------------------

/**
 * Decide what to name one web-page download. Resolves to a suggestion
 * object, or null to leave the browser's own name alone.
 * @param {chrome.downloads.DownloadItem} item
 */
function decide(item) {
  return withLock(async () => {
    const armed = await currentArmed();
    if (!armed) {
      detach();
      await updateBadge(null);
      return null;
    }
    const { settings } = await loadState();
    const now = Date.now();
    const hosts = downloadHosts(item);
    const original = item.filename || "";
    const leaf = original.split(/[\\/]/).pop() || splitFilename(original).base;

    if (!passesHostFilter(hosts, parseHostList(settings.exportHostFilter))) {
      await appendLog({ at: now, status: "skipped", caseRef: armed.caseRef, from: leaf, hosts, reason: "host-filter" });
      return null;
    }

    const stored = await chrome.storage.local.get(KEYS.seq);
    const seqMap = { ...(stored[KEYS.seq] || {}) };
    const seq = Number(seqMap[armed.caseRef]) || 1;
    const { path } = buildExportPath({
      baseFolder: settings.baseFolder,
      caseRef: armed.caseRef,
      subfolder: settings.exportSubfolder,
      template: settings.exportTemplate,
      prefix: settings.hiddenPrefix,
      seq,
      label: armed.pendingLabel,
      originalFilename: original,
      date: new Date(now),
    });

    seqMap[armed.caseRef] = seq + 1;
    await chrome.storage.local.set({
      [KEYS.seq]: seqMap,
      [KEYS.arm]: { ...armed, pendingLabel: "", lastActivityAt: now },
    });
    await appendLog({ at: now, status: "renamed", caseRef: armed.caseRef, seq, from: leaf, to: path, hosts });
    return { filename: path, conflictAction: "uniquify" };
  });
}

function onDeterminingFilename(item, suggest) {
  // This extension's own downloads: suggest back the filename it asked for.
  if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) {
    const own = takeOwnDownload(item.url);
    if (own) suggest({ filename: own.filename, conflictAction: own.conflictAction });
    else suggest();
    return undefined;
  }
  // Any other extension's downloads: not ours to rename.
  if (item.byExtensionId) {
    suggest();
    return undefined;
  }

  let settled = false;
  const finish = (suggestion) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    try {
      if (suggestion) suggest(suggestion);
      else suggest();
    } catch (err) {
      console.error("IOC Lookup Capture: suggest() failed", err);
    }
  };
  // Never leave a download waiting on us.
  const deadline = setTimeout(() => finish(null), SUGGEST_DEADLINE_MS);
  decide(item).then(finish, (err) => {
    console.error("IOC Lookup Capture: export renaming failed; keeping the browser's name", err);
    finish(null);
  });
  return true; // suggest() is called asynchronously
}
