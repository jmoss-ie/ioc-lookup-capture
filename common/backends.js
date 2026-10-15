// Capture-backend registry: ids, what each one needs from Chrome's
// permission system, and how a saved setting resolves to the backend that
// will actually run. Pure data/logic with no chrome.* calls, so it's
// unit-tested directly under Node and shared by the service worker, the
// popup, and the Options page.

/** @typedef {"fullpage"|"stitched"|"viewport"} BackendId */

/** @type {BackendId[]} */
export const BACKEND_IDS = ["fullpage", "stitched", "viewport"];

/** Short names for status lines and messages (the Options radios spell out the APIs). */
export const BACKEND_LABELS = {
  fullpage: "Full page (debugger)",
  stitched: "Full page (stitched)",
  viewport: "Viewport",
};

/**
 * Permissions each backend needs beyond the always-required set
 * (tabs/downloads/storage/offscreen), in the shape chrome.permissions takes.
 * `debugger` is listed for completeness but can never be requested at
 * runtime — Chrome only allows it as an install-time permission — so a
 * build either ships it in the manifest or doesn't have the full-page
 * (debugger) backend at all.
 */
const RUNTIME_PERMISSIONS = {
  fullpage: { permissions: [], origins: [] },
  stitched: { permissions: ["scripting"], origins: ["<all_urls>"] },
  viewport: { permissions: [], origins: ["<all_urls>"] },
};

/**
 * The optional permissions a backend needs granted at runtime.
 * @param {string} backendId
 * @returns {{ permissions: string[], origins: string[] }}
 */
export function runtimePermissionsFor(backendId) {
  const entry = RUNTIME_PERMISSIONS[backendId] || RUNTIME_PERMISSIONS.fullpage;
  return { permissions: [...entry.permissions], origins: [...entry.origins] };
}

/** Whether a backend needs anything granted at runtime at all. */
export function needsRuntimePermissions(backendId) {
  const p = runtimePermissionsFor(backendId);
  return p.permissions.length > 0 || p.origins.length > 0;
}

/**
 * Which backend will actually run for a saved setting.
 *
 * The full-page (debugger) backend only exists in builds whose manifest
 * includes the `debugger` permission. In a build without it, a saved
 * "fullpage" setting (including the shipped default) resolves to
 * "stitched", the other backend that captures the whole page. Unknown
 * values resolve the same way an unset one would.
 *
 * @param {string|undefined} savedBackend
 * @param {{ debuggerAvailable: boolean }} env
 * @returns {BackendId}
 */
export function resolveBackend(savedBackend, { debuggerAvailable }) {
  const id = BACKEND_IDS.includes(savedBackend) ? savedBackend : "fullpage";
  if (id === "fullpage" && !debuggerAvailable) return "stitched";
  return id;
}

/**
 * Human-readable list of what's missing, for UI messages.
 * @param {{ permissions: string[], origins: string[] }} missing
 */
export function describeMissing(missing) {
  const parts = [];
  if (missing.origins.includes("<all_urls>")) parts.push('"All sites" (<all_urls>)');
  for (const p of missing.permissions) parts.push(p);
  return parts.join(" and ");
}
