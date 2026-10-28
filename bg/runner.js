import { expandUrlTemplate } from "../common/urlTemplate.js";
import {
  buildEvidencePath,
  buildManifestPath,
  buildShaSumsPath,
  sanitizeSegment,
} from "../common/pathSanitize.js";
import { sha256HexBytes } from "../common/hash.js";
import * as fullPageBackend from "./fullPageCapture.js";
import * as stitchedBackend from "./stitchedCapture.js";
import * as viewportBackend from "./viewportCapture.js";
import { resolveBackend } from "../common/backends.js";
import { debuggerAvailable } from "./permissions.js";
import { decodePng } from "./pngUtils.js";
import { downloadPngBlob, downloadText } from "./downloads.js";
import { startKeepAlive, stopKeepAlive } from "./keepalive.js";
import { trackOpenSession, untrackOpenSessionByTab } from "./windowTracking.js";
import { settleWithBotCheck } from "./challengeWait.js";
import { botCheckMode, challengeTimeoutSec } from "../common/challenge.js";

const BACKENDS = {
  fullpage: fullPageBackend,
  stitched: stitchedBackend,
  viewport: viewportBackend,
};

/** The backend id that will actually run (see resolveBackend in common/backends.js). */
function effectiveBackendId(settings) {
  return resolveBackend(settings.captureBackend, { debuggerAvailable: debuggerAvailable() });
}

function backendFor(settings) {
  return BACKENDS[effectiveBackendId(settings)];
}

/** Filesystem-safe UTC timestamp for filenames, e.g. 20260912T010305Z. */
export function timestampForFilenames(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function relativeToCaseFolder(fullPath, baseFolder, caseRef) {
  const parts = [sanitizeSegment(baseFolder), caseRef ? sanitizeSegment(caseRef) : null].filter(
    Boolean
  );
  const prefix = parts.join("/") + "/";
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

/**
 * Capture one (indicator, site) job inside an already-open session —
 * navigates the session's tab, screenshots it, and downloads the PNG. The
 * caller owns opening/closing the session (so it can be reused across jobs).
 */
async function captureJobInSession({ backend, session, job, settings, caseRef, onWaiting, onWaitEnd, waitControl }) {
  const { indicator, indicatorKind, site, host } = job;
  const targetUrl = await expandUrlTemplate(site.url, { indicator, kind: indicatorKind, host });
  const settleMs = settings.settleMsOverride ?? site.settleMs ?? 3000;

  // Per-site "Bot check": it takes over the settle period (see bg/challengeWait.js).
  const mode = botCheckMode(site);
  let botCheck = null;
  const afterLoad =
    mode === "off"
      ? undefined
      : async () => {
          botCheck = await settleWithBotCheck(session, {
            mode,
            settleMs,
            timeoutMs: challengeTimeoutSec(settings.challengeTimeoutSec) * 1000,
            onWaiting,
            onWaitEnd,
            control: waitControl,
          });
        };

  await backend.setSessionFullscreen(session, !!site.fullscreen);
  const raw = await backend.captureInSession(session, {
    url: targetUrl,
    navigationTimeoutMs: settings.navigationTimeoutMs,
    settleMs: mode === "off" ? settleMs : 0,
    afterLoad,
  });

  const { width, height, bytes } = decodePng(raw.pngBase64);
  const pngSha256 = await sha256HexBytes(bytes);
  const timestamp = timestampForFilenames(raw.captureTime);

  const pngPath = buildEvidencePath({
    baseFolder: settings.baseFolder,
    hiddenPrefix: settings.hiddenPrefix,
    caseRef,
    perIndicatorFolder: settings.perIndicatorFolder,
    indicator,
    site: site.id,
    timestamp,
    ext: "png",
  });

  await downloadPngBlob(pngPath, raw.pngBase64, settings.navigationTimeoutMs);

  return {
    manifestEntry: {
      indicator,
      site: site.id,
      siteName: site.name,
      pngPath,
      pngSha256,
      width,
      height,
      truncated: !!raw.truncated,
      realHeightPx: raw.realHeightPx ?? null,
      capturedAt: raw.captureTime.toISOString(),
      // Set only when the capture waited: for a bot check that was showing
      // ("auto"), or for Capture now ("pause"). continuedBy says what ended
      // the wait: "check-gone" or "capture-now" (pressed in the popup).
      ...(botCheck && botCheck.continuedBy
        ? {
            botCheck: {
              mode,
              ...(botCheck.reason ? { shown: botCheck.reason } : {}),
              waitedMs: botCheck.waitedMs,
              continuedBy: botCheck.continuedBy,
            },
          }
        : {}),
    },
    diagnostics: { pngPath, width, height, truncated: !!raw.truncated, realHeightPx: raw.realHeightPx ?? null },
  };
}

/**
 * Capture a single (indicator, site) job end to end: open a dedicated
 * session, capture, close it. Used by the diagnostics self-test, which
 * never reuses a window.
 */
async function runSingleCapture({ job, settings, caseRef }) {
  const backend = backendFor(settings);
  const session = await backend.openSession({
    windowWidth: settings.captureWindowWidth,
    windowHeight: settings.captureWindowHeight,
    fullscreen: !!job.site.fullscreen,
  });
  try {
    return await captureJobInSession({ backend, session, job, settings, caseRef });
  } finally {
    await backend.closeSession(session);
  }
}

async function writeManifestAndShaSums({ manifestEntries, caseRef, settings, runTimestamp }) {
  const manifest = {
    schemaVersion: 2,
    caseRef: caseRef || null,
    generatedAt: new Date().toISOString(),
    backend: effectiveBackendId(settings),
    toolVersion: chrome.runtime.getManifest().version,
    entries: manifestEntries,
  };
  const manifestPath = buildManifestPath({
    baseFolder: settings.baseFolder,
    caseRef,
    timestamp: runTimestamp,
  });
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  await downloadText(manifestPath, manifestText, "application/json", settings.navigationTimeoutMs);

  const shaLines = manifestEntries.map(
    (e) => `${e.pngSha256}  ${relativeToCaseFolder(e.pngPath, settings.baseFolder, caseRef)}`
  );
  const shaPath = buildShaSumsPath({
    baseFolder: settings.baseFolder,
    caseRef,
    timestamp: runTimestamp,
  });
  await downloadText(shaPath, shaLines.join("\n") + "\n", "text/plain", settings.navigationTimeoutMs);

  return { manifestPath, shaPath };
}

/**
 * Run a full capture batch, one (indicator, site) job at a time.
 *
 * Window behaviour is governed by two settings:
 *   - `reuseWindow`: when true, one window/tab is opened and reused for
 *     every job in the batch (each job still gets its own navigation,
 *     settle delay, and screenshot — only the window itself is shared).
 *     When false (default), each job gets its own fresh window, as before.
 *   - `keepWindowsOpen`: when true, capture windows are left open at the
 *     end of the run (one window if `reuseWindow` is also on, otherwise
 *     one per job) instead of being closed, so an analyst can review them.
 *     Left-open windows are tracked so the popup can offer "Close all".
 *   - `useCurrentWindow`: when true, lookups open as tabs in the window the
 *     run was started from (see `currentWindowId` below) instead of a new
 *     browser window. The window itself is never closed or removed by this
 *     extension, whatever `keepWindowsOpen` says — only the tabs it opened.
 *
 * @param {Object} opts
 * @param {Array<{indicator:string, indicatorKind:string, host:string|null, site:object}>} opts.jobs
 * @param {object} opts.settings
 * @param {string} opts.caseRef
 * @param {number} [opts.currentWindowId] - the window to open tabs in when `useCurrentWindow` is set
 * @param {(evt: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.shouldStop]
 * @param {{ take: () => ("capture"|"skip"|null), stopped: () => boolean }} [opts.waitControl]
 *   Capture now / Skip from the popup, for a job waiting on its bot check
 */
export async function runCapture({ jobs, settings, caseRef, currentWindowId, onProgress, shouldStop, waitControl }) {
  startKeepAlive();
  const runTimestamp = timestampForFilenames(new Date());
  const manifestEntries = [];
  const results = [];
  const backend = backendFor(settings);
  const reuseWindow = !!settings.reuseWindow;
  const keepWindowsOpen = !!settings.keepWindowsOpen;
  const useCurrentWindowId = settings.useCurrentWindow ? currentWindowId : undefined;

  let sharedSession = null;
  async function ensureSharedSession(firstJob) {
    if (!sharedSession) {
      sharedSession = await backend.openSession({
        windowWidth: settings.captureWindowWidth,
        windowHeight: settings.captureWindowHeight,
        fullscreen: !!firstJob.site.fullscreen,
        currentWindowId: useCurrentWindowId,
      });
      await trackOpenSession(sharedSession);
    }
    return sharedSession;
  }

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (shouldStop && shouldStop()) {
        onProgress?.({ type: "stopped", index: i, total: jobs.length });
        break;
      }
      const job = jobs[i];
      onProgress?.({
        type: "start",
        index: i,
        total: jobs.length,
        indicator: job.indicator,
        site: job.site.id,
      });

      let session = null;
      let shouldCloseAfter = false;
      try {
        if (reuseWindow) {
          session = await ensureSharedSession(job);
        } else {
          session = await backend.openSession({
            windowWidth: settings.captureWindowWidth,
            windowHeight: settings.captureWindowHeight,
            fullscreen: !!job.site.fullscreen,
            currentWindowId: useCurrentWindowId,
          });
          shouldCloseAfter = !keepWindowsOpen;
          if (!shouldCloseAfter) await trackOpenSession(session);
        }

        const outcome = await captureJobInSession({
          backend,
          session,
          job,
          settings,
          caseRef,
          onWaiting: ({ mode, reason }) =>
            onProgress?.({ type: "waiting", index: i, total: jobs.length, indicator: job.indicator, site: job.site.id, mode, reason }),
          onWaitEnd: () => onProgress?.({ type: "resumed", index: i, total: jobs.length }),
          waitControl,
        });
        manifestEntries.push(outcome.manifestEntry);
        results.push({ ok: true, indicator: job.indicator, site: job.site.id });
        onProgress?.({
          type: "done",
          index: i,
          total: jobs.length,
          indicator: job.indicator,
          site: job.site.id,
          pngPath: outcome.manifestEntry.pngPath,
        });
      } catch (err) {
        const message = (err && err.message) || String(err);
        results.push({ ok: false, indicator: job.indicator, site: job.site.id, error: message });
        onProgress?.({
          type: "error",
          index: i,
          total: jobs.length,
          indicator: job.indicator,
          site: job.site.id,
          error: message,
        });
      } finally {
        if (session && !reuseWindow && shouldCloseAfter) {
          await backend.closeSession(session);
        }
      }
    }

    if (sharedSession) {
      if (keepWindowsOpen) {
        // Leave it open — already tracked above.
      } else {
        await backend.closeSession(sharedSession);
        await untrackOpenSessionByTab(sharedSession.tabId);
      }
    }

    // The manifest and SHA256SUMS can be switched off in Options.
    let manifestPath = null;
    if (manifestEntries.length > 0 && settings.saveManifest !== false) {
      const written = await writeManifestAndShaSums({
        manifestEntries,
        caseRef,
        settings,
        runTimestamp,
      });
      manifestPath = written.manifestPath;
    }
    onProgress?.({ type: "complete", results, manifestPath });
    return { results, manifestPath };
  } finally {
    stopKeepAlive();
  }
}

/**
 * Open-for-review mode: navigates each job's URL so an analyst can look at
 * it, but never screenshots or downloads anything. Windows are always left
 * open at the end regardless of `keepWindowsOpen` — leaving them open is
 * the entire point of this mode — and are tracked the same way so the
 * popup can offer "Close all".
 *
 * @param {Object} opts
 * @param {Array<{indicator:string, indicatorKind:string, host:string|null, site:object}>} opts.jobs
 * @param {object} opts.settings
 * @param {number} [opts.currentWindowId] - the window to open tabs in when `useCurrentWindow` is set
 * @param {(evt: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.shouldStop]
 */
export async function runReview({ jobs, settings, currentWindowId, onProgress, shouldStop }) {
  startKeepAlive();
  const backend = backendFor(settings);
  const reuseWindow = !!settings.reuseWindow;
  const useCurrentWindowId = settings.useCurrentWindow ? currentWindowId : undefined;
  const results = [];

  let sharedSession = null;
  async function ensureSharedSession(firstJob) {
    if (!sharedSession) {
      sharedSession = await backend.openSession({
        windowWidth: settings.captureWindowWidth,
        windowHeight: settings.captureWindowHeight,
        fullscreen: !!firstJob.site.fullscreen,
        currentWindowId: useCurrentWindowId,
      });
      await trackOpenSession(sharedSession);
    }
    return sharedSession;
  }

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (shouldStop && shouldStop()) {
        onProgress?.({ type: "stopped", index: i, total: jobs.length });
        break;
      }
      const job = jobs[i];
      onProgress?.({
        type: "start",
        index: i,
        total: jobs.length,
        indicator: job.indicator,
        site: job.site.id,
      });

      try {
        const { indicator, indicatorKind, site, host } = job;
        const targetUrl = await expandUrlTemplate(site.url, { indicator, kind: indicatorKind, host });
        const settleMs = settings.settleMsOverride ?? site.settleMs ?? 3000;

        let session;
        if (reuseWindow) {
          session = await ensureSharedSession(job);
        } else {
          session = await backend.openSession({
            windowWidth: settings.captureWindowWidth,
            windowHeight: settings.captureWindowHeight,
            fullscreen: !!site.fullscreen,
            currentWindowId: useCurrentWindowId,
          });
          await trackOpenSession(session);
        }

        await backend.setSessionFullscreen(session, !!site.fullscreen);
        await backend.navigateOnly(session, {
          url: targetUrl,
          navigationTimeoutMs: settings.navigationTimeoutMs,
          settleMs,
        });

        results.push({ ok: true, indicator: job.indicator, site: job.site.id });
        onProgress?.({ type: "done", index: i, total: jobs.length, indicator: job.indicator, site: job.site.id });
      } catch (err) {
        const message = (err && err.message) || String(err);
        results.push({ ok: false, indicator: job.indicator, site: job.site.id, error: message });
        onProgress?.({
          type: "error",
          index: i,
          total: jobs.length,
          indicator: job.indicator,
          site: job.site.id,
          error: message,
        });
      }
    }

    onProgress?.({ type: "complete", results, manifestPath: null });
    return { results, manifestPath: null };
  } finally {
    stopKeepAlive();
  }
}

/**
 * Run one diagnostic capture against a configurable URL and report exactly
 * what happened at whichever step failed. Used by the Options page's
 * self-test.
 * @param {Object} opts
 * @param {string} opts.url
 * @param {object} opts.settings
 */
export async function runSelfTest({ url, settings }) {
  const job = {
    indicator: url,
    indicatorKind: "url",
    host: null,
    site: { id: "selftest", name: "Diagnostics self-test", url, settleMs: 2000, fullscreen: false },
  };
  try {
    const outcome = await runSingleCapture({ job, settings, caseRef: "selftest" });
    return {
      ok: true,
      backend: effectiveBackendId(settings),
      width: outcome.diagnostics.width,
      height: outcome.diagnostics.height,
      pngPath: outcome.manifestEntry.pngPath,
      truncated: outcome.diagnostics.truncated,
      realHeightPx: outcome.diagnostics.realHeightPx,
    };
  } catch (err) {
    return { ok: false, error: (err && err.stack) || String(err) };
  }
}
