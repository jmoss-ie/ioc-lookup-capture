import test from "node:test";
import assert from "node:assert/strict";
import {
  cropRectForImage,
  intersect,
  locateSection,
  parseSelectorList,
} from "../common/sectionGeometry.js";

const vp = (width, height, innerWidth = width) => ({ width, height, innerWidth, innerHeight: height });

test("parseSelectorList: one per line, skipping blanks; # is an ID selector, not a comment", () => {
  assert.deepEqual(parseSelectorList(" .a \n\n#target \n.b, .c\r\n"), [".a", "#target", ".b, .c"]);
  assert.deepEqual(parseSelectorList(undefined), []);
});

test("intersect: overlap or null", () => {
  assert.deepEqual(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), {
    x: 5,
    y: 5,
    width: 5,
    height: 5,
  });
  assert.equal(intersect({ x: 0, y: 0, width: 5, height: 5 }, { x: 5, y: 0, width: 5, height: 5 }), null);
});

test("locateSection: a match in the top frame is used as-is", () => {
  const r = locateSection([
    {
      frameId: 0,
      result: { ok: true, viewport: vp(1000, 800), match: { selectorIndex: 0, rect: { x: 10, y: 20, width: 300, height: 200 } }, frames: [] },
    },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(r.clipped, false);
});

test("locateSection: a match two cross-origin frames down is offset at each level", () => {
  const r = locateSection([
    {
      frameId: 0,
      result: { ok: true, viewport: vp(1200, 900), match: null, frames: [{ frameId: 5, x: 48, y: 68, width: 900, height: 600, scaleX: 1, scaleY: 1 }] },
    },
    {
      frameId: 5,
      result: { ok: true, viewport: vp(900, 600), match: null, frames: [{ frameId: 9, x: 20, y: 30, width: 700, height: 500, scaleX: 1, scaleY: 1 }] },
    },
    {
      frameId: 9,
      result: { ok: true, viewport: vp(700, 500), match: { selectorIndex: 0, rect: { x: 30, y: 20, width: 408, height: 308 } }, frames: [] },
    },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 48 + 20 + 30, y: 68 + 30 + 20, width: 408, height: 308 });
  assert.equal(r.frameId, 9);
  assert.equal(r.clipped, false);
});

test("locateSection: clipped by the frame's viewport, and flagged", () => {
  const r = locateSection([
    { frameId: 0, result: { ok: true, viewport: vp(1000, 800), frames: [{ frameId: 3, x: 100, y: 100, width: 400, height: 300 }] } },
    { frameId: 3, result: { ok: true, viewport: vp(400, 300), match: { selectorIndex: 0, rect: { x: 0, y: -50, width: 400, height: 500 } }, frames: [] } },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 100, y: 100, width: 400, height: 300 });
  assert.deepEqual(r.fullRect, { x: 100, y: 50, width: 400, height: 500 });
  assert.equal(r.clipped, true);
});

test("locateSection: CSS-scaled iframe scales the child's coordinates", () => {
  const r = locateSection([
    { frameId: 0, result: { ok: true, viewport: vp(1000, 800), frames: [{ frameId: 2, x: 10, y: 10, width: 400, height: 300, scaleX: 0.5, scaleY: 0.5 }] } },
    { frameId: 2, result: { ok: true, viewport: vp(800, 600), match: { selectorIndex: 0, rect: { x: 100, y: 100, width: 200, height: 100 } }, frames: [] } },
  ]);
  assert.deepEqual(r.rect, { x: 60, y: 60, width: 100, height: 50 });
});

test("locateSection: earlier selector wins, then the larger visible area", () => {
  const frames = [
    {
      frameId: 0,
      result: { ok: true, viewport: vp(1000, 800), match: { selectorIndex: 1, rect: { x: 0, y: 0, width: 900, height: 700 } }, frames: [{ frameId: 4, x: 0, y: 0, width: 500, height: 500 }] },
    },
    { frameId: 4, result: { ok: true, viewport: vp(500, 500), match: { selectorIndex: 0, rect: { x: 0, y: 0, width: 50, height: 50 } }, frames: [] } },
  ];
  assert.equal(locateSection(frames).frameId, 4);
});

test("locateSection: explains each failure", () => {
  assert.equal(locateSection([]).reason, "no-top");
  assert.equal(locateSection([{ frameId: 0, result: { ok: true, viewport: vp(10, 10), match: null, frames: [] } }]).reason, "not-found");
  // A matching frame whose parent link is missing (e.g. its parent couldn't be probed).
  assert.equal(
    locateSection([
      { frameId: 0, result: { ok: true, viewport: vp(10, 10), frames: [] } },
      { frameId: 7, result: { ok: true, viewport: vp(10, 10), match: { selectorIndex: 0, rect: { x: 0, y: 0, width: 5, height: 5 } }, frames: [] } },
    ]).reason,
    "unplaced"
  );
  assert.equal(
    locateSection([
      { frameId: 0, result: { ok: true, viewport: vp(100, 100), match: { selectorIndex: 0, rect: { x: 0, y: 200, width: 50, height: 50 } }, frames: [] } },
    ]).reason,
    "not-visible"
  );
});

test("cropRectForImage: scales by screenshot width / innerWidth and clamps to the image", () => {
  assert.deepEqual(cropRectForImage({ x: 10, y: 20, width: 100, height: 50 }, { innerWidth: 500 }, { width: 1000, height: 800 }), {
    x: 20,
    y: 40,
    width: 200,
    height: 100,
  });
  assert.deepEqual(cropRectForImage({ x: 450, y: 0, width: 100, height: 10 }, { innerWidth: 500 }, { width: 500, height: 400 }), {
    x: 450,
    y: 0,
    width: 50,
    height: 10,
  });
  assert.equal(cropRectForImage({ x: 600, y: 0, width: 10, height: 10 }, { innerWidth: 500 }, { width: 500, height: 400 }), null);
});
