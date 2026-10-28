import test from "node:test";
import assert from "node:assert/strict";
import { mergeSites, upgradeUnchangedDefaults } from "../common/storage.js";
import { DEFAULT_SITES, PREVIOUS_DEFAULT_VALUES } from "../common/defaultSites.js";

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

test("upgradeUnchangedDefaults: a field still at an old default moves to the new one; edited fields stay", () => {
  const current = [
    { id: "spur", url: "https://app.spur.us/{host}", settleMs: 5000 },
    { id: "abuseipdb", url: "https://www.abuseipdb.com/check/{host}", settleMs: 7000 },
  ];
  const prev = { spur: { url: ["https://app.spur.us/context/{host}"] }, abuseipdb: { settleMs: [3000] } };
  const saved = [
    { id: "spur", url: "https://app.spur.us/context/{host}", settleMs: 4000, enabled: true },
    { id: "abuseipdb", url: "https://www.abuseipdb.com/check/{host}", settleMs: 9000, enabled: true },
    { id: "custom", url: "https://example.com/{host}", settleMs: 3000 },
  ];
  const { sites, upgraded } = upgradeUnchangedDefaults(saved, current, prev);
  assert.equal(sites[0].url, "https://app.spur.us/{host}");
  assert.equal(sites[0].settleMs, 4000, "only the old-default field changes");
  assert.equal(sites[0].enabled, true);
  assert.equal(sites[1].settleMs, 9000, "an analyst-set settle time is kept");
  assert.equal(sites[2], saved[2], "non-default sites untouched");
  assert.deepEqual(upgraded, ["spur.url"]);
});

test("mergeSites: reports upgrades so loadState persists them", () => {
  const saved = [{ id: "abuseipdb", url: "https://www.abuseipdb.com/check/{host}", settleMs: 3000, enabled: true }];
  const { sites, upgraded } = mergeSites(saved, DEFAULT_SITES.map((d) => d.id));
  assert.equal(sites.find((s) => s.id === "abuseipdb").settleMs, 7000);
  assert.deepEqual(upgraded, ["abuseipdb.settleMs"]);
});

test("PREVIOUS_DEFAULT_VALUES: every listed old value differs from the current default", () => {
  for (const [id, fields] of Object.entries(PREVIOUS_DEFAULT_VALUES)) {
    const site = DEFAULT_SITES.find((d) => d.id === id);
    assert.ok(site, `${id} is a default site`);
    for (const [field, oldValues] of Object.entries(fields)) {
      assert.ok(!oldValues.includes(site[field]), `${id}.${field} current value isn't listed as old`);
    }
  }
});
