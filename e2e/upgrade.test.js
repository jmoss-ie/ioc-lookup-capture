// End-to-end test of updating an unpacked install by replacing its files.
//
// Observed in Chromium: after the files of an unpacked extension are
// replaced, the extension's background code can stay the previous version's
// — through a browser restart — until the extension is reloaded, while the
// popup and Options pages already load the new files. Everything the
// background does (site-list upgrades, captures) is then still the old
// version's. This test replays that with the 1.7.0 release (taken from git),
// then checks that the popup notices, that its Reload button brings in the
// new background code, and that the site-list upgrade then happens.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { EXT_DIR, copyExtension, extensionWorker, launchNative, sleep } from "./nativeChrome.js";

const OLD_RELEASE = "3cc3a1b"; // main at 1.7.0

function oldReleaseAvailable() {
  try {
    execFileSync("git", ["-C", EXT_DIR, "cat-file", "-e", `${OLD_RELEASE}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function replaceContents(dir, fromDir) {
  for (const f of await fsp.readdir(dir)) await fsp.rm(path.join(dir, f), { recursive: true, force: true });
  await fsp.cp(fromDir, dir, { recursive: true });
}

/** Open a page of the extension, retrying while it's mid-reload. */
async function openExtPage(context, extId, file) {
  const page = await context.newPage();
  for (let i = 0; ; i++) {
    try {
      await page.goto(`chrome-extension://${extId}/${file}`);
      return page;
    } catch (err) {
      if (i >= 30) throw err;
      await sleep(500);
    }
  }
}

test("files replaced without a reload: the popup says so, and its Reload finishes the update", { skip: !oldReleaseAvailable() && "needs git history" }, async () => {
  const extDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-upgrade-ext-"));
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  execFileSync("sh", ["-c", `git -C "${EXT_DIR}" archive ${OLD_RELEASE} | tar -x -C "${extDir}"`]);

  // 1.7.0 runs once, seeding the site list with its defaults.
  let { browser, context, proc, profile } = await launchNative(extDir, downloadsDir, { developerMode: true });
  let extId;
  try {
    const worker = await extensionWorker(context);
    extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
    const options = await openExtPage(context, extId, "options.html");
    await options.waitForSelector("#siteTableBody tr");
    assert.equal(await options.evaluate(() => chrome.runtime.getManifest().version), "1.7.0");
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
  }
  await sleep(1000);

  // The new files go in the same folder (same extension id, same storage); Chrome restarts.
  await replaceContents(extDir, await copyExtension());
  ({ browser, context, proc } = await launchNative(extDir, downloadsDir, { profile, developerMode: true }));
  try {
    const files = JSON.parse(await fsp.readFile(path.join(EXT_DIR, "manifest.json"), "utf8")).version;
    const popup = await openExtPage(context, extId, "popup.html");
    await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    const stale = await popup.isVisible("#staleBanner");
    console.log(`stale background after restart: ${stale}`);
    const sitesNow = await popup.evaluate(async () => (await chrome.storage.local.get("sites")).sites);
    const teohNow = sitesNow.find((s) => s.id === "ip-teoh-io").url;
    if (!stale) {
      // This Chromium ran the new background straight away: nothing to catch.
      assert.equal(teohNow, "https://ip.teoh.io/{host}", "and so it upgraded the site list");
      return;
    }
    assert.match(await popup.textContent("#staleText"), new RegExp(`files are version ${files.replace(/\./g, "\\.")}`));
    assert.match(await popup.textContent("#staleText"), /an earlier version's background code/);
    assert.equal(teohNow, "https://ip.teoh.io/geolocation/{host}", "the old background didn't upgrade anything");

    await popup.click("#staleReloadBtn").catch(() => {}); // the popup closes as the extension reloads

    const after = await openExtPage(context, extId, "popup.html");
    await after.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
    assert.equal(await after.isVisible("#staleBanner"), false, "the background is the new code now");
    const sites = await after.evaluate(async () => (await chrome.storage.local.get("sites")).sites);
    const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
    assert.equal(byId["ip-teoh-io"].url, "https://ip.teoh.io/{host}");
    assert.equal(byId.spur.url, "https://app.spur.us/{host}");
    assert.equal(byId.pulsedive.url, "https://pulsedive.com/indicator/?ioc={base64}");
    assert.equal(byId.abuseipdb.settleMs, 7000);
    assert.equal(byId["virustotal-ip"].settleMs, 5000);
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
  }
});
