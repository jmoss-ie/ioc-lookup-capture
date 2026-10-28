import { buildEvidencePath } from "./common/pathSanitize.js";
import { buildExportPath, checkExportTemplate, effectiveHostFilter } from "./common/exportNaming.js";
import { challengeTimeoutSec } from "./common/challenge.js";
import { DEFAULT_SETTINGS } from "./common/storage.js";
import {
  BACKEND_LABELS,
  describeMissing,
  needsRuntimePermissions,
  resolveBackend,
  runtimePermissionsFor,
} from "./common/backends.js";

// Whether this build's manifest includes `debugger` (see README: a build
// without it has no chrome.debugger backend, and "fullpage" resolves to
// the stitched backend instead).
const DEBUGGER_AVAILABLE = !!chrome.debugger;
// Every optional permission this extension can hold, for the Revoke button.
const ALL_OPTIONAL = { permissions: ["scripting"], origins: ["<all_urls>"] };

const KIND_LIST = ["ipv4", "ipv6", "domain", "url", "hash"];

const el = Object.fromEntries(
  [
    "baseFolder",
    "hiddenPrefix",
    "perIndicatorFolder",
    "examplePath",
    "exportTemplate",
    "exportSubfolder",
    "exportAutoStopMinutes",
    "exportHostFilter",
    "exportHostFilterOn",
    "exportTemplateWarning",
    "exportExamplePath",
    "sectionSelectors",
    "permissionState",
    "grantPermissionBtn",
    "revokePermissionBtn",
    "reuseWindow",
    "keepWindowsOpen",
    "useCurrentWindow",
    "settleMsOverride",
    "navigationTimeoutMs",
    "captureWindowWidth",
    "captureWindowHeight",
    "challengeTimeoutSec",
    "siteTableBody",
    "addSiteBtn",
    "selfTestUrl",
    "runSelfTestBtn",
    "selfTestOutput",
    "saveBtn",
    "saveStatus",
  ].map((id) => [id, document.getElementById(id)])
);

let settings = { ...DEFAULT_SETTINGS };
let sites = [];

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function init() {
  const state = await sendMessage({ type: "GET_STATE" });
  settings = { ...DEFAULT_SETTINGS, ...state.settings };
  sites = state.sites.map((s) => ({ ...s }));

  el.baseFolder.value = settings.baseFolder;
  el.hiddenPrefix.value = settings.hiddenPrefix;
  el.perIndicatorFolder.checked = settings.perIndicatorFolder;
  el.exportTemplate.value = settings.exportTemplate;
  el.exportSubfolder.value = settings.exportSubfolder;
  el.exportAutoStopMinutes.value = settings.exportAutoStopMinutes;
  el.exportHostFilter.value = settings.exportHostFilter;
  el.exportHostFilterOn.checked = effectiveHostFilter(settings).on;
  el.sectionSelectors.value = settings.sectionSelectors;
  if (!DEBUGGER_AVAILABLE) {
    // A build without `debugger`: the debugger backend doesn't exist here,
    // so remove every mention of it rather than showing a dead option, and
    // mark stitched as the default (it's what a saved "fullpage" runs as).
    document.querySelector('input[name="backend"][value="fullpage"]').disabled = true;
    document.querySelectorAll("[data-requires-debugger]").forEach((node) => (node.hidden = true));
    document.querySelectorAll("[data-without-debugger]").forEach((node) => (node.hidden = false));
  }
  const effective = resolveBackend(settings.captureBackend, { debuggerAvailable: DEBUGGER_AVAILABLE });
  document.querySelector(`input[name="backend"][value="${effective}"]`).checked = true;
  el.reuseWindow.checked = settings.reuseWindow;
  el.keepWindowsOpen.checked = settings.keepWindowsOpen;
  el.useCurrentWindow.checked = settings.useCurrentWindow;
  el.settleMsOverride.value = settings.settleMsOverride ?? "";
  el.navigationTimeoutMs.value = settings.navigationTimeoutMs;
  el.captureWindowWidth.value = settings.captureWindowWidth;
  el.captureWindowHeight.value = settings.captureWindowHeight;
  el.challengeTimeoutSec.value = challengeTimeoutSec(settings.challengeTimeoutSec);
  el.selfTestUrl.value = settings.selfTestUrl;

  renderExamplePath();
  renderExportExample();
  renderSiteTable();
  await refreshPermissionState();
}

// --- Live example path -------------------------------------------------------------

function renderExamplePath() {
  const example = buildEvidencePath({
    baseFolder: el.baseFolder.value,
    hiddenPrefix: el.hiddenPrefix.value,
    caseRef: "INC-1234",
    perIndicatorFolder: el.perIndicatorFolder.checked,
    indicator: "1.2.3.4",
    site: "abuseipdb",
    timestamp: "20260912T010305Z",
    ext: "png",
  });
  el.examplePath.textContent = "Downloads/" + example;
}
[el.baseFolder, el.hiddenPrefix, el.perIndicatorFolder].forEach((input) =>
  input.addEventListener("input", renderExamplePath)
);

function renderExportExample() {
  const template = el.exportTemplate.value.trim() || DEFAULT_SETTINGS.exportTemplate;
  const { path } = buildExportPath({
    baseFolder: el.baseFolder.value,
    caseRef: "INC-1234",
    subfolder: el.exportSubfolder.value,
    template,
    prefix: el.hiddenPrefix.value,
    seq: 3,
    label: "",
    originalFilename: "query_data.csv",
    date: new Date("2026-09-12T01:03:05Z"),
  });
  el.exportExamplePath.textContent = "Downloads/" + path;

  const { unknown, hasSeq } = checkExportTemplate(template);
  const warnings = [];
  if (unknown.length) warnings.push(`Not a token, kept as plain text: ${unknown.join(" ")}.`);
  if (!hasSeq) warnings.push("Without {seq}, exports won't sort in the order they were made.");
  el.exportTemplateWarning.textContent = warnings.join(" ");
  el.exportTemplateWarning.hidden = warnings.length === 0;
}
[el.baseFolder, el.hiddenPrefix, el.exportTemplate, el.exportSubfolder].forEach((input) =>
  input.addEventListener("input", renderExportExample)
);

// --- Permission grant/revoke --------------------------------------------------------

function selectedBackend() {
  return document.querySelector('input[name="backend"]:checked').value;
}

/** Which of `wanted` isn't granted yet, or null if all of it is. */
async function missingFrom(wanted) {
  const missing = { permissions: [], origins: [] };
  for (const p of wanted.permissions) {
    if (!(await chrome.permissions.contains({ permissions: [p] }))) missing.permissions.push(p);
  }
  for (const o of wanted.origins) {
    if (!(await chrome.permissions.contains({ origins: [o] }))) missing.origins.push(o);
  }
  return missing.permissions.length || missing.origins.length ? missing : null;
}

/** The optional permissions currently granted (for Revoke), or null if none are. */
async function grantedOptional() {
  const granted = { permissions: [], origins: [] };
  for (const p of ALL_OPTIONAL.permissions) {
    if (await chrome.permissions.contains({ permissions: [p] })) granted.permissions.push(p);
  }
  for (const o of ALL_OPTIONAL.origins) {
    if (await chrome.permissions.contains({ origins: [o] })) granted.origins.push(o);
  }
  return granted.permissions.length || granted.origins.length ? granted : null;
}

async function refreshPermissionState() {
  const backend = selectedBackend();
  const anyGranted = await grantedOptional();
  el.revokePermissionBtn.disabled = !anyGranted;
  el.revokePermissionBtn.textContent = anyGranted ? `Revoke ${describeMissing(anyGranted)}` : "Revoke";

  if (!needsRuntimePermissions(backend)) {
    el.permissionState.textContent = `${BACKEND_LABELS[backend]} needs no extra permission.`;
    el.grantPermissionBtn.hidden = true;
    return;
  }
  const missing = await missingFrom(runtimePermissionsFor(backend));
  el.grantPermissionBtn.hidden = !missing;
  if (missing) {
    el.permissionState.textContent = `${BACKEND_LABELS[backend]} needs ${describeMissing(
      missing
    )} — not granted yet.`;
    el.grantPermissionBtn.textContent = `Grant ${describeMissing(missing)}`;
  } else {
    el.permissionState.textContent = `Everything ${BACKEND_LABELS[backend]} needs is granted.`;
  }
}

document
  .querySelectorAll('input[name="backend"]')
  .forEach((radio) => radio.addEventListener("change", refreshPermissionState));

el.grantPermissionBtn.addEventListener("click", async () => {
  // Must be called directly from this user gesture — chrome.permissions.request()
  // cannot be proxied through a background-script message and still count as
  // triggered by a user gesture. Requests exactly what the selected backend
  // needs: <all_urls> for viewport; <all_urls> + scripting for stitched.
  try {
    await chrome.permissions.request(runtimePermissionsFor(selectedBackend()));
  } catch (err) {
    el.permissionState.textContent = `Permission request failed: ${(err && err.message) || err}`;
    return;
  }
  await refreshPermissionState();
});
el.revokePermissionBtn.addEventListener("click", async () => {
  const granted = await grantedOptional();
  if (granted) await chrome.permissions.remove(granted);
  await refreshPermissionState();
});

// --- Site table ----------------------------------------------------------------------

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "site"
  );
}

function uniqueId(base) {
  let id = base;
  let n = 2;
  const ids = new Set(sites.map((s) => s.id));
  while (ids.has(id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

function renderSiteTable() {
  el.siteTableBody.innerHTML = "";
  sites.forEach((site, index) => {
    const tr = document.createElement("tr");

    const onCell = document.createElement("td");
    const onCb = document.createElement("input");
    onCb.type = "checkbox";
    onCb.checked = site.enabled;
    onCb.addEventListener("change", () => (sites[index].enabled = onCb.checked));
    onCell.appendChild(onCb);

    const nameCell = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = site.name;
    nameInput.addEventListener("input", () => (sites[index].name = nameInput.value));
    nameCell.appendChild(nameInput);

    const urlCell = document.createElement("td");
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.value = site.url;
    urlInput.addEventListener("input", () => (sites[index].url = urlInput.value));
    urlCell.appendChild(urlInput);

    const kindsCell = document.createElement("td");
    const kindsWrap = document.createElement("div");
    kindsWrap.className = "kinds";
    for (const kind of KIND_LIST) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = site.applies.includes(kind);
      cb.addEventListener("change", () => {
        const set = new Set(sites[index].applies);
        if (cb.checked) set.add(kind);
        else set.delete(kind);
        sites[index].applies = [...set];
      });
      label.append(cb, document.createTextNode(kind));
      kindsWrap.appendChild(label);
    }
    kindsCell.appendChild(kindsWrap);

    const settleCell = document.createElement("td");
    const settleInput = document.createElement("input");
    settleInput.type = "number";
    settleInput.min = "0";
    settleInput.value = site.settleMs;
    settleInput.addEventListener(
      "input",
      () => (sites[index].settleMs = Number(settleInput.value) || 0)
    );
    settleCell.appendChild(settleInput);

    const fullscreenCell = document.createElement("td");
    const fullscreenCb = document.createElement("input");
    fullscreenCb.type = "checkbox";
    fullscreenCb.checked = !!site.fullscreen;
    fullscreenCb.title = "Maximize the capture window for this site before capturing";
    fullscreenCb.addEventListener("change", () => (sites[index].fullscreen = fullscreenCb.checked));
    fullscreenCell.appendChild(fullscreenCb);

    const challengeCell = document.createElement("td");
    const challengeCb = document.createElement("input");
    challengeCb.type = "checkbox";
    challengeCb.checked = !!site.waitForChallenge;
    challengeCb.title = "Wait for a Cloudflare check or captcha to be cleared before capturing";
    challengeCb.addEventListener("change", () => (sites[index].waitForChallenge = challengeCb.checked));
    challengeCell.appendChild(challengeCb);

    const noteCell = document.createElement("td");
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.value = site.note || "";
    noteInput.addEventListener("input", () => (sites[index].note = noteInput.value));
    noteCell.appendChild(noteInput);

    const delCell = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      sites.splice(index, 1);
      renderSiteTable();
    });
    delCell.appendChild(delBtn);

    tr.append(onCell, nameCell, urlCell, kindsCell, settleCell, fullscreenCell, challengeCell, noteCell, delCell);
    el.siteTableBody.appendChild(tr);
  });
}

el.addSiteBtn.addEventListener("click", () => {
  const id = uniqueId(slugify("new-site"));
  sites.push({
    id,
    name: "New site",
    url: "https://example.com/lookup/{host}",
    applies: [],
    settleMs: 3000,
    enabled: true,
    fullscreen: false,
    waitForChallenge: false,
    note: "",
  });
  renderSiteTable();
});

// --- Self-test -------------------------------------------------------------------

function collectSettingsFromForm() {
  return {
    ...settings,
    baseFolder: el.baseFolder.value.trim() || "soc-evidence",
    hiddenPrefix: el.hiddenPrefix.value.trim(),
    perIndicatorFolder: el.perIndicatorFolder.checked,
    exportTemplate: el.exportTemplate.value.trim() || DEFAULT_SETTINGS.exportTemplate,
    exportSubfolder: el.exportSubfolder.value.trim(),
    exportAutoStopMinutes:
      el.exportAutoStopMinutes.value === ""
        ? DEFAULT_SETTINGS.exportAutoStopMinutes
        : Math.max(0, Math.floor(Number(el.exportAutoStopMinutes.value) || 0)),
    exportHostFilter: el.exportHostFilter.value,
    exportHostFilterOn: el.exportHostFilterOn.checked,
    sectionSelectors: el.sectionSelectors.value.trim() || DEFAULT_SETTINGS.sectionSelectors,
    captureBackend: document.querySelector('input[name="backend"]:checked').value,
    reuseWindow: el.reuseWindow.checked,
    keepWindowsOpen: el.keepWindowsOpen.checked,
    useCurrentWindow: el.useCurrentWindow.checked,
    settleMsOverride: el.settleMsOverride.value === "" ? null : Number(el.settleMsOverride.value),
    navigationTimeoutMs: Number(el.navigationTimeoutMs.value) || DEFAULT_SETTINGS.navigationTimeoutMs,
    captureWindowWidth: Number(el.captureWindowWidth.value) || DEFAULT_SETTINGS.captureWindowWidth,
    captureWindowHeight:
      Number(el.captureWindowHeight.value) || DEFAULT_SETTINGS.captureWindowHeight,
    challengeTimeoutSec: challengeTimeoutSec(el.challengeTimeoutSec.value),
    selfTestUrl: el.selfTestUrl.value.trim() || DEFAULT_SETTINGS.selfTestUrl,
  };
}

el.runSelfTestBtn.addEventListener("click", async () => {
  el.runSelfTestBtn.disabled = true;
  el.selfTestOutput.textContent = "Running self-test…";
  const formSettings = collectSettingsFromForm();
  const backend = resolveBackend(formSettings.captureBackend, { debuggerAvailable: DEBUGGER_AVAILABLE });
  const missing = await missingFrom(runtimePermissionsFor(backend));
  if (missing) {
    el.selfTestOutput.textContent = `Cannot run: ${BACKEND_LABELS[backend]} selected but ${describeMissing(
      missing
    )} is not granted. Grant it above first.`;
    el.runSelfTestBtn.disabled = false;
    return;
  }
  const result = await sendMessage({
    type: "RUN_SELF_TEST",
    url: formSettings.selfTestUrl,
    settings: formSettings,
  });
  if (result.ok) {
    el.selfTestOutput.textContent = [
      "OK",
      `Backend: ${BACKEND_LABELS[result.backend] || result.backend}`,
      `Captured image: ${result.width} × ${result.height}px${
        result.truncated ? ` (truncated; real page height ${result.realHeightPx}px)` : ""
      }`,
      `PNG saved to: Downloads/${result.pngPath}`,
    ].join("\n");
  } else {
    el.selfTestOutput.textContent = "FAILED\n" + result.error;
  }
  el.runSelfTestBtn.disabled = false;
});

// --- Save ----------------------------------------------------------------------------

el.saveBtn.addEventListener("click", async () => {
  settings = collectSettingsFromForm();
  el.saveStatus.textContent = "Saving…";
  const r1 = await sendMessage({ type: "SAVE_SETTINGS", settings });
  const r2 = await sendMessage({ type: "SAVE_SITES", sites });
  el.saveStatus.textContent =
    r1.ok && r2.ok ? "Saved." : "Save failed: " + (r1.error || r2.error || "unknown error");
  await refreshPermissionState();
  setTimeout(() => (el.saveStatus.textContent = ""), 3000);
});

init();
