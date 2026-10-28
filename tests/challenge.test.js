import test from "node:test";
import assert from "node:assert/strict";
import {
  BOT_CHECK_MODES,
  botCheckMode,
  CHALLENGE_SELECTORS,
  DEFAULT_CHALLENGE_TIMEOUT_SEC,
  challengeTimeoutSec,
  titleLooksLikeChallenge,
} from "../common/challenge.js";

test("titleLooksLikeChallenge: Cloudflare and common bot-check titles", () => {
  for (const t of [
    "Just a moment...",
    "Attention Required! | Cloudflare",
    "Please Wait... | Cloudflare",
    "One more step",
    "Checking your browser before accessing example.com",
    "Verify you are human",
    "Verifying that you are a human",
    "Are you a robot?",
    "DDoS-Guard",
  ]) {
    assert.equal(titleLooksLikeChallenge(t), true, t);
  }
});

test("titleLooksLikeChallenge: ordinary lookup-page titles don't match", () => {
  for (const t of [
    "8.8.8.8 | dns.google | Google LLC | AbuseIPDB",
    "VirusTotal",
    "VirusTotal - IP address - 8.8.8.8",
    "Shodan",
    "Spur - 1.2.3.4",
    "Cloudflare Radar",
    "1.1.1.1 | Cloudflare, Inc. | AbuseIPDB",
    "",
    undefined,
  ]) {
    assert.equal(titleLooksLikeChallenge(t), false, String(t));
  }
});

test("CHALLENGE_SELECTORS: all valid CSS (no throw-and-skip in the page)", () => {
  // A cheap syntax check without a DOM: balanced brackets and quotes.
  for (const sel of CHALLENGE_SELECTORS) {
    assert.equal((sel.match(/\[/g) || []).length, (sel.match(/\]/g) || []).length, sel);
    assert.equal((sel.match(/"/g) || []).length % 2, 0, sel);
  }
});

test("challengeTimeoutSec: default, clamped to 5..900", () => {
  assert.equal(challengeTimeoutSec(undefined), DEFAULT_CHALLENGE_TIMEOUT_SEC);
  assert.equal(challengeTimeoutSec("abc"), DEFAULT_CHALLENGE_TIMEOUT_SEC);
  assert.equal(challengeTimeoutSec(0), DEFAULT_CHALLENGE_TIMEOUT_SEC);
  assert.equal(challengeTimeoutSec(2), 5);
  assert.equal(challengeTimeoutSec(60), 60);
  assert.equal(challengeTimeoutSec(5000), 900);
});

test("CHALLENGE_SELECTORS: captcha frames by title, and widget containers (Turnstile's frame is in a closed shadow root)", () => {
  for (const sel of ['iframe[title*="hCaptcha" i]', ".cf-turnstile", ".h-captcha", ".g-recaptcha"]) {
    assert.ok(CHALLENGE_SELECTORS.includes(sel), sel);
  }
});

test("botCheckMode: off / auto / pause, reading 1.8's waitForChallenge as auto/off", () => {
  assert.deepEqual(BOT_CHECK_MODES, ["off", "auto", "pause"]);
  assert.equal(botCheckMode({}), "off");
  assert.equal(botCheckMode(undefined), "off");
  assert.equal(botCheckMode({ waitForChallenge: false }), "off");
  assert.equal(botCheckMode({ waitForChallenge: true }), "auto");
  assert.equal(botCheckMode({ botCheck: "pause" }), "pause");
  assert.equal(botCheckMode({ botCheck: "off", waitForChallenge: true }), "off");
  assert.equal(botCheckMode({ botCheck: "nonsense", waitForChallenge: true }), "auto");
});
