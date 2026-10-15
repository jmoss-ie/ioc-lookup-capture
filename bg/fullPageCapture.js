// Full-page capture backend using chrome.debugger (CDP). Empirically
// established behaviour this file relies on (see README "Chromium
// behaviour" section):
//   - The debugger must be attached BEFORE navigating, or the capture can
//     race the page's own load.
//   - Page.captureScreenshot with an explicit clip can throw on some pages;
//     fall back to Emulation.setDeviceMetricsOverride + an unclipped
//     capture.
//   - Chromium will not allocate a screenshot bitmap taller/wider than
//     16384px; clamp both axes and flag truncation.
//
// Exposed as session primitives (openSession/captureInSession/navigateOnly/
// setSessionFullscreen/closeSession) so a batch can either open a fresh
// window per job (the original behaviour) or reuse one window/tab across
// several jobs when the analyst turns on "open lookups in the same window".
// The debugger is attached once in openSession and stays attached for the
// life of the session; captureInSession/navigateOnly just re-navigate the
// same tab.

const MAX_DIMENSION = 16384;

function sendCommand(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function navigateAndSettle(tabId, { url, navigationTimeoutMs, settleMs }) {
  let loadEventResolve;
  const loadEventFired = new Promise((resolve) => {
    loadEventResolve = resolve;
  });
  const onEvent = (source, method) => {
    if (source.tabId === tabId && method === "Page.loadEventFired") loadEventResolve();
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    const navResult = await sendCommand(tabId, "Page.navigate", { url });
    if (navResult && navResult.errorText) {
      throw new Error(`Navigation failed: ${navResult.errorText}`);
    }

    await Promise.race([
      loadEventFired,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${navigationTimeoutMs}ms waiting for page load`)),
          navigationTimeoutMs
        )
      ),
    ]);

    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

/**
 * Open a debugger-attached tab that can be reused across multiple
 * navigations/captures — either a dedicated new window, or (when
 * `currentWindowId` is given) a new background tab in an existing window,
 * for the "keep lookups in my current window" setting. Either way the
 * debugger attaches to a background tab; CDP doesn't need it to be visible.
 * @param {Object} opts
 * @param {number} opts.windowWidth
 * @param {number} opts.windowHeight
 * @param {boolean} [opts.fullscreen] - maximize the window immediately
 * @param {number} [opts.currentWindowId] - open a tab here instead of a new window
 * @returns {Promise<{backend: "fullpage", windowId: number, tabId: number, ownsWindow: boolean, originalWindowState: string, fullscreen: boolean}>}
 */
export async function openSession({ windowWidth, windowHeight, fullscreen, currentWindowId }) {
  let windowId, tabId, ownsWindow, originalWindowState, initiallyMaximized;

  if (currentWindowId != null) {
    const win = await chrome.windows.get(currentWindowId);
    const tab = await chrome.tabs.create({ windowId: currentWindowId, url: "about:blank", active: false });
    windowId = currentWindowId;
    tabId = tab.id;
    ownsWindow = false;
    originalWindowState = win.state;
    initiallyMaximized = win.state === "maximized" || win.state === "fullscreen";
  } else {
    const win = await chrome.windows.create({
      url: "about:blank",
      width: windowWidth,
      height: windowHeight,
      focused: false,
      type: "normal",
    });
    windowId = win.id;
    tabId = win.tabs[0].id;
    ownsWindow = true;
    originalWindowState = "normal";
    initiallyMaximized = false;
  }

  await chrome.debugger.attach({ tabId }, "1.3");
  await sendCommand(tabId, "Page.enable");

  const session = {
    backend: "fullpage",
    windowId,
    tabId,
    ownsWindow,
    originalWindowState,
    fullscreen: initiallyMaximized,
  };
  if (fullscreen && !initiallyMaximized) await setSessionFullscreen(session, true);
  return session;
}

/**
 * Maximize or restore the session's window. "Fullscreen" here means the
 * per-site checkbox's maximize-the-window behaviour, not an in-page
 * fullscreen request to the website itself.
 */
export async function setSessionFullscreen(session, fullscreen) {
  const want = !!fullscreen;
  if (session.fullscreen === want) return;
  await chrome.windows.update(session.windowId, { state: want ? "maximized" : "normal" });
  session.fullscreen = want;
}

/** Navigate and let the page settle, without capturing anything (review mode). */
export async function navigateOnly(session, opts) {
  await navigateAndSettle(session.tabId, opts);
}

/**
 * @param {{tabId: number}} session
 * @param {Object} opts
 * @param {string} opts.url
 * @param {number} opts.navigationTimeoutMs
 * @param {number} opts.settleMs
 * @returns {Promise<{ pngBase64: string, truncated: boolean, realHeightPx: number|null, captureTime: Date }>}
 */
export async function captureInSession(session, opts) {
  const { tabId } = session;
  await navigateAndSettle(tabId, opts);
  const captureTime = new Date();

  // Layout metrics -> clip, clamped to Chromium's max bitmap dimension.
  const metrics = await sendCommand(tabId, "Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize || metrics.contentSize;
  const realHeightPx = Math.ceil(contentSize.height);
  const realWidthPx = Math.ceil(contentSize.width);
  const clipHeight = Math.min(realHeightPx, MAX_DIMENSION);
  const clipWidth = Math.min(realWidthPx, MAX_DIMENSION);
  const truncated = realHeightPx > MAX_DIMENSION || realWidthPx > MAX_DIMENSION;

  let pngBase64;
  try {
    const shot = await sendCommand(tabId, "Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: clipWidth, height: clipHeight, scale: 1 },
      captureBeyondViewport: true,
    });
    pngBase64 = shot.data;
  } catch {
    // Fallback: emulate a viewport of the clamped size and capture unclipped.
    await sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
      width: clipWidth,
      height: clipHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      const shot = await sendCommand(tabId, "Page.captureScreenshot", { format: "png" });
      pngBase64 = shot.data;
    } finally {
      await sendCommand(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }

  return {
    pngBase64,
    truncated,
    realHeightPx: truncated ? realHeightPx : null,
    captureTime,
  };
}

/**
 * Detach the debugger and close the session. A dedicated window is removed
 * outright; a tab opened in the analyst's own window is just closed (the
 * window itself is never removed), and that window's maximize state is
 * restored first if this session had changed it.
 */
export async function closeSession(session) {
  await chrome.debugger.detach({ tabId: session.tabId }).catch(() => {});
  if (session.ownsWindow) {
    await chrome.windows.remove(session.windowId).catch(() => {});
  } else {
    if (session.fullscreen) {
      await chrome.windows.update(session.windowId, { state: session.originalWindowState }).catch(() => {});
    }
    await chrome.tabs.remove(session.tabId).catch(() => {});
  }
}

/**
 * Single-shot convenience wrapper (open -> capture -> close) used by the
 * Options page's diagnostics self-test, which never reuses a window.
 * @param {Object} opts
 * @param {string} opts.url
 * @param {number} opts.windowWidth
 * @param {number} opts.windowHeight
 * @param {number} opts.navigationTimeoutMs
 * @param {number} opts.settleMs
 * @param {boolean} [opts.fullscreen]
 * @returns {Promise<{ pngBase64: string, truncated: boolean, realHeightPx: number|null, captureTime: Date }>}
 */
export async function captureFullPage(opts) {
  const session = await openSession(opts);
  try {
    return await captureInSession(session, opts);
  } finally {
    await closeSession(session);
  }
}
