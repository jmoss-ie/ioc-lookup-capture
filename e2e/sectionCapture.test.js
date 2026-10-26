// End-to-end test for "Capture section": finds the Log Analytics query view
// (by its CSS classes) inside nested cross-site iframes, the way the Azure
// portal embeds the Logs page, and checks the saved PNG is cropped to
// exactly that element. Uses the native-Chromium harness so files land
// under their real names (see e2e/nativeChrome.js).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./staticServer.js";
import {
  TS,
  copyExtension,
  extensionWorker,
  grantScriptingAndAllUrls,
  launchNative,
  listFiles,
  sendFromPage,
  sleep,
  waitForNewFile,
} from "./nativeChrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BLUE = [0, 90, 200];
const RED = [255, 0, 0];

/** Decode a PNG in the browser; return its size and the colours at the given points. */
async function samplePng(context, file, points) {
  const page = await context.newPage();
  await page.goto("about:blank");
  const b64 = fs.readFileSync(file).toString("base64");
  const out = await page.evaluate(
    async ({ b64, points }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const colours = points.map(([x, y]) => {
        const px = Math.min(bmp.width - 1, Math.max(0, x < 0 ? bmp.width + x : x));
        const py = Math.min(bmp.height - 1, Math.max(0, y < 0 ? bmp.height + y : y));
        return Array.from(ctx.getImageData(px, py, 1, 1).data.slice(0, 3));
      });
      return { width: bmp.width, height: bmp.height, colours };
    },
    { b64, points }
  );
  await page.close();
  return out;
}

function near(actual, expected, tolerance = 4) {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
}

/** The id of the tab showing `url`. */
async function tabIdFor(extPage, url) {
  return extPage.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.startsWith(u));
    return t ? t.id : null;
  }, url);
}

/** Make `page` the visible tab of its window, as it is when you click the toolbar button. */
async function bringToFront(page) {
  await page.bringToFront();
  await sleep(300);
}

test("Capture section: crops to the query view inside nested cross-site iframes", async (t) => {
  const extDir = await copyExtension(grantScriptingAndAllUrls);
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "section-page"));
  const exportServer = await startStaticServer(path.join(__dirname, "fixtures", "export-page"));
  const port = new URL(server.url).port;
  // 127.0.0.1 and localhost are different sites, so Chromium puts the inner
  // frame in its own process (an out-of-process iframe), as the portal's is.
  const topUrl = (target) =>
    `http://127.0.0.1:${port}/top.html?inner=${encodeURIComponent(`http://localhost:${port}/inner.html`)}` +
    `&target=${encodeURIComponent(target)}`;
  const { browser, context, proc } = await launchNative(extDir, downloadsDir);

  try {
    const worker = await extensionWorker(context);
    const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extId}/options.html`);

    const site = await context.newPage();
    const capture = async (url, caseRef = "INC-1234") => {
      await site.goto(url);
      await site.waitForLoadState("load");
      await sleep(800); // nested frames
      await bringToFront(site);
      const tabId = await tabIdFor(ext, url.split("?")[0]);
      assert.ok(tabId, "found the fixture tab");
      const before = listFiles(downloadsDir);
      const res = await sendFromPage(ext, { type: "CAPTURE_SECTION", tabId, caseRef });
      if (!res.ok) return { res };
      const file = await waitForNewFile(downloadsDir, before, /\.png$/);
      return { res, file };
    };

    await t.test("nested cross-site frames: exactly the 408x308 element, border to border", async () => {
      const { res, file } = await capture(topUrl(`http://127.0.0.1:${port}/target.html`));
      assert.equal(res.ok, true, res.error);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-01-section-${TS}\\.png$`));
      const png = await samplePng(context, path.join(downloadsDir, file), [
        [0, 0],
        [-1, -1],
        [3, 150],
        [204, 154],
        [403, 303],
      ]);
      assert.equal(png.width, 408, "width");
      assert.equal(png.height, 308, "height");
      assert.ok(near(png.colours[0], RED), `top-left is the red border, got ${png.colours[0]}`);
      assert.ok(near(png.colours[1], RED), `bottom-right is the red border, got ${png.colours[1]}`);
      assert.ok(near(png.colours[2], RED), `left edge is the red border, got ${png.colours[2]}`);
      assert.ok(near(png.colours[3], BLUE), `centre is the blue fill, got ${png.colours[3]}`);
      assert.ok(near(png.colours[4], BLUE), `just inside the bottom-right border is blue, got ${png.colours[4]}`);
      assert.equal(res.width, 408);
      assert.equal(res.clipped, false);
    });

    await t.test("partly scrolled out of its frame: the visible part only, flagged as clipped", async () => {
      const { res, file } = await capture(topUrl(`http://127.0.0.1:${port}/target.html?shift=-70`));
      assert.equal(res.ok, true, res.error);
      // top moves from 20 to -50: 50px of the 308px element are above the frame.
      const png = await samplePng(context, path.join(downloadsDir, file), [[0, 0], [204, 0], [-1, -1]]);
      assert.equal(png.width, 408);
      assert.equal(png.height, 258);
      assert.ok(near(png.colours[1], BLUE), `top edge is now the blue fill, got ${png.colours[1]}`);
      assert.equal(res.clipped, true);
      assert.match(file, /-02-section-/, "numbering continues");
    });

    await t.test("an element in the top frame itself", async () => {
      const { res, file } = await capture(`http://127.0.0.1:${port}/flat.html`, "INC-5678");
      assert.equal(res.ok, true, res.error);
      assert.match(file, /^soc-evidence\/INC-5678\/exports\/INC-5678-01-section-/);
      const png = await samplePng(context, path.join(downloadsDir, file), [[0, 0], [129, 64]]);
      assert.equal(png.width, 258);
      assert.equal(png.height, 128);
      assert.ok(near(png.colours[0], RED));
      assert.ok(near(png.colours[1], BLUE));
    });

    await t.test("nothing matching: a clear error, and no number used", async () => {
      const { settings } = await sendFromPage(ext, { type: "GET_STATE" });
      await sendFromPage(ext, { type: "SAVE_SETTINGS", settings: { ...settings, sectionSelectors: "#does-not-exist" } });
      const { res } = await capture(`http://127.0.0.1:${port}/flat.html`, "INC-5678");
      assert.equal(res.ok, false);
      assert.match(res.error, /None of the section selectors match/);
      const status = await sendFromPage(ext, { type: "EXPORT_GET_STATUS" });
      assert.equal(status.nextSeqByCase["INC-5678"], 2, "failed capture didn't take a number");
      await sendFromPage(ext, { type: "SAVE_SETTINGS", settings });
    });

    await t.test("a later selector line is used when the first matches nothing", async () => {
      const { settings } = await sendFromPage(ext, { type: "GET_STATE" });
      await sendFromPage(ext, {
        type: "SAVE_SETTINGS",
        settings: { ...settings, sectionSelectors: "#nope\n\n#target" },
      });
      const { res } = await capture(`http://127.0.0.1:${port}/flat.html`, "INC-5678");
      assert.equal(res.ok, true, res.error);
      assert.equal(res.width, 258);
      await sendFromPage(ext, { type: "SAVE_SETTINGS", settings });
    });

    await t.test("popup: button needs a case ref, and the capture shows in the list", async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.waitForSelector("#sectionCaptureBtn");
      await popup.waitForFunction(() => document.getElementById("exportNext").textContent !== "");
      assert.equal(await popup.isDisabled("#sectionCaptureBtn"), true);
      await popup.fill("#caseRef", "INC-1234");
      assert.equal(await popup.isDisabled("#sectionCaptureBtn"), false);
      assert.equal(await popup.textContent("#exportNext"), "INC-1234 · next #03");
      await popup.reload();
      await popup.waitForSelector("#exportLog li");
      assert.match(await popup.textContent("#exportLog"), /#01 section 408×308 → INC-1234-01-section-/);
      assert.match(await popup.textContent("#exportLog"), /#02 section 408×258 \(visible part only\)/);
      await popup.close();
    });

    await t.test("with renaming on: capture and export share the numbering and the label", async () => {
      await sendFromPage(ext, { type: "EXPORT_ARM", caseRef: "INC-1234" });
      await sendFromPage(ext, { type: "EXPORT_SET_LABEL", label: "failedlogons" });
      const { res, file } = await capture(topUrl(`http://127.0.0.1:${port}/target.html`));
      assert.equal(res.ok, true, res.error);
      assert.match(file, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-03-failedlogons-section-${TS}\\.png$`));

      const exportPage = await context.newPage();
      await exportPage.goto(exportServer.url);
      const before = listFiles(downloadsDir);
      await exportPage.click("#csv");
      const csv = await waitForNewFile(downloadsDir, before, /\.csv$/);
      assert.match(csv, new RegExp(`^soc-evidence/INC-1234/exports/INC-1234-04-failedlogons-query_data-${TS}\\.csv$`));
      await sendFromPage(ext, { type: "EXPORT_DISARM" });
      await exportPage.close();
    });
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
    await server.close();
    await exportServer.close();
  }
});

test("Capture section: without scripting + <all_urls> granted, says so instead of failing oddly", async () => {
  const extDir = await copyExtension(); // optional permissions left ungranted
  const downloadsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-native-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "section-page"));
  const { browser, context, proc } = await launchNative(extDir, downloadsDir);
  try {
    const worker = await extensionWorker(context);
    const extId = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extId}/options.html`);
    const site = await context.newPage();
    await site.goto(`${server.url}flat.html`);
    const tabId = await tabIdFor(ext, `${server.url}flat.html`);
    const res = await sendFromPage(ext, { type: "CAPTURE_SECTION", tabId, caseRef: "INC-1" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "PERMISSION");
    assert.match(res.error, /needs "All sites" \(<all_urls>\) and scripting/);
    assert.deepEqual(listFiles(downloadsDir), []);
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
    await server.close();
  }
});
