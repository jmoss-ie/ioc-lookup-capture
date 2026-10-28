// End-to-end tests for the per-site "Bot check" setting, against local
// stand-ins for a Cloudflare interstitial and captcha widgets (an iframe
// framed and titled like the vendors', a Turnstile-style container whose
// frame is in a closed shadow root, a widget added after the page loads, a
// captcha gate that never goes away). Checks that:
//   - "Wait if shown" waits for a check to go — including one that appears
//     a moment after load — and screenshots the page behind it;
//   - Capture now and Skip end a wait, and Stop does too;
//   - "Always pause" waits for Capture now on any page;
//   - invisible captchas don't count, and a check that isn't dealt with in
//     time fails the job with nothing saved;
//   - the manifest records the wait, and "Save a manifest" off saves none;
//   - a popup opened mid-wait picks up the batch and its Capture now works.
// Runs with the debugger backend (checks over CDP) and the stitched backend
// (checks with chrome.scripting).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./staticServer.js";
import { copyExtension, extensionWorker, grantScriptingAndAllUrls, launchNative, listFiles, sleep } from "./nativeChrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGENTA = [200, 0, 200]; // the challenge page
const GREEN = [0, 150, 0]; // the page after the check

/**
 * Start a one-job capture batch from an extension page, the way the popup
 * does. The port and progress events stay on the page (window.__run) so a
 * test can press Capture now / Skip / Stop mid-run.
 */
async function startCapture(extPage, { url, backend, botCheck, waitForChallenge, settleMs = 300, challengeTimeoutSec = 30, saveManifest = true }) {
  await extPage.evaluate(
    async ({ url, backend, botCheck, waitForChallenge, settleMs, challengeTimeoutSec, saveManifest }) => {
      const state = await new Promise((r) => chrome.runtime.sendMessage({ type: "GET_STATE" }, r));
      const site = { id: "fixture", name: "Fixture", url, applies: ["ipv4"], settleMs, fullscreen: false };
      if (botCheck !== undefined) site.botCheck = botCheck;
      if (waitForChallenge !== undefined) site.waitForChallenge = waitForChallenge;
      const events = [];
      const port = chrome.runtime.connect({ name: "capture" });
      const done = new Promise((resolve, reject) => {
        port.onMessage.addListener((msg) => {
          if (msg.type === "PROGRESS") events.push(msg.evt);
          if (msg.type === "RUN_COMPLETE") resolve(msg.final);
          if (msg.type === "RUN_FAILED") reject(new Error(msg.error));
        });
      });
      window.__run = { port, events, done };
      port.postMessage({
        type: "START_CAPTURE",
        caseRef: "BOT-1",
        settings: { ...state.settings, captureBackend: backend, navigationTimeoutMs: 20000, challengeTimeoutSec, saveManifest },
        jobs: [{ indicator: "1.2.3.4", indicatorKind: "ipv4", host: "1.2.3.4", site }],
      });
    },
    { url, backend, botCheck, waitForChallenge, settleMs, challengeTimeoutSec, saveManifest }
  );
}

async function finish(extPage) {
  return extPage.evaluate(async () => ({ final: await window.__run.done, events: window.__run.events }));
}

async function runCapture(extPage, opts) {
  await startCapture(extPage, opts);
  return finish(extPage);
}

async function waitForWaiting(extPage) {
  await extPage.waitForFunction(() => window.__run.events.some((e) => e.type === "waiting"), null, { timeout: 20000 });
  return extPage.evaluate(() => window.__run.events.find((e) => e.type === "waiting"));
}

async function send(extPage, message) {
  await extPage.evaluate((m) => window.__run.port.postMessage(m), message);
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

async function setup() {
  const extDir = await copyExtension(grantScriptingAndAllUrls);
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "bot-check"));
  const { browser, context, proc } = await launchNative(extDir, downloadsDir);
  const worker = await extensionWorker(context);
  const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  const close = async () => {
    await browser.close().catch(() => {});
    proc.kill();
    await server.close();
  };
  return { downloadsDir, server, context, worker, extId, ext, close };
}

for (const backend of ["fullpage", "stitched"]) {
  test(`Bot check (${backend})`, async (t) => {
    const { downloadsDir, server, context, ext, close } = await setup();
    try {
      await t.test("Wait if shown, Cloudflare-style interstitial: waits, then the screenshot is the page behind it", async () => {
        const started = Date.now();
        const { final, events } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=4000&ip={host}`,
          backend,
          botCheck: "auto",
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        assert.ok(Date.now() - started >= 4000, "didn't capture before the check cleared");
        const waiting = events.find((e) => e.type === "waiting");
        assert.ok(waiting, "the popup was told it's waiting");
        assert.equal(waiting.mode, "auto");
        assert.match(waiting.reason, /Just a moment/);
        assert.ok(events.some((e) => e.type === "resumed"), "and told when the wait ended");
        const entry = await manifestEntry(downloadsDir, final);
        assert.equal(entry.botCheck.mode, "auto");
        assert.equal(entry.botCheck.continuedBy, "check-gone");
        assert.ok(entry.botCheck.waitedMs >= 2000, `waitedMs ${entry.botCheck.waitedMs}`);
        const rgb = await pixelAt(context, path.join(downloadsDir, entry.pngPath), 10, 300);
        assert.ok(near(rgb, GREEN), `expected the real page (green), got ${rgb}`);
      });

      await t.test("a site saved by 1.8 with waitForChallenge: true still waits", async () => {
        const { final, events } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=2500&ip={host}`,
          backend,
          waitForChallenge: true,
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        assert.ok(events.some((e) => e.type === "waiting"));
      });

      await t.test("Off: the same page is captured as the challenge", async () => {
        const { final } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=4000&ip={host}`,
          backend,
          botCheck: "off",
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
          botCheck: "auto",
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        assert.ok(events.some((e) => e.type === "waiting"));
        const entry = await manifestEntry(downloadsDir, final);
        const rgb = await pixelAt(context, path.join(downloadsDir, entry.pngPath), 10, 300);
        assert.ok(near(rgb, GREEN), `got ${rgb}`);
      });

      await t.test("a captcha added after the page has loaded is caught during the settle time", async () => {
        const { final, events } = await runCapture(ext, {
          url: `${server.url}late.html?showAfter=1500&clearAfter=5000&ip={host}`,
          backend,
          botCheck: "auto",
          settleMs: 3000,
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        const waiting = events.find((e) => e.type === "waiting");
        assert.ok(waiting, "the late widget was seen");
        assert.match(waiting.reason, /hCaptcha/);
        const entry = await manifestEntry(downloadsDir, final);
        const rgb = await pixelAt(context, path.join(downloadsDir, entry.pngPath), 10, 300);
        assert.ok(near(rgb, GREEN), `expected the page after the widget went (green), got ${rgb}`);
      });

      await t.test("a Turnstile-style widget (frame in a closed shadow root) is found by its container", async () => {
        const { final, events } = await runCapture(ext, {
          url: `${server.url}turnstile.html?clearAfter=3000&ip={host}`,
          backend,
          botCheck: "auto",
        });
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        const waiting = events.find((e) => e.type === "waiting");
        assert.ok(waiting);
        assert.match(waiting.reason, /cf-turnstile/);
      });

      await t.test("invisible captchas (a reCAPTCHA badge, an invisible-mode button) are not checks: no wait", async () => {
        for (const page of ["invisible.html", "plain.html"]) {
          const started = Date.now();
          const { final, events } = await runCapture(ext, { url: `${server.url}${page}?ip={host}`, backend, botCheck: "auto" });
          assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
          assert.equal(events.some((e) => e.type === "waiting"), false, page);
          assert.ok(Date.now() - started < 15000);
          const entry = await manifestEntry(downloadsDir, final);
          assert.equal(entry.botCheck, undefined);
        }
      });

      await t.test("a captcha that stays on the page: Capture now ends the wait and captures", async () => {
        await startCapture(ext, { url: `${server.url}gate.html?ip={host}`, backend, botCheck: "auto" });
        await waitForWaiting(ext);
        await sleep(500);
        await send(ext, { type: "WAIT_ACTION", action: "capture" });
        const { final } = await finish(ext);
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        const entry = await manifestEntry(downloadsDir, final);
        assert.equal(entry.botCheck.continuedBy, "capture-now");
      });

      await t.test("Skip ends the wait without a screenshot", async () => {
        await startCapture(ext, { url: `${server.url}gate.html?ip={host}`, backend, botCheck: "auto" });
        await waitForWaiting(ext);
        await send(ext, { type: "WAIT_ACTION", action: "skip" });
        const { final } = await finish(ext);
        assert.equal(final.results[0].ok, false);
        assert.match(final.results[0].error, /Skipped while waiting for a bot check or captcha/);
        assert.equal(final.manifestPath, null, "nothing saved");
      });

      await t.test("Stop ends the wait too", async () => {
        await startCapture(ext, { url: `${server.url}gate.html?ip={host}`, backend, botCheck: "auto" });
        await waitForWaiting(ext);
        await send(ext, { type: "STOP" });
        const { final } = await finish(ext);
        assert.equal(final.results[0].ok, false);
        assert.match(final.results[0].error, /Stopped while waiting/);
      });

      await t.test("Always pause: waits for Capture now on an ordinary page", async () => {
        await startCapture(ext, { url: `${server.url}invisible.html?ip={host}`, backend, botCheck: "pause" });
        const waiting = await waitForWaiting(ext);
        assert.equal(waiting.mode, "pause");
        await sleep(1500);
        assert.equal(await ext.evaluate(() => window.__run.events.some((e) => e.type === "done")), false, "still waiting");
        await send(ext, { type: "WAIT_ACTION", action: "capture" });
        const { final } = await finish(ext);
        assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
        const entry = await manifestEntry(downloadsDir, final);
        assert.equal(entry.botCheck.mode, "pause");
        assert.equal(entry.botCheck.continuedBy, "capture-now");
        assert.ok(entry.botCheck.waitedMs >= 1500);
      });

      await t.test("a check that isn't cleared in time fails the job, with no screenshot", async () => {
        const { final } = await runCapture(ext, {
          url: `${server.url}challenge.html?clearAfter=600000&ip={host}`,
          backend,
          botCheck: "auto",
          challengeTimeoutSec: 5,
        });
        assert.equal(final.results[0].ok, false);
        assert.match(final.results[0].error, /wasn't cleared within 5 s, so this lookup wasn't captured/);
        assert.equal(final.manifestPath, null, "nothing saved");
      });

      await t.test("Always pause with nobody pressing Capture now fails in time", async () => {
        const { final } = await runCapture(ext, {
          url: `${server.url}invisible.html?ip={host}`,
          backend,
          botCheck: "pause",
          challengeTimeoutSec: 5,
        });
        assert.equal(final.results[0].ok, false);
        assert.match(final.results[0].error, /Capture now wasn't pressed within 5 s/);
      });
    } finally {
      await close();
    }
  });
}

test("Save a manifest off: only the screenshot is saved", async () => {
  const { downloadsDir, server, ext, close } = await setup();
  try {
    const { final } = await runCapture(ext, {
      url: `${server.url}invisible.html?ip={host}`,
      backend: "fullpage",
      botCheck: "off",
      saveManifest: false,
    });
    assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
    assert.equal(final.manifestPath, null);
    await sleep(500);
    const files = listFiles(downloadsDir);
    assert.equal(files.filter((f) => f.endsWith(".png")).length, 1, files.join("\n"));
    assert.equal(files.some((f) => /manifest-|SHA256SUMS-/.test(f)), false, files.join("\n"));
  } finally {
    await close();
  }
});

test("popup opened mid-wait: shows the batch, Capture now works, badge shows WAIT", async () => {
  const { server, context, worker, extId, ext, close } = await setup();
  try {
    await startCapture(ext, { url: `${server.url}gate.html?ip={host}`, backend: "fullpage", botCheck: "auto" });
    await waitForWaiting(ext);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "WAIT");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector(".wait-capture", { timeout: 10000 });
    assert.match(await popup.textContent("#runHeaderText"), /Batch running/);
    assert.equal(await popup.isDisabled("#stopBtn"), false, "Stop is available");
    assert.match(await popup.textContent(".wait-text"), /Bot check showing/);
    await popup.click(".wait-capture");
    await popup.waitForSelector(".status.ok", { timeout: 20000 });
    await popup.waitForFunction(() => /Last batch/.test(document.getElementById("runHeaderText").textContent));
    const { final } = await finish(ext);
    assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");

    // Reopened later, the popup shows how the last batch ended, and Clear clears it.
    await popup.reload();
    await popup.waitForSelector(".status.ok");
    assert.match(await popup.textContent("#runHeaderText"), /Last batch · finished/);
    await popup.click("#runClearBtn");
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    await sleep(300);
    assert.equal(await popup.$$eval(".progress-row", (rows) => rows.length), 0);
  } finally {
    await close();
  }
});

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

test("popup: − and + correct the next number, and the held number while holding", async () => {
  const extDir = await copyExtension(grantScriptingAndAllUrls);
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  const { browser, context, proc } = await launchNative(extDir, downloadsDir);
  try {
    const worker = await extensionWorker(context);
    const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    assert.equal(await popup.isVisible("#exportSeqUp"), false, "no buttons without a case");
    await popup.fill("#caseRef", "INC-SEQ");
    const next = () => popup.textContent("#exportNext");
    assert.equal(await next(), "INC-SEQ · next #01");
    assert.equal(await popup.isDisabled("#exportSeqDown"), true, "can't go below 01");
    await popup.click("#exportSeqUp");
    await popup.waitForFunction(() => /#02/.test(document.getElementById("exportNext").textContent));
    await popup.click("#exportSeqUp");
    await popup.waitForFunction(() => /#03/.test(document.getElementById("exportNext").textContent));
    await popup.click("#exportSeqDown");
    await popup.waitForFunction(() => /next #02/.test(document.getElementById("exportNext").textContent));
    // Hold (keeps #01, the last number used), then move the held number.
    await popup.check("#exportHold");
    await popup.waitForFunction(() => /holding #01/.test(document.getElementById("exportNext").textContent));
    await popup.click("#exportSeqUp");
    await popup.waitForFunction(() => /holding #02/.test(document.getElementById("exportNext").textContent));
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "#02");
    // Released: numbering carries on after the held number.
    await popup.uncheck("#exportHold");
    await popup.waitForFunction(() => /next #03/.test(document.getElementById("exportNext").textContent));
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
  }
});
