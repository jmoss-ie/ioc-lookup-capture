import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStaticServer } from "./staticServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
// Override with CHROMIUM_PATH=/path/to/chrome when Playwright's bundled revision isn't installed.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium/chrome-linux/chrome";

async function copyExtensionWithPatchedManifest(patchFn) {
  const dst = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-ext-"));
  const SKIP = new Set(["node_modules", "e2e", "tests", ".git"]);
  await fsp.cp(EXT_DIR, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(EXT_DIR, src);
      const top = rel.split(path.sep)[0];
      return !SKIP.has(top);
    },
  });
  if (patchFn) {
    const manifestPath = path.join(dst, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    patchFn(manifest);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return dst;
}

async function launchWithExtension(extDir, downloadsPath) {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // MV3 extension service workers need a real (or xvfb) display
    executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-sandbox", // required to run Chromium as root in this container
    ],
    acceptDownloads: true,
    downloadsPath,
    // Playwright otherwise emulates a 1280x720 viewport on every page it
    // attaches to — including the windows the extension opens itself, and
    // not always before the extension measures/captures them. Real browsers
    // don't do this, and it makes page metrics disagree with what
    // captureVisibleTab returns.
    viewport: null,
  });
  return { context, userDataDir };
}

async function getExtensionId(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  }
  const url = sw.url();
  return url.match(/^chrome-extension:\/\/([a-z]+)\//)[1];
}

async function runSelfTestInOptionsPage(context, extId, { backend, selfTestUrl, windowWidth, windowHeight }) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForSelector("#runSelfTestBtn");

  await page.fill("#selfTestUrl", selfTestUrl);
  await page.check(`input[name="backend"][value="${backend}"]`);
  if (windowWidth) await page.fill("#captureWindowWidth", String(windowWidth));
  if (windowHeight) await page.fill("#captureWindowHeight", String(windowHeight));
  await page.fill("#navigationTimeoutMs", "20000");

  await page.click("#runSelfTestBtn");
  await page.waitForFunction(
    () => {
      const el = document.getElementById("selfTestOutput");
      return el && el.textContent && el.textContent !== "Running self-test…";
    },
    { timeout: 30000 }
  );
  const output = await page.textContent("#selfTestOutput");
  await page.close();
  return output;
}

/**
 * Replace the saved site list with a single test site (pointed at the local
 * static server via the {indicator} placeholder) and seed `knownDefaultIds`
 * with every real default id, so the default-merge in common/storage.js
 * doesn't resurrect the real (external, slow, login-walled) site list on
 * top of it. Also merges in whatever settings overrides the test needs.
 */
async function seedSingleTestSite(context, extId, { customSite, settingsOverrides }) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.evaluate(
    async ({ customSite, settingsOverrides }) => {
      const mod = await import(chrome.runtime.getURL("common/defaultSites.js"));
      const knownDefaultIds = mod.DEFAULT_SITES.map((s) => s.id);
      const stored = await chrome.storage.local.get(["settings"]);
      const settings = { ...(stored.settings || {}), ...settingsOverrides };
      await chrome.storage.local.set({ sites: [customSite], knownDefaultIds, settings });
    },
    { customSite, settingsOverrides }
  );
  await page.close();
}

/** Open the popup, type indicators, and run Capture or Review, waiting for completion. */
async function runPopupBatch(context, extId, { indicators, siteId, action }) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector("#indicators");
  await page.fill("#indicators", indicators.join("\n"));
  await page.waitForSelector(`#site-${siteId}`);

  const btnId = action === "review" ? "#reviewBtn" : "#captureBtn";
  await page.waitForFunction(
    (id) => !document.querySelector(id)?.disabled,
    btnId,
    { timeout: 10000 }
  );
  await page.click(btnId);

  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll("#progressList .progress-row .status");
      if (rows.length === 0) return false;
      return [...rows].every(
        (r) => r.className.includes("ok") || r.className.includes("fail")
      );
    },
    { timeout: 30000 }
  );
  // Every row being ticked only means every screenshot is saved; the run's
  // manifest and checksum file are written after that. The popup disables
  // Stop again once the whole run has completed.
  await page.waitForFunction(() => document.getElementById("stopBtn").disabled, null, { timeout: 15000 });
  return page;
}

/** Downloads can land on disk a moment after Chrome reports them complete. */
async function waitForDownloads(rootDir, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let found = classifyDownloadedFiles(rootDir);
  while (!predicate(found) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    found = classifyDownloadedFiles(rootDir);
  }
  return found;
}

/** Ask the background service worker how many windows it's tracking as left open. */
function getOpenWindowCount(page) {
  return page.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: "GET_OPEN_WINDOWS" }, (r) => resolve(r.count)))
  );
}

/**
 * How many actual browser windows exist right now. Used to prove
 * "keep lookups in my current window" opens tabs rather than new windows:
 * this count should stay flat across a whole batch when that setting is on.
 */
async function countChromeWindows(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  const n = await page.evaluate(
    () => new Promise((resolve) => chrome.windows.getAll({}, (wins) => resolve(wins.length)))
  );
  await page.close();
  return n;
}

/**
 * Which tab URL is currently active in the given window, read via an
 * ALREADY-OPEN extension page's evaluate() — never by opening a fresh page
 * to ask, since creating a new tab would itself change which tab is active
 * and corrupt the very thing being measured.
 */
function getActiveTabUrl(existingPage, windowId) {
  return existingPage.evaluate(
    (windowId) =>
      new Promise((resolve) =>
        chrome.tabs.query({ windowId, active: true }, (tabs) => resolve(tabs[0] && tabs[0].url))
      ),
    windowId
  );
}

function findAllFiles(rootDir) {
  const found = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir);
  return found;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Manifest patch granting what the stitched backend needs, without the runtime prompts. */
function grantStitchedPermissions(manifest) {
  // Same reasoning as the viewport test below: Chrome's native permission
  // bubble can't be driven from Playwright, so the test copy declares the
  // optional permissions as required ones. The runtime grant of `scripting`
  // on its own (which has no prompt) is exercised separately.
  manifest.host_permissions = ["<all_urls>"];
  manifest.permissions = [...manifest.permissions, "scripting"];
}

/**
 * Decode a PNG inside the browser and return every row's colour in the
 * given pixel columns, as 0xRRGGBB integers — so a test can check exactly
 * where each element of a fixture page ended up in a stitched capture.
 */
async function samplePngColumns(context, pngPath, xs) {
  const page = await context.newPage();
  await page.goto("about:blank");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const result = await page.evaluate(
    async ({ b64, xs }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const cols = {};
      for (const x of xs) {
        const data = ctx.getImageData(x, 0, 1, bmp.height).data;
        const rows = new Array(bmp.height);
        for (let y = 0; y < bmp.height; y++) {
          rows[y] = (data[y * 4] << 16) | (data[y * 4 + 1] << 8) | data[y * 4 + 2];
        }
        cols[x] = rows;
      }
      return { width: bmp.width, height: bmp.height, cols };
    },
    { b64, xs }
  );
  await page.close();
  return result;
}

/** Contiguous [start, endExclusive) runs of rows whose colour is exactly `rgb`. */
function runsOf(rows, rgb) {
  const runs = [];
  let start = -1;
  for (let y = 0; y <= rows.length; y++) {
    const hit = y < rows.length && rows[y] === rgb;
    if (hit && start < 0) start = y;
    if (!hit && start >= 0) {
      runs.push([start, y]);
      start = -1;
    }
  }
  return runs;
}

function rgbInt(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function closeTo(actualInt, [r, g, b], tolerance = 3) {
  const ar = (actualInt >> 16) & 255;
  const ag = (actualInt >> 8) & 255;
  const ab = actualInt & 255;
  return Math.abs(ar - r) <= tolerance && Math.abs(ag - g) <= tolerance && Math.abs(ab - b) <= tolerance;
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Optionally keep captured PNGs for a human to look at: E2E_SAVE_PNGS=/some/dir */
function keepForInspection(name, file) {
  const dir = process.env.E2E_SAVE_PNGS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${name}.png`));
}

/**
 * Playwright's `downloadsPath` intercepts downloads and stores them under
 * internal UUID names (no extension) unless the caller drives the
 * `download` event and calls saveAs() itself — so files here are
 * classified by content (PNG magic bytes vs. the manifest's JSON shape vs.
 * plain text), not by name.
 */
function classifyDownloadedFiles(rootDir) {
  const pngFiles = [];
  const manifests = [];
  const shaSumsTexts = [];
  for (const full of findAllFiles(rootDir)) {
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8).equals(PNG_MAGIC)) {
      pngFiles.push(full);
      continue;
    }
    const text = buf.toString("utf8");
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.schemaVersion === 2 && Array.isArray(parsed.entries)) {
        manifests.push(parsed);
        continue;
      }
    } catch {
      // not JSON
    }
    if (/^[0-9a-f]{64} {2}/.test(text)) {
      shaSumsTexts.push(text);
    }
  }
  return { pngFiles, manifests, shaSumsTexts };
}

test("extension loads and its service worker registers", async () => {
  const extDir = await copyExtensionWithPatchedManifest();
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    assert.match(extId, /^[a-p]{32}$/);
  } finally {
    await context.close();
  }
});

test("full-page backend self-test captures the whole 8000px page, not just the viewport", async () => {
  const extDir = await copyExtensionWithPatchedManifest();
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    const output = await runSelfTestInOptionsPage(context, extId, {
      backend: "fullpage",
      selfTestUrl: server.url,
      windowWidth: 1024,
      windowHeight: 768,
    });

    assert.match(output, /^OK/, `self-test failed:\n${output}`);
    const dims = output.match(/Captured image:\s*(\d+)\s*×\s*(\d+)px/);
    assert.ok(dims, `could not parse dimensions from:\n${output}`);
    const height = Number(dims[2]);
    // The fixture page is exactly 20 * 400 = 8000px tall.
    assert.equal(height, 8000, `expected full page height 8000px, got ${height}`);
    assert.equal(/truncated/.test(output), false);

    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 1, "expected exactly one downloaded PNG");
  } finally {
    await context.close();
    await server.close();
  }
});

test("viewport backend self-test captures only the above-the-fold viewport height", async () => {
  // <all_urls> is normally granted via a runtime user gesture + native Chrome
  // permission bubble, which cannot be driven through Playwright's page APIs
  // (it isn't part of the page's DOM). To exercise the viewport backend's
  // actual capture logic end-to-end, this test copy grants the SAME
  // permission the shipped extension requests at runtime, but declares it as
  // a required host permission instead — the runtime request flow itself is
  // Chrome's own UI, not this extension's code, and is documented/verified
  // in README.md rather than re-tested here.
  const extDir = await copyExtensionWithPatchedManifest((manifest) => {
    manifest.host_permissions = ["<all_urls>"];
  });
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    const output = await runSelfTestInOptionsPage(context, extId, {
      backend: "viewport",
      selfTestUrl: server.url,
      windowWidth: 1024,
      windowHeight: 768,
    });

    assert.match(output, /^OK/, `self-test failed:\n${output}`);
    const dims = output.match(/Captured image:\s*(\d+)\s*×\s*(\d+)px/);
    assert.ok(dims, `could not parse dimensions from:\n${output}`);
    const height = Number(dims[2]);
    // Above-the-fold only: nowhere near the fixture's full 8000px height.
    assert.ok(height < 2000, `expected a viewport-sized capture, got height ${height}`);

    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 1, "expected exactly one downloaded PNG");
  } finally {
    await context.close();
    await server.close();
  }
});

test("stitched backend self-test captures the whole 8000px page, with every band where it belongs", async () => {
  const extDir = await copyExtensionWithPatchedManifest(grantStitchedPermissions);
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    const output = await runSelfTestInOptionsPage(context, extId, {
      backend: "stitched",
      selfTestUrl: server.url,
      windowWidth: 1024,
      windowHeight: 768,
    });

    assert.match(output, /^OK/, `self-test failed:\n${output}`);
    assert.match(output, /Backend: Full page \(stitched\)/);
    const dims = output.match(/Captured image:\s*(\d+)\s*×\s*(\d+)px/);
    assert.ok(dims, `could not parse dimensions from:\n${output}`);
    assert.equal(Number(dims[2]), 8000, `expected full page height 8000px, got ${dims[2]}`);
    assert.equal(/truncated/.test(output), false);

    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 1, "expected exactly one downloaded PNG");
    keepForInspection("stitched-tall-page", pngFiles[0]);

    // Every 400px band must be its own colour at its own offset — a seam in
    // the wrong place, or a repeated/missing screen, would break this.
    const { cols } = await samplePngColumns(context, pngFiles[0], [5]);
    for (let i = 0; i < 20; i++) {
      for (const offset of [5, 200, 395]) {
        const y = i * 400 + offset;
        assert.ok(
          closeTo(cols[5][y], hslToRgb(i * 18, 60, 40)),
          `band ${i + 1} wrong at y=${y}: got #${cols[5][y].toString(16).padStart(6, "0")}`
        );
      }
    }
  } finally {
    await context.close();
    await server.close();
  }
});

test("stitched backend shows fixed header/footer (incl. in shadow DOM) once, unsticks sticky elements, and restores the page", async () => {
  const extDir = await copyExtensionWithPatchedManifest(grantStitchedPermissions);
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "fixed-sticky"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    await seedSingleTestSite(context, extId, {
      customSite: {
        id: "e2e-test-site",
        name: "E2E test site",
        url: "{indicator}",
        applies: ["url"],
        settleMs: 200,
        enabled: true,
        fullscreen: false,
      },
      settingsOverrides: {
        captureBackend: "stitched",
        navigationTimeoutMs: 20000,
        captureWindowWidth: 1024,
        captureWindowHeight: 768,
        reuseWindow: true,
        keepWindowsOpen: true, // so the captured page can be inspected afterwards
      },
    });

    const lookupUrl = `${server.url}?job=1`;
    const page = await runPopupBatch(context, extId, {
      indicators: [lookupUrl],
      siteId: "e2e-test-site",
      action: "capture",
    });

    const { pngFiles, manifests } = await waitForDownloads(
      downloadsPath,
      (f) => f.pngFiles.length >= 1 && f.manifests.length >= 1
    );
    assert.equal(pngFiles.length, 1, "expected one PNG");
    keepForInspection("stitched-fixed-sticky", pngFiles[0]);
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].backend, "stitched", "the run manifest should record the backend used");

    const { height, cols } = await samplePngColumns(context, pngFiles[0], [5]);
    const rows = cols[5];
    assert.equal(height, 15 * 400 + 40, "expected the page's full 6040px of content");

    assert.deepEqual(runsOf(rows, rgbInt(255, 0, 0)), [[0, 60]], "fixed header should appear once, at the top");
    assert.deepEqual(
      runsOf(rows, rgbInt(0, 0, 255)),
      [[height - 50, height]],
      "fixed footer should appear once, at the bottom"
    );
    assert.deepEqual(
      runsOf(rows, rgbInt(255, 0, 255)),
      [[1600, 1640]],
      "sticky bar should appear once, in its natural position"
    );

    // Everything the capture changed in the page has been put back.
    const lookupPage = context.pages().find((p) => p.url() === lookupUrl);
    assert.ok(lookupPage, "expected the kept-open lookup tab to be reachable");
    const after = await lookupPage.evaluate(() => ({
      headerOpacity: getComputedStyle(document.getElementById("fixedHeader")).opacity,
      footerOpacity: getComputedStyle(
        document.getElementById("footerHost").shadowRoot.getElementById("fixedFooter")
      ).opacity,
      stickyPosition: getComputedStyle(document.getElementById("sticky")).position,
      stickyInline: document.getElementById("sticky").getAttribute("style") || "",
      htmlInline: document.documentElement.getAttribute("style") || "",
      bodyInline: document.body.getAttribute("style") || "",
      styleElements: document.querySelectorAll("style").length,
      scrollY: window.scrollY,
    }));
    assert.deepEqual(after, {
      headerOpacity: "1",
      footerOpacity: "1",
      stickyPosition: "sticky",
      stickyInline: "",
      htmlInline: "",
      bodyInline: "",
      styleElements: 1, // the fixture's own
      scrollY: 0,
    });

    await page.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: "CLOSE_ALL_WINDOWS" }, resolve))
    );
    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

test("stitched backend captures an app-style page whose inner panel scrolls instead of the document", async () => {
  const extDir = await copyExtensionWithPatchedManifest(grantStitchedPermissions);
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "inner-scroller"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    const output = await runSelfTestInOptionsPage(context, extId, {
      backend: "stitched",
      selfTestUrl: server.url,
      windowWidth: 1024,
      windowHeight: 768,
    });
    assert.match(output, /^OK/, `self-test failed:\n${output}`);

    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 1);
    keepForInspection("stitched-inner-scroller", pngFiles[0]);

    const PANEL_X = 300; // inside the panel (the sidebar is 0–200px)
    const SIDEBAR_X = 50;
    const { height, cols } = await samplePngColumns(context, pngFiles[0], [SIDEBAR_X, PANEL_X]);
    // 80px header + the panel's full 6000px + 40px footer.
    assert.equal(height, 80 + 6000 + 40);

    for (const x of [SIDEBAR_X, PANEL_X]) {
      assert.deepEqual(runsOf(cols[x], rgbInt(255, 255, 0)), [[0, 80]], `header once at the top (x=${x})`);
      assert.deepEqual(
        runsOf(cols[x], rgbInt(255, 128, 0)),
        [[height - 40, height]],
        `footer once at the bottom (x=${x})`
      );
    }

    // The panel's 12 bands, each 500px, stacked under the header.
    for (let i = 0; i < 12; i++) {
      for (const offset of [5, 250, 495]) {
        const y = 80 + i * 500 + offset;
        assert.ok(
          closeTo(cols[PANEL_X][y], [20 + i * 10, 30 + i * 8, 140 + i * 6]),
          `panel band ${i + 1} wrong at y=${y}: got #${cols[PANEL_X][y].toString(16).padStart(6, "0")}`
        );
      }
    }

    // The sidebar only exists for the first screen's height; below that the
    // stitched image is blank beside the panel (documented behaviour).
    const cyanRuns = runsOf(cols[SIDEBAR_X], rgbInt(0, 255, 255));
    assert.equal(cyanRuns.length, 1);
    assert.equal(cyanRuns[0][0], 80);
    const whiteRuns = runsOf(cols[SIDEBAR_X], rgbInt(255, 255, 255));
    assert.deepEqual(whiteRuns, [[cyanRuns[0][1], height - 40]]);
  } finally {
    await context.close();
    await server.close();
  }
});

test("stitched backend works after granting `scripting` at runtime from the Options page", async () => {
  // <all_urls> is pre-granted (its prompt can't be driven from here), but
  // `scripting` stays an optional permission exactly as shipped, and is
  // granted through the Options page's own Grant button. That proves the
  // service worker picks up chrome.scripting without a reload.
  const extDir = await copyExtensionWithPatchedManifest((manifest) => {
    manifest.host_permissions = ["<all_urls>"];
  });
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.waitForSelector("#runSelfTestBtn");
    // Full build: the debugger backend is offered, and is the one marked default.
    assert.equal(await page.isVisible("#backendLabel-fullpage"), true);
    assert.doesNotMatch(await page.innerText("#backendLabel-stitched"), /default/);
    await page.check('input[name="backend"][value="stitched"]');
    await page.waitForFunction(() => /scripting — not granted/.test(document.getElementById("permissionState").textContent));

    // Running before granting must refuse cleanly, naming what's missing.
    await page.fill("#selfTestUrl", server.url);
    await page.click("#runSelfTestBtn");
    await page.waitForFunction(() => /^Cannot run/.test(document.getElementById("selfTestOutput").textContent));
    assert.match(await page.textContent("#selfTestOutput"), /scripting is not granted/);

    await page.click("#grantPermissionBtn");
    await page.waitForFunction(
      () => /^Everything .* is granted\.$/.test(document.getElementById("permissionState").textContent),
      { timeout: 10000 }
    );

    await page.fill("#captureWindowWidth", "1024");
    await page.fill("#captureWindowHeight", "768");
    await page.click("#runSelfTestBtn");
    await page.waitForFunction(
      () => /^(OK|FAILED)/.test(document.getElementById("selfTestOutput").textContent),
      { timeout: 30000 }
    );
    const output = await page.textContent("#selfTestOutput");
    assert.match(output, /^OK/, `self-test failed:\n${output}`);
    assert.match(output, /×\s*8000px/);
    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

test("a build without the debugger permission falls back to the stitched backend", async () => {
  const extDir = await copyExtensionWithPatchedManifest((manifest) => {
    grantStitchedPermissions(manifest);
    manifest.permissions = manifest.permissions.filter((p) => p !== "debugger");
  });
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.waitForSelector("#runSelfTestBtn");

    // Saved setting is still the default "fullpage"; the page shows what will
    // really run, and nothing about a debugger backend this build doesn't have.
    assert.equal(await page.isDisabled('input[name="backend"][value="fullpage"]'), true);
    assert.equal(await page.isVisible("#backendLabel-fullpage"), false);
    assert.equal(await page.isChecked('input[name="backend"][value="stitched"]'), true);
    assert.match(await page.innerText("#backendLabel-stitched"), /— default/);
    const visibleDebuggerMentions = await page.evaluate(
      () =>
        [...document.querySelectorAll("body *")].filter(
          (node) => node.children.length === 0 && /debugger/i.test(node.textContent) && node.offsetParent !== null
        ).length
    );
    assert.equal(visibleDebuggerMentions, 0, "the Options page shouldn't mention the debugger in this build");

    await page.fill("#selfTestUrl", server.url);
    await page.fill("#captureWindowWidth", "1024");
    await page.fill("#captureWindowHeight", "768");
    await page.click("#runSelfTestBtn");
    await page.waitForFunction(
      () => /^(OK|FAILED|Cannot)/.test(document.getElementById("selfTestOutput").textContent),
      { timeout: 30000 }
    );
    const output = await page.textContent("#selfTestOutput");
    assert.match(output, /^OK/, `self-test failed:\n${output}`);
    assert.match(output, /Backend: Full page \(stitched\)/);
    assert.match(output, /×\s*8000px/);

    // The background script agrees, even for the untouched "fullpage" setting.
    const status = await page.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: "GET_BACKEND_STATUS", captureBackend: "fullpage" }, resolve)
        )
    );
    assert.equal(status.backend, "stitched");
    assert.equal(status.debuggerAvailable, false);
    assert.equal(status.granted, true);
    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

test("reuseWindow + keepWindowsOpen share one window across a batch, and Close all closes it", async () => {
  const extDir = await copyExtensionWithPatchedManifest();
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    await seedSingleTestSite(context, extId, {
      customSite: {
        id: "e2e-test-site",
        name: "E2E test site",
        url: "{indicator}",
        applies: ["url"],
        settleMs: 200,
        enabled: true,
        fullscreen: false,
      },
      settingsOverrides: {
        captureBackend: "fullpage",
        navigationTimeoutMs: 20000,
        captureWindowWidth: 1024,
        captureWindowHeight: 768,
        reuseWindow: true,
        keepWindowsOpen: true,
      },
    });

    const page = await runPopupBatch(context, extId, {
      indicators: [`${server.url}?job=1`, `${server.url}?job=2`],
      siteId: "e2e-test-site",
      action: "capture",
    });

    // Two jobs still produce two screenshots even though the window is shared.
    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 2, "expected one PNG per job despite the shared window");

    const openCount = await getOpenWindowCount(page);
    assert.equal(openCount, 1, "expected exactly one shared window left open for review");

    // Exercise the popup's own "Close all" control, not just the message.
    await page.waitForSelector("#openWindowsSection:not([hidden])", { timeout: 5000 });
    await page.click("#closeAllWindowsBtn");
    await page.waitForFunction(
      () => document.getElementById("openWindowsSection").hidden === true,
      { timeout: 5000 }
    );
    assert.equal(await getOpenWindowCount(page), 0, "expected Close all to close the shared window");
    // Actually invisible, not just carrying the attribute (a class-level
    // display rule used to override [hidden] here).
    assert.equal(await page.isVisible("#openWindowsSection"), false, "the Close all row should disappear");

    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

test("without reuseWindow, keepWindowsOpen leaves one window open per job", async () => {
  const extDir = await copyExtensionWithPatchedManifest();
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    await seedSingleTestSite(context, extId, {
      customSite: {
        id: "e2e-test-site",
        name: "E2E test site",
        url: "{indicator}",
        applies: ["url"],
        settleMs: 200,
        enabled: true,
        fullscreen: false,
      },
      settingsOverrides: {
        captureBackend: "fullpage",
        navigationTimeoutMs: 20000,
        captureWindowWidth: 1024,
        captureWindowHeight: 768,
        reuseWindow: false,
        keepWindowsOpen: true,
      },
    });

    const page = await runPopupBatch(context, extId, {
      indicators: [`${server.url}?job=1`, `${server.url}?job=2`],
      siteId: "e2e-test-site",
      action: "capture",
    });

    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 2, "expected one PNG per job");

    const openCount = await getOpenWindowCount(page);
    assert.equal(openCount, 2, "expected one window left open per job when not reusing windows");

    await page.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: "CLOSE_ALL_WINDOWS" }, resolve))
    );
    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

test("Open for review navigates without capturing, and always leaves its window open", async () => {
  const extDir = await copyExtensionWithPatchedManifest();
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    await seedSingleTestSite(context, extId, {
      customSite: {
        id: "e2e-test-site",
        name: "E2E test site",
        url: "{indicator}",
        applies: ["url"],
        settleMs: 200,
        enabled: true,
        fullscreen: false,
      },
      settingsOverrides: {
        captureBackend: "fullpage",
        navigationTimeoutMs: 20000,
        captureWindowWidth: 1024,
        captureWindowHeight: 768,
        reuseWindow: true,
        // Deliberately off, to prove review mode ignores it and leaves
        // windows open anyway.
        keepWindowsOpen: false,
      },
    });

    const page = await runPopupBatch(context, extId, {
      indicators: [`${server.url}?job=1`, `${server.url}?job=2`],
      siteId: "e2e-test-site",
      action: "review",
    });

    const { pngFiles, manifests, shaSumsTexts } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 0, "review mode must not save any screenshots");
    assert.equal(manifests.length, 0, "review mode must not write a manifest");
    assert.equal(shaSumsTexts.length, 0, "review mode must not write a checksum file");

    const openCount = await getOpenWindowCount(page);
    assert.equal(openCount, 1, "review mode should leave its (shared) window open despite keepWindowsOpen being off");

    await page.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: "CLOSE_ALL_WINDOWS" }, resolve))
    );
    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

test("useCurrentWindow (full-page) opens lookups as tabs in the existing window, not a new one", async () => {
  const extDir = await copyExtensionWithPatchedManifest();
  const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
  const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
  const { context } = await launchWithExtension(extDir, downloadsPath);
  try {
    const extId = await getExtensionId(context);
    await seedSingleTestSite(context, extId, {
      customSite: {
        id: "e2e-test-site",
        name: "E2E test site",
        url: "{indicator}",
        applies: ["url"],
        settleMs: 200,
        enabled: true,
        fullscreen: false,
      },
      settingsOverrides: {
        captureBackend: "fullpage",
        navigationTimeoutMs: 20000,
        captureWindowWidth: 1024,
        captureWindowHeight: 768,
        reuseWindow: true,
        keepWindowsOpen: true,
        useCurrentWindow: true,
      },
    });

    const windowCountBefore = await countChromeWindows(context, extId);
    const pagesBefore = context.pages().length;

    const page = await runPopupBatch(context, extId, {
      indicators: [`${server.url}?job=1`, `${server.url}?job=2`],
      siteId: "e2e-test-site",
      action: "capture",
    });

    assert.equal(
      await countChromeWindows(context, extId),
      windowCountBefore,
      "expected no new browser window to be created"
    );
    assert.equal(
      context.pages().length,
      pagesBefore + 2, // the popup's own tab, plus the one reused lookup tab
      "expected exactly one extra tab (the reused lookup tab) in the existing window"
    );

    const { pngFiles } = classifyDownloadedFiles(downloadsPath);
    assert.equal(pngFiles.length, 2, "expected one PNG per job despite the shared tab");
    assert.equal(await getOpenWindowCount(page), 1, "expected the one left-open lookup tab to be tracked");

    await page.waitForSelector("#openWindowsSection:not([hidden])", { timeout: 5000 });
    await page.click("#closeAllWindowsBtn");
    await page.waitForFunction(() => document.getElementById("openWindowsSection").hidden === true, {
      timeout: 5000,
    });
    assert.equal(await getOpenWindowCount(page), 0, "expected Close all to close the lookup tab");
    assert.equal(
      context.pages().length,
      pagesBefore + 1, // back down to just the popup's own tab
      "expected Close all to close the lookup tab without touching the window itself"
    );
    assert.equal(
      await countChromeWindows(context, extId),
      windowCountBefore,
      "the analyst's own window must never be removed"
    );

    await page.close();
  } finally {
    await context.close();
    await server.close();
  }
});

for (const [backend, patchManifest] of [
  ["viewport", (manifest) => (manifest.host_permissions = ["<all_urls>"])],
  ["stitched", grantStitchedPermissions],
]) {
  test(`useCurrentWindow (${backend}) activates and restores the previously-active tab around each capture`, async () => {
    const extDir = await copyExtensionWithPatchedManifest(patchManifest);
    const downloadsPath = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-downloads-"));
    const server = await startStaticServer(path.join(__dirname, "fixtures", "tall-page"));
    const { context } = await launchWithExtension(extDir, downloadsPath);
    try {
      const extId = await getExtensionId(context);
      await seedSingleTestSite(context, extId, {
        customSite: {
          id: "e2e-test-site",
          name: "E2E test site",
          url: "{indicator}",
          applies: ["url"],
          settleMs: 200,
          enabled: true,
          fullscreen: false,
        },
        settingsOverrides: {
          captureBackend: backend,
          navigationTimeoutMs: 20000,
          captureWindowWidth: 1024,
          captureWindowHeight: 768,
          reuseWindow: false,
          keepWindowsOpen: false,
          useCurrentWindow: true,
        },
      });

      const windowCountBefore = await countChromeWindows(context, extId);

      const popupPage = await context.newPage();
      await popupPage.goto(`chrome-extension://${extId}/popup.html`);
      await popupPage.waitForSelector("#indicators");
      await popupPage.fill("#indicators", `${server.url}?job=1`);
      await popupPage.waitForSelector("#site-e2e-test-site");

      const windowId = await popupPage.evaluate(
        () => new Promise((resolve) => chrome.windows.getCurrent((w) => resolve(w.id)))
      );
      // Snapshot whichever tab is active right before the run starts (almost
      // certainly this popup tab itself) — the capture will have to steal
      // focus for the viewport screenshot, so this is what must come back.
      const preClickActiveUrl = await getActiveTabUrl(popupPage, windowId);

      await popupPage.waitForFunction(() => !document.getElementById("captureBtn").disabled, {
        timeout: 10000,
      });
      await popupPage.click("#captureBtn");
      await popupPage.waitForFunction(
        () => {
          const rows = document.querySelectorAll("#progressList .progress-row .status");
          if (rows.length === 0) return false;
          return [...rows].every((r) => r.className.includes("ok") || r.className.includes("fail"));
        },
        { timeout: 30000 }
      );

      assert.equal(
        await countChromeWindows(context, extId),
        windowCountBefore,
        "expected no new browser window to be created"
      );

      const { pngFiles } = classifyDownloadedFiles(downloadsPath);
      assert.equal(pngFiles.length, 1, "expected exactly one downloaded PNG");

      assert.equal(
        await getOpenWindowCount(popupPage),
        0,
        "expected the lookup tab to have closed itself (keepWindowsOpen is off)"
      );

      const postRunActiveUrl = await getActiveTabUrl(popupPage, windowId);
      assert.equal(
        postRunActiveUrl,
        preClickActiveUrl,
        `expected the previously-active tab to be restored after the ${backend} capture stole focus for it`
      );

      await popupPage.close();
    } finally {
      await context.close();
      await server.close();
    }
  });
}
