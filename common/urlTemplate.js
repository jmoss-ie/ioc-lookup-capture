import { sha256Hex } from "./hash.js";

/**
 * Expand a site URL template against a parsed indicator.
 *
 * Placeholders:
 *   {indicator}   the refanged indicator exactly as typed
 *   {host}        hostname only (domain for a URL/domain indicator, the IP for ipv4/ipv6)
 *   {encoded}     URL-encoded {indicator}
 *   {hostEncoded} URL-encoded {host}
 *   {vtUrlId}     VirusTotal URL id: the SHA-256 hex digest of the URL string, per this
 *                 extension's site-registry convention (see README)
 *   {base64}      {indicator} base64-encoded (UTF-8, standard alphabet with padding),
 *                 then URL-encoded — the form Pulsedive's ?ioc= parameter takes
 *
 * @param {string} template
 * @param {{ indicator: string, kind: string, host: string|null }} parsed
 * @returns {Promise<string>}
 */
export async function expandUrlTemplate(template, parsed) {
  const { indicator, host } = parsed;
  let out = template;

  if (out.includes("{vtUrlId}")) {
    const vtUrlId = await sha256Hex(indicator);
    out = out.split("{vtUrlId}").join(vtUrlId);
  }
  if (out.includes("{base64}")) {
    out = out.split("{base64}").join(encodeURIComponent(base64Utf8(indicator)));
  }
  if (out.includes("{hostEncoded}")) {
    out = out.split("{hostEncoded}").join(encodeURIComponent(host ?? ""));
  }
  if (out.includes("{encoded}")) {
    out = out.split("{encoded}").join(encodeURIComponent(indicator));
  }
  if (out.includes("{host}")) {
    out = out.split("{host}").join(host ?? "");
  }
  if (out.includes("{indicator}")) {
    out = out.split("{indicator}").join(indicator);
  }
  return out;
}

/** Standard base64 of a string's UTF-8 bytes. */
export function base64Utf8(s) {
  const bytes = new TextEncoder().encode(String(s ?? ""));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Which sites apply to a parsed indicator, respecting each site's `applies`
 * list and `enabled` flag.
 * @param {Array<{applies: string[], enabled: boolean}>} sites
 * @param {string} kind
 */
export function sitesForIndicatorKind(sites, kind) {
  return sites.filter((s) => s.enabled && Array.isArray(s.applies) && s.applies.includes(kind));
}
