// Shared harness for e2e tests that need Chromium's own download handling.
//
// Playwright intercepts every download when it launches the browser (saving
// them under UUID names in its own folder), which skips Chromium's filename
// decision — the step "Rename exports" hooks into, and the one that decides
// where every file this extension saves ends up. So these tests launch
// Chromium themselves, with a profile whose Downloads folder is a temp
// directory, connect Playwright over CDP only to drive pages, and put the
// browser's download behaviour back to Chromium's default. Files then land
// on disk under exactly the names Chromium picked.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(__dirname, "..");
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium/chrome-linux/chrome";
export const TS = String.raw`\d{8}T\d{6}Z`;

/** Copy the extension to a temp folder, optionally editing the copy's manifest. */
export async function copyExtension(patchManifest) {
  const dst = await fsp.mkdtemp(path.join(os.tmpdir(), "soc-ext-"));
  const SKIP = new Set(["node_modules", "e2e", "tests", ".git", "dist"]);
  await fsp.cp(EXT_DIR, dst, {
    recursive: true,
    filter: (src) => !SKIP.has(path.relative(EXT_DIR, src).split(path.sep)[0]),
  });
  if (patchManifest) {
    const file = path.join(dst, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(file, "utf8"));
    patchManifest(manifest);
    await fsp.writeFile(file, JSON.stringify(manifest, null, 2));
  }
  return dst;
}

/**
 * Manifest patch declaring the optional `scripting` + <all_urls> as required,
 * because Chrome's native permission prompt can't be driven from Playwright.
 */
export function grantScriptingAndAllUrls(manifest) {
  manifest.host_permissions = ["<all_urls>"];
  manifest.permissions = [...manifest.permissions, "scripting"];
}

/** Launch Chromium directly (no Playwright download interception) and connect over CDP. */
export async function launchNative(extDir, downloadsDir) {
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

export function sleep(ms) {
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

export async function extensionWorker(context, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    for (const w of context.serviceWorkers()) if (await isOurWorker(w)) return w;
    if (Date.now() - start > timeoutMs) throw new Error("extension service worker not found");
    await sleep(200);
  }
}

/** Every file under `dir`, as "/"-joined paths relative to it. Skips in-progress downloads. */
export function listFiles(dir) {
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
export async function waitForNewFile(dir, before, re, timeoutMs = 15000) {
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

export async function sendFromPage(page, message) {
  return page.evaluate((m) => new Promise((resolve) => chrome.runtime.sendMessage(m, resolve)), message);
}

