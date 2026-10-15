// Build the Chrome Web Store upload zips from this folder:
//
//   dist/ioc-lookup-capture-<version>-cws.zip              all three capture backends
//   dist/ioc-lookup-capture-<version>-cws-no-debugger.zip  without the `debugger` permission
//
// The two differ only in manifest.json: the no-debugger build drops
// "debugger" from `permissions`. Everything else adapts at runtime (see
// common/backends.js and the "A build without debugger" section of the
// README). bg/fullPageCapture.js is still included in that build because
// bg/runner.js imports it statically (MV3 service workers can't use dynamic
// import()); without the permission it is never called.
//
// Plain Node, no dependencies: writes standard deflate zips itself.
//
//   npm run package

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

// Exactly what the extension needs at runtime — no docs, tests or tooling.
const TOP_LEVEL_FILES = [
  "manifest.json",
  "background.js",
  "offscreen.html",
  "offscreen.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "options.html",
  "options.css",
  "options.js",
];
const DIRECTORIES = ["bg", "common", "icons"];

function listFiles() {
  const files = [...TOP_LEVEL_FILES];
  for (const dir of DIRECTORIES) {
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(childRel);
        else if (entry.isFile()) files.push(childRel);
      }
    };
    walk(dir);
  }
  return files.sort();
}

// --- Minimal zip writer -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** @param {Array<{ name: string, data: Buffer }>} entries */
function buildZip(entries, when = new Date()) {
  const { time, day } = dosDateTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra len, comment len, disk start, internal attrs, external attrs: all 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// --- Build both variants ------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
if (!manifest.permissions.includes("debugger")) {
  throw new Error("manifest.json has no `debugger` permission; this script expects the full build as its source.");
}

const variants = [
  { suffix: "cws", manifest },
  {
    suffix: "cws-no-debugger",
    manifest: { ...manifest, permissions: manifest.permissions.filter((p) => p !== "debugger") },
  },
];

fs.mkdirSync(DIST, { recursive: true });
const files = listFiles();
for (const variant of variants) {
  const entries = files.map((name) => ({
    name,
    data:
      name === "manifest.json"
        ? Buffer.from(JSON.stringify(variant.manifest, null, 2) + "\n", "utf8")
        : fs.readFileSync(path.join(ROOT, name)),
  }));
  const out = path.join(DIST, `ioc-lookup-capture-${manifest.version}-${variant.suffix}.zip`);
  fs.writeFileSync(out, buildZip(entries));
  console.log(`${path.relative(ROOT, out)}  (${entries.length} files; permissions: ${variant.manifest.permissions.join(", ")})`);
}
