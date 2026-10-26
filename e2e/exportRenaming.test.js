// End-to-end test for "Rename exports", against real Chromium downloads
// (see e2e/nativeChrome.js for why this doesn't let Playwright launch the
// browser). The assertions read the Downloads folder directly.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./staticServer.js";
import {
  TS,
  copyExtension,
  extensionWorker,
  launchNative,
  listFiles,
  sendFromPage,
  sleep,
  waitForNewFile,
} from "./nativeChrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Click an export button on the fixture page and return the one new file it produced. */
async function exportVia(page, downloadsDir, buttonId, re) {
  const before = listFiles(downloadsDir);
  await page.click(`#${buttonId}`);
  const file = await waitForNewFile(downloadsDir, before, re);
  await sleep(300); // let Chromium finish any rename-on-complete
  return file;
}

async function openPopup(context, extId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector("#exportToggleBtn");
  await popup.waitForFunction(() => document.getElementById("exportState").textContent !== "");
  return popup;
}

/** Run a one-job capture batch against a local page, the same way the popup's Capture button does. */
async function runLocalCapture(popup, url) {
  return popup.evaluate(
    async ({ url }) => {
      const state = await new Promise((r) => chrome.runtime.sendMessage({ type: "GET_STATE" }, r));
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "capture" });
        port.onMessage.addListener((msg) => {
          if (msg.type === "RUN_COMPLETE") resolve(msg.final);
          if (msg.type === "RUN_FAILED") reject(new Error(msg.error));
        });
        port.postMessage({
          type: "START_CAPTURE",
          caseRef: "INC-1234",
          settings: { ...state.settings, captureBackend: "fullpage", navigationTimeoutMs: 20000 },
          jobs: [
            {
              indicator: "1.2.3.4",
              indicatorKind: "ipv4",
              host: null,
              site: { id: "local", name: "Local", url: url + "?ip={indicator}", applies: ["ipv4"], settleMs: 300, fullscreen: false },
            },
          ],
        });
      });
    },
    { url }
  );
}

/** The three files a one-job capture writes, by their own names. */
function assertCaptureFiles(fresh) {
  assert.equal(fresh.length, 3, `expected PNG + manifest + checksums, got ${JSON.stringify(fresh)}`);
  assert.ok(fresh.some((f) => new RegExp(`^soc-evidence/INC-1234/1\\.2\\.3\\.4/local-1\\.2\\.3\\.4-${TS}\\.png$`).test(f)), JSON.stringify(fresh));
  assert.ok(fresh.some((f) => new RegExp(`^soc-evidence/INC-1234/manifest-${TS}\\.json$`).test(f)), JSON.stringify(fresh));
  assert.ok(fresh.some((f) => new RegExp(`^soc-evidence/INC-1234/SHA256SUMS-${TS}\\.txt$`).test(f)), JSON.stringify(fresh));
}

async function hasRenameListener(worker) {
  return worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners());
}

async function badgeText(worker) {
  return worker.evaluate(() => chrome.action.getBadgeText({}));
}

test("Rename exports: renames page downloads into the case folder, in order, and leaves everything else alone", async (t) => {
  const extDir = await copyExtension();
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "export-page"));
  const captureTarget = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { browser, browserSession, context, proc } = await launchNative(extDir, downloadsDir);

  try {
    let worker = await extensionWorker(context);
    const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
    const site = await context.newPage();
    await site.goto(server.url);

    await t.test("starting renaming from the popup sets the badge", async () => {
      const popup = await openPopup(context, extId);
      assert.equal(await popup.textContent("#exportState"), "Off");
      assert.equal(await popup.isDisabled("#exportToggleBtn"), true, "needs a case ref first");
      await popup.fill("#caseRef", "INC-1234");
      assert.equal(await popup.textContent("#exportNext"), "INC-1234 · next #01");
      await popup.click("#exportToggleBtn");
      await popup.waitForFunction(() => document.getElementById("exportState").textContent === "ON · INC-1234");
      assert.equal(await badgeText(worker), "ON");
      assert.equal(await hasRenameListener(worker), true);
      await popup.fill("#exportLabel", "signins");
      await sleep(300);
      await popup.close();
    });

    await t.test("an object-URL CSV export gets #01 and the label", async () => {
      const file = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-01-signins-query_data-${TS}\\.csv$`));
      const text = await fsp.readFile(path.join(downloadsDir, file), "utf8");
      assert.match(text, /UserPrincipalName/, "file content intact");
    });

    await t.test("the label stays until it's changed: #02 keeps it, then it's cleared", async () => {
      const file = await exportVia(site, downloadsDir, "xlsx", /\.xlsx$/);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-02-signins-query_data-${TS}\\.xlsx$`));
      const popup = await openPopup(context, extId);
      assert.equal(await popup.inputValue("#exportLabel"), "signins", "popup shows the current label");
      await popup.fill("#exportLabel", "");
      await sleep(300);
      await popup.close();
    });

    await t.test("a data:-URL export is renamed too (#03)", async () => {
      const file = await exportVia(site, downloadsDir, "dataurl", /\.txt$/);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-03-PowerBIQuery-${TS}\\.txt$`));
    });

    await t.test("the extension's own capture files keep their own names while renaming is on", async () => {
      // A real capture batch (screenshot + manifest + checksum file) against a
      // local page. Chromium ignores the filename an extension passes to
      // chrome.downloads.download while that extension has an
      // onDeterminingFilename listener, unless the listener suggests it back.
      const popup = await openPopup(context, extId);
      const before = listFiles(downloadsDir);
      const final = await runLocalCapture(popup, captureTarget.url);
      assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
      await sleep(500);
      const fresh = listFiles(downloadsDir).filter((f) => !before.includes(f));
      assertCaptureFiles(fresh);
      assert.equal(fresh.some((f) => f.includes("/exports/")), false, "own files must not be treated as exports");

      // ...and they didn't consume a sequence number.
      const status = await sendFromPage(popup, { type: "EXPORT_GET_STATUS" });
      assert.equal(status.nextSeqByCase["INC-1234"], 4);
      await popup.close();
    });

    await t.test("renaming survives a service-worker shutdown: the next download wakes it", async () => {
      // Stop the worker the way Chromium does when it's been idle, by closing
      // its target. No extension page is open, so nothing restarts it — until
      // the download event does. (Checked through CDP target listings:
      // Playwright doesn't report a worker closing over a CDP connection.)
      const ourWorkerTargets = async () =>
        (await browserSession.send("Target.getTargets")).targetInfos.filter(
          (ti) => ti.type === "service_worker" && ti.url === `chrome-extension://${extId}/background.js`
        );
      const [target] = await ourWorkerTargets();
      assert.ok(target, "found the worker's CDP target");
      await browserSession.send("Target.closeTarget", { targetId: target.targetId });
      for (let i = 0; i < 50 && (await ourWorkerTargets()).length > 0; i++) await sleep(100);
      assert.equal((await ourWorkerTargets()).length, 0, "service worker should have stopped");

      // Only the worker's listener can produce this name, and no worker was
      // running when the download started — so the download woke it.
      const file = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-04-query_data-${TS}\\.csv$`));
      worker = await extensionWorker(context);
    });

    await t.test("the host filter skips downloads from other sites, and the popup says where they came from", async () => {
      const popup = await openPopup(context, extId);
      const { settings } = await sendFromPage(popup, { type: "GET_STATE" });
      await sendFromPage(popup, { type: "SAVE_SETTINGS", settings: { ...settings, exportHostFilter: "portal.azure.com" } });
      const skipped = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(skipped, /^query_data[^/]*\.csv$/, "kept the browser's own name and place");

      await popup.reload();
      await popup.waitForSelector("#exportLog li.skipped");
      assert.match(await popup.textContent("#exportLog li.skipped"), /query_data\.csv from 127\.0\.0\.1/);

      await sendFromPage(popup, { type: "SAVE_SETTINGS", settings: { ...settings, exportHostFilter: "portal.azure.com\n127.0.0.1" } });
      const renamed = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(renamed, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-05-query_data-${TS}\\.csv$`));
      await sendFromPage(popup, { type: "SAVE_SETTINGS", settings: { ...settings, exportHostFilter: "" } });
      await popup.close();
    });

    await t.test("restart numbering, template changes, and switching case", async () => {
      const popup = await openPopup(context, extId);
      assert.equal(await popup.inputValue("#caseRef"), "INC-1234", "popup fills in the armed case");
      assert.equal(await popup.isVisible("#exportResetBtn"), true);
      await popup.click("#exportResetBtn");
      await popup.waitForFunction(() => document.getElementById("exportNext").textContent === "INC-1234 · next #01");

      const { settings } = await sendFromPage(popup, { type: "GET_STATE" });
      await sendFromPage(popup, {
        type: "SAVE_SETTINGS",
        settings: { ...settings, hiddenPrefix: "TCS", exportTemplate: "{prefix}_{case}_{seq}_{label}", exportSubfolder: "" },
      });
      const a = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.equal(a, "soc-evidence/INC-1234/TCS_INC-1234_01.csv");

      await popup.fill("#caseRef", "INC-5678");
      assert.equal(await popup.textContent("#exportSwitchBtn"), "Switch to INC-5678");
      await popup.click("#exportSwitchBtn");
      await popup.waitForFunction(() => document.getElementById("exportState").textContent === "ON · INC-5678");
      const b = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.equal(b, "soc-evidence/INC-5678/TCS_INC-5678_01.csv");

      await sendFromPage(popup, { type: "SAVE_SETTINGS", settings });
      await popup.close();
    });

    await t.test("stopping renaming clears the badge and downloads keep their own names again", async () => {
      const popup = await openPopup(context, extId);
      await popup.click("#exportToggleBtn");
      await popup.waitForFunction(() => document.getElementById("exportState").textContent === "Off");
      assert.equal(await badgeText(worker), "");
      assert.equal(await hasRenameListener(worker), false, "listener removed while off");
      const file = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(file, /^query_data[^/]*\.csv$/);

      // Capture files still get their own names with the listener gone.
      const before = listFiles(downloadsDir);
      const final = await runLocalCapture(popup, captureTarget.url);
      assert.equal(final.results[0].ok, true, JSON.stringify(final.results));
      await sleep(500);
      assertCaptureFiles(listFiles(downloadsDir).filter((f) => !before.includes(f)));
      await popup.close();
    });

    await t.test("renaming switches itself off after the idle timeout", async () => {
      const popup = await openPopup(context, extId);
      await popup.fill("#caseRef", "INC-9");
      await popup.click("#exportToggleBtn");
      await popup.waitForFunction(() => document.getElementById("exportState").textContent === "ON · INC-9");
      // Pretend the last export was two hours ago.
      await popup.evaluate(async () => {
        const { exportArm } = await chrome.storage.local.get("exportArm");
        exportArm.lastActivityAt -= 2 * 60 * 60 * 1000;
        await chrome.storage.local.set({ exportArm });
      });
      const file = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(file, /^query_data[^/]*\.csv$/, "not renamed after timing out");
      await popup.reload();
      await popup.waitForFunction(() => document.getElementById("exportState").textContent === "Off");
      assert.match(await popup.textContent("#exportLog"), /switched itself off after 60 min/);
      assert.equal(await badgeText(worker), "");
      await popup.close();
    });
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
    await server.close();
    await captureTarget.close();
  }
});
