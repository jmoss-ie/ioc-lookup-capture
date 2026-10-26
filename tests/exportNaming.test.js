import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXPORT_TEMPLATE,
  buildExportPath,
  checkExportTemplate,
  downloadHosts,
  expandExportTemplate,
  filenameTimestamp,
  formatSeq,
  hostMatches,
  isArmExpired,
  parseHostList,
  passesHostFilter,
  splitFilename,
} from "../common/exportNaming.js";

const DATE = new Date("2026-10-26T00:15:30.123Z");

test("filenameTimestamp: matches the screenshot filename format", () => {
  assert.equal(filenameTimestamp(DATE), "20261026T001530Z");
});

test("formatSeq: zero-pads to two digits and never goes below 1", () => {
  assert.equal(formatSeq(1), "01");
  assert.equal(formatSeq(9), "09");
  assert.equal(formatSeq(42), "42");
  assert.equal(formatSeq(100), "100");
  assert.equal(formatSeq(0), "01");
  assert.equal(formatSeq("x"), "01");
});

test("expandExportTemplate: fills every token", () => {
  assert.equal(
    expandExportTemplate(DEFAULT_EXPORT_TEMPLATE, {
      prefix: "TCS",
      case: "INC-1234",
      seq: "03",
      label: "signins",
      name: "query_data",
      timestamp: "20261026T001530Z",
    }),
    "TCS-INC-1234-03-signins-query_data-20261026T001530Z"
  );
});

test("expandExportTemplate: an empty token takes one adjacent template separator with it", () => {
  const values = { prefix: "", case: "INC-1234", seq: "03", label: "", name: "query_data", timestamp: "T" };
  assert.equal(expandExportTemplate(DEFAULT_EXPORT_TEMPLATE, values), "INC-1234-03-query_data-T");
  assert.equal(expandExportTemplate("{case}_{label}_{seq}", values), "INC-1234_03");
  assert.equal(expandExportTemplate("{label}-{case}", values), "INC-1234");
  assert.equal(expandExportTemplate("{prefix}{label}-{case}", values), "INC-1234");
  assert.equal(expandExportTemplate("{case}-{label}", values), "INC-1234");
});

test("expandExportTemplate: separators inside a value are left alone", () => {
  // The trailing "-" belongs to the case value, not the template, so an empty
  // {label} straight after it must not eat it.
  assert.equal(expandExportTemplate("{case}{label}x", { case: "A-", label: "" }), "A-x");
});

test("expandExportTemplate: unknown tokens stay as literal text", () => {
  assert.equal(expandExportTemplate("{case}-{nope}", { case: "C" }), "C-{nope}");
});

test("expandExportTemplate: token names are case-insensitive", () => {
  assert.equal(expandExportTemplate("{CASE}-{Seq}", { case: "C", seq: "01" }), "C-01");
});

test("expandExportTemplate: values and literals are made filename-safe", () => {
  assert.equal(
    expandExportTemplate("{case}/{label}", { case: "INC:1", label: "a/b\\c" }),
    "INC_1_a_b_c"
  );
  assert.equal(expandExportTemplate("{label}", { label: "evil..name" }), "evil_name");
});

test("expandExportTemplate: never returns an empty name", () => {
  assert.equal(expandExportTemplate("{label}", { label: "" }), "export");
  assert.equal(expandExportTemplate("", {}), "export");
  assert.equal(expandExportTemplate("---", {}), "export");
});

test("expandExportTemplate: long values are truncated", () => {
  const out = expandExportTemplate("{label}-{name}", { label: "x".repeat(500), name: "y".repeat(500) });
  assert.ok(out.length <= 150, `length ${out.length}`);
});

test("checkExportTemplate: reports unknown tokens and whether {seq} is present", () => {
  assert.deepEqual(checkExportTemplate(DEFAULT_EXPORT_TEMPLATE), { unknown: [], hasSeq: true });
  assert.deepEqual(checkExportTemplate("{case}-{table}"), { unknown: ["{table}"], hasSeq: false });
});

test("splitFilename: keeps a short alphanumeric extension only", () => {
  assert.deepEqual(splitFilename("query_data.csv"), { base: "query_data", ext: ".csv" });
  assert.deepEqual(splitFilename("C:\\Users\\x\\Downloads\\book.xlsx"), { base: "book", ext: ".xlsx" });
  assert.deepEqual(splitFilename("/home/x/PowerBIQuery.txt"), { base: "PowerBIQuery", ext: ".txt" });
  assert.deepEqual(splitFilename("report.final draft"), { base: "report.final draft", ext: "" });
  assert.deepEqual(splitFilename(".hidden"), { base: ".hidden", ext: "" });
  assert.deepEqual(splitFilename(""), { base: "download", ext: "" });
});

test("buildExportPath: case folder + subfolder + expanded name + original extension", () => {
  const { path, filename } = buildExportPath({
    baseFolder: "soc-evidence",
    caseRef: "INC-1234",
    subfolder: "exports",
    template: DEFAULT_EXPORT_TEMPLATE,
    prefix: "",
    seq: 3,
    label: "",
    originalFilename: "query_data.csv",
    date: DATE,
  });
  assert.equal(filename, "INC-1234-03-query_data-20261026T001530Z.csv");
  assert.equal(path, "soc-evidence/INC-1234/exports/INC-1234-03-query_data-20261026T001530Z.csv");
});

test("buildExportPath: empty subfolder puts exports straight in the case folder", () => {
  const { path } = buildExportPath({
    baseFolder: "soc-evidence",
    caseRef: "INC-1",
    subfolder: "  ",
    template: "{case}-{seq}",
    seq: 1,
    originalFilename: "x.csv",
    date: DATE,
  });
  assert.equal(path, "soc-evidence/INC-1/INC-1-01.csv");
});

test("buildExportPath: no path segment can escape the Downloads folder", () => {
  const { path } = buildExportPath({
    baseFolder: "..",
    caseRef: "../../etc",
    subfolder: "..",
    template: "{label}",
    label: "../x",
    seq: 1,
    originalFilename: "../../a.csv",
    date: DATE,
  });
  assert.equal(path.includes(".."), false, path);
  for (const seg of path.split("/")) assert.notEqual(seg, "");
});

test("parseHostList: accepts URLs, wildcards, ports and mixed separators", () => {
  assert.deepEqual(
    parseHostList("https://portal.azure.com/#view/blade, *.loganalytics.io\n.security.microsoft.com; example.com:8443 example.com"),
    ["portal.azure.com", "loganalytics.io", "security.microsoft.com", "example.com"]
  );
  assert.deepEqual(parseHostList("   "), []);
  assert.deepEqual(parseHostList(undefined), []);
});

test("hostMatches: exact host or subdomain, on a dot boundary", () => {
  assert.ok(hostMatches("portal.azure.com", "portal.azure.com"));
  assert.ok(hostMatches("x.reactblade.portal.azure.net", "portal.azure.net"));
  assert.ok(!hostMatches("evilportal.azure.com", "portal.azure.com"));
  assert.ok(!hostMatches("azure.com", "portal.azure.com"));
  assert.ok(!hostMatches("", "azure.com"));
});

test("downloadHosts: reads the creator host out of blob: URLs, plus the referrer", () => {
  assert.deepEqual(
    downloadHosts({
      url: "blob:https://sandbox-1.reactblade.portal.azure.net/0f1c-uuid",
      finalUrl: "blob:https://sandbox-1.reactblade.portal.azure.net/0f1c-uuid",
      referrer: "https://portal.azure.com/",
    }),
    ["sandbox-1.reactblade.portal.azure.net", "portal.azure.com"]
  );
  assert.deepEqual(downloadHosts({ url: "data:text/csv;base64,AAAA", referrer: "" }), []);
  assert.deepEqual(downloadHosts({ url: "https://api.example.com/f.xlsx" }), ["api.example.com"]);
});

test("passesHostFilter: empty filter passes everything; otherwise any host may match", () => {
  assert.ok(passesHostFilter([], []));
  assert.ok(passesHostFilter(["a.example.com"], []));
  assert.ok(passesHostFilter(["127.0.0.1", "portal.azure.com"], ["azure.com"]));
  assert.ok(!passesHostFilter(["127.0.0.1"], ["azure.com"]));
  assert.ok(!passesHostFilter([], ["azure.com"]));
});

test("isArmExpired: measured from the last activity; 0 minutes means never", () => {
  const armed = { armedAt: 0, lastActivityAt: 1_000_000 };
  assert.equal(isArmExpired(armed, 1_000_000 + 59 * 60_000, 60), false);
  assert.equal(isArmExpired(armed, 1_000_000 + 61 * 60_000, 60), true);
  assert.equal(isArmExpired(armed, 1_000_000 + 10_000 * 60_000, 0), false);
  assert.equal(isArmExpired(null, 5, 60), false);
});
