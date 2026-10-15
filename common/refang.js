// Refangs defanged indicators as commonly pasted from tickets/reports.
// Order matters: hxxps must be handled before hxxp (hxxps contains "hxxp").

/**
 * @param {string} input
 * @returns {string}
 */
export function refang(input) {
  if (typeof input !== "string") return input;
  let s = input;
  s = s.replace(/hxxps/gi, "https");
  s = s.replace(/hxxp/gi, "http");
  s = s.replace(/\[\.\]|\(\.\)|\[dot\]/gi, ".");
  s = s.replace(/\[:\]/gi, ":");
  s = s.replace(/\[@\]|\[at\]/gi, "@");
  return s;
}
