// Tab/window plumbing shared by the two backends that screenshot with
// chrome.tabs.captureVisibleTab (viewport and stitched). Both navigate with
// the ordinary tabs API rather than the debugger, and both can only capture
// whichever tab is currently the visible one in its window.

/**
 * Resolves on the tab's next "complete" status for something other than the
 * about:blank placeholder every session starts on. The listener is attached
 * BEFORE the navigation is issued, so a fast page can't finish before
 * anyone is listening (the same class of race as the downloads.onChanged
 * one in downloads.js). Ignoring a "complete" for the placeholder is
 * defensive: a late event from it would otherwise look like the lookup page
 * having loaded. The stitched backend also checks for itself that the page
 * isn't still blank before measuring anything.
 */
function waitForTabComplete(tabId, targetUrl, timeoutMs) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for the page to finish loading`));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      const isPlaceholder = tab && tab.url === "about:blank" && targetUrl !== "about:blank";
      if (isPlaceholder) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    cancel = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
  });
  return { promise, cancel };
}

/** Navigate a tab, wait for its load to complete, then wait `settleMs`. */
export async function navigateAndSettle(tabId, { url, navigationTimeoutMs, settleMs }) {
  const loaded = waitForTabComplete(tabId, url, navigationTimeoutMs);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    loaded.cancel();
    throw err;
  }
  await loaded.promise;
  await new Promise((r) => setTimeout(r, settleMs));
}

/**
 * Open a tab that can be reused across multiple navigations/captures —
 * either a dedicated new window, or (when `currentWindowId` is given) a new
 * background tab in an existing window, for the "keep lookups in my current
 * window" setting.
 * @param {string} backend - recorded on the session for diagnostics
 * @param {Object} opts
 * @param {number} opts.windowWidth
 * @param {number} opts.windowHeight
 * @param {boolean} [opts.fullscreen] - maximize the window immediately
 * @param {number} [opts.currentWindowId] - open a tab here instead of a new window
 */
export async function openTabSession(backend, { windowWidth, windowHeight, fullscreen, currentWindowId }) {
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

  const session = {
    backend,
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

/**
 * Run `fn` with the session's tab as the visible tab in its window.
 *
 * In a dedicated window the tab is already the only (and so active) tab and
 * nothing changes. In the analyst's own window it has to be made the visible
 * tab first, because captureVisibleTab only ever sees the visible one — which
 * briefly steals focus from whatever tab the analyst had active. That tab is
 * restored afterwards, whether `fn` succeeded or not.
 */
export async function withTabVisible(session, fn) {
  const { tabId, windowId, ownsWindow } = session;
  let restoreActiveTabId = null;
  if (!ownsWindow) {
    const [activeTab] = await chrome.tabs.query({ windowId, active: true });
    if (activeTab && activeTab.id !== tabId) restoreActiveTabId = activeTab.id;
    await chrome.tabs.update(tabId, { active: true });
  }
  try {
    return await fn();
  } finally {
    if (restoreActiveTabId !== null) {
      await chrome.tabs.update(restoreActiveTabId, { active: true }).catch(() => {});
    }
  }
}

/**
 * Close the session. A dedicated window is removed outright; a tab opened
 * in the analyst's own window is just closed (the window itself is never
 * removed), and that window's maximize state is restored first if this
 * session had changed it.
 */
export async function closeTabSession(session) {
  if (session.ownsWindow) {
    await chrome.windows.remove(session.windowId).catch(() => {});
  } else {
    if (session.fullscreen) {
      await chrome.windows.update(session.windowId, { state: session.originalWindowState }).catch(() => {});
    }
    await chrome.tabs.remove(session.tabId).catch(() => {});
  }
}
