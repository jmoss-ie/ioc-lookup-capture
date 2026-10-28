import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CODE_VERSION } from "../common/version.js";

test("CODE_VERSION matches manifest.json (the pages' out-of-date check compares the two)", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(CODE_VERSION, manifest.version);
});
