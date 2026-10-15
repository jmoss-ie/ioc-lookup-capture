import test from "node:test";
import assert from "node:assert/strict";
import { expandUrlTemplate, sitesForIndicatorKind } from "../common/urlTemplate.js";
import { sha256Hex } from "../common/hash.js";
import { DEFAULT_SITES } from "../common/defaultSites.js";

test("expandUrlTemplate: {host} substitution", async () => {
  const url = await expandUrlTemplate("https://www.abuseipdb.com/check/{host}", {
    indicator: "1.2.3.4",
    kind: "ipv4",
    host: "1.2.3.4",
  });
  assert.equal(url, "https://www.abuseipdb.com/check/1.2.3.4");
});

test("expandUrlTemplate: {indicator} for hash", async () => {
  const url = await expandUrlTemplate("https://www.virustotal.com/gui/file/{indicator}", {
    indicator: "d41d8cd98f00b204e9800998ecf8427e",
    kind: "hash",
    host: null,
  });
  assert.equal(url, "https://www.virustotal.com/gui/file/d41d8cd98f00b204e9800998ecf8427e");
});

test("expandUrlTemplate: {vtUrlId} is sha256 of the URL string", async () => {
  const indicator = "https://evil.com/pay.php";
  const expectedHash = await sha256Hex(indicator);
  const url = await expandUrlTemplate("https://www.virustotal.com/gui/url/{vtUrlId}", {
    indicator,
    kind: "url",
    host: "evil.com",
  });
  assert.equal(url, `https://www.virustotal.com/gui/url/${expectedHash}`);
});

test("expandUrlTemplate: {encoded} and {hostEncoded}", async () => {
  const url = await expandUrlTemplate("https://pulsedive.com/indicator/?ioc={encoded}", {
    indicator: "evil.com/a b",
    kind: "url",
    host: "evil.com",
  });
  assert.equal(url, "https://pulsedive.com/indicator/?ioc=evil.com%2Fa%20b");

  const url2 = await expandUrlTemplate(
    "https://talosintelligence.com/reputation_center/lookup?search={hostEncoded}",
    { indicator: "evil host.com", kind: "domain", host: "evil host.com" }
  );
  assert.equal(
    url2,
    "https://talosintelligence.com/reputation_center/lookup?search=evil%20host.com"
  );
});

test("expandUrlTemplate: multiple placeholders in one template", async () => {
  const url = await expandUrlTemplate("https://x.test/{host}/{indicator}", {
    indicator: "evil.com/pay.php",
    kind: "url",
    host: "evil.com",
  });
  assert.equal(url, "https://x.test/evil.com/evil.com/pay.php");
});

test("sitesForIndicatorKind: gates on applies + enabled", () => {
  const sites = [
    { id: "a", applies: ["ipv4"], enabled: true },
    { id: "b", applies: ["ipv4"], enabled: false },
    { id: "c", applies: ["domain"], enabled: true },
  ];
  const result = sitesForIndicatorKind(sites, "ipv4");
  assert.deepEqual(
    result.map((s) => s.id),
    ["a"]
  );
});

test("DEFAULT_SITES: every enabled shipped site matches the spec table", () => {
  const byId = Object.fromEntries(DEFAULT_SITES.map((s) => [s.id, s]));
  assert.equal(byId["abuseipdb"].enabled, true);
  assert.equal(byId["virustotal-file"].applies.includes("hash"), true);
  assert.equal(byId["ipvoid"].applies.length, 1);
  assert.equal(byId["talos"].enabled, false);
  assert.equal(byId["censys"].enabled, false);
  assert.equal(DEFAULT_SITES.filter((s) => s.isDefault).length, DEFAULT_SITES.length);
});

test("DEFAULT_SITES: ids are unique", () => {
  const ids = DEFAULT_SITES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});
