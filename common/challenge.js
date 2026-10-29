// What counts as "a bot check or captcha is in front of the page", for the
// per-site "Bot check" setting (see bg/challengeWait.js). Pure data
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
 * Elements that mean a check is showing. The page-side check skips any that
 * aren't visible, captcha frames of the invisible kind (an invisible
 * reCAPTCHA badge sits on many ordinary pages), and invisible-mode widget
 * markers, which sit on an ordinary button or a zero-size element.
 */
export const CHALLENGE_SELECTORS = [
  // Parts of Cloudflare's "Just a moment..." interstitial.
  "#challenge-form",
  "#challenge-stage",
  "#challenge-running",
  "#cf-challenge-running",
  // Captcha frames, by address...
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="/recaptcha/"]',
  // ...and by the title each vendor gives its frame, for one whose address doesn't say.
  'iframe[title*="hCaptcha" i]',
  'iframe[title*="Cloudflare security challenge" i]',
  'iframe[title="reCAPTCHA" i]',
  // Widget containers. Turnstile puts its frame in a closed shadow root that
  // a page script can't see into, so its container is what can be found.
  ".cf-turnstile",
  ".h-captcha",
  ".g-recaptcha",
  "#px-captcha",
];

/** Per-site "Bot check" settings. */
export const BOT_CHECK_MODES = ["off", "auto", "pause"];

/**
 * A site's bot-check setting: "off", "auto" (wait while a check is showing)
 * or "pause" (always wait for Capture now). Sites saved by 1.8 have a
 * waitForChallenge true/false instead, which maps to "auto"/"off".
 * @param {{ botCheck?: string, waitForChallenge?: boolean }} site
 */
export function botCheckMode(site) {
  if (site && BOT_CHECK_MODES.includes(site.botCheck)) return site.botCheck;
  return site && site.waitForChallenge ? "auto" : "off";
}

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
