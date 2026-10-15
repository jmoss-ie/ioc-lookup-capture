import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSegment,
  buildEvidencePath,
  buildManifestPath,
  buildShaSumsPath,
} from "../common/pathSanitize.js";

test("sanitizeSegment: strips reserved characters", () => {
  assert.equal(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
});

test("sanitizeSegment: collapses dot runs, no '..' can appear", () => {
  assert.equal(sanitizeSegment("evil..com"), "evil_com");
  assert.equal(sanitizeSegment("..").includes(".."), false);
  assert.equal(sanitizeSegment("...").includes(".."), false);
  assert.equal(sanitizeSegment("a...b"), "a_b");
});

test("sanitizeSegment: trims trailing dots/spaces (Windows)", () => {
  assert.equal(sanitizeSegment("evil.com."), "evil.com");
  assert.equal(sanitizeSegment("evil.com   "), "evil.com");
});

test("sanitizeSegment: escapes reserved Windows device names case-insensitively", () => {
  assert.equal(sanitizeSegment("CON"), "CON_");
  assert.equal(sanitizeSegment("con"), "con_");
  assert.equal(sanitizeSegment("LPT1"), "LPT1_");
  assert.equal(sanitizeSegment("COM9"), "COM9_");
  assert.equal(sanitizeSegment("evil.com"), "evil.com"); // not reserved, unaffected
});

test("sanitizeSegment: empty input falls back", () => {
  assert.equal(sanitizeSegment(""), "_");
  assert.equal(sanitizeSegment("   "), "_");
});

test("buildEvidencePath: full layout with case ref and per-indicator folder", () => {
  const p = buildEvidencePath({
    baseFolder: "soc-evidence",
    hiddenPrefix: "hidden",
    caseRef: "INC-123",
    perIndicatorFolder: true,
    indicator: "evil.com",
    site: "virustotal-domain",
    timestamp: "20260912T010305Z",
    ext: "png",
  });
  assert.equal(
    p,
    "soc-evidence/INC-123/evil.com/hidden-virustotal-domain-evil.com-20260912T010305Z.png"
  );
});

test("buildEvidencePath: empty case ref drops that folder level entirely", () => {
  const p = buildEvidencePath({
    baseFolder: "soc-evidence",
    hiddenPrefix: "hidden",
    caseRef: "",
    perIndicatorFolder: true,
    indicator: "1.2.3.4",
    site: "abuseipdb",
    timestamp: "20260912T010305Z",
    ext: "json",
  });
  assert.equal(p, "soc-evidence/1.2.3.4/hidden-abuseipdb-1.2.3.4-20260912T010305Z.json");
});

test("buildEvidencePath: per-indicator folder can be disabled", () => {
  const p = buildEvidencePath({
    baseFolder: "soc-evidence",
    hiddenPrefix: "hidden",
    caseRef: "INC-1",
    perIndicatorFolder: false,
    indicator: "1.2.3.4",
    site: "abuseipdb",
    timestamp: "20260912T010305Z",
    ext: "png",
  });
  assert.equal(p, "soc-evidence/INC-1/hidden-abuseipdb-1.2.3.4-20260912T010305Z.png");
});

test("buildEvidencePath: hidden prefix configurable/empty", () => {
  const p = buildEvidencePath({
    baseFolder: "soc-evidence",
    hiddenPrefix: "",
    caseRef: "",
    perIndicatorFolder: false,
    indicator: "1.2.3.4",
    site: "abuseipdb",
    timestamp: "20260912T010305Z",
    ext: "png",
  });
  assert.equal(p, "soc-evidence/abuseipdb-1.2.3.4-20260912T010305Z.png");
});

test("buildEvidencePath: path traversal attempt in indicator/case ref is neutralized", () => {
  const p = buildEvidencePath({
    baseFolder: "soc-evidence",
    hiddenPrefix: "hidden",
    caseRef: "../../etc",
    perIndicatorFolder: true,
    indicator: "../../evil.com",
    site: "abuseipdb",
    timestamp: "20260912T010305Z",
    ext: "png",
  });
  assert.equal(p.includes(".."), false);
  assert.equal(p.includes("//"), false);
});

test("buildManifestPath / buildShaSumsPath", () => {
  const m = buildManifestPath({ baseFolder: "soc-evidence", caseRef: "INC-1", timestamp: "TS" });
  assert.equal(m, "soc-evidence/INC-1/manifest-TS.json");
  const s = buildShaSumsPath({ baseFolder: "soc-evidence", caseRef: "", timestamp: "TS" });
  assert.equal(s, "soc-evidence/SHA256SUMS-TS.txt");
});
