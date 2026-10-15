import { refang } from "./refang.js";

/** @typedef {"ipv4"|"ipv6"|"domain"|"url"|"hash"} IndicatorKind */

/**
 * @typedef {Object} ParsedIndicator
 * @property {string} raw            - original text as pasted (before refang)
 * @property {string} refanged       - after refang normalization
 * @property {boolean} valid
 * @property {IndicatorKind|null} kind
 * @property {string|null} host      - hostname for domain/url/ip kinds
 * @property {string|null} reason    - rejection reason, when invalid
 */

const HASH_LENGTHS = { 32: "md5", 40: "sha1", 64: "sha256" };
const HEX_RE = /^[a-fA-F0-9]+$/;

function isValidIPv4(str) {
  if (typeof str !== "string") return false;
  const parts = str.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part[0] === "0") return false; // reject ambiguous/octal-looking leading zeros
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * RFC 4291-style IPv6 validation, including "::" compression and
 * IPv4-mapped tails (e.g. ::ffff:192.168.1.1). Expects the address WITHOUT
 * surrounding brackets.
 */
function isValidIPv6(str) {
  if (typeof str !== "string" || str.length < 2) return false;
  if (!str.includes(":")) return false;
  if ((str.match(/::/g) || []).length > 1) return false; // "::" at most once

  let head = str;
  let embeddedV4 = false;
  const lastColon = str.lastIndexOf(":");
  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isValidIPv4(tail)) return false;
    embeddedV4 = true;
    head = str.slice(0, lastColon + 1) + "0:0"; // placeholder occupying two groups
  }

  const hasDoubleColon = head.includes("::");
  const sides = head.split("::");
  if (sides.length > 2) return false;

  const groupsOf = (part) => (part === "" ? [] : part.split(":"));
  const left = groupsOf(sides[0]);
  const right = sides.length === 2 ? groupsOf(sides[1]) : [];

  const allGroups = hasDoubleColon ? [...left, ...right] : left;
  if (allGroups.length === 0) return false;
  for (const g of allGroups) {
    if (!/^[a-fA-F0-9]{1,4}$/.test(g)) return false;
  }

  void embeddedV4;
  const totalGroups = 8; // an embedded v4 tail always occupies the last two groups via the placeholder
  if (hasDoubleColon) {
    if (left.length + right.length >= totalGroups) return false; // "::" must collapse >=1 group
  } else {
    if (left.length !== totalGroups) return false;
  }
  return true;
}

function isHexHash(str) {
  if (!HEX_RE.test(str)) return null;
  const kind = HASH_LENGTHS[str.length];
  return kind || null;
}

const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

/**
 * Split a schemeless string into {host, afterHost}, handling bracketed IPv6,
 * a single host:port colon, and bare (unbracketed) IPv6 which uses 2+ colons.
 */
function splitHostAndRest(rest) {
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end === -1) return null;
    return { host: rest.slice(1, end), afterHost: rest.slice(end + 1) };
  }
  const pathIdx = rest.search(/[/?#]/);
  const prefix = pathIdx === -1 ? rest : rest.slice(0, pathIdx);
  const suffix = pathIdx === -1 ? "" : rest.slice(pathIdx);
  const colonCount = (prefix.match(/:/g) || []).length;
  if (colonCount === 1) {
    const ci = prefix.indexOf(":");
    return { host: prefix.slice(0, ci), afterHost: prefix.slice(ci) + suffix };
  }
  // 0 or >=2 colons: whole prefix is the host (plain host, or bare IPv6)
  return { host: prefix, afterHost: suffix };
}

function hostKind(host) {
  if (isValidIPv4(host)) return "ipv4";
  if (isValidIPv6(host)) return "ipv6";
  if (DOMAIN_RE.test(host)) return "domain";
  return null;
}

/**
 * Classify a single already-refanged, trimmed token.
 * @param {string} token
 * @returns {{valid: boolean, kind: IndicatorKind|null, host: string|null, reason: string|null}}
 */
export function classifyIndicator(token) {
  if (!token) return { valid: false, kind: null, host: null, reason: "empty" };

  const hashKind = isHexHash(token);
  if (hashKind) {
    return { valid: true, kind: "hash", host: null, reason: null };
  }

  let schemeless = token;
  let hadScheme = false;
  const schemeMatch = /^(https?):\/\//i.exec(token);
  if (schemeMatch) {
    hadScheme = true;
    schemeless = token.slice(schemeMatch[0].length);
  }

  const split = splitHostAndRest(schemeless);
  if (!split || !split.host) {
    return { valid: false, kind: null, host: null, reason: "unrecognized indicator format" };
  }
  const { host, afterHost } = split;
  const kind = hostKind(host);
  if (!kind) {
    return { valid: false, kind: null, host: null, reason: "invalid host" };
  }

  const hasPathOrPort = afterHost !== "";
  if (hadScheme || hasPathOrPort) {
    return { valid: true, kind: "url", host: host.toLowerCase(), reason: null };
  }
  return { valid: true, kind, host: host.toLowerCase(), reason: null };
}

/**
 * Split, refang, classify, and de-duplicate a raw textarea blob of indicators.
 * @param {string} text
 * @returns {ParsedIndicator[]} in original order, de-duplicated on refanged form
 */
export function parseIndicators(text) {
  if (!text) return [];
  const tokens = text
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const seen = new Set();
  const results = [];
  for (const raw of tokens) {
    const refanged = refang(raw).trim();
    const dedupeKey = refanged.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const { valid, kind, host, reason } = classifyIndicator(refanged);
    results.push({ raw, refanged, valid, kind, host, reason });
  }
  return results;
}
