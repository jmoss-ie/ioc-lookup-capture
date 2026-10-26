// Naming rules for "Rename exports": downloads started by other pages (a
// Sentinel/Log Analytics CSV or Excel export, a Defender advanced-hunting
// export, ...) that the extension renames and files into the case folder
// while renaming is switched on. Pure logic with no chrome.* calls, so it's
// unit-tested directly under Node and shared by the service worker and the
// Options page's live example.

import { sanitizeSegment } from "./pathSanitize.js";

export const EXPORT_TOKENS = ["prefix", "case", "seq", "label", "name", "timestamp", "date"];

export const DEFAULT_EXPORT_TEMPLATE = "{prefix}-{case}-{seq}-{label}-{name}-{timestamp}";
export const DEFAULT_EXPORT_SUBFOLDER = "exports";

// Keep generated names well inside Windows' 260-character path limit once the
// Downloads folder, base folder and case folder are in front of them.
const MAX_TOKEN_CHARS = 80;
const MAX_BASENAME_CHARS = 150;

const SEPARATOR_RE = /[-_. ]/;
const TOKEN_SPLIT_RE = /(\{[A-Za-z]+\})/;

/** Filesystem-safe UTC timestamp, same format as the screenshot filenames: 20260912T010305Z. */
export function filenameTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** UTC date as YYYYMMDD. */
export function filenameDate(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Sequence numbers are zero-padded to two digits (01, 02, ... 99, 100). */
export function formatSeq(n) {
  return String(Math.max(1, Math.floor(Number(n) || 1))).padStart(2, "0");
}

/** A token's value made filename-safe, or "" when there is nothing to put there. */
function cleanTokenValue(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return "";
  return sanitizeSegment(s).slice(0, MAX_TOKEN_CHARS).replace(/[ .]+$/g, "");
}

/**
 * The tokens in a template that aren't recognised (left in the filename as
 * literal text), and whether it has {seq} — for the Options page to warn about.
 * @param {string} template
 */
export function checkExportTemplate(template) {
  const unknown = [];
  let hasSeq = false;
  for (const part of String(template ?? "").split(TOKEN_SPLIT_RE)) {
    const m = /^\{([A-Za-z]+)\}$/.exec(part);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (!EXPORT_TOKENS.includes(name)) unknown.push(part);
    else if (name === "seq") hasSeq = true;
  }
  return { unknown, hasSeq };
}

/**
 * Expand a filename template (without extension). A token with no value is
 * dropped together with ONE separator character (- _ . or space) next to it
 * in the template's own text — the one before it, or the one after it when
 * the token starts the name — so an empty {label} or {prefix} doesn't leave
 * "--" or a leading "-" behind. Separators inside a value are never touched.
 *
 * @param {string} template e.g. "{prefix}-{case}-{seq}-{label}-{name}-{timestamp}"
 * @param {Record<string, string>} values keyed by token name
 * @returns {string} a single sanitized path segment, never empty
 */
export function expandExportTemplate(template, values) {
  let acc = "";
  let lastWasLiteral = false;
  let stripNextLeadingSep = false;

  for (const part of String(template ?? "").split(TOKEN_SPLIT_RE)) {
    if (part === "") continue;
    const m = /^\{([A-Za-z]+)\}$/.exec(part);
    const name = m && m[1].toLowerCase();

    if (!m || !EXPORT_TOKENS.includes(name)) {
      // Literal text (an unknown token is kept as literal text too).
      let lit = part;
      if (stripNextLeadingSep && SEPARATOR_RE.test(lit[0])) lit = lit.slice(1);
      stripNextLeadingSep = false;
      acc += lit;
      lastWasLiteral = lit !== "";
      continue;
    }

    const value = cleanTokenValue(values[name]);
    if (value !== "") {
      acc += value;
      lastWasLiteral = false;
      stripNextLeadingSep = false;
    } else if (acc === "") {
      stripNextLeadingSep = true;
    } else if (lastWasLiteral && SEPARATOR_RE.test(acc[acc.length - 1])) {
      acc = acc.slice(0, -1);
      lastWasLiteral = false;
    }
  }

  const trimmed = acc
    .replace(/^[-_. ]+|[-_. ]+$/g, "")
    .slice(0, MAX_BASENAME_CHARS)
    .replace(/[-_. ]+$/g, "");
  return sanitizeSegment(trimmed, { fallback: "export" });
}

/**
 * Split a browser-suggested filename into base name and extension. Only a
 * short alphanumeric extension counts (.csv, .xlsx, .txt), so a name like
 * "report.final draft" keeps all of it in the base name.
 * @param {string} filename may include a path; only the last segment is used
 * @returns {{ base: string, ext: string }} ext includes the leading dot, or is ""
 */
export function splitFilename(filename) {
  const leaf = String(filename ?? "").split(/[\\/]/).pop() || "";
  const dot = leaf.lastIndexOf(".");
  if (dot > 0 && dot < leaf.length - 1) {
    const ext = leaf.slice(dot + 1);
    if (/^[A-Za-z0-9]{1,10}$/.test(ext)) return { base: leaf.slice(0, dot), ext: "." + ext };
  }
  return { base: leaf || "download", ext: "" };
}

/**
 * The relative path (under Downloads) a renamed export is saved to:
 * <baseFolder>/<case>/<subfolder>/<expanded template><original extension>
 *
 * @param {Object} opts
 * @param {string} opts.baseFolder
 * @param {string} opts.caseRef      required — renaming can't be switched on without one
 * @param {string} opts.subfolder    "" puts exports straight in the case folder
 * @param {string} opts.template
 * @param {string} opts.prefix       the Options "Prefix" setting
 * @param {number} opts.seq
 * @param {string} [opts.label]      one-off label for this export
 * @param {string} opts.originalFilename the name the browser would have used
 * @param {Date} opts.date
 * @returns {{ path: string, filename: string }}
 */
export function buildExportPath(opts) {
  const { base, ext } = splitFilename(opts.originalFilename);
  const filename =
    expandExportTemplate(opts.template || DEFAULT_EXPORT_TEMPLATE, {
      prefix: opts.prefix,
      case: opts.caseRef,
      seq: formatSeq(opts.seq),
      label: opts.label,
      name: base,
      timestamp: filenameTimestamp(opts.date),
      date: filenameDate(opts.date),
    }) + ext;

  const folders = [
    sanitizeSegment(opts.baseFolder || "soc-evidence"),
    sanitizeSegment(opts.caseRef),
    opts.subfolder && opts.subfolder.trim() ? sanitizeSegment(opts.subfolder) : null,
  ].filter(Boolean);
  return { path: [...folders, filename].join("/"), filename };
}

/**
 * Normalise the Options "only rename downloads from" list into bare host
 * suffixes: "https://portal.azure.com/#blade", "*.azure.com" and ".azure.com"
 * all become "portal.azure.com" / "azure.com".
 * @param {string} text comma-, semicolon- or whitespace-separated
 * @returns {string[]}
 */
export function parseHostList(text) {
  const out = [];
  for (let raw of String(text ?? "").split(/[\s,;]+/)) {
    raw = raw.trim().toLowerCase();
    if (!raw) continue;
    raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
    raw = raw.split(/[/?#]/)[0]; // path, query, fragment
    raw = raw.replace(/:\d+$/, ""); // port
    raw = raw.replace(/^(\*\.|\.)+/, ""); // "*.example.com" / ".example.com"
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** True if `host` is `pattern` or a subdomain of it. */
export function hostMatches(host, pattern) {
  const h = String(host ?? "").toLowerCase();
  const p = String(pattern ?? "").toLowerCase();
  return !!h && !!p && (h === p || h.endsWith("." + p));
}

/**
 * Every web host a download can be attributed to: the tab you were looking at
 * when it started (if given), the download URL's own host, the host that
 * created a blob:/filesystem: URL (it's embedded in the URL), and the
 * referring page's host. The tab comes first: it's the stable one (an
 * embedded frame's host can be an unfamiliar or per-session one).
 * @param {{ url?: string, finalUrl?: string, referrer?: string }} item
 * @param {string} [tabUrl]
 * @returns {string[]}
 */
export function downloadHosts(item, tabUrl) {
  const hosts = [];
  for (let u of [tabUrl, item.url, item.finalUrl, item.referrer]) {
    if (!u) continue;
    if (u.startsWith("blob:")) u = u.slice(5);
    else if (u.startsWith("filesystem:")) u = u.slice(11);
    try {
      const parsed = new URL(u);
      if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname) {
        const h = parsed.hostname.toLowerCase();
        if (!hosts.includes(h)) hosts.push(h);
      }
    } catch {
      // not a URL with a host (data:, about:, ...)
    }
  }
  return hosts;
}

/**
 * Whether a download passes the host filter. An empty filter means every
 * download is renamed while renaming is on.
 * @param {string[]} hosts from downloadHosts()
 * @param {string[]} patterns from parseHostList()
 */
export function passesHostFilter(hosts, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return hosts.some((h) => patterns.some((p) => hostMatches(h, p)));
}

/**
 * The site filter as it applies: on with its list, or off. The on/off switch
 * was added after the list; a setting saved before it (no switch value) is on
 * exactly when its list isn't empty, as it behaved then. On with an empty
 * list filters nothing.
 * @param {{ exportHostFilter?: string, exportHostFilterOn?: boolean|null }} settings
 * @returns {{ on: boolean, patterns: string[] }}
 */
export function effectiveHostFilter(settings) {
  const patterns = parseHostList(settings && settings.exportHostFilter);
  const flag = settings ? settings.exportHostFilterOn : undefined;
  const on = (flag === true || (flag !== false && patterns.length > 0)) && patterns.length > 0;
  return { on, patterns };
}

/** The hosts not already covered by the filter's entries. */
export function uncoveredHosts(hosts, patterns) {
  return (hosts || []).filter((h) => !(patterns || []).some((p) => hostMatches(h, p)));
}

// --- Numbering ----------------------------------------------------------------------------

/**
 * The number a "keep the same number" hold uses: the case's most recent
 * number (one before its next), or 01 if it has none yet.
 * @param {number|undefined} next - the case's next number as stored
 */
export function holdSeqFor(next) {
  const n = Number(next) || 1;
  return n > 1 ? n - 1 : 1;
}

/**
 * The number the next file for a case gets, and what the case's next number
 * becomes. While a hold is on for this case, every file gets the held number
 * and numbering resumes after it when the hold is released.
 * @param {{ next: number|undefined, hold: { caseRef: string, seq: number }|null, caseRef: string }} opts
 * @returns {{ seq: number, next: number, held: boolean }}
 */
export function takeNumber({ next, hold, caseRef }) {
  const n = Number(next) || 1;
  if (hold && hold.caseRef === caseRef) {
    const seq = Number(hold.seq) || 1;
    return { seq, next: Math.max(n, seq + 1), held: true };
  }
  return { seq: n, next: n + 1, held: false };
}

/**
 * Whether renaming should have switched itself off by now.
 * @param {{ lastActivityAt: number }} armed
 * @param {number} nowMs
 * @param {number} autoStopMinutes 0 (or less) = never
 */
export function isArmExpired(armed, nowMs, autoStopMinutes) {
  const minutes = Number(autoStopMinutes) || 0;
  if (!armed || minutes <= 0) return false;
  return nowMs - (armed.lastActivityAt || armed.armedAt || 0) > minutes * 60_000;
}
