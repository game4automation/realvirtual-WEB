// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-id-seed.mjs — the deterministic NodeId of a node that arrives without
 * one (plan-769 F2/F7, rv-ODT §5a).
 *
 * Unity exports carry no ids. The viewer gives every such node, on load and in
 * memory only, `UUIDv5(RV_NODE_ID_NAMESPACE, <canonical authored path>)`: the same
 * bytes give the same ids in every session, in the browser and in the Node
 * scripts, and an unchanged Unity re-export gives the same ids again (D2/D3).
 *
 * Deliberately WITHOUT imports and without Node or DOM APIs beyond
 * `TextEncoder` (both have it): the browser bundle, the Node scripts and both
 * test runners load this very file (pattern of `rv-node-path-rewrite.mjs`).
 * Synchronous on purpose — `crypto.subtle` is async and Node's `crypto` is not
 * in the browser — so SHA-1 is implemented here and pinned by external vectors
 * (FIPS 180 SHA-1, RFC 9562 §A.4 and Python `uuid5` UUIDv5 values) plus a
 * comparison against `node:crypto` (`tests/node-id-seed.node.test.ts`).
 *
 * ## Canonical authored path (normative)
 *
 * Built from `json.nodes[].name` — the AUTHORED names, never the loader's
 * (GLTFLoader sanitizes and de-duplicates, and an extras `name` overrides
 * `userData.name`). Only the scene `json.scene ?? 0` is walked; its root nodes
 * are the first segments (the scene itself is the model root, path `''`).
 * Per segment:
 *  - `\` → `\\`, `/` → `\/`, `[` → `\[`, and a LEADING `#` → `\#`;
 *  - the k-th (k ≥ 1, counted in glTF child order) of several siblings with the
 *    SAME raw name gets `[k]` appended (`Pin`, `Pin[1]`, `Pin[2]`); a node
 *    literally named `Pin[1]` is `Pin\[1]` — no collision;
 *  - an empty (or missing) name is `#<index in its parent's child list>`.
 * The escapes make every canonical path of a file unique, so the seeds of one
 * file can collide only with ids the file already carries.
 *
 * The leading-`#` escape is a plan-769 Phase-0 addition to the plan's §2.3 rule:
 * without it a node literally named `#0` and an unnamed sibling at index 0 would
 * share the path `#0`.
 *
 * ## Seed algorithm (normative, two passes)
 *
 * {@link seedNodeIdsForFile}: pass 1 reserves every `NodeId` the file carries;
 * pass 2 walks the nodes WITHOUT one in ascending glTF node index and takes
 * `seedNodeId(path)`, or — when that id is taken — the smallest n ≥ 1 for which
 * `seedNodeId(path + '\u0000' + n)` is free. Every such retry is a reported
 * collision. The result never depends on processing order.
 */

/** UUIDv5(NAMESPACE_URL, 'https://realvirtual.io/rv-odt/node-id') — fixed forever (rv-ODT §5a). */
export const RV_NODE_ID_NAMESPACE = '7ca1fd38-357d-572c-ae1e-dc902c5ea089';

/** The RFC 9562 URL namespace the rv namespace above is derived from (documentation + test). */
export const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** Canonical path of the model root (the glTF scene itself). */
export const ROOT_CANONICAL_PATH = '';

// ─── SHA-1 (FIPS 180-4), synchronous, reused buffers ────────────────────

const H = new Int32Array(5);
const encoder = new TextEncoder();
/** Message buffer of the string API; its length stays a multiple of 64 (the Int32 view). */
let msg = new Uint8Array(1024);
let msg32 = new Int32Array(msg.buffer);

/** The SHA-1 initial state (FIPS 180-4 §5.3.1). */
const H0 = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]);

/** Blocks are read as 32-bit words through an Int32 view: big-endian words need a swap here. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** A byte length rounded up to whole 64-byte blocks. */
const blocksOf = (n) => ((n + 63) >>> 6) << 6;

/**
 * One SHA-1 block — the 16 words `b32[at..at+16)` (an Int32 view of the message
 * bytes, `at` = byte offset / 4, block-aligned) — onto the state words
 * `st[so..so+5)`. THE compression function: the string API ({@link sha1Hex},
 * {@link uuidV5}) and the bulk seed ({@link seedNodeIdsForFile}) both run it.
 *
 * Unrolled on purpose (plan-769 9.15: the seed is on every decode, and V8 runs
 * the 80 rounds over sixteen locals ~2x faster than over a W[80] loop): the five
 * working variables change roles per round instead of being shifted, the message
 * schedule is the 16-word ring, and every sum is truncated pairwise so it stays
 * 32-bit integer arithmetic.
 */
function compress(b32, at, st, so) {
  let w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13, w14, w15;
  if (LITTLE_ENDIAN) {
    w0 = b32[at + 0]; w0 = (w0 << 24) | ((w0 & 0xff00) << 8) | ((w0 >>> 8) & 0xff00) | (w0 >>> 24);
    w1 = b32[at + 1]; w1 = (w1 << 24) | ((w1 & 0xff00) << 8) | ((w1 >>> 8) & 0xff00) | (w1 >>> 24);
    w2 = b32[at + 2]; w2 = (w2 << 24) | ((w2 & 0xff00) << 8) | ((w2 >>> 8) & 0xff00) | (w2 >>> 24);
    w3 = b32[at + 3]; w3 = (w3 << 24) | ((w3 & 0xff00) << 8) | ((w3 >>> 8) & 0xff00) | (w3 >>> 24);
    w4 = b32[at + 4]; w4 = (w4 << 24) | ((w4 & 0xff00) << 8) | ((w4 >>> 8) & 0xff00) | (w4 >>> 24);
    w5 = b32[at + 5]; w5 = (w5 << 24) | ((w5 & 0xff00) << 8) | ((w5 >>> 8) & 0xff00) | (w5 >>> 24);
    w6 = b32[at + 6]; w6 = (w6 << 24) | ((w6 & 0xff00) << 8) | ((w6 >>> 8) & 0xff00) | (w6 >>> 24);
    w7 = b32[at + 7]; w7 = (w7 << 24) | ((w7 & 0xff00) << 8) | ((w7 >>> 8) & 0xff00) | (w7 >>> 24);
    w8 = b32[at + 8]; w8 = (w8 << 24) | ((w8 & 0xff00) << 8) | ((w8 >>> 8) & 0xff00) | (w8 >>> 24);
    w9 = b32[at + 9]; w9 = (w9 << 24) | ((w9 & 0xff00) << 8) | ((w9 >>> 8) & 0xff00) | (w9 >>> 24);
    w10 = b32[at + 10]; w10 = (w10 << 24) | ((w10 & 0xff00) << 8) | ((w10 >>> 8) & 0xff00) | (w10 >>> 24);
    w11 = b32[at + 11]; w11 = (w11 << 24) | ((w11 & 0xff00) << 8) | ((w11 >>> 8) & 0xff00) | (w11 >>> 24);
    w12 = b32[at + 12]; w12 = (w12 << 24) | ((w12 & 0xff00) << 8) | ((w12 >>> 8) & 0xff00) | (w12 >>> 24);
    w13 = b32[at + 13]; w13 = (w13 << 24) | ((w13 & 0xff00) << 8) | ((w13 >>> 8) & 0xff00) | (w13 >>> 24);
    w14 = b32[at + 14]; w14 = (w14 << 24) | ((w14 & 0xff00) << 8) | ((w14 >>> 8) & 0xff00) | (w14 >>> 24);
    w15 = b32[at + 15]; w15 = (w15 << 24) | ((w15 & 0xff00) << 8) | ((w15 >>> 8) & 0xff00) | (w15 >>> 24);
  } else {
    w0 = b32[at]; w1 = b32[at + 1]; w2 = b32[at + 2]; w3 = b32[at + 3]; w4 = b32[at + 4]; w5 = b32[at + 5]; w6 = b32[at + 6]; w7 = b32[at + 7];
    w8 = b32[at + 8]; w9 = b32[at + 9]; w10 = b32[at + 10]; w11 = b32[at + 11]; w12 = b32[at + 12]; w13 = b32[at + 13]; w14 = b32[at + 14]; w15 = b32[at + 15];
  }
  let a = st[so], b = st[so + 1], c = st[so + 2], d = st[so + 3], e = st[so + 4], x = 0;
  // rounds 0..19
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (~b & d))) | 0) + ((e + w0) | 0) | 0) + 0x5a827999) | 0; b = (b << 30) | (b >>> 2);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (~a & c))) | 0) + ((d + w1) | 0) | 0) + 0x5a827999) | 0; a = (a << 30) | (a >>> 2);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (~e & b))) | 0) + ((c + w2) | 0) | 0) + 0x5a827999) | 0; e = (e << 30) | (e >>> 2);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (~d & a))) | 0) + ((b + w3) | 0) | 0) + 0x5a827999) | 0; d = (d << 30) | (d >>> 2);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (~c & e))) | 0) + ((a + w4) | 0) | 0) + 0x5a827999) | 0; c = (c << 30) | (c >>> 2);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (~b & d))) | 0) + ((e + w5) | 0) | 0) + 0x5a827999) | 0; b = (b << 30) | (b >>> 2);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (~a & c))) | 0) + ((d + w6) | 0) | 0) + 0x5a827999) | 0; a = (a << 30) | (a >>> 2);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (~e & b))) | 0) + ((c + w7) | 0) | 0) + 0x5a827999) | 0; e = (e << 30) | (e >>> 2);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (~d & a))) | 0) + ((b + w8) | 0) | 0) + 0x5a827999) | 0; d = (d << 30) | (d >>> 2);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (~c & e))) | 0) + ((a + w9) | 0) | 0) + 0x5a827999) | 0; c = (c << 30) | (c >>> 2);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (~b & d))) | 0) + ((e + w10) | 0) | 0) + 0x5a827999) | 0; b = (b << 30) | (b >>> 2);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (~a & c))) | 0) + ((d + w11) | 0) | 0) + 0x5a827999) | 0; a = (a << 30) | (a >>> 2);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (~e & b))) | 0) + ((c + w12) | 0) | 0) + 0x5a827999) | 0; e = (e << 30) | (e >>> 2);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (~d & a))) | 0) + ((b + w13) | 0) | 0) + 0x5a827999) | 0; d = (d << 30) | (d >>> 2);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (~c & e))) | 0) + ((a + w14) | 0) | 0) + 0x5a827999) | 0; c = (c << 30) | (c >>> 2);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (~b & d))) | 0) + ((e + w15) | 0) | 0) + 0x5a827999) | 0; b = (b << 30) | (b >>> 2);
  x = w13 ^ w8 ^ w2 ^ w0; w0 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (~a & c))) | 0) + ((d + w0) | 0) | 0) + 0x5a827999) | 0; a = (a << 30) | (a >>> 2);
  x = w14 ^ w9 ^ w3 ^ w1; w1 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (~e & b))) | 0) + ((c + w1) | 0) | 0) + 0x5a827999) | 0; e = (e << 30) | (e >>> 2);
  x = w15 ^ w10 ^ w4 ^ w2; w2 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (~d & a))) | 0) + ((b + w2) | 0) | 0) + 0x5a827999) | 0; d = (d << 30) | (d >>> 2);
  x = w0 ^ w11 ^ w5 ^ w3; w3 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (~c & e))) | 0) + ((a + w3) | 0) | 0) + 0x5a827999) | 0; c = (c << 30) | (c >>> 2);
  // rounds 20..39
  x = w1 ^ w12 ^ w6 ^ w4; w4 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w4) | 0) | 0) + 0x6ed9eba1) | 0; b = (b << 30) | (b >>> 2);
  x = w2 ^ w13 ^ w7 ^ w5; w5 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w5) | 0) | 0) + 0x6ed9eba1) | 0; a = (a << 30) | (a >>> 2);
  x = w3 ^ w14 ^ w8 ^ w6; w6 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w6) | 0) | 0) + 0x6ed9eba1) | 0; e = (e << 30) | (e >>> 2);
  x = w4 ^ w15 ^ w9 ^ w7; w7 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w7) | 0) | 0) + 0x6ed9eba1) | 0; d = (d << 30) | (d >>> 2);
  x = w5 ^ w0 ^ w10 ^ w8; w8 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w8) | 0) | 0) + 0x6ed9eba1) | 0; c = (c << 30) | (c >>> 2);
  x = w6 ^ w1 ^ w11 ^ w9; w9 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w9) | 0) | 0) + 0x6ed9eba1) | 0; b = (b << 30) | (b >>> 2);
  x = w7 ^ w2 ^ w12 ^ w10; w10 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w10) | 0) | 0) + 0x6ed9eba1) | 0; a = (a << 30) | (a >>> 2);
  x = w8 ^ w3 ^ w13 ^ w11; w11 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w11) | 0) | 0) + 0x6ed9eba1) | 0; e = (e << 30) | (e >>> 2);
  x = w9 ^ w4 ^ w14 ^ w12; w12 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w12) | 0) | 0) + 0x6ed9eba1) | 0; d = (d << 30) | (d >>> 2);
  x = w10 ^ w5 ^ w15 ^ w13; w13 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w13) | 0) | 0) + 0x6ed9eba1) | 0; c = (c << 30) | (c >>> 2);
  x = w11 ^ w6 ^ w0 ^ w14; w14 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w14) | 0) | 0) + 0x6ed9eba1) | 0; b = (b << 30) | (b >>> 2);
  x = w12 ^ w7 ^ w1 ^ w15; w15 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w15) | 0) | 0) + 0x6ed9eba1) | 0; a = (a << 30) | (a >>> 2);
  x = w13 ^ w8 ^ w2 ^ w0; w0 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w0) | 0) | 0) + 0x6ed9eba1) | 0; e = (e << 30) | (e >>> 2);
  x = w14 ^ w9 ^ w3 ^ w1; w1 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w1) | 0) | 0) + 0x6ed9eba1) | 0; d = (d << 30) | (d >>> 2);
  x = w15 ^ w10 ^ w4 ^ w2; w2 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w2) | 0) | 0) + 0x6ed9eba1) | 0; c = (c << 30) | (c >>> 2);
  x = w0 ^ w11 ^ w5 ^ w3; w3 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w3) | 0) | 0) + 0x6ed9eba1) | 0; b = (b << 30) | (b >>> 2);
  x = w1 ^ w12 ^ w6 ^ w4; w4 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w4) | 0) | 0) + 0x6ed9eba1) | 0; a = (a << 30) | (a >>> 2);
  x = w2 ^ w13 ^ w7 ^ w5; w5 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w5) | 0) | 0) + 0x6ed9eba1) | 0; e = (e << 30) | (e >>> 2);
  x = w3 ^ w14 ^ w8 ^ w6; w6 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w6) | 0) | 0) + 0x6ed9eba1) | 0; d = (d << 30) | (d >>> 2);
  x = w4 ^ w15 ^ w9 ^ w7; w7 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w7) | 0) | 0) + 0x6ed9eba1) | 0; c = (c << 30) | (c >>> 2);
  // rounds 40..59
  x = w5 ^ w0 ^ w10 ^ w8; w8 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d))) | 0) + ((e + w8) | 0) | 0) + -0x70e44324) | 0; b = (b << 30) | (b >>> 2);
  x = w6 ^ w1 ^ w11 ^ w9; w9 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (a & c) | (b & c))) | 0) + ((d + w9) | 0) | 0) + -0x70e44324) | 0; a = (a << 30) | (a >>> 2);
  x = w7 ^ w2 ^ w12 ^ w10; w10 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (e & b) | (a & b))) | 0) + ((c + w10) | 0) | 0) + -0x70e44324) | 0; e = (e << 30) | (e >>> 2);
  x = w8 ^ w3 ^ w13 ^ w11; w11 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (d & a) | (e & a))) | 0) + ((b + w11) | 0) | 0) + -0x70e44324) | 0; d = (d << 30) | (d >>> 2);
  x = w9 ^ w4 ^ w14 ^ w12; w12 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (c & e) | (d & e))) | 0) + ((a + w12) | 0) | 0) + -0x70e44324) | 0; c = (c << 30) | (c >>> 2);
  x = w10 ^ w5 ^ w15 ^ w13; w13 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d))) | 0) + ((e + w13) | 0) | 0) + -0x70e44324) | 0; b = (b << 30) | (b >>> 2);
  x = w11 ^ w6 ^ w0 ^ w14; w14 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (a & c) | (b & c))) | 0) + ((d + w14) | 0) | 0) + -0x70e44324) | 0; a = (a << 30) | (a >>> 2);
  x = w12 ^ w7 ^ w1 ^ w15; w15 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (e & b) | (a & b))) | 0) + ((c + w15) | 0) | 0) + -0x70e44324) | 0; e = (e << 30) | (e >>> 2);
  x = w13 ^ w8 ^ w2 ^ w0; w0 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (d & a) | (e & a))) | 0) + ((b + w0) | 0) | 0) + -0x70e44324) | 0; d = (d << 30) | (d >>> 2);
  x = w14 ^ w9 ^ w3 ^ w1; w1 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (c & e) | (d & e))) | 0) + ((a + w1) | 0) | 0) + -0x70e44324) | 0; c = (c << 30) | (c >>> 2);
  x = w15 ^ w10 ^ w4 ^ w2; w2 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d))) | 0) + ((e + w2) | 0) | 0) + -0x70e44324) | 0; b = (b << 30) | (b >>> 2);
  x = w0 ^ w11 ^ w5 ^ w3; w3 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (a & c) | (b & c))) | 0) + ((d + w3) | 0) | 0) + -0x70e44324) | 0; a = (a << 30) | (a >>> 2);
  x = w1 ^ w12 ^ w6 ^ w4; w4 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (e & b) | (a & b))) | 0) + ((c + w4) | 0) | 0) + -0x70e44324) | 0; e = (e << 30) | (e >>> 2);
  x = w2 ^ w13 ^ w7 ^ w5; w5 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (d & a) | (e & a))) | 0) + ((b + w5) | 0) | 0) + -0x70e44324) | 0; d = (d << 30) | (d >>> 2);
  x = w3 ^ w14 ^ w8 ^ w6; w6 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (c & e) | (d & e))) | 0) + ((a + w6) | 0) | 0) + -0x70e44324) | 0; c = (c << 30) | (c >>> 2);
  x = w4 ^ w15 ^ w9 ^ w7; w7 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d))) | 0) + ((e + w7) | 0) | 0) + -0x70e44324) | 0; b = (b << 30) | (b >>> 2);
  x = w5 ^ w0 ^ w10 ^ w8; w8 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + ((a & b) | (a & c) | (b & c))) | 0) + ((d + w8) | 0) | 0) + -0x70e44324) | 0; a = (a << 30) | (a >>> 2);
  x = w6 ^ w1 ^ w11 ^ w9; w9 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + ((e & a) | (e & b) | (a & b))) | 0) + ((c + w9) | 0) | 0) + -0x70e44324) | 0; e = (e << 30) | (e >>> 2);
  x = w7 ^ w2 ^ w12 ^ w10; w10 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + ((d & e) | (d & a) | (e & a))) | 0) + ((b + w10) | 0) | 0) + -0x70e44324) | 0; d = (d << 30) | (d >>> 2);
  x = w8 ^ w3 ^ w13 ^ w11; w11 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + ((c & d) | (c & e) | (d & e))) | 0) + ((a + w11) | 0) | 0) + -0x70e44324) | 0; c = (c << 30) | (c >>> 2);
  // rounds 60..79
  x = w9 ^ w4 ^ w14 ^ w12; w12 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w12) | 0) | 0) + -0x359d3e2a) | 0; b = (b << 30) | (b >>> 2);
  x = w10 ^ w5 ^ w15 ^ w13; w13 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w13) | 0) | 0) + -0x359d3e2a) | 0; a = (a << 30) | (a >>> 2);
  x = w11 ^ w6 ^ w0 ^ w14; w14 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w14) | 0) | 0) + -0x359d3e2a) | 0; e = (e << 30) | (e >>> 2);
  x = w12 ^ w7 ^ w1 ^ w15; w15 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w15) | 0) | 0) + -0x359d3e2a) | 0; d = (d << 30) | (d >>> 2);
  x = w13 ^ w8 ^ w2 ^ w0; w0 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w0) | 0) | 0) + -0x359d3e2a) | 0; c = (c << 30) | (c >>> 2);
  x = w14 ^ w9 ^ w3 ^ w1; w1 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w1) | 0) | 0) + -0x359d3e2a) | 0; b = (b << 30) | (b >>> 2);
  x = w15 ^ w10 ^ w4 ^ w2; w2 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w2) | 0) | 0) + -0x359d3e2a) | 0; a = (a << 30) | (a >>> 2);
  x = w0 ^ w11 ^ w5 ^ w3; w3 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w3) | 0) | 0) + -0x359d3e2a) | 0; e = (e << 30) | (e >>> 2);
  x = w1 ^ w12 ^ w6 ^ w4; w4 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w4) | 0) | 0) + -0x359d3e2a) | 0; d = (d << 30) | (d >>> 2);
  x = w2 ^ w13 ^ w7 ^ w5; w5 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w5) | 0) | 0) + -0x359d3e2a) | 0; c = (c << 30) | (c >>> 2);
  x = w3 ^ w14 ^ w8 ^ w6; w6 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w6) | 0) | 0) + -0x359d3e2a) | 0; b = (b << 30) | (b >>> 2);
  x = w4 ^ w15 ^ w9 ^ w7; w7 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w7) | 0) | 0) + -0x359d3e2a) | 0; a = (a << 30) | (a >>> 2);
  x = w5 ^ w0 ^ w10 ^ w8; w8 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w8) | 0) | 0) + -0x359d3e2a) | 0; e = (e << 30) | (e >>> 2);
  x = w6 ^ w1 ^ w11 ^ w9; w9 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w9) | 0) | 0) + -0x359d3e2a) | 0; d = (d << 30) | (d >>> 2);
  x = w7 ^ w2 ^ w12 ^ w10; w10 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w10) | 0) | 0) + -0x359d3e2a) | 0; c = (c << 30) | (c >>> 2);
  x = w8 ^ w3 ^ w13 ^ w11; w11 = (x << 1) | (x >>> 31);
  e = ((((((a << 5) | (a >>> 27)) + (b ^ c ^ d)) | 0) + ((e + w11) | 0) | 0) + -0x359d3e2a) | 0; b = (b << 30) | (b >>> 2);
  x = w9 ^ w4 ^ w14 ^ w12; w12 = (x << 1) | (x >>> 31);
  d = ((((((e << 5) | (e >>> 27)) + (a ^ b ^ c)) | 0) + ((d + w12) | 0) | 0) + -0x359d3e2a) | 0; a = (a << 30) | (a >>> 2);
  x = w10 ^ w5 ^ w15 ^ w13; w13 = (x << 1) | (x >>> 31);
  c = ((((((d << 5) | (d >>> 27)) + (e ^ a ^ b)) | 0) + ((c + w13) | 0) | 0) + -0x359d3e2a) | 0; e = (e << 30) | (e >>> 2);
  x = w11 ^ w6 ^ w0 ^ w14; w14 = (x << 1) | (x >>> 31);
  b = ((((((c << 5) | (c >>> 27)) + (d ^ e ^ a)) | 0) + ((b + w14) | 0) | 0) + -0x359d3e2a) | 0; d = (d << 30) | (d >>> 2);
  x = w12 ^ w7 ^ w1 ^ w15; w15 = (x << 1) | (x >>> 31);
  a = ((((((b << 5) | (b >>> 27)) + (c ^ d ^ e)) | 0) + ((a + w15) | 0) | 0) + -0x359d3e2a) | 0; c = (c << 30) | (c >>> 2);
  st[so] = (st[so] + a) | 0; st[so + 1] = (st[so + 1] + b) | 0; st[so + 2] = (st[so + 2] + c) | 0;
  st[so + 3] = (st[so + 3] + d) | 0; st[so + 4] = (st[so + 4] + e) | 0;
}

/**
 * Pad `buf[0..len)` in place (0x80, zeros, big-endian bit length) and run the
 * blocks from byte `from` (a multiple of 64; the state `st[so..]` already holds
 * every block before it). `buf` (viewed as `b32`) must have room for the padding.
 */
function finish(buf, b32, len, from, st, so) {
  const total = ((len + 9 + 63) >>> 6) << 6;
  buf[len] = 0x80;
  for (let i = len + 1; i < total - 5; i++) buf[i] = 0;
  // Bit length, big-endian, in the last 8 bytes (the high word is 0 for < 512 MB).
  const bits = len * 8;
  buf[total - 5] = Math.floor(len / 0x20000000) & 0xff;
  buf[total - 4] = (bits >>> 24) & 0xff;
  buf[total - 3] = (bits >>> 16) & 0xff;
  buf[total - 2] = (bits >>> 8) & 0xff;
  buf[total - 1] = bits & 0xff;
  for (let off = from; off < total; off += 64) compress(b32, off >>> 2, st, so);
}

/** Grow `msg` to at least `need` bytes, keeping `msg[0..keep)`. */
function growMsg(need, keep) {
  if (msg.length >= need) return;
  const grown = new Uint8Array(blocksOf(Math.max(need, msg.length * 2)));
  grown.set(msg.subarray(0, keep));
  msg = grown;
  msg32 = new Int32Array(msg.buffer);
}

/** SHA-1 of `msg[0..len)`, digest into `H`. */
function sha1Into(len) {
  growMsg(((len + 9 + 63) >>> 6) << 6, len);
  H.set(H0);
  finish(msg, msg32, len, 0, H, 0);
}

/** Write the UTF-8 bytes of `text` into `msg` at `offset`; returns the new length. */
function writeUtf8(text, offset) {
  // Worst case 3 bytes per UTF-16 unit, plus the SHA-1 padding.
  growMsg(offset + text.length * 3 + 72, offset);
  return offset + encoder.encodeInto(text, msg.subarray(offset)).written;
}

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

/** Lowercase hex SHA-1 of the UTF-8 bytes of `text` (exported for the vector tests). */
export function sha1Hex(text) {
  sha1Into(writeUtf8(String(text), 0));
  let out = '';
  for (let i = 0; i < 5; i++) out += (H[i] >>> 0).toString(16).padStart(8, '0');
  return out;
}

function parseUuid(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`rv-node-id-seed: not a UUID: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * RFC 9562 UUIDv5 of `name` (UTF-8) in `namespace` — lowercase, hyphenated.
 * Exported for the vector tests; production code calls {@link seedNodeId}.
 */
const nsCache = new Map();
export function uuidV5(namespace, name) {
  let ns = nsCache.get(namespace);
  if (!ns) { ns = parseUuid(namespace); nsCache.set(namespace, ns); }
  msg.set(ns, 0);
  sha1Into(writeUtf8(String(name), 16));
  const b = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const w = H[i] >>> 0;
    b[i * 4] = w >>> 24; b[i * 4 + 1] = (w >>> 16) & 0xff; b[i * 4 + 2] = (w >>> 8) & 0xff; b[i * 4 + 3] = w & 0xff;
  }
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
    s += HEX[b[i]];
  }
  return s;
}

/** The seeded NodeId of a canonical authored path: `UUIDv5(RV_NODE_ID_NAMESPACE, path)`. */
export function seedNodeId(canonicalPath) {
  return uuidV5(RV_NODE_ID_NAMESPACE, canonicalPath);
}

// ─── Canonical authored paths ───────────────────────────────────────────

/** One escaped path segment for a non-empty raw name (no `[k]`). */
export function escapeSegment(name) {
  let s = name.replace(/\\/g, '\\\\').replace(/\//g, '\\/').replace(/\[/g, '\\[');
  if (s.charCodeAt(0) === 35 /* '#' */) s = '\\' + s;
  return s;
}

/**
 * Canonical authored path of every node reachable from scene `sceneIndex`
 * (default `json.scene ?? 0`), indexed by glTF node index; `undefined` for a
 * node that scene does not reach. A node reachable twice (not a tree) keeps the
 * path of its first visit in glTF order.
 */
export function canonicalAuthoredPaths(json, sceneIndex) {
  const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
  const out = new Array(nodes.length);
  const scenes = Array.isArray(json?.scenes) ? json.scenes : [];
  const scene = scenes[sceneIndex ?? json?.scene ?? 0];
  const roots = Array.isArray(scene?.nodes) ? scene.nodes : [];
  // Explicit stack (large CAD files are deep and wide); children are pushed in
  // reverse so the visit order is glTF order.
  const stack = [];
  const pushChildren = (list, prefix) => {
    const seen = new Map();
    const segs = new Array(list.length);
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const raw = Number.isInteger(i) && i >= 0 && i < nodes.length ? nodes[i]?.name : undefined;
      if (typeof raw !== 'string' || raw === '') { segs[k] = `#${k}`; continue; }
      const n = seen.get(raw) ?? 0;
      seen.set(raw, n + 1);
      segs[k] = n === 0 ? escapeSegment(raw) : `${escapeSegment(raw)}[${n}]`;
    }
    for (let k = list.length - 1; k >= 0; k--) stack.push(list[k], prefix === null ? segs[k] : `${prefix}/${segs[k]}`);
  };
  pushChildren(roots, null);
  while (stack.length > 0) {
    const path = stack.pop();
    const i = stack.pop();
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || out[i] !== undefined) continue;
    out[i] = path;
    const kids = nodes[i]?.children;
    if (Array.isArray(kids) && kids.length > 0) pushChildren(kids, path);
  }
  return out;
}

function existingId(holder) {
  const id = holder?.extras?.realvirtual?.NodeId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}


// ─── The bulk seed of one file (plan-769 9.15) ──────────────────────────
//
// `seedNodeIdsForFile` hashes every node of a file on every decode, so it does
// not run `seedNodeId(canonicalAuthoredPaths()[i])` per node (a string per node,
// UTF-8 encoded and hashed from byte 0). It produces the SAME message bytes
// incrementally, in one depth-first walk with the canonical walk's rules:
//  - one byte buffer holds namespace ‖ path of the node being visited; a child
//    appends `/` + its escaped segment behind its parent's bytes (pre-order, so
//    the parent's bytes are intact whenever one of its children is visited);
//  - SHA-1 resumes from the parent's state after the parent's last COMPLETE
//    64-byte block — every descendant's message starts with those bytes;
//  - pass 2 checks "taken" on a 48-bit key of the digest (UUID bytes 0..5, which
//    the version/variant bits never touch) and compares strings only on a key
//    hit (in practice never; then exactly as the reference algorithm does).
// Same bytes, same hash, same pass-2 order: bit-identical to the reference
// two-pass algorithm of the module doc (`tests/node-id-seed.node.test.ts` pins the
// bulk seed against `seedNodeId(canonicalAuthoredPaths()[i])` and `node:crypto`).

let seg = new Uint8Array(4096);
let seg32 = new Int32Array(seg.buffer);
let ord = new Int32Array(256);
let rawAt = new Array(256);
const seenNames = new Map();
/** Up to this many siblings the same-name ordinals are counted pairwise (no string hashing). */
const SMALL_LIST = 12;

/** Room for `need` bytes in the walk buffer, keeping `seg[0..keep)`. */
function ensureSeg(need, keep) {
  if (seg.length >= need) return;
  const grown = new Uint8Array(blocksOf(Math.max(need, seg.length * 2)));
  grown.set(seg.subarray(0, keep));
  seg = grown;
  seg32 = new Int32Array(seg.buffer);
}

/**
 * The escaped segment of a non-empty raw name as UTF-8 at `seg[pos..]` — the
 * bytes of `encoder.encode(escapeSegment(name))`, lone surrogates → U+FFFD like
 * `TextEncoder`. Returns the end. The caller made room for `3 * name.length`.
 */
function writeSegment(name, pos) {
  const buf = seg;
  const n = name.length;
  for (let j = 0; j < n; j++) {
    let c = name.charCodeAt(j);
    if (c < 0x80) {
      if (c === 92 /* \ */ || c === 47 /* / */ || c === 91 /* [ */ || (c === 35 /* # */ && j === 0)) buf[pos++] = 92;
      buf[pos++] = c;
      continue;
    }
    if (c < 0x800) {
      buf[pos++] = 0xc0 | (c >> 6);
      buf[pos++] = 0x80 | (c & 63);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = j + 1 < n ? name.charCodeAt(j + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        buf[pos++] = 0xf0 | (cp >> 18);
        buf[pos++] = 0x80 | ((cp >> 12) & 63);
        buf[pos++] = 0x80 | ((cp >> 6) & 63);
        buf[pos++] = 0x80 | (cp & 63);
        j++;
        continue;
      }
      c = 0xfffd;
    }
    buf[pos++] = 0xe0 | (c >> 12);
    buf[pos++] = 0x80 | ((c >> 6) & 63);
    buf[pos++] = 0x80 | (c & 63);
  }
  return pos;
}

/** The decimal digits of a non-negative integer at `seg[pos..]`; returns the end. */
function writeInt(v, pos) {
  const s = String(v);
  for (let j = 0; j < s.length; j++) seg[pos++] = s.charCodeAt(j);
  return pos;
}

const HEX_CODES = new Uint8Array(512);
for (let i = 0; i < 256; i++) {
  const h = i.toString(16).padStart(2, '0');
  HEX_CODES[i * 2] = h.charCodeAt(0);
  HEX_CODES[i * 2 + 1] = h.charCodeAt(1);
}
const uuidCodes = new Array(36).fill(45 /* - */);
const UUID_HEX_AT = [0, 2, 4, 6, 9, 11, 14, 16, 19, 21, 24, 26, 28, 30, 32, 34];

/** The UUIDv5 string of the digest words `dig[o..o+4)` — {@link uuidV5}'s formatting. */
function uuidOfDigest(dig, o) {
  for (let i = 0; i < 16; i++) {
    const w = dig[o + (i >> 2)];
    let b = (w >>> (24 - ((i & 3) << 3))) & 0xff;
    if (i === 6) b = (b & 0x0f) | 0x50;
    else if (i === 8) b = (b & 0x3f) | 0x80;
    const at = UUID_HEX_AT[i];
    uuidCodes[at] = HEX_CODES[b * 2];
    uuidCodes[at + 1] = HEX_CODES[b * 2 + 1];
  }
  return String.fromCharCode.apply(null, uuidCodes);
}

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}/;

/**
 * Grow-only scratch arrays of the bulk seed, reused by every call (single-threaded,
 * never re-entered). plan-769 9.15: several MB of fresh typed arrays per decode are
 * external memory, and on a loaded heap (a big model's geometry) that pressure buys
 * full garbage collections inside the decode. Nothing in them outlives a call.
 */
const scratch = Object.create(null);
function scratchOf(name, Ctor, n) {
  let a = scratch[name];
  if (!a || a.length < n) {
    a = new Ctor(Math.max(n, a ? a.length * 2 : 0, 1024));
    scratch[name] = a;
  }
  return a;
}

/**
 * The 48-bit keys of the taken ids — UUID bytes 0..5 (`k0` = bytes 0..3 = digest
 * word 0, `k1` = bytes 4..5 = the top half of word 1; the version/variant bits
 * never touch them) — in an open-addressing table: no string is hashed for a seed.
 * A key hit is only a hint; the caller then compares the strings.
 */
function createKeyTable(capacity) {
  let cap = 64;
  while (cap < capacity * 2) cap <<= 1;
  const mask = cap - 1;
  const k0 = scratchOf('k0', Int32Array, cap);
  const k1 = scratchOf('k1', Int32Array, cap);
  const used = scratchOf('used', Uint8Array, cap);
  used.fill(0, 0, cap);
  /** Probe for (a, b); inserts it when `insert`. Returns whether it was present. */
  const probe = (a, b, insert) => {
    let j = a & mask;
    while (used[j] === 1) {
      if (k0[j] === a && k1[j] === b) return true;
      j = (j + 1) & mask;
    }
    if (insert) { used[j] = 1; k0[j] = a; k1[j] = b; }
    return false;
  };
  return {
    has: (a, b) => probe(a, b, false),
    add: (a, b) => { probe(a, b, true); },
  };
}

/** Key words [k0, k1] of an id string; null for a string no seed can equal (not lowercase-UUID-shaped). */
function keyOfId(id) {
  if (!UUID_PREFIX_RE.test(id)) return null;
  return [parseInt(id.slice(0, 8), 16) | 0, parseInt(id.slice(9, 13), 16)];
}

/**
 * One walk (see above): `parent[i]` for every node the scene reaches (`-1` top
 * level; the array arrives filled with `-2` = not reached), and for each of them
 * WITHOUT an id (`hasId[i] === 0`) `dig[4i..4i+4)` = the first four SHA-1 words of
 * `namespace ‖ UTF-8(canonical path of i)`. Visit order, `[k]` ordinals and `#k`
 * segments are those of {@link canonicalAuthoredPaths}; the first visit of a node
 * reached twice wins, as there and in `sceneParents` (rv-reference-migration.mjs).
 */
function hashTree(nodes, roots, nsBytes, hasId, parent, dig) {
  const N = nodes.length;
  const st = scratchOf('st', Int32Array, N * 5);
  const endOf = scratchOf('endOf', Int32Array, N);
  const stack = [];
  const pushChildren = (list, parent) => {
    const len = list.length;
    if (ord.length < len) { ord = new Int32Array(Math.max(len, ord.length * 2)); rawAt = new Array(ord.length); }
    // ord[k] = how many EARLIER siblings carry the same raw name (-1 = no name → `#k`):
    // compared pairwise for a short list, counted in a map for a long one.
    const small = len <= SMALL_LIST;
    for (let k = 0; k < len; k++) {
      const i = list[k];
      const raw = Number.isInteger(i) && i >= 0 && i < N ? nodes[i]?.name : undefined;
      if (typeof raw !== 'string' || raw === '') { ord[k] = -1; rawAt[k] = undefined; continue; }
      if (small) {
        let c = 0;
        for (let j = 0; j < k; j++) if (rawAt[j] === raw) c++;
        rawAt[k] = raw;
        ord[k] = c;
        continue;
      }
      const c = seenNames.get(raw) ?? 0;
      seenNames.set(raw, c + 1);
      ord[k] = c;
    }
    if (small) rawAt.fill(undefined, 0, len);
    else seenNames.clear();
    for (let k = len - 1; k >= 0; k--) stack.push(list[k], parent, k, ord[k]);
  };
  ensureSeg(16 + 72, 0);
  seg.set(nsBytes, 0);
  pushChildren(roots, -1);
  while (stack.length > 0) {
    const n = stack.pop();
    const k = stack.pop();
    const p = stack.pop();
    const i = stack.pop();
    if (!Number.isInteger(i) || i < 0 || i >= N || parent[i] !== -2) continue;
    parent[i] = p;
    // Message: namespace ‖ parent path ‖ '/' ‖ segment (a top-level node has no '/').
    const pEnd = p === -1 ? 16 : endOf[p];
    const name = n < 0 ? '' : nodes[i].name;
    ensureSeg(pEnd + 1 + 3 * name.length + 32 + 72, pEnd);
    let pos = pEnd;
    if (p !== -1) seg[pos++] = 47;
    if (n < 0) {
      seg[pos++] = 35;
      pos = writeInt(k, pos);
    } else {
      pos = writeSegment(name, pos);
      if (n > 0) { seg[pos++] = 91; pos = writeInt(n, pos); seg[pos++] = 93; }
    }
    endOf[i] = pos;
    // State after the node's complete blocks = the parent's + the blocks in between.
    const so = i * 5;
    if (p === -1) {
      st[so] = H0[0]; st[so + 1] = H0[1]; st[so + 2] = H0[2]; st[so + 3] = H0[3]; st[so + 4] = H0[4];
    } else {
      const po = p * 5;
      st[so] = st[po]; st[so + 1] = st[po + 1]; st[so + 2] = st[po + 2]; st[so + 3] = st[po + 3]; st[so + 4] = st[po + 4];
    }
    const full = pos >>> 6;
    for (let b = pEnd >>> 6; b < full; b++) compress(seg32, b << 4, st, so);
    if (hasId[i] === 0) {
      H[0] = st[so]; H[1] = st[so + 1]; H[2] = st[so + 2]; H[3] = st[so + 3]; H[4] = st[so + 4];
      finish(seg, seg32, pos, full << 6, H, 0);
      const o = i * 4;
      dig[o] = H[0]; dig[o + 1] = H[1]; dig[o + 2] = H[2]; dig[o + 3] = H[3];
    }
    const kids = nodes[i]?.children;
    if (Array.isArray(kids) && kids.length > 0) pushChildren(kids, i);
  }
}

/**
 * The two-pass seed of one file (see the module doc). Returns per glTF node
 * index the id the node ends up with (`undefined` = unreachable and without an
 * id), the model root's id (`rootId`: the scene's own `NodeId`, else the seed of
 * {@link ROOT_CANONICAL_PATH}), the canonical paths (built on first read — the
 * decode never reads them), and every retry.
 */
export function seedNodeIdsForFile(json, sceneIndex) {
  const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
  const scenes = Array.isArray(json?.scenes) ? json.scenes : [];
  const scene = scenes[sceneIndex ?? json?.scene ?? 0];
  const roots = Array.isArray(scene?.nodes) ? scene.nodes : [];
  const N = nodes.length;
  const ids = new Array(N);
  const hasId = scratchOf('hasId', Uint8Array, N);
  hasId.fill(0, 0, N);
  const taken = new Set();
  const duplicates = [];
  let existing = 0;
  const reserve = (id, index) => {
    if (taken.has(id)) duplicates.push({ index, id });
    taken.add(id);
  };
  const sceneId = existingId(scene);
  if (sceneId) { reserve(sceneId, -1); existing++; }
  for (let i = 0; i < N; i++) {
    const id = existingId(nodes[i]);
    if (id) { ids[i] = id; hasId[i] = 1; reserve(id, i); existing++; }
  }

  // Pass-2 input: the digest of every reachable node without an id.
  const parent = new Array(N).fill(-2);
  const dig = scratchOf('dig', Int32Array, N * 4);
  let ns = nsCache.get(RV_NODE_ID_NAMESPACE);
  if (!ns) { ns = parseUuid(RV_NODE_ID_NAMESPACE); nsCache.set(RV_NODE_ID_NAMESPACE, ns); }
  hashTree(nodes, roots, ns, hasId, parent, dig);

  let paths = null;
  const pathsOf = () => (paths ??= canonicalAuthoredPaths(json, sceneIndex));

  // "Taken" = every existing id + every seed so far: keys first, strings only on a key hit.
  const keys = createKeyTable(N + taken.size + 1);
  for (const id of taken) { const k = keyOfId(id); if (k) keys.add(k[0], k[1]); }
  // The exact set is built on the first key hit: the existing ids, the root's seed and
  // the seeds of the nodes before `upto` (pass 2 runs in ascending index order).
  let exact = null;
  let rootSeed = null;
  let upto = 0;
  const isTaken = (id, a, b) => {
    if (!keys.has(a, b)) return false;
    if (!exact) {
      exact = new Set(taken);
      if (rootSeed !== null) exact.add(rootSeed);
      for (let j = 0; j < upto; j++) if (hasId[j] === 0 && ids[j] !== undefined) exact.add(ids[j]);
    }
    return exact.has(id);
  };
  const take = (id, a, b) => {
    keys.add(a, b);
    if (exact) exact.add(id);
  };
  const isTakenId = (id) => { const k = keyOfId(id); return isTaken(id, k[0], k[1]); };
  const takeId = (id) => { const k = keyOfId(id); take(id, k[0], k[1]); };
  const collisions = [];
  let seeded = 0;
  const retry = (path, index) => {
    let n = 1;
    let id;
    for (;;) {
      id = seedNodeId(`${path}\u0000${n}`);
      if (!isTakenId(id)) break;
      n++;
    }
    takeId(id);
    seeded++;
    collisions.push({ index, path, n });
    return id;
  };
  let rootId = sceneId;
  if (!rootId) {
    const id = seedNodeId(ROOT_CANONICAL_PATH);
    if (!isTakenId(id)) { takeId(id); seeded++; rootId = id; }
    else rootId = retry(ROOT_CANONICAL_PATH, -1);
    rootSeed = rootId;
  }
  for (let i = 0; i < N; i++) {
    if (hasId[i] === 1 || parent[i] === -2) continue;
    upto = i;
    const o = i * 4;
    const id = uuidOfDigest(dig, o);
    const b = dig[o + 1] >>> 16;
    if (!isTaken(id, dig[o], b)) { take(id, dig[o], b); seeded++; ids[i] = id; }
    else ids[i] = retry(pathsOf()[i], i);
  }
  const result = { ids, rootId, paths: undefined, existing, seeded, collisions, duplicates };
  Object.defineProperty(result, 'paths', { enumerable: true, configurable: true, get: pathsOf });
  // The walk's by-product, for the decode (= `sceneParents(json)` of the same scene).
  Object.defineProperty(result, 'parent', { enumerable: false, value: parent });
  return result;
}
