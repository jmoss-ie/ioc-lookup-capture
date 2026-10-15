import test from "node:test";
import assert from "node:assert/strict";
import { mergeSites } from "../common/storage.js";

const V1_DEFAULTS = [
  { id: "a", name: "A", enabled: true },
  { id: "b", name: "B", enabled: true },
  { id: "c", name: "C", enabled: false },
];

test("mergeSites: first run adds nothing beyond what's already saved (no known ids yet, all present)", () => {
  const saved = [...V1_DEFAULTS];
  const { sites, knownDefaultIds } = mergeSites(saved, [], V1_DEFAULTS);
  assert.equal(sites.length, 3);
  assert.deepEqual(knownDefaultIds.sort(), ["a", "b", "c"]);
});

test("mergeSites: analyst deletion of a default is NOT resurrected on next load", () => {
  // Analyst deleted "c" after it was known.
  const saved = [
    { id: "a", name: "A", enabled: true },
    { id: "b", name: "B", enabled: true },
  ];
  const knownDefaultIds = ["a", "b", "c"]; // "c" existed at save time
  const { sites } = mergeSites(saved, knownDefaultIds, V1_DEFAULTS);
  assert.equal(
    sites.some((s) => s.id === "c"),
    false
  );
  assert.equal(sites.length, 2);
});

test("mergeSites: a genuinely NEW default (added in a later extension version) IS added", () => {
  const saved = [
    { id: "a", name: "A", enabled: true },
    { id: "b", name: "B", enabled: true },
  ];
  const knownDefaultIds = ["a", "b"]; // "c" did not exist yet
  const V2_DEFAULTS = [...V1_DEFAULTS, { id: "d", name: "D new site", enabled: false }];
  const { sites, knownDefaultIds: newKnown } = mergeSites(saved, knownDefaultIds, V2_DEFAULTS);
  // "c" is new relative to what analyst had last seen -> added.
  // "d" is also new -> added.
  assert.equal(sites.some((s) => s.id === "c"), true);
  assert.equal(sites.some((s) => s.id === "d"), true);
  assert.deepEqual(newKnown.sort(), ["a", "b", "c", "d"]);
});

test("mergeSites: analyst edits to an existing default are preserved, not overwritten", () => {
  const saved = [{ id: "a", name: "A (renamed by analyst)", enabled: false, settleMs: 9999 }];
  const knownDefaultIds = ["a"];
  const { sites } = mergeSites(saved, knownDefaultIds, [
    { id: "a", name: "A", enabled: true, settleMs: 3000 },
  ]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name, "A (renamed by analyst)");
  assert.equal(sites[0].enabled, false);
  assert.equal(sites[0].settleMs, 9999);
});

test("mergeSites: analyst-added custom site (non-default id) is always preserved", () => {
  const saved = [
    { id: "a", name: "A", enabled: true },
    { id: "custom-1", name: "My Custom Site", enabled: true },
  ];
  const { sites } = mergeSites(saved, ["a"], V1_DEFAULTS);
  assert.equal(sites.some((s) => s.id === "custom-1"), true);
});
