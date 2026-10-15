import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKEND_IDS,
  BACKEND_LABELS,
  describeMissing,
  needsRuntimePermissions,
  resolveBackend,
  runtimePermissionsFor,
} from "../common/backends.js";

test("every backend id has a label", () => {
  for (const id of BACKEND_IDS) assert.ok(BACKEND_LABELS[id], `missing label for ${id}`);
});

test("runtimePermissionsFor: fullpage needs nothing at runtime", () => {
  assert.deepEqual(runtimePermissionsFor("fullpage"), { permissions: [], origins: [] });
  assert.equal(needsRuntimePermissions("fullpage"), false);
});

test("runtimePermissionsFor: viewport needs only <all_urls>", () => {
  assert.deepEqual(runtimePermissionsFor("viewport"), { permissions: [], origins: ["<all_urls>"] });
  assert.equal(needsRuntimePermissions("viewport"), true);
});

test("runtimePermissionsFor: stitched needs <all_urls> and scripting", () => {
  assert.deepEqual(runtimePermissionsFor("stitched"), {
    permissions: ["scripting"],
    origins: ["<all_urls>"],
  });
});

test("runtimePermissionsFor returns a copy, not the shared table", () => {
  const p = runtimePermissionsFor("stitched");
  p.permissions.push("tampered");
  assert.deepEqual(runtimePermissionsFor("stitched").permissions, ["scripting"]);
});

test("resolveBackend: saved choice is kept when the debugger is available", () => {
  for (const id of BACKEND_IDS) {
    assert.equal(resolveBackend(id, { debuggerAvailable: true }), id);
  }
});

test("resolveBackend: fullpage falls back to stitched in a build without debugger", () => {
  assert.equal(resolveBackend("fullpage", { debuggerAvailable: false }), "stitched");
  assert.equal(resolveBackend("viewport", { debuggerAvailable: false }), "viewport");
  assert.equal(resolveBackend("stitched", { debuggerAvailable: false }), "stitched");
});

test("resolveBackend: unknown or missing values behave like the default", () => {
  assert.equal(resolveBackend(undefined, { debuggerAvailable: true }), "fullpage");
  assert.equal(resolveBackend("bogus", { debuggerAvailable: true }), "fullpage");
  assert.equal(resolveBackend("bogus", { debuggerAvailable: false }), "stitched");
});

test("describeMissing names each missing permission", () => {
  assert.equal(
    describeMissing({ permissions: ["scripting"], origins: ["<all_urls>"] }),
    '"All sites" (<all_urls>) and scripting'
  );
  assert.equal(describeMissing({ permissions: ["scripting"], origins: [] }), "scripting");
  assert.equal(describeMissing({ permissions: [], origins: ["<all_urls>"] }), '"All sites" (<all_urls>)');
});
