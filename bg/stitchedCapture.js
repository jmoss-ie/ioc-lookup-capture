// Stitched full-page capture backend: scroll the page one screen at a
// time, screenshot each screen with chrome.tabs.captureVisibleTab, and
// join the screenshots into one PNG on an OffscreenCanvas.
//
// This exists as an alternative to the chrome.debugger backend for anyone
// who doesn't want the debugger attached (no "started debugging this
// browser" banner), or for a build of this extension without the
// `debugger` permission at all. It needs the same runtime <all_urls> grant
// as the viewport backend (captureVisibleTab requires that exact pattern —
// see viewportCapture.js) plus `scripting`, to run the small scroll/measure
// functions below inside the lookup page.
//
// Behaviour this file relies on, and works around:
//   - captureVisibleTab is rate-limited (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
//     2 in current Chrome). Calls are spaced out to respect it, so a
//     stitched capture takes roughly half a second per screen of page.
//   - It only sees the visible tab, so (as with the viewport backend) a tab
//     in the analyst's own window is briefly made active for the capture.
//   - Fixed-position elements (headers, cookie bars, chat buttons) would be
//     repeated in every screenshot. They're hidden while the middle of the
//     page is captured: ones in the top half of the screen appear only in
//     the first screenshot, ones in the bottom half only in the last.
//     Fixed elements covering most of the screen (backdrops) are left alone.
//   - Sticky elements would also repeat once stuck. They're switched to
//     position: relative (with their offsets cleared) for the duration of
//     the capture, which is where they sit before they stick anyway.
//   - Some app-style pages don't scroll the document at all; an inner panel
//     scrolls instead. When the document can't scroll, the largest visible
//     scrolling element is used: everything above the panel is taken once
//     from the first screenshot, the panel's whole content is stitched below
//     it, and anything below the panel is taken once from the last
//     screenshot. Areas beside the panel (sidebars) appear only for the
//     first screen's height.
//   - Scrollbars are hidden during the capture (otherwise every screenshot
//     would carry its own scrollbar, at a different position), smooth
//     scrolling and scroll snapping are turned off, and everything this
//     changes in the page is put back afterwards.
//   - Output is clamped at 16384px on either axis, like the debugger
//     backend, and flagged as truncated when that cuts the page short — or
//     when the page grew taller while it was being captured.

import { runtimePermissionsFor, describeMissing } from "../common/backends.js";
import { planStitchTiles } from "../common/stitchPlan.js";
import {
  navigateAndSettle,
  openTabSession,
  setSessionFullscreen as setTabSessionFullscreen,
  withTabVisible,
  closeTabSession,
} from "./tabSession.js";
import { missingPermissions } from "./permissions.js";

const MAX_DIMENSION = 16384;
const CALLS_PER_SECOND =
  (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) || 2;
// A little headroom over the documented limit, so timer jitter never trips it.
const MIN_CAPTURE_INTERVAL_MS = Math.ceil(1000 / CALLS_PER_SECOND) + 60;

let lastCaptureAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureVisibleRateLimited(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    // Only the quota error is worth one retry; anything else is real.
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String((err && err.message) || err))) throw err;
    await sleep(1000);
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } finally {
    lastCaptureAt = Date.now();
  }
}

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

async function dataUrlToBitmap(dataUrl) {
  const blob = new Blob([base64ToBytes(dataUrl.split(",")[1])], { type: "image/png" });
  return createImageBitmap(blob);
}

// --- Functions injected into the lookup page ----------------------------------------
//
// chrome.scripting serializes these, so each must be self-contained (no
// references to anything outside its own body). They run in the
// extension's isolated world: the page's own scripts can't see or touch
// the state object stored on `window` here, though both share the DOM.

/* eslint-disable no-undef */
async function pagePrepare() {
  const KEY = "__iocLookupCaptureStitch";
  try {
    if (location.href === "about:blank") {
      return { ok: false, error: "the lookup page hadn't started loading (the tab was still blank)" };
    }
    if (document.readyState !== "complete") {
      await new Promise((resolve) => {
        window.addEventListener("load", resolve, { once: true });
        setTimeout(resolve, 10000);
      });
    }
    if (window[KEY]) {
      try {
        window[KEY].restore();
      } catch {
        // stale state from an interrupted capture; carry on
      }
    }

    const root = document.scrollingElement || document.documentElement;
    const state = {
      mode: "none",
      scroller: null,
      styleChanges: [],
      fixed: new Map(),
      stickyDone: new WeakSet(),
      styleEl: null,
      origDoc: { x: window.scrollX, y: window.scrollY },
      origScrollerTop: 0,
    };

    const setImportant = (el, prop, value) => {
      state.styleChanges.push({
        el,
        prop,
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      });
      el.style.setProperty(prop, value, "important");
    };
    const restoreStyles = () => {
      for (let i = state.styleChanges.length - 1; i >= 0; i--) {
        const c = state.styleChanges[i];
        if (c.value) c.el.style.setProperty(c.prop, c.value, c.priority);
        else c.el.style.removeProperty(c.prop);
      }
      state.styleChanges = [];
    };
    function* allElements(scope) {
      for (const el of scope.querySelectorAll("*")) {
        yield el;
        if (el.shadowRoot) yield* allElements(el.shadowRoot);
      }
    }
    // Two animation frames is the usual "the browser has painted this" wait.
    // The timeout is a fallback in case frames are throttled.
    const nextFrame = () =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 150);
      });

    const viewport = () => ({
      width: root.clientWidth,
      height: root.clientHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });

    const neutralizeSticky = () => {
      for (const el of allElements(document)) {
        if (state.stickyDone.has(el)) continue;
        const pos = getComputedStyle(el).position;
        if (pos === "sticky" || pos === "-webkit-sticky") {
          state.stickyDone.add(el);
          setImportant(el, "position", "relative");
          for (const side of ["top", "right", "bottom", "left"]) setImportant(el, side, "auto");
        }
      }
    };

    const scanFixed = () => {
      const vp = viewport();
      for (const el of allElements(document)) {
        if (state.fixed.has(el)) continue;
        if (getComputedStyle(el).position !== "fixed") continue;
        const r = el.getBoundingClientRect();
        const visibleH = Math.min(r.bottom, vp.innerHeight) - Math.max(r.top, 0);
        const visibleW = Math.min(r.right, vp.innerWidth) - Math.max(r.left, 0);
        if (visibleH <= 0 || visibleW <= 0) continue; // not on screen (yet)
        let side;
        if (r.height >= vp.innerHeight * 0.9) side = "always"; // backdrop / overlay
        else side = r.top + r.height / 2 < vp.innerHeight / 2 ? "top" : "bottom";
        state.fixed.set(el, {
          side,
          value: el.style.getPropertyValue("opacity"),
          priority: el.style.getPropertyPriority("opacity"),
        });
      }
    };

    const showFixed = (el, info) => {
      if (info.value) el.style.setProperty("opacity", info.value, info.priority);
      else el.style.removeProperty("opacity");
    };

    const applyPhase = (phase) => {
      for (const [el, info] of state.fixed) {
        let visible;
        if (info.side === "always" || phase === "only") visible = true;
        else if (phase === "first") visible = info.side === "top";
        else if (phase === "last") visible = info.side === "bottom";
        else visible = false;
        if (visible) showFixed(el, info);
        else el.style.setProperty("opacity", "0", "important");
      }
    };

    const contentHeight = () => {
      if (state.mode === "element") return state.scroller.scrollHeight;
      if (state.mode === "document") return root.scrollHeight;
      return root.clientHeight;
    };

    const scrollTarget = (y) => {
      if (state.mode === "document") window.scrollTo({ top: y, left: 0, behavior: "instant" });
      else if (state.mode === "element") state.scroller.scrollTo({ top: y, behavior: "instant" });
    };
    const currentScroll = () => {
      if (state.mode === "document") return window.scrollY;
      if (state.mode === "element") return state.scroller.scrollTop;
      return 0;
    };

    state.step = async (y, phase) => {
      scrollTarget(y);
      await nextFrame();
      neutralizeSticky();
      scanFixed();
      applyPhase(phase);
      await nextFrame();
      return { y: currentScroll(), contentHeight: contentHeight() };
    };
    state.measure = () => ({ contentHeight: contentHeight() });
    state.restore = () => {
      for (const [el, info] of state.fixed) showFixed(el, info);
      state.fixed.clear();
      restoreStyles();
      if (state.styleEl) state.styleEl.remove();
      if (state.scroller) {
        state.scroller.removeAttribute("data-ioc-capture-scroller");
        state.scroller.scrollTo({ top: state.origScrollerTop, behavior: "instant" });
      }
      window.scrollTo({ top: state.origDoc.y, left: state.origDoc.x, behavior: "instant" });
      delete window[KEY];
    };
    window[KEY] = state;

    // Hide scrollbars, turn off smooth scrolling and scroll snapping.
    // (scrollbar-width covers current Chrome; the ::-webkit-scrollbar rule
    // covers versions before 121.)
    state.styleEl = document.createElement("style");
    state.styleEl.textContent =
      "html::-webkit-scrollbar, body::-webkit-scrollbar, [data-ioc-capture-scroller]::-webkit-scrollbar" +
      " { display: none !important; width: 0 !important; height: 0 !important; }";
    (document.head || document.documentElement).appendChild(state.styleEl);
    for (const el of [document.documentElement, document.body].filter(Boolean)) {
      setImportant(el, "scrollbar-width", "none");
      setImportant(el, "scroll-behavior", "auto");
      setImportant(el, "scroll-snap-type", "none");
    }
    await nextFrame();

    // Decide what scrolls: the document itself, or an inner panel.
    const lockedValues = ["hidden", "clip"];
    const htmlOverflow = getComputedStyle(document.documentElement).overflowY;
    const bodyOverflow = document.body ? getComputedStyle(document.body).overflowY : "visible";
    const locked = lockedValues.includes(htmlOverflow) || lockedValues.includes(bodyOverflow);
    if (!locked && root.scrollHeight > root.clientHeight + 1) {
      state.mode = "document";
    } else {
      const vp = viewport();
      const viewportArea = vp.innerWidth * vp.innerHeight;
      let best = null;
      let bestArea = 0;
      for (const el of allElements(document)) {
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const oy = getComputedStyle(el).overflowY;
        if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, vp.innerWidth) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vp.innerHeight) - Math.max(r.top, 0));
        const area = w * h;
        if (area >= viewportArea * 0.25 && area > bestArea) {
          best = el;
          bestArea = area;
        }
      }
      if (best) {
        state.mode = "element";
        state.scroller = best;
        state.origScrollerTop = best.scrollTop;
        best.setAttribute("data-ioc-capture-scroller", "");
        setImportant(best, "scrollbar-width", "none");
        setImportant(best, "scroll-behavior", "auto");
        setImportant(best, "scroll-snap-type", "none");
      }
    }

    // Start from the top, with sticky elements already unstuck.
    scrollTarget(0);
    await nextFrame();
    neutralizeSticky();
    await nextFrame();

    const vp = viewport();
    const result = {
      ok: true,
      mode: state.mode,
      viewportWidth: vp.width,
      viewportHeight: vp.height,
      innerWidth: vp.innerWidth,
      innerHeight: vp.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      contentHeight: contentHeight(),
    };
    if (state.mode === "element") {
      const r = state.scroller.getBoundingClientRect();
      result.panel = {
        left: r.left + state.scroller.clientLeft,
        top: r.top + state.scroller.clientTop,
        width: state.scroller.clientWidth,
        height: state.scroller.clientHeight,
      };
    }
    return result;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function pageStep(y, phase) {
  const state = window.__iocLookupCaptureStitch;
  if (!state) return { ok: false, error: "capture state lost (did the page navigate during capture?)" };
  try {
    return { ok: true, ...(await state.step(y, phase)) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function pageMeasure() {
  const state = window.__iocLookupCaptureStitch;
  if (!state) return { ok: false, error: "capture state lost (did the page navigate during capture?)" };
  return { ok: true, ...state.measure() };
}

function pageRestore() {
  const state = window.__iocLookupCaptureStitch;
  if (state) state.restore();
  return { ok: true };
}
/* eslint-enable no-undef */

async function runInPage(tabId, func, args = []) {
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (err) {
    throw new Error(
      `Stitched capture could not run its scroll script on this page: ${(err && err.message) || err}`
    );
  }
  const result = injection && injection.result;
  if (!result) throw new Error("Stitched capture: the page script returned no result.");
  if (!result.ok) throw new Error(`Stitched capture: ${result.error}`);
  return result;
}

// --- Session primitives ---------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {number} opts.windowWidth
 * @param {number} opts.windowHeight
 * @param {boolean} [opts.fullscreen] - maximize the window immediately
 * @param {number} [opts.currentWindowId] - open a tab here instead of a new window
 */
export async function openSession(opts) {
  const missing = await missingPermissions(runtimePermissionsFor("stitched"));
  if (missing) {
    throw new Error(
      `The stitched full-page backend needs ${describeMissing(missing)}, which has not been granted. Grant it from the Options page first.`
    );
  }
  return openTabSession("stitched", opts);
}

export const setSessionFullscreen = setTabSessionFullscreen;

/** Navigate and let the page settle, without capturing anything (review mode). */
export async function navigateOnly(session, opts) {
  await navigateAndSettle(session.tabId, opts);
}

/**
 * Scroll, capture each screen, and stitch. Called with the tab visible.
 * @returns {Promise<{ pngBase64: string, truncated: boolean, realHeightPx: number|null, captureTime: Date, tiles: number }>}
 */
async function stitchCurrentPage(session) {
  const { tabId, windowId } = session;

  // Preparation is inside the try: if it fails partway (after it has
  // already hidden scrollbars, say), the finally still puts the page back.
  try {
    const prep = await runInPage(tabId, pagePrepare);
    const captureTime = new Date();

    // --- Nothing scrolls: one screenshot is the whole page. -------------------------
    // Everything stays visible, and Chrome's own PNG is handed back unchanged.
    if (prep.mode === "none") {
      await runInPage(tabId, pageStep, [0, "only"]);
      const onlyDataUrl = await captureVisibleRateLimited(windowId);
      return { pngBase64: onlyDataUrl.split(",")[1], truncated: false, realHeightPx: null, captureTime, tiles: 1 };
    }

    const firstStep = await runInPage(tabId, pageStep, [0, "first"]);
    const firstDataUrl = await captureVisibleRateLimited(windowId);
    const firstBitmap = await dataUrlToBitmap(firstDataUrl);

    // Device pixels per CSS pixel. The screenshot should be the page's
    // viewport at that ratio; if it isn't, the window changed size between
    // measuring and capturing, and stitching would misplace every tile.
    // Fail clearly instead of producing a subtly wrong image.
    const scale = prep.devicePixelRatio;
    const tolerance = Math.ceil(scale) + 1;
    const expectedWidth = prep.innerWidth * scale;
    if (Math.abs(firstBitmap.width - expectedWidth) > tolerance) {
      const got = firstBitmap.width;
      firstBitmap.close();
      throw new Error(
        `The capture window changed size during the capture (page reported ${prep.innerWidth}px × ${scale}, ` +
          `screenshot was ${got}px wide). Try again, and leave the window alone while it runs.`
      );
    }
    const tileWidth = firstBitmap.width;
    const tileHeight = firstBitmap.height;
    const maxCss = Math.floor(MAX_DIMENSION / scale);

    // --- Plan the scroll positions. ---------------------------------------------------
    let panel = null;
    let below = 0;
    let plan;
    if (prep.mode === "element") {
      panel = prep.panel;
      below = Math.max(0, prep.innerHeight - (panel.top + panel.height));
      plan = planStitchTiles({
        contentHeight: prep.contentHeight,
        viewportHeight: panel.height,
        maxContentHeight: maxCss - Math.ceil(panel.top) - Math.ceil(below),
      });
    } else {
      plan = planStitchTiles({
        contentHeight: prep.contentHeight,
        viewportHeight: prep.viewportHeight,
        maxContentHeight: maxCss,
      });
    }

    const cssHeight =
      prep.mode === "element"
        ? panel.top + plan.capturedHeight + (plan.truncated ? 0 : below)
        : plan.capturedHeight;
    const canvasWidth = firstBitmap.width;
    const canvasHeight = Math.min(MAX_DIMENSION, Math.round(cssHeight * scale));

    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error(`Could not allocate a ${canvasWidth}×${canvasHeight} canvas for stitching.`);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const px = (v) => Math.round(v * scale);

    const drawTile = (bitmap, scrolledY, isFirst, isLast) => {
      if (prep.mode === "document") {
        ctx.drawImage(bitmap, 0, px(scrolledY));
        return;
      }
      // Inner-panel mode.
      const sx = px(panel.left);
      const sy = px(panel.top);
      const sw = Math.min(px(panel.width), bitmap.width - sx);
      const sh = Math.min(px(panel.height), bitmap.height - sy);
      if (isFirst) {
        // Everything from the top of the screen to the bottom of the panel.
        const h = Math.min(bitmap.height, sy + sh);
        ctx.drawImage(bitmap, 0, 0, bitmap.width, h, 0, 0, bitmap.width, h);
      }
      ctx.drawImage(bitmap, sx, sy, sw, sh, sx, px(panel.top + scrolledY), sw, sh);
      if (isLast && !plan.truncated && below > 0) {
        // Whatever sits under the panel (a footer bar), once, at the very end.
        const srcY = sy + sh;
        const h = bitmap.height - srcY;
        if (h > 0) {
          ctx.drawImage(bitmap, 0, srcY, bitmap.width, h, 0, px(panel.top + plan.capturedHeight), bitmap.width, h);
        }
      }
    };

    // Tile 0 was already captured above, at the "first" phase.
    const n = plan.tiles.length;
    drawTile(firstBitmap, firstStep.y, true, n === 1);
    firstBitmap.close();

    for (let i = 1; i < n; i++) {
      const tile = plan.tiles[i];
      const step = await runInPage(tabId, pageStep, [tile.y, tile.phase]);
      const dataUrl = await captureVisibleRateLimited(windowId);
      const bitmap = await dataUrlToBitmap(dataUrl);
      if (bitmap.width !== tileWidth || bitmap.height !== tileHeight) {
        const got = `${bitmap.width}×${bitmap.height}`;
        bitmap.close();
        throw new Error(
          `The capture window changed size partway through (screenshot ${i + 1} of ${n} was ` +
            `${got}, the first was ${tileWidth}×${tileHeight}). ` +
            "Try again, and leave the window alone while it runs."
        );
      }
      drawTile(bitmap, step.y, false, i === n - 1);
      bitmap.close();
    }

    // Did the page grow while it was being captured (lazy loading, infinite
    // scroll)? If so, the image doesn't hold all of it — say so.
    const after = await runInPage(tabId, pageMeasure);
    let truncated = plan.truncated;
    let realCssHeight = prep.mode === "element" ? panel.top + prep.contentHeight + below : prep.contentHeight;
    if (after.contentHeight > prep.contentHeight + 1) {
      truncated = true;
      realCssHeight += after.contentHeight - prep.contentHeight;
    }

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const pngBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    return {
      pngBase64,
      truncated,
      realHeightPx: truncated ? Math.round(realCssHeight * scale) : null,
      captureTime,
      tiles: n,
    };
  } finally {
    await runInPage(tabId, pageRestore).catch(() => {});
  }
}

/**
 * @param {{tabId: number, windowId: number, ownsWindow: boolean}} session
 * @param {Object} opts
 * @param {string} opts.url
 * @param {number} opts.navigationTimeoutMs
 * @param {number} opts.settleMs
 * @returns {Promise<{ pngBase64: string, truncated: boolean, realHeightPx: number|null, captureTime: Date }>}
 */
export async function captureInSession(session, opts) {
  return withTabVisible(session, async () => {
    await navigateAndSettle(session.tabId, opts);
    return stitchCurrentPage(session);
  });
}

export const closeSession = closeTabSession;

/**
 * Single-shot convenience wrapper (open -> capture -> close).
 * @param {Object} opts
 */
export async function captureStitched(opts) {
  const session = await openSession(opts);
  try {
    return await captureInSession(session, opts);
  } finally {
    await closeSession(session);
  }
}
