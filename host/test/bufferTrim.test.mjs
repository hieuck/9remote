// Tests for the append-and-trim budget on the terminal scrollback buffer.
//
// The shipped onData handler did this per chunk:
//   const size = buffer.reduce((s, c) => s + c.length, 0);      // O(chunks) re-walk
//   if (size > MAX) buffer = [takeBufferTail(buffer, MAX)];     // trims back to exactly MAX
// takeBufferTail returns exactly MAX bytes, so the NEXT chunk pushed the total over the
// limit again: the trim — a full MAX-sized Buffer.concat — re-ran on 100% of chunks, and
// the reduce re-walked the array every time. Measured cost: ~4100ms of CPU per 1MB of
// terminal output, i.e. the daemon pegs a core and never drains while an agent streams.
//
// Covered here: the running total never drifts from the array, the trim amortizes instead of
// firing per chunk, the trim keeps the TAIL (a wrong slice paints corrupted terminal content),
// and scrollback stays close to the full budget rather than collapsing.
//
// Run: node host/test/bufferTrim.test.mjs
import assert from "node:assert/strict";
import * as slice from "../features/terminal/bufferSlice.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const MAX = 2 * 1024 * 1024;
const CHUNK = 178;            // ConPTY on Windows hands out chunks this small
const actual = (chunks) => chunks.reduce((s, c) => s + c.length, 0);
const joined = (chunks) => Buffer.concat(chunks).toString("utf-8");

// Drive `appendChunk` the way onData does, returning what the test needs to assert on.
function drive({ chunks, count, chunkSize = CHUNK, high = MAX, low }) {
  let trims = 0;
  let buf = chunks;
  let total = buf ? slice.bufferTotal(buf) : 0;
  const chunk = Buffer.alloc(chunkSize, 0x42);
  const snapshotEvery = count / 4;
  const snapshots = [];
  for (let i = 0; i < count; i++) {
    if (i % snapshotEvery === 0) snapshots.push({ i, buf, total });
    const before = buf;
    [buf, total] = slice.appendChunk(buf, total, chunk, high, low);
    if (buf !== before) trims++;
    // The invariant that matters most: the carried count describes the array it came with.
    assert.equal(total, actual(buf), `running total drifted at chunk ${i}`);
  }
  return { trims, buf, total };
}

console.log("\nappendChunk — scrollback byte budget");

test("is exported from bufferSlice", () => {
  assert.equal(typeof slice.appendChunk, "function");
});

test("appends and reports a running total with no trim under budget", () => {
  const chunk = Buffer.from("hello", "utf-8");
  let buf, total;
  [buf, total] = slice.appendChunk([], 0, chunk, MAX);
  assert.equal(total, 5);
  [buf, total] = slice.appendChunk(buf, total, Buffer.from(" world"), MAX);
  assert.equal(total, 11);
  assert.equal(joined(buf), "hello world");
});

test("extends the given array in place so the hot path stays O(1) in the chunk count", () => {
  const seed = [Buffer.from("abc")];
  const [buf, total] = slice.appendChunk(seed, 3, Buffer.from("d"), MAX);
  assert.equal(buf, seed, "no-trim path must reuse the array, not copy it per chunk");
  assert.equal(total, 4);
});

test("trims once the budget is passed and keeps total within budget", () => {
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  let buf = [], total = 0;
  for (let i = 0; i < 64; i++) [buf, total] = slice.appendChunk(buf, total, chunk, 256 * 1024);
  assert.ok(total <= 256 * 1024, `total ${total} exceeded budget`);
  assert.ok(total > 0, "trim must not empty the buffer");
});

test("REGRESSION: trims amortize once the buffer is full instead of firing per chunk", () => {
  // Seed a full buffer — the state every long-lived session is permanently in.
  const seed = [];
  for (let i = 0; i < Math.floor(MAX / CHUNK); i++) seed.push(Buffer.alloc(CHUNK, 0x41));
  const count = 4000;
  const { trims } = drive({ chunks: seed, count });
  assert.ok(
    trims < count / 100,
    `trim ran ${trims}/${count} times — the concat re-arms on every chunk again`
  );
});

test("a full buffer stays cheap to append to for many chunks", () => {
  const seed = [];
  for (let i = 0; i < Math.floor(MAX / CHUNK); i++) seed.push(Buffer.alloc(CHUNK, 0x41));
  const { total } = drive({ chunks: seed, count: 2000 });
  assert.ok(total <= MAX, `total ${total} must never exceed the budget`);
});

test("trim keeps the TAIL — content is dropped from the front, never corrupted", () => {
  const marks = [];
  let buf = [], total = 0;
  for (let i = 0; i < 400; i++) {
    const chunk = Buffer.from(`[${i}]`, "utf-8");
    [buf, total] = slice.appendChunk(buf, total, chunk, 4096);
    marks.push(i);
  }
  const kept = joined(buf);
  const full = marks.map((i) => `[${i}]`).join("");
  assert.ok(kept.length > 0, "buffer must not be empty");
  // A trim may cut into the oldest surviving chunk, so the invariant is "suffix", not
  // "aligned": whatever is kept must appear verbatim at the end of the stream.
  assert.ok(full.endsWith(kept), "kept content is not an untouched suffix of the stream");
  assert.ok(kept.endsWith("[399]"), "the newest output must always survive");
});

test("scrollback stays close to the full budget after a trim", () => {
  const seed = [];
  for (let i = 0; i < Math.floor(MAX / CHUNK); i++) seed.push(Buffer.alloc(CHUNK, 0x41));
  const { buf } = drive({ chunks: seed, count: 5000 });
  const kept = actual(buf);
  assert.ok(
    kept >= MAX * 0.85,
    `scrollback collapsed to ${(kept / 1048576).toFixed(2)}MB — low-water mark is too aggressive`
  );
});

test("ESC alignment may drop bytes but never invents them", () => {
  // takeBufferTail skips forward to the next ESC; the tail must remain a real slice of the
  // stream (a subsequence of the original bytes), never reordered or padded.
  const body = "A".repeat(300);
  const esc = Buffer.from("\x1b[31mB\x1b[0m", "utf-8");
  let buf = [], total = 0;
  for (let i = 0; i < 60; i++) [buf, total] = slice.appendChunk(buf, total, Buffer.from(body), 2048);
  [buf, total] = slice.appendChunk(buf, total, esc, 2048);
  const out = joined(buf);
  assert.equal(total, actual(buf));
  assert.ok(out.endsWith("\x1b[31mB\x1b[0m"), "ESC sequence at the end must survive intact");
  assert.ok(!out.includes("\x1b[31mB\x1b[0m\x1b[31mB"), "content must not be duplicated");
});

test("ignores a low-water mark that is not below the budget", () => {
  const chunk = Buffer.alloc(1024, 0x41);
  let buf = [], total = 0;
  // low >= high would re-arm the trim every chunk, so the helper must refuse it.
  for (let i = 0; i < 400; i++) [buf, total] = slice.appendChunk(buf, total, chunk, 8192, 8192);
  assert.ok(total <= 8192, `total ${total} exceeded budget`);
  assert.equal(buf.length <= 64, true, "trim must collapse the array, not grow it forever");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);