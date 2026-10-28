import test from "node:test";
import assert from "node:assert/strict";
import {
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
