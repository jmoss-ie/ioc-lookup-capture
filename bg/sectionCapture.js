// "Capture section": screenshot one part of the page in the current tab — by
// default the query editor and results of the Sentinel / Log Analytics Logs
// page — the way DevTools' "Capture node screenshot" does, from one button.
//
// How:
//   1. Small scripts run in every frame of the tab (chrome.scripting,
//      allFrames). Each frame reports its viewport, the best match for the
//      configured CSS selectors, and where each of its child frames sits.
//      The Azure portal puts the Logs page in a cross-origin iframe, and
//      Chrome gives a content script no way to ask which of its <iframe>
//      elements holds a given frameId (runtime.getFrameId is Firefox-only).
//      So every frame posts a one-off nonce to its parent window, and the
//      parent matches the message's source to the <iframe> whose
//      contentWindow sent it; the nonces tie that back to frameIds.
//   2. common/sectionGeometry.js walks from the matching frame up to the top
//      frame to get the section's position in the top-level page.
//   3. chrome.tabs.captureVisibleTab screenshots the tab and the image is
//      cropped to that rectangle on an OffscreenCanvas.
//
// Only what's on screen can be captured: a section larger than the visible
// area is cut to the visible part (reported as `clipped`), and grids that
// draw only their visible rows (Log Analytics' results grid does) show only
// those rows, exactly as DevTools' node screenshot does.
//
// Needs `scripting` + `<all_urls>` — the same optional permissions the
// stitched capture backend uses, granted at runtime.

import { cropRectForImage, locateSection, parseSelectorList } from "../common/sectionGeometry.js";
import { missingPermissions } from "./permissions.js";
import { describeMissing } from "../common/backends.js";

export const SECTION_PERMISSIONS = { permissions: ["scripting"], origins: ["<all_urls>"] };

// --- Injected into every frame (each must be self-contained) --------------------------
//
// They run in the extension's isolated world. State is kept on a window
// property there, invisible to the page's own scripts. The nonce message is
// an ordinary postMessage, so the page's own message listeners can see it;
// it's a small object under a key no page would use, and carries nothing but
// a random token.

/* eslint-disable no-undef */
function installRelay(token) {
  const KEY = "__iocLookupCaptureSection";
  const st = (window[KEY] = window[KEY] || {});
  if (st.listener) window.removeEventListener("message", st.listener, true);
  st.token = token;
  st.children = {};
  st.listener = (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d[KEY] !== token || typeof d.nonce !== "string") return;
    for (const f of document.querySelectorAll("iframe, frame")) {
      if (f.contentWindow !== ev.source) continue;
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const px = (v) => parseFloat(v) || 0;
      const scaleX = f.offsetWidth ? r.width / f.offsetWidth : 1;
      const scaleY = f.offsetHeight ? r.height / f.offsetHeight : 1;
      st.children[d.nonce] = {
        x: r.left + (px(cs.borderLeftWidth) + px(cs.paddingLeft)) * scaleX,
        y: r.top + (px(cs.borderTopWidth) + px(cs.paddingTop)) * scaleY,
        width: (f.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)) * scaleX,
        height: (f.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)) * scaleY,
        scaleX,
        scaleY,
      };
      break;
    }
  };
  window.addEventListener("message", st.listener, true);
  return true;
}

function announceToParent(token) {
  const KEY = "__iocLookupCaptureSection";
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  if (window !== window.top) {
    try {
      window.parent.postMessage({ [KEY]: token, nonce }, "*");
    } catch {
      // nothing to do: this frame just won't be placeable
    }
  }
  return nonce;
}

function probeFrame(selectors, token) {
  const KEY = "__iocLookupCaptureSection";
  try {
    const de = document.documentElement;
    const viewport = {
      width: (de && de.clientWidth) || window.innerWidth,
      height: (de && de.clientHeight) || window.innerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };

    let match = null;
    for (let i = 0; i < selectors.length && !match; i++) {
      let els;
      try {
        els = document.querySelectorAll(selectors[i]);
      } catch {
        continue; // invalid selector: skip it rather than fail the whole probe
      }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const area = r.width * r.height;
        if (!match || area > match.area) {
          match = { selectorIndex: i, area, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
        }
      }
    }

    const st = window[KEY];
    const children = st && st.token === token ? { ...st.children } : {};
    return { ok: true, isTop: window === window.top, viewport, match, children };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function removeRelay() {
  const KEY = "__iocLookupCaptureSection";
  const st = window[KEY];
  if (st && st.listener) window.removeEventListener("message", st.listener, true);
  delete window[KEY];
  return true;
}
/* eslint-enable no-undef */

/** Run one of the functions above in every frame of the tab. */
async function inAllFrames(tabId, func, args = []) {
  return (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args })) || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe every frame and work out which frame is inside which <iframe>.
 * Returns the per-frame results in the shape common/sectionGeometry.js takes.
 */
async function probeTab(tabId, selectors) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await inAllFrames(tabId, installRelay, [token]);
  try {
    const announced = await inAllFrames(tabId, announceToParent, [token]);
    const frameIdByNonce = new Map();
    for (const a of announced) if (typeof a.result === "string") frameIdByNonce.set(a.result, a.frameId);
    const childFrameCount = announced.filter((a) => a.frameId !== 0).length;

    // The nonce messages arrive asynchronously; give them a moment.
    let probes = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(attempt === 0 ? 50 : 100);
      probes = await inAllFrames(tabId, probeFrame, [selectors, token]);
      let placed = 0;
      for (const p of probes) placed += p.result && p.result.children ? Object.keys(p.result.children).length : 0;
      if (placed >= childFrameCount) break;
    }

    return probes.map((p) => {
      const r = p.result;
      if (!r || !r.ok) return { frameId: p.frameId, result: r };
      const frames = [];
      for (const [nonce, box] of Object.entries(r.children || {})) {
        if (frameIdByNonce.has(nonce)) frames.push({ frameId: frameIdByNonce.get(nonce), ...box });
      }
      return { frameId: p.frameId, result: { ...r, frames } };
    });
  } finally {
    await inAllFrames(tabId, removeRelay).catch(() => {});
  }
}

// --- Image helpers ----------------------------------------------------------------------

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// --- Capture ----------------------------------------------------------------------------

/**
 * Find the configured section in a tab, screenshot the tab, and crop to it.
 *
 * @param {Object} opts
 * @param {number} opts.tabId
 * @param {string} opts.selectorsText - the Options setting, one selector per line
 * @returns {Promise<{ pngBase64: string, width: number, height: number, clipped: boolean,
 *                     captureTime: Date, pageUrl: string }>}
 */
export async function captureSection({ tabId, selectorsText }) {
  const missing = await missingPermissions(SECTION_PERMISSIONS);
  if (missing) {
    const err = new Error(`Capture section needs ${describeMissing(missing)}, which hasn't been granted.`);
    err.code = "PERMISSION";
    throw err;
  }

  const selectors = parseSelectorList(selectorsText);
  if (selectors.length === 0) {
    throw new Error("No section selectors are set. Add one in Options → Query evidence.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("That tab isn't the visible tab in its window any more.");

  let probed;
  try {
    probed = await probeTab(tabId, selectors);
  } catch (err) {
    throw new Error(`Chrome doesn't let extensions read this page: ${(err && err.message) || err}`);
  }

  const located = locateSection(probed);
  if (!located.ok) {
    if (located.reason === "not-found") {
      throw new Error(
        `${located.message} Check the page has finished loading, or set the selectors in Options → Query evidence.`
      );
    }
    throw new Error(located.message);
  }

  const captureTime = new Date();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(
    new Blob([base64ToBytes(dataUrl.split(",")[1])], { type: "image/png" })
  );
  try {
    const crop = cropRectForImage(located.rect, located.topViewport, bitmap);
    if (!crop) throw new Error("The section is outside the visible part of the tab.");
    const canvas = new OffscreenCanvas(crop.width, crop.height);
    canvas.getContext("2d").drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      pngBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      width: crop.width,
      height: crop.height,
      clipped: located.clipped,
      captureTime,
      pageUrl: tab.url || "",
    };
  } finally {
    bitmap.close();
  }
}
