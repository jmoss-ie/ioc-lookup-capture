// The filenames this extension asked for on its own downloads (screenshots,
// run manifest, checksum file), keyed by download URL.
//
// Why this exists: while this extension has a
// chrome.downloads.onDeterminingFilename listener registered (i.e. while
// "Rename exports" is on), Chromium no longer honours the `filename` this
// same extension passes to chrome.downloads.download(). The listener is
// handed Chromium's own default name instead ("download.txt" for a data:
// URL), and that default is what gets saved unless the listener suggests
// the intended name back. Observed directly in Chromium; see README
// "Chromium behaviour this extension is built around".
//
// So every download this extension starts is registered here first, and
// the listener in bg/exportRenamer.js suggests the registered filename back
// for it. The entry is always removed again once the download call is
// finished, whether or not a listener ever consumed it.

const expected = new Map(); // url -> Array<{ filename, conflictAction }>

/**
 * Record the filename for a download this extension is about to start.
 * Call before chrome.downloads.download().
 */
export function expectOwnDownload(url, filename, conflictAction = "uniquify") {
  const queue = expected.get(url) || [];
  queue.push({ filename, conflictAction });
  expected.set(url, queue);
}

/** Take (and remove) the oldest registered filename for this URL, if any. */
export function takeOwnDownload(url) {
  const queue = expected.get(url);
  if (!queue || queue.length === 0) return null;
  const entry = queue.shift();
  if (queue.length === 0) expected.delete(url);
  return entry;
}

/** Drop a registration that was never consumed (no listener was attached). */
export function forgetOwnDownload(url, filename) {
  const queue = expected.get(url);
  if (!queue) return;
  const i = queue.findIndex((e) => e.filename === filename);
  if (i !== -1) queue.splice(i, 1);
  if (queue.length === 0) expected.delete(url);
}
