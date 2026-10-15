// Pure planning logic for the stitched full-page backend: given how tall
// the scrollable content is and how much of it is visible at once, which
// scroll offsets to capture, and which "phase" each capture is in (which
// decides whether fixed-position headers/footers are shown in that tile).
// No browser APIs here, so it's unit-tested directly under Node.

/**
 * @typedef {"only"|"first"|"middle"|"last"} TilePhase
 *   only   - the content fits in one viewport; nothing is hidden
 *   first  - top of the page; fixed elements in the top half stay visible
 *   middle - fixed elements are all hidden, so they aren't repeated
 *   last   - true bottom of the page; fixed elements in the bottom half are
 *            shown again (cookie bars, footers), top-half ones stay hidden
 */

/**
 * @param {Object} opts
 * @param {number} opts.contentHeight  - total scrollable height (CSS px)
 * @param {number} opts.viewportHeight - visible height per capture (CSS px)
 * @param {number} opts.maxContentHeight - most content (CSS px) the output
 *   image can hold; anything beyond it is truncated
 * @returns {{ tiles: Array<{ y: number, phase: TilePhase }>, capturedHeight: number, truncated: boolean }}
 */
export function planStitchTiles({ contentHeight, viewportHeight, maxContentHeight }) {
  const vh = Math.max(1, Math.floor(viewportHeight));
  const total = Math.max(0, Math.ceil(contentHeight));
  const cap = Math.max(vh, Math.floor(maxContentHeight));

  if (total <= vh) {
    return { tiles: [{ y: 0, phase: "only" }], capturedHeight: total, truncated: false };
  }

  const truncated = total > cap;
  const covered = truncated ? cap : total;
  // The lowest offset that still shows a full viewport of the covered range.
  const lastY = covered - vh;

  const ys = [];
  for (let y = 0; y < lastY; y += vh) ys.push(y);
  ys.push(lastY);

  const tiles = ys.map((y, i) => {
    let phase = "middle";
    if (i === 0) phase = "first";
    else if (i === ys.length - 1 && !truncated) phase = "last";
    return { y, phase };
  });

  return { tiles, capturedHeight: covered, truncated };
}
