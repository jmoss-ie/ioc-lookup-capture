// An MV3 service worker is torn down after ~30s of no extension-API
// activity, and setTimeout/setInterval callbacks themselves do NOT reset
// that idle timer. A capture batch spends most of its time waiting on page
// loads and settle delays, so we poke a trivial chrome API on an interval
// for the duration of a run to keep the worker alive.

let intervalId = null;

/** @param {number} [periodMs] */
export function startKeepAlive(periodMs = 20000) {
  stopKeepAlive();
  intervalId = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, periodMs);
}

export function stopKeepAlive() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
