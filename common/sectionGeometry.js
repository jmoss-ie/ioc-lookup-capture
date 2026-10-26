// Geometry for "Capture section": given what a probe script reported from
// every frame of a tab, find the section to capture and work out where it
// sits in the top-level page, so a screenshot of the visible tab can be
// cropped to it. Pure logic with no chrome.* calls, unit-tested under Node.
//
// Each frame reports, in its own CSS pixels:
//   - its viewport size (the part of the frame that's visible, minus scrollbars),
//   - the best match for the configured selectors, if any, and
//   - for each child <iframe>/<frame>: the child's frameId and where the
//     child's content box sits in this frame (plus any CSS scale on it).
//     (bg/sectionCapture.js works out which frameId is in which <iframe>.)
// A section inside nested frames is placed by walking from its frame up to
// the top frame, offsetting and clipping at every level.

/** Default selector: the query editor + results area of the Sentinel / Log Analytics "Logs" page. */
export const DEFAULT_SECTION_SELECTORS = ".listener-to-user-interaction.main-container";

/**
 * Split the Options text into selectors: one per line, blank lines ignored.
 * (No comment syntax: "#" starts an ID selector.)
 * @param {string} text
 * @returns {string[]}
 */
export function parseSelectorList(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** Intersection of two rects, or null if they don't overlap. */
export function intersect(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Map a rect from a child frame's coordinates into its parent's. */
function toParent(rect, box) {
  return {
    x: box.x + rect.x * (box.scaleX || 1),
    y: box.y + rect.y * (box.scaleY || 1),
    width: rect.width * (box.scaleX || 1),
    height: rect.height * (box.scaleY || 1),
  };
}

/**
 * Pick the section to capture and place it in top-level CSS pixels.
 *
 * @param {Array<{ frameId: number, result: any }>} frames - one entry per
 *   frame the probe ran in (frameId 0 is the top frame).
 * @returns {{ ok: true, rect: Rect, fullRect: Rect, clipped: boolean,
 *             selectorIndex: number, frameId: number, topViewport: object }
 *         | { ok: false, reason: "no-top"|"not-found"|"unplaced"|"not-visible", message: string }}
 */
export function locateSection(frames) {
  const byId = new Map();
  for (const f of frames || []) {
    if (f && f.result && f.result.ok) byId.set(f.frameId, f.result);
  }
  const top = byId.get(0);
  if (!top) {
    return { ok: false, reason: "no-top", message: "The extension couldn't read this page." };
  }

  // child frameId -> { parentFrameId, box }
  const parentOf = new Map();
  for (const [frameId, r] of byId) {
    for (const child of r.frames || []) {
      if (typeof child.frameId === "number" && child.frameId >= 0 && !parentOf.has(child.frameId)) {
        parentOf.set(child.frameId, { parentFrameId: frameId, box: child });
      }
    }
  }

  // Candidates: lowest selector index wins (the Options list is in priority
  // order); among those, the one with the largest visible area in the top page.
  const candidates = [];
  for (const [frameId, r] of byId) {
    if (r.match && r.match.rect) candidates.push({ frameId, match: r.match });
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      message: "None of the section selectors match anything on this page.",
    };
  }

  let best = null;
  let sawUnplaced = false;
  for (const c of candidates) {
    const placed = placeInTop(c.frameId, c.match.rect, byId, parentOf);
    if (!placed) {
      sawUnplaced = true;
      continue;
    }
    const area = placed.rect ? placed.rect.width * placed.rect.height : 0;
    const better =
      !best ||
      c.match.selectorIndex < best.selectorIndex ||
      (c.match.selectorIndex === best.selectorIndex && area > best.area);
    if (better) best = { ...placed, area, selectorIndex: c.match.selectorIndex, frameId: c.frameId };
  }

  if (!best) {
    return {
      ok: false,
      reason: sawUnplaced ? "unplaced" : "not-found",
      message: "Found the section, but couldn't work out where its frame sits on the page.",
    };
  }
  if (!best.rect) {
    return { ok: false, reason: "not-visible", message: "The section is scrolled out of view." };
  }

  const clipped =
    best.rect.width < best.fullRect.width - 1 || best.rect.height < best.fullRect.height - 1;
  return {
    ok: true,
    rect: best.rect,
    fullRect: best.fullRect,
    clipped,
    selectorIndex: best.selectorIndex,
    frameId: best.frameId,
    topViewport: top.viewport,
  };
}

/**
 * Walk a rect from its frame up to the top frame. Returns null if the frame
 * chain can't be followed; `rect` is null if nothing of it is visible.
 */
function placeInTop(frameId, rect, byId, parentOf) {
  let full = { ...rect };
  let current = frameId;
  let visible = intersect(rect, viewportRect(byId.get(current)));
  const seen = new Set();
  while (current !== 0) {
    if (seen.has(current)) return null; // defensive: a cycle would be a bug upstream
    seen.add(current);
    const link = parentOf.get(current);
    if (!link || !byId.has(link.parentFrameId)) return null;
    full = toParent(full, link.box);
    if (visible) {
      visible = toParent(visible, link.box);
      visible = intersect(visible, link.box); // the iframe's own content box
      if (visible) visible = intersect(visible, viewportRect(byId.get(link.parentFrameId)));
    }
    current = link.parentFrameId;
  }
  return { rect: visible, fullRect: full };
}

function viewportRect(frameResult) {
  const v = (frameResult && frameResult.viewport) || {};
  return { x: 0, y: 0, width: v.width || 0, height: v.height || 0 };
}

/**
 * Convert a top-level CSS-pixel rect to a crop rect in the screenshot's own
 * pixels, using the screenshot width against the top frame's innerWidth to
 * get the scale (device pixel ratio × page zoom), clamped to the image.
 * @param {Rect} rect
 * @param {{ innerWidth: number }} topViewport
 * @param {{ width: number, height: number }} image
 * @returns {Rect|null}
 */
export function cropRectForImage(rect, topViewport, image) {
  const scale = topViewport && topViewport.innerWidth ? image.width / topViewport.innerWidth : 1;
  const x1 = Math.max(0, Math.round(rect.x * scale));
  const y1 = Math.max(0, Math.round(rect.y * scale));
  const x2 = Math.min(image.width, Math.round((rect.x + rect.width) * scale));
  const y2 = Math.min(image.height, Math.round((rect.y + rect.height) * scale));
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
