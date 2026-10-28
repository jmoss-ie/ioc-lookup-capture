// "Wait for bot check" (a per-site option): after a lookup page loads, check
// whether a Cloudflare challenge or a captcha is in front of it. If one is,
// bring the capture window to the front so you can solve it, and wait until
// it has gone (or the time limit passes) before the usual settle delay and
// screenshot. A screenshot of a challenge page isn't evidence of anything,
// so a check that isn't cleared in time fails the job instead.
//
// How the page is checked, by what this build and session allow:
//   - full-page (debugger) sessions: Runtime.evaluate over the debugger the
//     session already has attached — no extra permission;
//   - otherwise chrome.scripting, when `scripting` has been granted (the
//     stitched backend always has it);
//   - otherwise the tab's title alone, which still catches Cloudflare's
//     "Just a moment..." interstitial.
// The check reads the page's title and looks for the challenge elements in
// common/challenge.js; it reads no other page content.

import { CHALLENGE_SELECTORS, CHALLENGE_TITLE_PATTERN, titleLooksLikeChallenge } from "../common/challenge.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable no-undef */
// Runs in the page. Self-contained: everything it needs comes in as arguments.
function detectChallengePage(titleSource, titleFlags, selectors) {
  try {
    const title = document.title || "";
    if (new RegExp(titleSource, titleFlags).test(title)) {
      return { challenge: true, reason: `page title "${title.slice(0, 60)}"` };
    }
    for (const sel of selectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
        const src = el.getAttribute("src") || "";
        if (/invisible/i.test(src)) continue;
        return { challenge: true, reason: `"${sel}" on the page` };
      }
    }
    return { challenge: false };
  } catch (err) {
    return { challenge: false, error: String((err && err.message) || err) };
  }
}
/* eslint-enable no-undef */

const ARGS = [CHALLENGE_TITLE_PATTERN.source, CHALLENGE_TITLE_PATTERN.flags, CHALLENGE_SELECTORS];

/** One check of the session's tab. */
export async function detectChallenge(session) {
  const { tabId } = session;
  if (session.backend === "fullpage" && typeof chrome !== "undefined" && chrome.debugger) {
    try {
      const expression = `(${detectChallengePage.toString()})(...${JSON.stringify(ARGS)})`;
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (res && res.result && res.result.value) return { ...res.result.value, via: "debugger" };
    } catch {
      // page mid-navigation, or the debugger detached: fall through
    }
  }
  if (typeof chrome !== "undefined" && chrome.scripting) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: detectChallengePage,
        args: ARGS,
      });
      if (injection && injection.result) return { ...injection.result, via: "scripting" };
    } catch {
      // not granted for this page, or mid-navigation: fall through
    }
  }
  const tab = await chrome.tabs.get(tabId);
  return titleLooksLikeChallenge(tab.title)
    ? { challenge: true, reason: `page title "${String(tab.title).slice(0, 60)}"`, via: "title" }
    : { challenge: false, via: "title" };
}

/** Put the capture window and tab in front of you, so the check can be solved. */
async function bringToFront(session) {
  await chrome.windows.update(session.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(session.tabId, { active: true }).catch(() => {});
}

/**
 * If the loaded page is behind a bot check, wait until it's cleared.
 * Cleared = the tab has finished loading and two checks in a row (a poll
 * apart) find no challenge, so the moment between a challenge passing and
 * the real page loading isn't mistaken for the real page.
 *
 * @param {{ tabId: number, windowId: number, backend: string }} session
 * @param {{ timeoutMs: number, onWaiting?: (reason: string) => void, pollMs?: number }} opts
 * @returns {Promise<{ waitedMs: number, reason?: string }>} waitedMs 0 = no check was showing
 * @throws if the check is still there when the time runs out
 */
export async function waitForChallengeCleared(session, { timeoutMs, onWaiting, pollMs = 1000 }) {
  const first = await detectChallenge(session);
  if (!first.challenge) return { waitedMs: 0 };

  const start = Date.now();
  if (onWaiting) onWaiting(first.reason);
  await bringToFront(session);

  let clearChecks = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    let tab;
    try {
      tab = await chrome.tabs.get(session.tabId);
    } catch {
      throw new Error("The lookup tab was closed while waiting for its bot check.");
    }
    if (tab.status !== "complete") {
      clearChecks = 0;
      continue;
    }
    const now = await detectChallenge(session);
    if (now.challenge) {
      clearChecks = 0;
      continue;
    }
    clearChecks += 1;
    if (clearChecks >= 2) return { waitedMs: Date.now() - start, reason: first.reason };
  }
  throw new Error(
    `A bot check or captcha (${first.reason}) wasn't cleared within ${Math.round(timeoutMs / 1000)} s, so this lookup wasn't captured.`
  );
}
