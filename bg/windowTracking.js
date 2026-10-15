// Tracks capture/review sessions this extension has deliberately left open
// (because "keep windows open" was on, or because an "open for review" run
// always leaves its windows open), so the popup can show "N open" and offer
// a "Close all" action even after the service worker has been torn down and
// restarted.
//
// A tracked entry is a session descriptor, not just a window id, because
// closing it correctly depends on how it was opened:
//   - ownsWindow: true  -> a dedicated window this extension created;
//     closing it means chrome.windows.remove(windowId).
//   - ownsWindow: false -> a tab opened in the analyst's own window (the
//     "keep lookups in my current window" setting); closing it means
//     chrome.tabs.remove(tabId) and restoring that window's original
//     maximize/normal state if we changed it — the analyst's window itself
//     is never removed.
//
// chrome.storage.session is used rather than chrome.storage.local: it's
// cleared when the browser itself closes, which matches the lifetime of
// whatever this extension opened (there's no reason to remember it across
// a full browser restart, since none of it will have survived that either).

const STORAGE_KEY = "openSessions";

function hasSessionStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
}

async function readSessions() {
  if (!hasSessionStorage()) return [];
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? [];
}

async function writeSessions(list) {
  if (!hasSessionStorage()) return;
  await chrome.storage.session.set({ [STORAGE_KEY]: list });
}

/** Record a capture/review session this extension intends to leave open. */
export async function trackOpenSession(session) {
  const list = await readSessions();
  if (!list.some((s) => s.tabId === session.tabId)) {
    list.push({
      windowId: session.windowId,
      tabId: session.tabId,
      ownsWindow: !!session.ownsWindow,
      originalWindowState: session.originalWindowState || "normal",
    });
    await writeSessions(list);
  }
}

/** Stop tracking a session by its tab id (we closed it ourselves, or the analyst did). */
export async function untrackOpenSessionByTab(tabId) {
  const list = await readSessions();
  const next = list.filter((s) => s.tabId !== tabId);
  if (next.length !== list.length) {
    await writeSessions(next);
  }
}

/**
 * Tracked sessions whose tab still actually exists (lazy pruning — this
 * also covers a whole dedicated window having been closed manually, since
 * its tab disappears along with it).
 */
async function liveSessions() {
  const list = await readSessions();
  if (list.length === 0) return [];
  const alive = [];
  for (const s of list) {
    try {
      await chrome.tabs.get(s.tabId);
      alive.push(s);
    } catch {
      // Tab (and, for a dedicated window, its window) no longer exists.
    }
  }
  if (alive.length !== list.length) {
    await writeSessions(alive);
  }
  return alive;
}

/** How many open sessions are still actually open right now. */
export async function getOpenSessionCount() {
  return (await liveSessions()).length;
}

/** Close every session this extension is tracking as left-open. */
export async function closeAllOpenSessions() {
  const list = await liveSessions();
  for (const s of list) {
    if (s.ownsWindow) {
      await chrome.windows.remove(s.windowId).catch(() => {});
    } else {
      await chrome.windows.update(s.windowId, { state: s.originalWindowState }).catch(() => {});
      await chrome.tabs.remove(s.tabId).catch(() => {});
    }
  }
  await writeSessions([]);
}
