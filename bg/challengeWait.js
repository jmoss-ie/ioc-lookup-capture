// Per-site "Bot check" setting, used in place of the plain settle delay:
//
//   - "auto" (Wait if shown): watch the page for a Cloudflare challenge or a
//     captcha for the whole settle period — a captcha widget is often added a
//     moment after the page has finished loading. If one shows, wait until it
//     has gone, then let the page settle again (still watching). If it's
//     still there after a few seconds, the lookup window is brought to the
//     front so you can solve it.
//   - "pause" (Always pause): settle, bring the window to the front, and wait
//     for you to press Capture now — for sites whose captcha has to be
//     completed every time and stays on the page afterwards (tick the box,
//     press the site's own button, then Capture now).
//
// While waiting, the popup offers Capture now and Skip (see background.js);
// Stop ends the wait too. A check that isn't dealt with in time fails the
// job: a screenshot of a challenge page isn't evidence of anything.
//
// How the page is checked, by what this build and session allow:
//   - full-page (debugger) sessions: Runtime.evaluate over the debugger the
//     session already has attached — no extra permission;
//   - otherwise chrome.scripting, when `scripting` has been granted (the
//     stitched backend always has it);
//   - otherwise the tab's title alone, which still catches Cloudflare's
//     "Just a moment..." interstitial.
// The check reads the page's title and looks for the elements listed in
// common/challenge.js (in the page and any open shadow roots); it reads no
// other page content.

import { CHALLENGE_SELECTORS, CHALLENGE_TITLE_PATTERN, titleLooksLikeChallenge } from "../common/challenge.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The shortest time a page is watched for a check, even with a shorter settle time. */
export const MIN_WATCH_MS = 1000;

/* eslint-disable no-undef */
// Runs in the page. Self-contained: everything it needs comes in as arguments.
function detectChallengePage(titleSource, titleFlags, selectors) {
  try {
    const title = document.title || "";
    if (new RegExp(titleSource, titleFlags).test(title)) {
      return { challenge: true, reason: `page title "${title.slice(0, 60)}"` };
    }
    // The document plus any open shadow roots (some sites build their pages
    // from web components), within a bound so a huge page stays quick.
    const roots = [document];
    let scanned = 0;
    for (let i = 0; i < roots.length && roots.length < 200 && scanned < 50000; i++) {
      for (const node of roots[i].querySelectorAll("*")) {
        scanned++;
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    for (const root of roots) {
      for (const sel of selectors) {
        let els;
        try {
          els = root.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of els) {
          const tag = el.tagName;
          // Invisible-mode captchas are attached to an ordinary button or link.
          if (tag === "BUTTON" || tag === "INPUT" || tag === "A") continue;
          if ((el.getAttribute("data-size") || "").toLowerCase() === "invisible") continue;
          const src = el.getAttribute("src") || "";
          if (/invisible/i.test(src)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
          return { challenge: true, reason: `"${sel}" on the page` };
        }
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

async function tabOrThrow(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error("The lookup tab was closed while waiting for its bot check, so this lookup wasn't captured.");
  }
}

/**
 * What the popup asked for, if anything: "capture" (Capture now), "skip",
 * or a Stop. Throws for skip and stop; returns true for Capture now.
 */
function checkControl(control, what) {
  if (!control) return false;
  if (control.stopped && control.stopped()) {
    throw new Error(`Stopped while waiting for ${what}, so this lookup wasn't captured.`);
  }
  const action = control.take ? control.take() : null;
  if (action === "skip") throw new Error(`Skipped while waiting for ${what}, so this lookup wasn't captured.`);
  return action === "capture";
}

/**
 * Wait while a check is showing. Gone = the tab has finished loading and two
 * checks in a row (a poll apart) find no check, so the moment between a check
 * passing and the real page loading isn't mistaken for the real page.
 */
async function waitWhileShowing(session, first, { deadline, timeoutMs, onWaiting, control, pollMs, focusAfterMs }) {
  const start = Date.now();
  if (onWaiting) onWaiting({ mode: "auto", reason: first.reason });
  const what = `a bot check or captcha (${first.reason})`;
  let focused = false;
  let clearChecks = 0;
  for (;;) {
    if (checkControl(control, what)) return { waitedMs: Date.now() - start, continuedBy: "capture-now" };
    if (Date.now() >= deadline) {
      throw new Error(
        `A bot check or captcha (${first.reason}) wasn't cleared within ${Math.round(timeoutMs / 1000)} s, so this lookup wasn't captured.`
      );
    }
    // A check that passes by itself within a few seconds doesn't take over your screen.
    if (!focused && Date.now() - start >= focusAfterMs) {
      await bringToFront(session);
      focused = true;
    }
    await sleep(pollMs);
    const tab = await tabOrThrow(session.tabId);
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
    if (clearChecks >= 2) return { waitedMs: Date.now() - start, continuedBy: "check-gone" };
  }
}

/**
 * The settle period of a site whose "Bot check" setting is on, in place of
 * the plain settle delay. Called once the page has loaded.
 *
 * @param {{ tabId: number, windowId: number, backend: string }} session
 * @param {object} opts
 * @param {"auto"|"pause"} opts.mode
 * @param {number} opts.settleMs - the site's settle time
 * @param {number} opts.timeoutMs - the longest wait for a check (auto) or for Capture now (pause)
 * @param {(info: { mode: string, reason: string }) => void} [opts.onWaiting]
 * @param {() => void} [opts.onWaitEnd]
 * @param {{ take: () => ("capture"|"skip"|null), stopped: () => boolean }} [opts.control]
 * @returns {Promise<{ waitedMs: number, reason?: string, continuedBy?: "check-gone"|"capture-now" }>}
 *   continuedBy is set only when there was a wait
 * @throws when a check isn't dealt with in time, or on Skip or Stop
 */
export async function settleWithBotCheck(
  session,
  { mode, settleMs, timeoutMs, onWaiting, onWaitEnd, control, pollMs = 500, focusAfterMs = 2500 }
) {
  if (mode === "pause") {
    await sleep(settleMs);
    const start = Date.now();
    if (onWaiting) onWaiting({ mode: "pause", reason: "this site is set to always pause" });
    try {
      await bringToFront(session);
      for (;;) {
        if (checkControl(control, "Capture now")) {
          return { waitedMs: Date.now() - start, continuedBy: "capture-now" };
        }
        if (Date.now() - start >= timeoutMs) {
          throw new Error(
            `Capture now wasn't pressed within ${Math.round(timeoutMs / 1000)} s, so this lookup wasn't captured.`
          );
        }
        await sleep(pollMs);
        await tabOrThrow(session.tabId);
      }
    } finally {
      if (onWaitEnd) onWaitEnd();
    }
  }

  // "auto"
  let result = { waitedMs: 0 };
  let deadline = null;
  let watchUntil = Date.now() + Math.max(settleMs, MIN_WATCH_MS);
  while (Date.now() < watchUntil) {
    const found = await detectChallenge(session);
    if (found.challenge) {
      if (deadline === null) deadline = Date.now() + timeoutMs;
      let waited;
      try {
        waited = await waitWhileShowing(session, found, { deadline, timeoutMs, onWaiting, control, pollMs, focusAfterMs });
      } finally {
        if (onWaitEnd) onWaitEnd();
      }
      result = {
        waitedMs: result.waitedMs + waited.waitedMs,
        reason: result.reason || found.reason,
        continuedBy: waited.continuedBy,
      };
      if (waited.continuedBy === "capture-now") return result;
      // The check has gone: let the real page settle, still watching.
      watchUntil = Date.now() + settleMs;
      continue;
    }
    await sleep(Math.max(0, Math.min(pollMs, watchUntil - Date.now())));
  }
  return result;
}
