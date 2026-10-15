// Offscreen documents have chrome.runtime and essentially nothing else —
// no chrome.downloads. Service workers, in turn, have no
// URL.createObjectURL. So the blob is minted HERE and only its URL crosses
// back to the service worker, which issues the actual download.

function base64ToBlob(base64, mimeType) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return undefined;

  if (message.type === "PING") {
    // Used by the service worker to confirm this document's listener is
    // actually registered before trusting it with real work — see the
    // "offscreen readiness race" note in bg/downloads.js.
    sendResponse({ pong: true });
    return true;
  }

  if (message.type === "MINT_BLOB_URL") {
    try {
      const blob = base64ToBlob(message.base64, message.mimeType || "application/octet-stream");
      const blobUrl = URL.createObjectURL(blob);
      sendResponse({ blobUrl });
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
    return true;
  }

  if (message.type === "REVOKE_BLOB_URL") {
    try {
      URL.revokeObjectURL(message.url);
    } catch {
      // ignore
    }
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});
