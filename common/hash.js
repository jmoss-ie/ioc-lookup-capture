// SHA-256 helpers built on the standard Web Crypto API (available as the
// global `crypto.subtle` in both browser/extension contexts and modern Node).

/**
 * @param {string} str - UTF-8 text to hash
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufToHex(digest);
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256HexBytes(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufToHex(digest);
}

/** @param {ArrayBuffer} buf */
export function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
