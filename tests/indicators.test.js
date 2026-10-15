import test from "node:test";
import assert from "node:assert/strict";
import { refang } from "../common/refang.js";
import { classifyIndicator, parseIndicators } from "../common/indicators.js";

test("refang: scheme and dot/colon/at variants", () => {
  assert.equal(refang("hxxp://evil[.]com"), "http://evil.com");
  assert.equal(refang("hxxps://evil[.]com"), "https://evil.com");
  assert.equal(refang("evil(.)com"), "evil.com");
  assert.equal(refang("evil[dot]com"), "evil.com");
  assert.equal(refang("1[.]2[.]3[.]4"), "1.2.3.4");
  assert.equal(refang("evil[.]com[:]8080"), "evil.com:8080");
  assert.equal(refang("user[@]evil[.]com"), "user@evil.com");
  assert.equal(refang("user[at]evil[.]com"), "user@evil.com");
  assert.equal(refang("HXXPS://EVIL[.]COM"), "https://EVIL.COM");
});

test("refang: hxxps handled before hxxp", () => {
  assert.equal(refang("hxxps"), "https");
});

test("classify: IPv4 valid and invalid", () => {
  assert.equal(classifyIndicator("1.2.3.4").kind, "ipv4");
  assert.equal(classifyIndicator("255.255.255.255").kind, "ipv4");
  assert.equal(classifyIndicator("999.1.1.1").valid, false);
  assert.equal(classifyIndicator("192.168.01.1").valid, false); // leading zero ambiguity
  assert.equal(classifyIndicator("1.2.3").valid, false);
  assert.equal(classifyIndicator("1.2.3.4.5").valid, false);
});

test("classify: IPv6 valid and invalid", () => {
  assert.equal(classifyIndicator("2001:db8::1").kind, "ipv6");
  assert.equal(classifyIndicator("::1").kind, "ipv6");
  assert.equal(classifyIndicator("::ffff:192.168.1.1").kind, "ipv6");
  assert.equal(classifyIndicator("2001:0db8:0000:0000:0000:0000:0000:0001").kind, "ipv6");
  assert.equal(classifyIndicator("2001::db8::1").valid, false); // double "::"
  assert.equal(classifyIndicator("gggg::1").valid, false);
});

test("classify: domain", () => {
  assert.equal(classifyIndicator("evil.com").kind, "domain");
  assert.equal(classifyIndicator("sub.evil.co.uk").kind, "domain");
});

test("classify: bad domain leading hyphen rejected", () => {
  const r = classifyIndicator("-bad-.com");
  assert.equal(r.valid, false);
});

test("classify: host with path or port is a URL, not domain/ip", () => {
  assert.equal(classifyIndicator("evil.com/pay.php").kind, "url");
  assert.equal(classifyIndicator("evil.com:8080").kind, "url");
  assert.equal(classifyIndicator("1.2.3.4/admin").kind, "url");
  assert.equal(classifyIndicator("1.2.3.4:8080").kind, "url");
});

test("classify: full URL with scheme", () => {
  const r = classifyIndicator("https://evil.com/a/b?x=1");
  assert.equal(r.kind, "url");
  assert.equal(r.host, "evil.com");
});

test("classify: hashes by length", () => {
  assert.equal(classifyIndicator("d41d8cd98f00b204e9800998ecf8427e").kind, "hash"); // md5 32
  assert.equal(classifyIndicator("da39a3ee5e6b4b0d3255bfef95601890afd80709").kind, "hash"); // sha1 40
  assert.equal(
    classifyIndicator("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855").kind,
    "hash"
  ); // sha256 64
});

test("classify: unrecognized", () => {
  assert.equal(classifyIndicator("not an indicator!!").valid, false);
});

test("parseIndicators: split, refang, dedupe, order preserved", () => {
  const input = "evil.com\nEVIL.COM, 1.2.3.4; hxxp://bad[.]net\nevil.com";
  const parsed = parseIndicators(input);
  assert.equal(parsed.length, 3); // "evil.com" and "EVIL.COM" dedupe (case-insensitive refanged key)
  assert.equal(parsed[0].refanged, "evil.com");
  assert.equal(parsed[1].kind, "ipv4");
  assert.equal(parsed[2].kind, "url");
});

test("parseIndicators: reports rejects alongside accepts", () => {
  const parsed = parseIndicators("evil.com\n999.1.1.1\ngarbage!!!");
  const rejected = parsed.filter((p) => !p.valid);
  assert.equal(rejected.length, 2);
});
