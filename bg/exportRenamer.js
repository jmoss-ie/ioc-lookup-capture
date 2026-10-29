// "Query evidence": per-case numbered files in <base folder>/<case>/<exports
// subfolder>/, from two sources that share one sequence and one label:
//
//   - Rename exports: while switched on for a case, every download started
//     by a web page (a Sentinel/Log Analytics CSV or Open-in-Excel export, a
//     Defender advanced-hunting export, ...) is renamed with the export
//     filename template and saved there.
//   - Capture section: a screenshot of part of the current tab (see
//     bg/sectionCapture.js), saved there with the same template.
//
// So a five-query investigation's screenshots and exports sort in the order
// they were made. "Keep the same number" (a hold) gives every file the case's
// current number until it's released — for a query's screenshot plus its
// exports.
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

import { loadState, saveSettings } from "../common/storage.js";
import {
  buildExportPath,
  downloadHosts,
  effectiveHostFilter,
  adjustNumber,
  holdSeqFor,
  isArmExpired,
  parseHostList,
  passesHostFilter,
  splitFilename,
  takeNumber,
} from "../common/exportNaming.js";
import { takeOwnDownload } from "./ownDownloads.js";
import { captureSection } from "./sectionCapture.js";
import { downloadPngBlob } from "./downloads.js";
import { setExportBadge } from "./badge.js";

const KEYS = { arm: "exportArm", seq: "exportSeq", log: "exportLog", label: "exportLabel", hold: "exportHold" };
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

/**
 * Toolbar badge: the held number (amber) while a hold is on — so it's visible
 * without opening the popup — otherwise "ON" (red) while renaming is on.
 * (A capture waiting on a bot check shows WAIT over this; see bg/badge.js.)
 */
async function updateBadge(armed) {
  try {
    const hold = (await chrome.storage.local.get(KEYS.hold))[KEYS.hold] || null;
    const title = [];
    if (armed) title.push(`renaming exports for ${armed.caseRef}`);
    if (hold) title.push(`keeping #${String(hold.seq).padStart(2, "0")} for ${hold.caseRef}`);
    if (hold) {
      await setExportBadge({ text: `#${String(hold.seq).padStart(2, "0")}`, color: "#9a6700", title });
    } else {
      await setExportBadge({ text: armed ? "ON" : "", color: armed ? "#b3261e" : null, title });
    }
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
    const stored = await chrome.storage.local.get([KEYS.seq, KEYS.log, KEYS.label, KEYS.hold]);
    const { settings } = await loadState();
    return {
      armed,
      label: stored[KEYS.label] || "",
      hold: stored[KEYS.hold] || null,
      nextSeqByCase: stored[KEYS.seq] || {},
      log: stored[KEYS.log] || [],
      autoStopMinutes: settings.exportAutoStopMinutes,
      hostFilter: effectiveHostFilter(settings),
    };
  });
}

/** Switch renaming on for a case (or switch it to a different case). */
export function armExportRenaming(caseRef) {
  const ref = String(caseRef ?? "").trim();
  if (!ref) return Promise.reject(new Error("Enter a case reference first — exports are filed and numbered per case."));
  return withLock(async () => {
    const now = Date.now();
    const armed = { caseRef: ref, armedAt: now, lastActivityAt: now };
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

/**
 * Set the label put into every case file's name ({label}) until it's
 * changed or cleared — so a query's screenshot and its exports share it.
 */
export function setExportLabel(label) {
  return withLock(async () => {
    await chrome.storage.local.set({ [KEYS.label]: String(label ?? "").slice(0, MAX_LABEL_CHARS) });
    return {};
  });
}

/** Start a case's numbering again from 01 (and release a hold on that case). */
export function resetExportSeq(caseRef) {
  const ref = String(caseRef ?? "").trim();
  return withLock(async () => {
    const stored = await chrome.storage.local.get([KEYS.seq, KEYS.hold]);
    const seqMap = { ...(stored[KEYS.seq] || {}) };
    delete seqMap[ref];
    await chrome.storage.local.set({ [KEYS.seq]: seqMap });
    if (stored[KEYS.hold] && stored[KEYS.hold].caseRef === ref) await chrome.storage.local.remove(KEYS.hold);
  }).then(getExportStatus);
}

/**
 * Keep the same number: while on, every file for this case (captures and
 * renamed exports) gets the case's current number — its most recent, or 01
 * before any — until released. One hold at a time; holding another case
 * replaces it.
 */
export function setExportHold(caseRef, on) {
  const ref = String(caseRef ?? "").trim();
  if (on && !ref) return Promise.reject(new Error("Enter a case reference first."));
  return withLock(async () => {
    if (on) {
      const stored = await chrome.storage.local.get(KEYS.seq);
      const seq = holdSeqFor((stored[KEYS.seq] || {})[ref]);
      await chrome.storage.local.set({ [KEYS.hold]: { caseRef: ref, seq } });
    } else {
      await chrome.storage.local.remove(KEYS.hold);
    }
  }).then(getExportStatus);
}

/**
 * Move a case's number by `delta` (the popup's − and +), to fix a mistake:
 * the held number while this case has a hold, otherwise the next number.
 * Files already saved keep their names.
 */
export function adjustExportSeq(caseRef, delta) {
  const ref = String(caseRef ?? "").trim();
  if (!ref) return Promise.reject(new Error("Enter a case reference first."));
  const step = Math.trunc(Number(delta)) || 0;
  return withLock(async () => {
    const stored = await chrome.storage.local.get([KEYS.seq, KEYS.hold]);
    const seqMap = { ...(stored[KEYS.seq] || {}) };
    const hold = stored[KEYS.hold] || null;
    const adjusted = adjustNumber({ next: seqMap[ref], hold, caseRef: ref, delta: step });
    if (adjusted.next <= 1) delete seqMap[ref];
    else seqMap[ref] = adjusted.next;
    await chrome.storage.local.set({ [KEYS.seq]: seqMap });
    if (adjusted.hold !== hold) await chrome.storage.local.set({ [KEYS.hold]: adjusted.hold });
  }).then(getExportStatus);
}

// --- Site filter (stored in settings, so Options shows the same list) ------------------

/** Add hosts to the "only rename from" list and switch the filter on. */
export function addExportFilterHosts(hosts) {
  return withLock(async () => {
    const { settings } = await loadState();
    const merged = parseHostList([settings.exportHostFilter, ...(hosts || [])].join("\n"));
    if (merged.length === 0) throw new Error("No site to add.");
    await saveSettings({ ...settings, exportHostFilter: merged.join("\n"), exportHostFilterOn: true });
  }).then(getExportStatus);
}

/** Switch the site filter on or off, keeping its list. */
export function setExportFilterOn(on) {
  return withLock(async () => {
    const { settings } = await loadState();
    await saveSettings({ ...settings, exportHostFilterOn: !!on });
  }).then(getExportStatus);
}

// --- Numbering -------------------------------------------------------------------------

/**
 * Take the case's next number (or the held one) and build that file's path.
 * Call under the lock.
 * @returns {Promise<{ path: string, seq: number, held: boolean }>}
 */
async function allocateCaseFile({ caseRef, originalFilename, settings, now }) {
  const stored = await chrome.storage.local.get([KEYS.seq, KEYS.label, KEYS.hold]);
  const seqMap = { ...(stored[KEYS.seq] || {}) };
  const { seq, next, held } = takeNumber({ next: seqMap[caseRef], hold: stored[KEYS.hold] || null, caseRef });
  const { path } = buildExportPath({
    baseFolder: settings.baseFolder,
    caseRef,
    subfolder: settings.exportSubfolder,
    template: settings.exportTemplate,
    prefix: settings.hiddenPrefix,
    seq,
    label: stored[KEYS.label] || "",
    originalFilename,
    date: new Date(now),
  });
  seqMap[caseRef] = next;
  await chrome.storage.local.set({ [KEYS.seq]: seqMap });
  return { path, seq, held };
}

/** Counts as activity for the idle auto-stop, if renaming is on for this case. Call under the lock. */
async function touchArmed(caseRef, now) {
  const stored = await chrome.storage.local.get(KEYS.arm);
  const armed = stored[KEYS.arm];
  if (armed && armed.caseRef === caseRef) {
    await chrome.storage.local.set({ [KEYS.arm]: { ...armed, lastActivityAt: now } });
  }
}

// --- Capture section --------------------------------------------------------------------

/**
 * Screenshot the configured section of a tab and save it as the case's next
 * numbered file. The number is only taken once the screenshot has worked.
 * @param {{ tabId: number, caseRef: string }} opts
 */
export async function captureSectionToCase({ tabId, caseRef }) {
  const ref = String(caseRef ?? "").trim();
  if (!ref) throw new Error("Enter a case reference first — captures are filed and numbered per case.");
  const { settings } = await loadState();
  const shot = await captureSection({ tabId, selectorsText: settings.sectionSelectors });

  const { path, seq, held } = await withLock(async () => {
    const now = shot.captureTime.getTime();
    const allocated = await allocateCaseFile({ caseRef: ref, originalFilename: "section.png", settings, now });
    await touchArmed(ref, now);
    return allocated;
  });

  try {
    await downloadPngBlob(path, shot.pngBase64, settings.navigationTimeoutMs);
  } catch (err) {
    await withLock(() =>
      appendLog({ at: Date.now(), status: "failed", caseRef: ref, seq, to: path, error: String((err && err.message) || err) })
    );
    throw err;
  }
  await withLock(() =>
    appendLog({
      at: Date.now(),
      status: "captured",
      caseRef: ref,
      seq,
      held,
      to: path,
      width: shot.width,
      height: shot.height,
      clipped: shot.clipped,
    })
  );
  return { path, seq, held, width: shot.width, height: shot.height, clipped: shot.clipped };
}

// --- The listener ----------------------------------------------------------------------

/**
 * The URL of the tab you're looking at as a download starts — almost always
 * the tab you clicked Export in. Download items don't say which tab they came
 * from, so this is a best guess, used only as one more site to match the
 * filter against (and the one worth adding to it: the portal's own host).
 */
async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return (tab && tab.url) || undefined;
  } catch {
    return undefined;
  }
}

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
    const hosts = downloadHosts(item, await activeTabUrl());
    const original = item.filename || "";
    const leaf = original.split(/[\\/]/).pop() || splitFilename(original).base;

    const filter = effectiveHostFilter(settings);
    if (filter.on && !passesHostFilter(hosts, filter.patterns)) {
      await appendLog({ at: now, status: "skipped", caseRef: armed.caseRef, from: leaf, hosts, reason: "host-filter" });
      return null;
    }

    const { path, seq, held } = await allocateCaseFile({ caseRef: armed.caseRef, originalFilename: original, settings, now });
    await chrome.storage.local.set({ [KEYS.arm]: { ...armed, lastActivityAt: now } });
    await appendLog({ at: now, status: "renamed", caseRef: armed.caseRef, seq, held, from: leaf, to: path, hosts });
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
