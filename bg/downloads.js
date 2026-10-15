// Download plumbing. Three Chromium quirks drive this file's shape:
//   1. Offscreen documents have chrome.runtime and nothing else — calling
//      chrome.downloads from one fails. Service workers have no
//      URL.createObjectURL. So: mint the blob URL in the offscreen document,
//      issue the download from the service worker, revoke only once the
//      download has reached a terminal state (revoking earlier cancels it).
//   2. Do not rely on downloads.onChanged alone — a small file can finish
//      before the listener attaches. Poll downloads.search for the terminal
//      state instead.
//   3. chrome.offscreen.createDocument() can resolve before the document's
//      own script has actually run and registered its onMessage listener
//      (worse for a `type="module"` script, which is deferred like
//      `defer`). Messaging it immediately after creation can race that and
//      fail with "Could not establish connection. Receiving end does not
//      exist." — observed in practice as the very first capture in a run
//      failing to get a response from the offscreen document. Fixed here by
//      PING-ing it and waiting for a real response before trusting it with
//      any work, and recreating it if an already-existing document turns
//      out not to be responsive.

const OFFSCREEN_JUSTIFICATION =
  "Mint object URLs for screenshot PNG downloads (service workers cannot call URL.createObjectURL).";

async function offscreenDocumentExists() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return !!contexts && contexts.length > 0;
}

/** Resolves once the offscreen document answers a PING; throws if it never does. */
async function waitForOffscreenReady(maxAttempts = 20, delayMs = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "PING" });
      if (res && res.pong) return;
    } catch {
      // No listener yet (or a transient messaging error) — retry.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("The offscreen document never became responsive (no response to PING).");
}

async function createOffscreenDocument() {
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: OFFSCREEN_JUSTIFICATION,
  });
}

async function ensureOffscreenDocument() {
  const existed = await offscreenDocumentExists();
  if (!existed) {
    await createOffscreenDocument();
  }
  try {
    await waitForOffscreenReady();
  } catch (err) {
    if (!existed) throw err; // freshly created and still unresponsive — nothing left to try
    // An existing document that isn't answering (e.g. left over from before
    // an extension reload) — recreate it and give it one more chance.
    await chrome.offscreen.closeDocument().catch(() => {});
    await createOffscreenDocument();
    await waitForOffscreenReady();
  }
}

/**
 * Send a message to the offscreen document, retrying a few times on a
 * transient messaging failure before giving up with a clear error.
 */
async function sendToOffscreen(message, { retries = 3, delayMs = 150 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response) return response;
      lastError = new Error("empty response");
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `No response from the offscreen document for "${message.type}" after ${retries + 1} attempt(s): ${
      (lastError && lastError.message) || lastError
    }`
  );
}

/**
 * @param {number} downloadId
 * @param {number} [timeoutMs]
 * @param {number} [pollMs]
 * @returns {Promise<chrome.downloads.DownloadItem>}
 */
export async function pollDownloadUntilDone(downloadId, timeoutMs = 60000, pollMs = 250) {
  const start = Date.now();
  for (;;) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items[0];
    if (item && (item.state === "complete" || item.state === "interrupted")) {
      return item;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for download ${downloadId}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * @param {string} filename - "/"-joined relative path under the Downloads folder
 * @param {string} base64Png - raw base64 (no data: prefix)
 * @param {number} timeoutMs
 */
export async function downloadPngBlob(filename, base64Png, timeoutMs) {
  await ensureOffscreenDocument();
  const mintResponse = await sendToOffscreen({
    target: "offscreen",
    type: "MINT_BLOB_URL",
    base64: base64Png,
    mimeType: "image/png",
  });
  if (!mintResponse.blobUrl) {
    throw new Error(
      `Offscreen document failed to mint a blob URL for the screenshot: ${mintResponse.error || "unknown reason"}`
    );
  }
  const { blobUrl } = mintResponse;
  let item;
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    item = await pollDownloadUntilDone(downloadId, timeoutMs);
  } finally {
    // Revoke only after the download reaches a terminal state.
    await sendToOffscreen({ target: "offscreen", type: "REVOKE_BLOB_URL", url: blobUrl }).catch(
      () => {}
    );
  }
  if (item.state !== "complete") {
    throw new Error(`Screenshot download was interrupted: ${item.error || "unknown reason"}`);
  }
  return item;
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/**
 * @param {string} filename
 * @param {string} text
 * @param {string} mimeType
 * @param {number} timeoutMs
 */
export async function downloadText(filename, text, mimeType, timeoutMs) {
  const dataUrl = `data:${mimeType};charset=utf-8;base64,${utf8ToBase64(text)}`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  const item = await pollDownloadUntilDone(downloadId, timeoutMs);
  if (item.state !== "complete") {
    throw new Error(`Download of ${filename} was interrupted: ${item.error || "unknown reason"}`);
  }
  return item;
}
