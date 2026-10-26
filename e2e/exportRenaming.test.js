// End-to-end test for "Rename exports", against real Chromium downloads.
//
// The other e2e tests launch Chromium through Playwright, and Playwright
// intercepts every download (it saves them under UUID names in its own
// folder), which bypasses Chromium's filename decision — the very thing
// this feature hooks into. So this test launches Chromium itself, with a
// profile whose Downloads folder is a temp directory, connects Playwright
// over CDP only to drive pages, and puts the browser's download behaviour
// back to Chromium's default. Files then land on disk under exactly the
// names Chromium picked, and the assertions read the folder directly.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStaticServer } from "./staticServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium/chrome-linux/chrome";
const TS = String.raw`\d{8}T\d{6}Z`;

async function copyExtension() {
  const dst = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-ext-"));
  const SKIP = new Set(["node_modules", "e2e", "tests", ".git", "dist"]);
  await fsp.cp(EXT_DIR, dst, {
    recursive: true,
    filter: (src) => !SKIP.has(path.relative(EXT_DIR, src).split(path.sep)[0]),
  });
  return dst;
}

/** Launch Chromium directly (no Playwright download interception) and connect over CDP. */
async function launchNative(extDir, downloadsDir) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-profile-"));
  await fsp.mkdir(path.join(profile, "Default"), { recursive: true });
  await fsp.writeFile(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false } })
  );
  const exe = fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : chromium.executablePath();
  const proc = spawn(
    exe,
    [
      "--no-sandbox", // required to run Chromium as root in this container
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(100);
  const cdpPort = (await fsp.readFile(portFile, "utf8")).split("\n")[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const browserSession = await browser.newBrowserCDPSession();
  // Undo any download interception so Chromium names and places files itself.
  await browserSession.send("Browser.setDownloadBehavior", { behavior: "default" });
  const context = browser.contexts()[0];
  return { browser, browserSession, context, proc };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Chromium launched without Playwright's default flags also runs its own
// component extensions, some of which have a background.js too — so match
// on the manifest name, not the script URL.
async function isOurWorker(w) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(w.url())) return false;
  try {
    // A worker Chromium has stopped can still be listed, and evaluating in it
    // never returns — hence the race.
    const name = await Promise.race([w.evaluate(() => chrome.runtime.getManifest().name), sleep(2000)]);
    return name === "IOC Lookup Capture";
  } catch {
    return false;
  }
}

async function extensionWorker(context, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    for (const w of context.serviceWorkers()) if (await isOurWorker(w)) return w;
    if (Date.now() - start > timeoutMs) throw new Error("extension service worker not found");
    await sleep(200);
  }
}

/** Every file under `dir`, as "/"-joined paths relative to it. Skips in-progress downloads. */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (!/\.(crdownload|tmp)$/.test(e.name)) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Wait until a file matching `re` appears that wasn't in `before`; return its path. */
async function waitForNewFile(dir, before, re, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const fresh = listFiles(dir).filter((f) => !before.includes(f));
    const hit = fresh.find((f) => re.test(f));
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`No new file matching ${re} after ${timeoutMs}ms. New files: ${JSON.stringify(fresh)}`);
    }
    await sleep(150);
  }
}

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

async function sendFromPage(page, message) {
  return page.evaluate((m) => new Promise((resolve) => chrome.runtime.sendMessage(m, resolve)), message);
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
      assert.equal(await popup.textContent("#exportNext"), "Next number for INC-1234: #01");
      await popup.click("#exportToggleBtn");
      await popup.waitForFunction(() => document.getElementById("exportState").textContent === "ON · INC-1234");
      assert.equal(await badgeText(worker), "ON");
      assert.equal(await hasRenameListener(worker), true);
      await popup.fill("#exportLabel", "signins");
      await sleep(300);
      await popup.close();
    });

    await t.test("an object-URL CSV export gets #01 and the one-off label", async () => {
      const file = await exportVia(site, downloadsDir, "csv", /\.csv$/);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-01-signins-query_data-${TS}\\.csv$`));
      const text = await fsp.readFile(path.join(downloadsDir, file), "utf8");
      assert.match(text, /UserPrincipalName/, "file content intact");
    });

    await t.test("the label is used once; the next export gets #02 without it", async () => {
      const file = await exportVia(site, downloadsDir, "xlsx", /\.xlsx$/);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-02-query_data-${TS}\\.xlsx$`));
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
      await popup.waitForFunction(() => document.getElementById("exportNext").textContent.startsWith("Next export: #01"));

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
