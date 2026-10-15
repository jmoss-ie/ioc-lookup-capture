// Cross-platform (Windows/macOS/Linux) path-segment sanitization for
// filenames chrome.downloads.download() will write under the browser's
// Downloads directory. Segments are joined with "/", which Chrome accepts
// cross-platform in the `filename` option to create subfolders.

const RESERVED_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Sanitize a single path segment (a folder name, or a filename WITHOUT its
 * extension). Never returns a string containing "/" or "\", never produces
 * "..", never collides with a reserved Windows device name, and never ends
 * in a trailing dot or space (which Windows silently strips/rejects).
 *
 * @param {string} raw
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function sanitizeSegment(raw, opts = {}) {
  const fallback = opts.fallback ?? "_";
  let s = String(raw ?? "");

  // Strip reserved/control characters outright.
  s = s.replace(RESERVED_CHARS_RE, "_");

  // Collapse any run of 2+ dots so ".." can never appear (also catches "...").
  s = s.replace(/\.{2,}/g, "_");

  // Trim leading/trailing whitespace, then trailing dots/spaces (Windows).
  s = s.trim().replace(/[ .]+$/g, "");
  // Also strip a leading dot run left dangling after the above (keeps hidden-file-ish
  // names like ".env" intact only if a single leading dot remains legitimate; a
  // segment that is now empty falls through to the fallback below).
  if (s === "") s = fallback;

  // Escape reserved Windows device names, case-insensitively, whole-basename match.
  if (RESERVED_WINDOWS_NAMES.has(s.toUpperCase())) {
    s = s + "_";
  }

  return s;
}

/**
 * @param {string[]} segments
 */
function joinSegments(segments) {
  return segments.filter((s) => s !== null && s !== undefined && s !== "").join("/");
}

/**
 * @param {Object} opts
 * @param {string} opts.baseFolder     e.g. "soc-evidence" (configurable)
 * @param {string} opts.hiddenPrefix   e.g. "hidden" (configurable, "-" appended automatically)
 * @param {string} opts.caseRef        may be "" — an empty case ref drops that folder level entirely
 * @param {boolean} opts.perIndicatorFolder
 * @param {string} opts.indicator      the raw indicator string (used as a folder + filename component)
 * @param {string} opts.site           site id or name
 * @param {string} opts.timestamp      filesystem-safe timestamp, e.g. 20260912T010305Z
 * @param {"png"|"json"} opts.ext
 * @returns {string} a "/"-joined relative path suitable for chrome.downloads.download's `filename`
 */
export function buildEvidencePath(opts) {
  const {
    baseFolder,
    hiddenPrefix,
    caseRef,
    perIndicatorFolder = true,
    indicator,
    site,
    timestamp,
    ext,
  } = opts;

  const indicatorSeg = sanitizeSegment(indicator);
  const siteSeg = sanitizeSegment(site);
  const tsSeg = sanitizeSegment(timestamp);
  const prefix = hiddenPrefix ? sanitizeSegment(hiddenPrefix) + "-" : "";
  const filename = `${prefix}${siteSeg}-${indicatorSeg}-${tsSeg}.${ext}`;

  const folders = [
    sanitizeSegment(baseFolder),
    caseRef ? sanitizeSegment(caseRef) : null, // empty case ref: drop this level entirely
    perIndicatorFolder ? indicatorSeg : null,
  ];

  return joinSegments([...folders, filename]);
}

/**
 * @param {Object} opts
 * @param {string} opts.baseFolder
 * @param {string} opts.caseRef
 * @param {string} opts.timestamp
 */
export function buildManifestPath({ baseFolder, caseRef, timestamp }) {
  const folders = [sanitizeSegment(baseFolder), caseRef ? sanitizeSegment(caseRef) : null];
  const filename = `manifest-${sanitizeSegment(timestamp)}.json`;
  return joinSegments([...folders, filename]);
}

/**
 * @param {Object} opts
 * @param {string} opts.baseFolder
 * @param {string} opts.caseRef
 * @param {string} opts.timestamp
 */
export function buildShaSumsPath({ baseFolder, caseRef, timestamp }) {
  const folders = [sanitizeSegment(baseFolder), caseRef ? sanitizeSegment(caseRef) : null];
  const filename = `SHA256SUMS-${sanitizeSegment(timestamp)}.txt`;
  return joinSegments([...folders, filename]);
}
