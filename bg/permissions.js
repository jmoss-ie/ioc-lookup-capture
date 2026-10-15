import { runtimePermissionsFor } from "../common/backends.js";

/** Whether the optional <all_urls> host permission is currently granted. */
export async function hasAllUrlsPermission() {
  return chrome.permissions.contains({ origins: ["<all_urls>"] });
}

/**
 * Which of `wanted` is not currently granted, or null if everything is.
 * Checked item by item so the answer can name exactly what's missing.
 * @param {{ permissions: string[], origins: string[] }} wanted
 * @returns {Promise<{ permissions: string[], origins: string[] } | null>}
 */
export async function missingPermissions(wanted) {
  const missing = { permissions: [], origins: [] };
  for (const p of wanted.permissions) {
    if (!(await chrome.permissions.contains({ permissions: [p] }))) missing.permissions.push(p);
  }
  for (const o of wanted.origins) {
    if (!(await chrome.permissions.contains({ origins: [o] }))) missing.origins.push(o);
  }
  return missing.permissions.length || missing.origins.length ? missing : null;
}

/** Runtime permission status for one backend, for the popup and Options page. */
export async function backendPermissionStatus(backendId) {
  const missing = await missingPermissions(runtimePermissionsFor(backendId));
  return { granted: !missing, missing };
}

/** Whether this build's manifest includes the `debugger` permission at all. */
export function debuggerAvailable() {
  return typeof chrome !== "undefined" && !!chrome.debugger;
}
