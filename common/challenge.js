// What counts as "a bot check or captcha is in front of the page", for the
// per-site "wait for bot check" option (see bg/challengeWait.js). Pure data
// and logic, unit-tested under Node; the same pattern and selectors are
// passed into the page-side check, so there is one definition.
//
// Deliberately narrow: a false positive makes a capture wait for its full
// timeout, so only signals that mean "the page is behind a check" are here.

/**
 * Page titles of challenge interstitials: Cloudflare ("Just a moment...",
 * "Attention Required! | Cloudflare", "... | Cloudflare"), and the generic
 * wording other bot-check pages use.
 */
export const CHALLENGE_TITLE_PATTERN =
  /\b(just a moment|attention required|checking your browser|one more step|verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|human verification|ddos-guard)\b|\|\s*cloudflare\s*$/i;

/**
 * Elements that mean a check is showing. Captcha iframes count only when
 * visible and not the invisible kind (an invisible reCAPTCHA badge sits on
 * many ordinary pages); the page-side check filters those out.
 */
export const CHALLENGE_SELECTORS = [
  "#challenge-form",
  "#challenge-stage",
  "#challenge-running",
  "#cf-challenge-running",
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="/recaptcha/"]',
  "#px-captcha",
];

/** @param {string} title */
export function titleLooksLikeChallenge(title) {
  return CHALLENGE_TITLE_PATTERN.test(String(title ?? ""));
}

/** Default and limits for the longest wait, in seconds. */
export const DEFAULT_CHALLENGE_TIMEOUT_SEC = 120;
export const MIN_CHALLENGE_TIMEOUT_SEC = 5;
export const MAX_CHALLENGE_TIMEOUT_SEC = 900;

/** The settings value as a number of seconds within the limits. */
export function challengeTimeoutSec(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHALLENGE_TIMEOUT_SEC;
  return Math.min(MAX_CHALLENGE_TIMEOUT_SEC, Math.max(MIN_CHALLENGE_TIMEOUT_SEC, n));
}
