import { DEFAULT_SITES } from "./defaultSites.js";
import { DEFAULT_EXPORT_SUBFOLDER, DEFAULT_EXPORT_TEMPLATE } from "./exportNaming.js";

export const DEFAULT_SETTINGS = {
  baseFolder: "soc-evidence",
  hiddenPrefix: "",
  perIndicatorFolder: true,
  // "fullpage" (chrome.debugger) | "stitched" (scroll + captureVisibleTab) | "viewport".
  // Full page is the default; in a build without the `debugger` permission
  // it resolves to "stitched" instead (see common/backends.js).
  captureBackend: "fullpage",
  settleMsOverride: null, // null = use each site's own settleMs
  navigationTimeoutMs: 30000,
  captureWindowWidth: 1440,
  captureWindowHeight: 1080,
  selfTestUrl: "https://example.com/",
  reuseWindow: false, // true = one window/tab reused across every job in a batch
  keepWindowsOpen: false, // true = don't close capture windows when a batch finishes
  useCurrentWindow: false, // true = open lookups as tabs in the window the run was started from, not a new window
  // "Rename exports" (see bg/exportRenamer.js and common/exportNaming.js).
  exportTemplate: DEFAULT_EXPORT_TEMPLATE,
  exportSubfolder: DEFAULT_EXPORT_SUBFOLDER, // "" = straight into the case folder
  exportHostFilter: "", // blank = rename every download while renaming is on
  exportAutoStopMinutes: 60, // switch renaming off after this long with no export; 0 = never
};

/**
 * Merge the extension's current built-in site list into the analyst's saved
 * list WITHOUT resurrecting defaults the analyst deliberately deleted.
 *
 * A default is only added if its id was never seen before (i.e. is new to
 * this extension version) — never merely because it's "missing" from the
 * saved list, since "missing" is indistinguishable from "deleted" without
 * this tracking.
 *
 * @param {Array<object>} savedSites - analyst's current saved site list (their edits intact)
 * @param {string[]} knownDefaultIds - default ids that existed the last time this ran
 * @param {Array<object>} [currentDefaultSites] - defaults to reconcile against (DI for tests)
 * @returns {{ sites: object[], knownDefaultIds: string[] }}
 */
export function mergeSites(savedSites, knownDefaultIds, currentDefaultSites = DEFAULT_SITES) {
  const savedIds = new Set(savedSites.map((s) => s.id));
  const knownIds = new Set(knownDefaultIds || []);

  const additions = currentDefaultSites.filter((d) => !knownIds.has(d.id) && !savedIds.has(d.id));

  const mergedSites = [...savedSites, ...additions.map((d) => ({ ...d }))];
  const newKnownDefaultIds = currentDefaultSites.map((d) => d.id);

  return { sites: mergedSites, knownDefaultIds: newKnownDefaultIds };
}

const STORAGE_KEYS = {
  sites: "sites",
  knownDefaultIds: "knownDefaultIds",
  settings: "settings",
};

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}

/**
 * Load sites + settings, running the safe default-merge exactly once per
 * call, and persist the merge result. Falls back to fresh defaults when
 * chrome.storage is unavailable (e.g. under a plain Node test import).
 * @returns {Promise<{ sites: object[], settings: object }>}
 */
export async function loadState() {
  if (!hasChromeStorage()) {
    return { sites: DEFAULT_SITES.map((d) => ({ ...d })), settings: { ...DEFAULT_SETTINGS } };
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.sites,
    STORAGE_KEYS.knownDefaultIds,
    STORAGE_KEYS.settings,
  ]);

  const savedSites = stored[STORAGE_KEYS.sites] ?? null;
  const knownDefaultIds = stored[STORAGE_KEYS.knownDefaultIds] ?? [];
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] ?? {}) };

  if (savedSites === null) {
    // First run: seed with the full default set.
    const sites = DEFAULT_SITES.map((d) => ({ ...d }));
    const ids = DEFAULT_SITES.map((d) => d.id);
    await chrome.storage.local.set({
      [STORAGE_KEYS.sites]: sites,
      [STORAGE_KEYS.knownDefaultIds]: ids,
    });
    return { sites, settings };
  }

  const { sites, knownDefaultIds: newKnownDefaultIds } = mergeSites(savedSites, knownDefaultIds);
  if (sites.length !== savedSites.length) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.sites]: sites,
      [STORAGE_KEYS.knownDefaultIds]: newKnownDefaultIds,
    });
  } else if (JSON.stringify(newKnownDefaultIds) !== JSON.stringify(knownDefaultIds)) {
    await chrome.storage.local.set({ [STORAGE_KEYS.knownDefaultIds]: newKnownDefaultIds });
  }

  return { sites, settings };
}

/** @param {object[]} sites */
export async function saveSites(sites) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.sites]: sites });
}

/** @param {object} settings */
export async function saveSettings(settings) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}
