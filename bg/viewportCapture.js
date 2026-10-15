// Viewport capture backend using chrome.tabs.captureVisibleTab.
//
// Chromium quirk this file depends on: captureVisibleTab requires the
// literal <all_urls> host permission (a named-site permission, or even a
// fully-granted "*://*/*", is refused with "Either the <all_urls> or
// activeTab permission is required"). activeTab cannot substitute — it only
// ever covers the tab the toolbar icon was clicked on, never a tab this
// extension opened itself. <all_urls> is requested at runtime (see
// options.js) only when a captureVisibleTab-based backend is selected.
//
// Simpler than the full-page backends, but above-the-fold only.
//
// Exposed as session primitives (openSession/captureInSession/navigateOnly/
// setSessionFullscreen/closeSession) matching the other backends, so a
// batch can either open a fresh window per job or reuse one window/tab
// across several jobs. The window/tab plumbing itself lives in
// tabSession.js, shared with the stitched backend.

import { runtimePermissionsFor, describeMissing } from "../common/backends.js";
import {
  navigateAndSettle,
  openTabSession,
  setSessionFullscreen as setTabSessionFullscreen,
  withTabVisible,
  closeTabSession,
} from "./tabSession.js";
import { missingPermissions } from "./permissions.js";

/**
 * @param {Object} opts
 * @param {number} opts.windowWidth
 * @param {number} opts.windowHeight
 * @param {boolean} [opts.fullscreen] - maximize the window immediately
 * @param {number} [opts.currentWindowId] - open a tab here instead of a new window
 * @returns {Promise<{backend: "viewport", windowId: number, tabId: number, ownsWindow: boolean, originalWindowState: string, fullscreen: boolean}>}
 */
export async function openSession(opts) {
  const missing = await missingPermissions(runtimePermissionsFor("viewport"));
  if (missing) {
    throw new Error(
      `The viewport backend needs ${describeMissing(missing)}, which has not been granted. Grant it from the Options page first.`
    );
  }
  return openTabSession("viewport", opts);
}

export const setSessionFullscreen = setTabSessionFullscreen;

/** Navigate and let the page settle, without capturing anything (review mode). */
export async function navigateOnly(session, opts) {
  await navigateAndSettle(session.tabId, opts);
}

/**
 * @param {{tabId: number, windowId: number, ownsWindow: boolean}} session
 * @param {Object} opts
 * @param {string} opts.url
 * @param {number} opts.navigationTimeoutMs
 * @param {number} opts.settleMs
 * @returns {Promise<{ pngBase64: string, truncated: false, realHeightPx: null, captureTime: Date }>}
 */
export async function captureInSession(session, opts) {
  return withTabVisible(session, async () => {
    await navigateAndSettle(session.tabId, opts);
    const captureTime = new Date();
    const dataUrl = await chrome.tabs.captureVisibleTab(session.windowId, { format: "png" });
    const pngBase64 = dataUrl.split(",")[1];
    return { pngBase64, truncated: false, realHeightPx: null, captureTime };
  });
}

export const closeSession = closeTabSession;

/**
 * Single-shot convenience wrapper (open -> capture -> close).
 * @param {Object} opts
 */
export async function captureViewport(opts) {
  const session = await openSession(opts);
  try {
    return await captureInSession(session, opts);
  } finally {
    await closeSession(session);
  }
}
