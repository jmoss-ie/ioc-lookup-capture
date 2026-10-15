// Minimal PNG header parsing to get authoritative pixel dimensions and byte
// size directly from the captured image bytes, rather than trusting
// whatever dimensions a capture backend thinks it asked for.

/**
 * @param {string} base64 - raw base64 PNG data (no data: prefix)
 * @returns {{ width: number, height: number, byteSize: number, bytes: Uint8Array }}
 */
export function decodePng(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  // PNG signature (8 bytes) + IHDR chunk length (4) + "IHDR" (4) = offset 16 for width.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height, byteSize: bytes.byteLength, bytes };
}
