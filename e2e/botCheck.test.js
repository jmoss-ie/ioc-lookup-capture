// End-to-end test for the per-site "wait for bot check" option, against
// local stand-ins for a Cloudflare interstitial and a captcha frame that
// clear themselves after a delay (as if solved). Checks that the screenshot
// is of the page after the check, that it's recorded in the run manifest,
// that an invisible reCAPTCHA badge doesn't count, and that a check that
// never clears fails the job instead of saving a screenshot of it. Runs
// with the debugger backend (checks over CDP) and the stitched backend
// (checks with chrome.scripting).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./staticServer.js";
import { copyExtension, extensionWorker, grantScriptingAndAllUrls, launchNative, sleep } from "./nativeChrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGENTA = [200, 0, 200]; // the challenge page
const GREEN = [0, 150, 0]; // the page after the check

/** Run a one-job capture batch the way the popup does; returns { final, events }. */
async function runCapture(extPage, { url, backend, waitForChallenge, challengeTimeoutSec = 30 }) {
  return extPage.evaluate(
    async ({ url, backend, waitForChallenge, challengeTimeoutSec }) => {
      const state = await new Promise((r) => chrome.runtime.sendMessage({ type: "GET_STATE" }, r));
      const events = [];
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "capture" });
        port.onMessage.addListener((msg) => {
          if (msg.type === "PROGRESS") events.push(msg.evt);
          if (msg.type === "RUN_COMPLETE") resolve({ final: msg.final, events });
          if (msg.type === "RUN_FAILED") reject(new Error(msg.error));
        });
        port.postMessage({
          type: "START_CAPTURE",
          caseRef: "BOT-1",
          settings: { ...state.settings, captureBackend: backend, navigationTimeoutMs: 20000, challengeTimeoutSec },
          jobs: [
            {
              indicator: "1.2.3.4",
              indicatorKind: "ipv4",
              host: "1.2.3.4",
              site: { id: "fixture", name: "Fixture", url, applies: ["ipv4"], settleMs: 300, fullscreen: false, waitForChallenge },
            },
          ],
        });
      });
    },
    { url, backend, waitForChallenge, challengeTimeoutSec }
  );
}

/** Colour of one pixel of a PNG on disk, decoded in the browser. */
async function pixelAt(context, file, x, y) {
  const page = await context.newPage();
  await page.goto("about:blank");
  const b64 = fs.readFileSync(file).toString("base64");
  const rgb = await page.evaluate(
    async ({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    },
    { b64, x, y }
  );
  await page.close();
  return rgb;
}

const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function manifestEntry(downloadsDir, final) {
  assert.ok(final.manifestPath, "a manifest was written");
  const manifest = JSON.parse(await fsp.readFile(path.join(downloadsDir, final.manifestPath), "utf8"));
  return manifest.entries[0];
}

for (const backend of ["fullpage", "stitched"]) {
  test(`Bot check (${backend}): waits for the check to clear, then captures the real page`, async (t) => {
    const extDir = await copyExtension(grantScriptingAndAllUrls);
    const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
    const server = await startStaticServer(path.join(__dirname, "fixtures", "bot-check"));
    const { browser, context, proc } = await launchNative(extDir, downloadsDir);
    try {
      const worker = await extensionWorker(context);
      const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
      const ext = await context.newPage();
      await ext.goto(`chrome-extension://${extId}/options.html`);

      await t.test("Cloudflare-style interstitial: waits, then the screenshot is the page behind it", async () => {
        const started = Date.now();
        const { final, events } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=4000&ip={host}`,
          backend,
          waitForChallenge: true,
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        assert.ok(Date.now() - started >= 4000, "didn't capture before the check cleared");
        const waiting = events.find((e) => e.type === "waiting");
        assert.ok(waiting, "the popup was told it's waiting");
        assert.match(waiting.reason, /Just a moment/);
        const entry = await manifestEntry(downloadsDir, final);
        assert.ok(entry.botCheck, "the manifest records the bot check");
        assert.ok(entry.botCheck.waitedMs >= 2000, `waitedMs ${entry.botCheck.waitedMs}`);
        const rgb = await pixelAt(context, path.join(downloadsDir, entry.pngPath), 10, 300);
        assert.ok(near(rgb, GREEN), `expected the real page (green), got ${rgb}`);
      });

      await t.test("without the option, the same page is captured as the challenge", async () => {
        const { final } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=4000&ip={host}`,
          backend,
          waitForChallenge: false,
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        const entry = await manifestEntry(downloadsDir, final);
        assert.equal(entry.botCheck, undefined);
        const rgb = await pixelAt(context, path.join(downloadsDir, entry.pngPath), 10, 300);
        assert.ok(near(rgb, MAGENTA), `expected the challenge page (magenta), got ${rgb}`);
      });

      await t.test("a visible captcha frame is waited out too", async () => {
        const { final, events } = await runCapture(ext, {
          url: `${server.url}captcha.html?clearAfter=3000&ip={host}`,
          backend,
          waitForChallenge: true,
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        assert.ok(events.some((e) => e.type === "waiting"));
        const entry = await manifestEntry(downloadsDir, final);
        const rgb = await pixelAt(context, path.join(downloadsDir, entry.pngPath), 10, 300);
        assert.ok(near(rgb, GREEN), `got ${rgb}`);
      });

      await t.test("an invisible reCAPTCHA badge is not a check: no wait", async () => {
        const started = Date.now();
        const { final, events } = await runCapture(ext, {
          url: `${server.url}invisible.html?ip={host}`,
          backend,
          waitForChallenge: true,
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        assert.equal(events.some((e) => e.type === "waiting"), false);
        assert.ok(Date.now() - started < 15000);
        const entry = await manifestEntry(downloadsDir, final);
        assert.equal(entry.botCheck, undefined);
      });

      await t.test("a check that isn't cleared in time fails the job, with no screenshot", async () => {
        const { final } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=600000&ip={host}`,
          backend,
          waitForChallenge: true,
          challengeTimeoutSec: 5,
        });
        assert.equal(final.results[0].ok, false);
        assert.match(final.results[0].error, /wasn't cleared within 5 s, so this lookup wasn't captured/);
        assert.equal(final.manifestPath, null, "nothing saved");
      });
    } finally {
      await browser.close().catch(() => {});
      proc.kill();
      await server.close();
    }
  });
}

test("popup: a number held for another case is shown, and Release clears it", async () => {
  const extDir = await copyExtension(grantScriptingAndAllUrls);
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  const { browser, context, proc } = await launchNative(extDir, downloadsDir);
  try {
    const worker = await extensionWorker(context);
    const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "EXPORT_SET_HOLD", caseRef: "INC-HELD", on: true }, r)));
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    await popup.fill("#caseRef", "INC-OTHER");
    assert.equal(await popup.isVisible("#exportHoldOther"), true);
    assert.equal(await popup.textContent("#exportHoldOtherText"), "#01 is held for INC-HELD");
    assert.equal(await popup.isChecked("#exportHold"), false, "not this case's hold");
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "#01");
    await popup.click("#exportHoldReleaseBtn");
    await popup.waitForFunction(() => document.getElementById("exportHoldOther").hidden);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");
    // And on the held case itself, the checkbox is the control (no extra line).
    await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "EXPORT_SET_HOLD", caseRef: "INC-OTHER", on: true }, r)));
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    await popup.fill("#caseRef", "INC-OTHER");
    assert.equal(await popup.isChecked("#exportHold"), true);
    assert.equal(await popup.isVisible("#exportHoldOther"), false);
    await sleep(100);
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
  }
});
