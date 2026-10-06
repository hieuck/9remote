// Regression: the daemon runtime cache was refreshed only by the DAEMON_VERSION number, so an
// upgrade that shipped a new ptyDaemon.js WITHOUT bumping the version left the old copy on
// disk forever. The host then spawned the stale daemon: a shipped bug fix silently never
// reached anyone who already had the cache directory, and updating the host looked like it
// worked because it did — just not for the terminal.
//
// isPrepared() only asked "does the file exist?", never "is it the file I would write today?".
//
// Run: node host/test/daemonCache.test.mjs
import assert from "node:assert/strict";
import { daemonCacheIsCurrent, fileFingerprint } from "../features/terminal/daemonCache.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-cache-"));
const SRC = path.join(ROOT, "src");
const DST = path.join(ROOT, "dst");
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(DST, { recursive: true });
const srcFile = path.join(SRC, "ptyDaemon.cjs");
const dstFile = path.join(DST, "ptyDaemon.cjs");

// A "stale cache" left by a previous install.
fs.writeFileSync(srcFile, "// v2 daemon with the scrollback fix\n");
fs.writeFileSync(dstFile, "// v1 daemon, from an older install\n");

console.log("\ndaemonCacheIsCurrent — a cache must match the source, not just exist");

test("fingerprints equal content, not just existence", () => {
  fs.writeFileSync(dstFile, fs.readFileSync(srcFile, "utf8"));
  assert.equal(fileFingerprint(srcFile), fileFingerprint(dstFile), "identical bytes must fingerprint equal");
  fs.writeFileSync(dstFile, "// v1 daemon, from an older install\n");
  assert.notEqual(fileFingerprint(srcFile), fileFingerprint(dstFile), "different bytes must differ");
});

test("a stale cache is reported as NOT current", () => {
  assert.equal(
    daemonCacheIsCurrent(srcFile, dstFile),
    false,
    "cache holds older code but exists — this is the bug: reported as prepared"
  );
});

test("a cache matching the source is current", () => {
  fs.writeFileSync(dstFile, fs.readFileSync(srcFile, "utf8"));
  assert.equal(daemonCacheIsCurrent(srcFile, dstFile), true);
});

test("a missing destination is not current (caller must copy)", () => {
  const missing = path.join(DST, "never-copied.cjs");
  assert.equal(daemonCacheIsCurrent(srcFile, missing), false);
});

test("a missing SOURCE is never 'current' — do not delete a good cache for it", () => {
  const gone = path.join(SRC, "not-here.cjs");
  assert.equal(daemonCacheIsCurrent(gone, dstFile), false);
});

test("an unreadable/undefined path is false, not a throw", () => {
  assert.equal(daemonCacheIsCurrent(undefined, dstFile), false);
  assert.equal(daemonCacheIsCurrent(srcFile, undefined), false);
  assert.equal(daemonCacheIsCurrent(srcFile, 12345), false);
});

test("an empty source file matches an empty destination (both legitimately empty)", () => {
  const a = path.join(SRC, "empty-a.js");
  const b = path.join(DST, "empty-b.js");
  fs.writeFileSync(a, "");
  fs.writeFileSync(b, "");
  assert.equal(daemonCacheIsCurrent(a, b), true);
});

test("a truncated destination is caught (partial copy from a killed upgrade)", () => {
  fs.writeFileSync(srcFile, "// full content here\n");
  fs.writeFileSync(dstFile, "// full");
  assert.equal(daemonCacheIsCurrent(srcFile, dstFile), false, "a half-copied file must not pass as current");
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);