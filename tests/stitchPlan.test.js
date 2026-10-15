import test from "node:test";
import assert from "node:assert/strict";
import { planStitchTiles } from "../common/stitchPlan.js";

test("content that fits one viewport is a single 'only' tile", () => {
  const plan = planStitchTiles({ contentHeight: 700, viewportHeight: 768, maxContentHeight: 16384 });
  assert.deepEqual(plan.tiles, [{ y: 0, phase: "only" }]);
  assert.equal(plan.truncated, false);
  assert.equal(plan.capturedHeight, 700);
});

test("exact multiple of the viewport: one tile per screen, last one at the bottom", () => {
  const plan = planStitchTiles({ contentHeight: 3000, viewportHeight: 1000, maxContentHeight: 16384 });
  assert.deepEqual(
    plan.tiles.map((t) => t.y),
    [0, 1000, 2000]
  );
  assert.deepEqual(
    plan.tiles.map((t) => t.phase),
    ["first", "middle", "last"]
  );
  assert.equal(plan.truncated, false);
  assert.equal(plan.capturedHeight, 3000);
});

test("non-multiple: the final tile is pulled up so it ends exactly at the bottom", () => {
  const plan = planStitchTiles({ contentHeight: 8000, viewportHeight: 768, maxContentHeight: 16384 });
  const ys = plan.tiles.map((t) => t.y);
  assert.equal(ys[0], 0);
  assert.equal(ys[ys.length - 1], 8000 - 768);
  // Strictly increasing, and no gaps bigger than one viewport.
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] > ys[i - 1]);
    assert.ok(ys[i] - ys[i - 1] <= 768);
  }
  assert.equal(plan.tiles.length, Math.ceil(8000 / 768));
  assert.equal(plan.tiles.at(-1).phase, "last");
});

test("two tiles: first and last, no middle", () => {
  const plan = planStitchTiles({ contentHeight: 1200, viewportHeight: 768, maxContentHeight: 16384 });
  assert.deepEqual(plan.tiles, [
    { y: 0, phase: "first" },
    { y: 432, phase: "last" },
  ]);
});

test("taller than the cap: truncated, stops at the cap, never shows bottom-fixed elements mid-page", () => {
  const plan = planStitchTiles({ contentHeight: 30000, viewportHeight: 1000, maxContentHeight: 16384 });
  assert.equal(plan.truncated, true);
  assert.equal(plan.capturedHeight, 16384);
  const last = plan.tiles.at(-1);
  assert.equal(last.y, 16384 - 1000);
  assert.equal(last.phase, "middle", "a truncated capture's last tile isn't the page bottom");
});

test("fractional sizes are handled without producing a gap", () => {
  const plan = planStitchTiles({ contentHeight: 2500.4, viewportHeight: 999.6, maxContentHeight: 16384 });
  const ys = plan.tiles.map((t) => t.y);
  assert.equal(ys.at(-1) + 999, Math.ceil(2500.4));
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] <= 999);
});
