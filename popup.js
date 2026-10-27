import { parseIndicators } from "./common/indicators.js";
import { sitesForIndicatorKind } from "./common/urlTemplate.js";
import { BACKEND_LABELS, describeMissing } from "./common/backends.js";
import { uncoveredHosts } from "./common/exportNaming.js";

const el = {
  indicators: document.getElementById("indicators"),
  parseSummary: document.getElementById("parseSummary"),
  caseRef: document.getElementById("caseRef"),
  siteList: document.getElementById("siteList"),
  allUrlsWarning: document.getElementById("allUrlsWarning"),
  plannedCount: document.getElementById("plannedCount"),
  captureBtn: document.getElementById("captureBtn"),
  reviewBtn: document.getElementById("reviewBtn"),
  stopBtn: document.getElementById("stopBtn"),
  progressList: document.getElementById("progressList"),
  openOptions: document.getElementById("openOptions"),
  openWindowsSection: document.getElementById("openWindowsSection"),
  openWindowsCount: document.getElementById("openWindowsCount"),
  closeAllWindowsBtn: document.getElementById("closeAllWindowsBtn"),
  exportSection: document.getElementById("exportSection"),
  exportState: document.getElementById("exportState"),
  exportHint: document.getElementById("exportHint"),
  exportLabel: document.getElementById("exportLabel"),
  sectionCaptureBtn: document.getElementById("sectionCaptureBtn"),
  exportHoldLine: document.getElementById("exportHoldLine"),
  exportHold: document.getElementById("exportHold"),
  exportHoldText: document.getElementById("exportHoldText"),
  exportFilterOn: document.getElementById("exportFilterOn"),
  exportFilterText: document.getElementById("exportFilterText"),
  exportFilterAddBtn: document.getElementById("exportFilterAddBtn"),
  exportNext: document.getElementById("exportNext"),
  exportResetBtn: document.getElementById("exportResetBtn"),
  exportSwitchBtn: document.getElementById("exportSwitchBtn"),
  exportToggleBtn: document.getElementById("exportToggleBtn"),
  exportError: document.getElementById("exportError"),
  exportLog: document.getElementById("exportLog"),
};

let state = { sites: [], settings: {} };
let parsed = [];
let checkedSiteIds = new Set();
let port = null;

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function init() {
  state = await sendMessage({ type: "GET_STATE" });
  const status = await sendMessage({
    type: "GET_BACKEND_STATUS",
    captureBackend: state.settings.captureBackend,
  });
  if (status && !status.granted && status.missing) {
    el.allUrlsWarning.textContent = `${BACKEND_LABELS[status.backend]} needs ${describeMissing(
      status.missing
    )} — grant it in Options.`;
    el.allUrlsWarning.hidden = false;
  } else {
    el.allUrlsWarning.hidden = true;
  }
  renderAll();
  await refreshExportStatus({ fillCaseRef: true });
  await refreshOpenWindows();
}

async function refreshOpenWindows() {
  const { count } = await sendMessage({ type: "GET_OPEN_WINDOWS" });
  el.openWindowsSection.hidden = count === 0;
  if (count > 0) {
    el.openWindowsCount.textContent = `${count} lookup${count === 1 ? "" : "s"} still open`;
  }
}

// --- Query evidence: Capture section + Rename exports ---------------------------------

// The permissions Capture section needs (see bg/sectionCapture.js).
const SECTION_PERMISSIONS = { permissions: ["scripting"], origins: ["<all_urls>"] };

let exportStatus = null;
let capturing = false;

async function refreshExportStatus({ fillCaseRef = false } = {}) {
  const status = await sendMessage({ type: "EXPORT_GET_STATUS" });
  if (!status || !status.ok) return;
  exportStatus = status;
  if (fillCaseRef && status.armed && !el.caseRef.value.trim()) {
    el.caseRef.value = status.armed.caseRef;
  }
  if (fillCaseRef) el.exportLabel.value = status.label || "";
  renderExport();
}

function nextSeqFor(caseRef) {
  const n = exportStatus && exportStatus.nextSeqByCase[caseRef];
  return Number(n) || 1;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function renderExport() {
  if (!exportStatus) return;
  const armed = exportStatus.armed;
  const typed = el.caseRef.value.trim();

  el.exportSection.classList.toggle("armed", !!armed);
  el.exportHint.hidden = !!armed || nextSeqFor(typed) > 1;

  const hold = exportStatus.hold;
  const held = !!(typed && hold && hold.caseRef === typed);
  el.exportNext.classList.toggle("held", held);
  el.exportNext.textContent = !typed
    ? "Needs a case reference"
    : held
      ? `${typed} · holding #${pad2(hold.seq)}`
      : `${typed} · next #${pad2(nextSeqFor(typed))}`;
  el.sectionCaptureBtn.disabled = !typed || capturing;
  el.exportResetBtn.hidden = !typed || nextSeqFor(typed) <= 1;

  // Keep the same number (a query's screenshot + its exports).
  el.exportHoldLine.hidden = !typed;
  el.exportHold.checked = held;
  const keepSeq = held ? hold.seq : Math.max(1, nextSeqFor(typed) - 1);
  el.exportHoldText.textContent = held
    ? `Keeping #${pad2(keepSeq)} for every file — untick for a new query`
    : `Keep #${pad2(keepSeq)} for the next files (same query)`;

  renderFilter();

  if (armed) {
    const autoStop =
      exportStatus.autoStopMinutes > 0 ? ` (stops after ${exportStatus.autoStopMinutes} min idle)` : "";
    el.exportState.textContent = `ON · ${armed.caseRef}`;
    el.exportState.title = `Renaming downloads into ${armed.caseRef}${autoStop}`;
    el.exportToggleBtn.textContent = "Stop";
    el.exportToggleBtn.disabled = false;
    const differs = typed && typed !== armed.caseRef;
    el.exportSwitchBtn.hidden = !differs;
    if (differs) el.exportSwitchBtn.textContent = `Switch to ${typed}`;
  } else {
    el.exportState.textContent = "Off";
    el.exportState.title = "";
    el.exportToggleBtn.textContent = "Start";
    el.exportToggleBtn.disabled = !typed;
    el.exportSwitchBtn.hidden = true;
  }

  renderExportLog();
}

function renderFilter() {
  const { on, patterns } = exportStatus.hostFilter || { on: false, patterns: [] };
  el.exportFilterOn.checked = on;
  el.exportFilterOn.disabled = patterns.length === 0;
  el.exportFilterText.textContent =
    patterns.length === 0
      ? "Only rename from listed sites (none yet)"
      : `Only rename from ${patterns[0]}${patterns.length > 1 ? ` +${patterns.length - 1}` : ""}`;
  el.exportFilterText.title = patterns.join(", ");

  // Offer the sites of the most recent download that isn't already covered.
  const latest = exportStatus.log.find(
    (e) => (e.status === "renamed" || e.status === "skipped") && e.hosts && e.hosts.length
  );
  const missing = latest ? uncoveredHosts(latest.hosts, patterns) : [];
  el.exportFilterAddBtn.hidden = missing.length === 0;
  if (missing.length) {
    const more = missing.length > 1 ? ` +${missing.length - 1}` : "";
    el.exportFilterAddBtn.textContent = `${on ? "Also allow" : "Only rename from"} ${missing[0]}${more}`;
    el.exportFilterAddBtn.title = `Sites of the last download (${latest.from}): ${missing.join(", ")}`;
    el.exportFilterAddBtn.dataset.hosts = JSON.stringify(missing);
  }
}

function leafOf(p) {
  return String(p || "").split("/").pop();
}

function renderExportLog() {
  const armed = exportStatus.armed;
  const latest = exportStatus.log[0];
  const items = [];
  if (!armed && latest && latest.status === "stopped" && latest.reason === "auto-stopped") {
    items.push(`<li class="wrap">Renaming for ${escapeHtml(latest.caseRef)} switched itself off after ${
      exportStatus.autoStopMinutes
    } min with no export.</li>`);
  }
  const shown = exportStatus.log
    .filter((e) => ["renamed", "skipped", "captured", "failed"].includes(e.status))
    .slice(0, 4);
  for (const e of shown) {
    if (e.status === "renamed") {
      const from = e.hosts && e.hosts.length ? `\nfrom ${e.hosts.join(", ")}` : "";
      items.push(
        `<li title="${escapeHtml(e.to + from)}"><span class="seq">#${pad2(e.seq)}</span> ${escapeHtml(
          e.from
        )} → ${escapeHtml(leafOf(e.to))}</li>`
      );
    } else if (e.status === "captured") {
      const note = e.clipped ? " (visible part only)" : "";
      items.push(
        `<li title="${escapeHtml(e.to)}"><span class="seq">#${pad2(e.seq)}</span> section ${e.width}×${
          e.height
        }${note} → ${escapeHtml(leafOf(e.to))}</li>`
      );
    } else if (e.status === "failed") {
      items.push(`<li class="wrap"><span class="seq">#${pad2(e.seq)}</span> not saved: ${escapeHtml(e.error)}</li>`);
    } else {
      const from = e.hosts && e.hosts.length ? e.hosts.join(", ") : "an unknown site";
      items.push(
        `<li class="wrap skipped">Not renamed: ${escapeHtml(e.from)} from ${escapeHtml(
          from
        )} (not in the Options site list)</li>`
      );
    }
  }
  el.exportLog.innerHTML = items.join("");
}

function showExportError(message) {
  el.exportError.textContent = message;
  el.exportError.hidden = false;
}

function clearExportError() {
  el.exportError.hidden = true;
  el.exportError.textContent = "";
}

async function exportAction(message) {
  clearExportError();
  const result = await sendMessage(message);
  if (!result || !result.ok) {
    showExportError((result && result.error) || "Something went wrong.");
    return;
  }
  exportStatus = result;
  renderExport();
}

el.exportToggleBtn.addEventListener("click", async () => {
  el.exportToggleBtn.disabled = true;
  if (exportStatus && exportStatus.armed) {
    await exportAction({ type: "EXPORT_DISARM" });
  } else {
    await exportAction({ type: "EXPORT_ARM", caseRef: el.caseRef.value.trim() });
  }
});

el.exportSwitchBtn.addEventListener("click", async () => {
  await exportAction({ type: "EXPORT_ARM", caseRef: el.caseRef.value.trim() });
});

el.exportHold.addEventListener("change", async () => {
  await exportAction({ type: "EXPORT_SET_HOLD", caseRef: el.caseRef.value.trim(), on: el.exportHold.checked });
});

el.exportFilterOn.addEventListener("change", async () => {
  await exportAction({ type: "EXPORT_FILTER_SET_ON", on: el.exportFilterOn.checked });
});

el.exportFilterAddBtn.addEventListener("click", async () => {
  const hosts = JSON.parse(el.exportFilterAddBtn.dataset.hosts || "[]");
  await exportAction({ type: "EXPORT_FILTER_ADD", hosts });
});

el.exportResetBtn.addEventListener("click", async () => {
  await exportAction({ type: "EXPORT_RESET_SEQ", caseRef: el.caseRef.value.trim() });
});

// Saved on every keystroke: the popup closes as soon as you click into the
// page, so there's no later moment to save it.
el.exportLabel.addEventListener("input", () => {
  sendMessage({ type: "EXPORT_SET_LABEL", label: el.exportLabel.value });
});

el.sectionCaptureBtn.addEventListener("click", async () => {
  clearExportError();
  // Ask for the permissions first thing in the click handler, while Chrome
  // still counts it as a user gesture. Already granted: resolves true with no
  // prompt. The first time, the prompt may close this popup — the grant still
  // happens, and the next click captures.
  let granted = false;
  try {
    granted = await chrome.permissions.request(SECTION_PERMISSIONS);
  } catch (err) {
    showExportError(`Couldn't ask for permission: ${(err && err.message) || err}`);
    return;
  }
  if (!granted) {
    showExportError('Capture section needs "All sites" access and scripting to find and screenshot the section.');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showExportError("No tab to capture.");
    return;
  }
  capturing = true;
  el.sectionCaptureBtn.textContent = "Capturing…";
  renderExport();
  const result = await sendMessage({ type: "CAPTURE_SECTION", tabId: tab.id, caseRef: el.caseRef.value.trim() });
  capturing = false;
  el.sectionCaptureBtn.textContent = "Capture section";
  if (!result || !result.ok) showExportError((result && result.error) || "Capture failed.");
  await refreshExportStatus();
});

el.caseRef.addEventListener("input", renderExport);

el.closeAllWindowsBtn.addEventListener("click", async () => {
  el.closeAllWindowsBtn.disabled = true;
  await sendMessage({ type: "CLOSE_ALL_WINDOWS" });
  await refreshOpenWindows();
  el.closeAllWindowsBtn.disabled = false;
});

el.indicators.addEventListener("input", () => {
  parsed = parseIndicators(el.indicators.value);
  renderAll();
});
el.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

function renderAll() {
  renderParseSummary();
  renderSiteList();
  renderPlannedCount();
  el.captureBtn.disabled = plannedJobs().length === 0;
  el.reviewBtn.disabled = plannedJobs().length === 0;
}

function renderParseSummary() {
  if (parsed.length === 0) {
    el.parseSummary.innerHTML = "";
    return;
  }
  const accepted = parsed.filter((p) => p.valid);
  const rejected = parsed.filter((p) => !p.valid);
  let html = `<div class="accepted">${accepted.length} accepted</div>`;
  if (accepted.length) {
    html += "<ul>";
    for (const p of accepted) html += `<li>${escapeHtml(p.refanged)} — ${p.kind}</li>`;
    html += "</ul>";
  }
  if (rejected.length) {
    html += `<div class="rejected">${rejected.length} rejected</div><ul>`;
    for (const p of rejected) html += `<li>${escapeHtml(p.raw)} — ${p.reason}</li>`;
    html += "</ul>";
  }
  el.parseSummary.innerHTML = html;
}

function presentKinds() {
  return new Set(parsed.filter((p) => p.valid).map((p) => p.kind));
}

function applicableSites() {
  const kinds = presentKinds();
  const enabled = state.sites.filter((s) => s.enabled);
  const seen = new Map();
  for (const kind of kinds) {
    for (const s of sitesForIndicatorKind(enabled, kind)) seen.set(s.id, s);
  }
  return [...seen.values()];
}

function renderSiteList() {
  const sites = applicableSites();
  if (sites.length === 0) {
    el.siteList.innerHTML = `<p class="muted">${
      parsed.some((p) => p.valid)
        ? "No enabled sites apply to what was typed."
        : "Type an indicator above to see applicable sites."
    }</p>`;
    return;
  }
  // Default newly-seen sites to checked.
  for (const s of sites) if (!checkedSiteIds.has(s.id) && !s._unchecked) checkedSiteIds.add(s.id);

  el.siteList.innerHTML = "";
  for (const s of sites) {
    const row = document.createElement("div");
    row.className = "site-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `site-${s.id}`;
    cb.checked = checkedSiteIds.has(s.id);
    cb.addEventListener("change", () => {
      if (cb.checked) checkedSiteIds.add(s.id);
      else checkedSiteIds.delete(s.id);
      renderPlannedCount();
      el.captureBtn.disabled = plannedJobs().length === 0;
    });
    const label = document.createElement("label");
    label.htmlFor = cb.id;
    label.textContent = s.name;
    const tag = document.createElement("span");
    tag.className = "kind-tag";
    tag.textContent = s.applies.join(",");
    row.append(cb, label, tag);
    el.siteList.appendChild(row);
  }
}

function plannedJobs() {
  const accepted = parsed.filter((p) => p.valid);
  const checked = state.sites.filter((s) => s.enabled && checkedSiteIds.has(s.id));
  const jobs = [];
  for (const ind of accepted) {
    for (const site of checked) {
      if (site.applies.includes(ind.kind)) {
        jobs.push({
          indicator: ind.refanged,
          indicatorKind: ind.kind,
          host: ind.host,
          site,
        });
      }
    }
  }
  return jobs;
}

function renderPlannedCount() {
  const n = plannedJobs().length;
  el.plannedCount.textContent = `${n} screenshot${n === 1 ? "" : "s"} planned`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// --- Capture run -------------------------------------------------------------------

function progressRowId(index) {
  return `progress-${index}`;
}

function startRun(mode) {
  const jobs = plannedJobs();
  if (jobs.length === 0) return;

  el.progressList.innerHTML = "";
  jobs.forEach((job, i) => {
    const row = document.createElement("div");
    row.className = "progress-row";
    row.id = progressRowId(i);
    row.innerHTML = `<span class="status pending">•</span><span class="label">${escapeHtml(
      job.site.name
    )} — ${escapeHtml(job.indicator)}</span>`;
    el.progressList.appendChild(row);
  });

  el.captureBtn.disabled = true;
  el.reviewBtn.disabled = true;
  el.stopBtn.disabled = false;

  port = chrome.runtime.connect({ name: "capture" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "PROGRESS") handleProgress(msg.evt);
    else if (msg.type === "RUN_COMPLETE") finishRun();
    else if (msg.type === "RUN_FAILED") {
      finishRun();
      const banner = document.createElement("div");
      banner.className = "progress-row";
      banner.innerHTML = `<span class="status fail">✗</span><span class="label error-text">Run failed: ${escapeHtml(
        msg.error
      )}</span>`;
      el.progressList.appendChild(banner);
    }
  });

  chrome.windows.getCurrent((win) => {
    port.postMessage({
      type: mode === "review" ? "START_REVIEW" : "START_CAPTURE",
      jobs: jobs.map((j) => ({
        indicator: j.indicator,
        indicatorKind: j.indicatorKind,
        host: j.host,
        site: j.site,
      })),
      settings: state.settings,
      caseRef: el.caseRef.value.trim(),
      // The browser window this popup was opened over — used only when the
      // "keep lookups in my current window" setting is on.
      currentWindowId: win && win.id,
    });
  });
}

function handleProgress(evt) {
  const row = document.getElementById(progressRowId(evt.index));
  if (!row) return;
  const status = row.querySelector(".status");
  if (evt.type === "start") {
    status.className = "status running";
    status.textContent = "";
  } else if (evt.type === "done") {
    status.className = "status ok";
    status.textContent = "✓";
  } else if (evt.type === "error") {
    status.className = "status fail";
    status.textContent = "✗";
    const err = document.createElement("span");
    err.className = "error-text";
    err.textContent = evt.error;
    row.appendChild(err);
  } else if (evt.type === "stopped") {
    status.className = "status fail";
    status.textContent = "■";
  }
}

function finishRun() {
  el.captureBtn.disabled = plannedJobs().length === 0;
  el.reviewBtn.disabled = plannedJobs().length === 0;
  el.stopBtn.disabled = true;
  if (port) {
    port.disconnect();
    port = null;
  }
  refreshOpenWindows();
}

el.captureBtn.addEventListener("click", () => startRun("capture"));
el.reviewBtn.addEventListener("click", () => startRun("review"));
el.stopBtn.addEventListener("click", () => {
  if (port) port.postMessage({ type: "STOP" });
});

init();
