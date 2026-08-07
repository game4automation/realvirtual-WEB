// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * patch-occt-memory.mjs — raise occt-import-js's WASM heap ceiling 2 GB → 4 GB.
 *
 * WHY: occt-import-js 0.0.23 ships a .wasm whose memory section declares
 * `maximum = 32768 pages` (2 GB), and glue code that caps `getHeapMax()` at the
 * same 2 GB. A large STEP assembly's B-rep exhausts that ceiling BEFORE meshing,
 * so `ReadStepFile` returns `success:true` with empty geometry and the model
 * imports invisibly (see step-import-core.ts). 4 GB is the full wasm32 address
 * space and doubles the headroom.
 *
 * WHY A PATCH, NOT A REBUILD: `-sMAXIMUM_MEMORY=4gb` changes exactly two build
 * artifacts — the memory section's `maximum`, and the glue's `getHeapMax()`.
 * Nothing in the generated code depends on the value (wasm32 pointer arithmetic
 * is unsigned and 4 GB-clean). So patching those two bytes-spans yields a binary
 * IDENTICAL to a rebuild, without a multi-hour OpenCascade-for-WASM toolchain.
 *
 * The maximum is located by PARSING the memory section (not a blind byte search —
 * `0x80 0x80 0x02` is a common sequence). Idempotent: re-running detects the
 * already-patched value and does nothing. Runs on `postinstall` (survives
 * `npm install`) and `prebuild` (so the copied dist/ wasm is patched too).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const WASM = resolve(root, 'node_modules/occt-import-js/dist/occt-import-js.wasm');
const GLUE = resolve(root, 'node_modules/occt-import-js/dist/occt-import-js.js');

const OLD_MAX_PAGES = 32768; // 2 GB / 64 KiB
const NEW_MAX_PAGES = 65536; // 4 GB / 64 KiB — the wasm32 ceiling
const OLD_HEAP_MAX = '2147483648'; // 2 GB, in the glue's getHeapMax()
const NEW_HEAP_MAX = '4294967296'; // 4 GB

/** Minimal LEB128 (unsigned) — occt's memory limits are small u32s. */
function encodeLEB(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

/**
 * Walk the wasm to the memory section and return the byte span of its `maximum`
 * field, plus the decoded value. Returns null if the section is absent.
 */
function findMemoryMaximum(buf) {
  let p = 8; // skip magic (4) + version (4)
  const readU = () => {
    let r = 0, s = 0, b, start = p;
    do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return { val: r >>> 0, start, len: p - start };
  };
  while (p < buf.length) {
    const id = buf[p++];
    const size = readU();
    const end = p + size.val;
    if (id === 5) { // memory section
      const count = readU();
      if (count.val < 1) return null;
      const flags = buf[p++];
      readU(); // initial (skip)
      if (!(flags & 1)) return null; // no maximum declared
      const max = readU();
      return { start: max.start, len: max.len, value: max.val };
    }
    p = end;
  }
  return null;
}

function patchWasm() {
  if (!existsSync(WASM)) {
    console.warn(`[patch-occt] wasm not found (${WASM}) — occt-import-js not installed yet, skipping.`);
    return;
  }
  const buf = readFileSync(WASM);
  const mem = findMemoryMaximum(buf);
  if (!mem) {
    console.warn('[patch-occt] no memory section with a maximum — occt-import-js format changed; NOT patching.');
    return;
  }
  if (mem.value === NEW_MAX_PAGES) {
    console.log('[patch-occt] wasm already at 4 GB — nothing to do.');
    return;
  }
  if (mem.value !== OLD_MAX_PAGES) {
    console.warn(
      `[patch-occt] unexpected wasm maximum (${mem.value} pages, expected ${OLD_MAX_PAGES}); ` +
      'occt-import-js version may have changed — NOT patching to avoid corruption.',
    );
    return;
  }
  const newBytes = encodeLEB(NEW_MAX_PAGES);
  if (newBytes.length !== mem.len) {
    // Both 32768 and 65536 encode to 3 bytes; if not, an in-place patch would
    // shift every following byte and wreck the module — refuse.
    console.warn('[patch-occt] LEB length mismatch — refusing to shift the binary.');
    return;
  }
  for (let i = 0; i < newBytes.length; i++) buf[mem.start + i] = newBytes[i];
  writeFileSync(WASM, buf);
  console.log(`[patch-occt] wasm heap ceiling raised ${OLD_MAX_PAGES}→${NEW_MAX_PAGES} pages (2 GB → 4 GB).`);
}

function patchGlue() {
  if (!existsSync(GLUE)) {
    console.warn(`[patch-occt] glue not found (${GLUE}) — skipping.`);
    return;
  }
  const src = readFileSync(GLUE, 'utf8');
  const from = `getHeapMax=()=>${OLD_HEAP_MAX}`;
  const to = `getHeapMax=()=>${NEW_HEAP_MAX}`;
  if (src.includes(to)) {
    console.log('[patch-occt] glue getHeapMax already at 4 GB — nothing to do.');
    return;
  }
  if (!src.includes(from)) {
    console.warn(`[patch-occt] glue getHeapMax pattern not found (expected "${from}") — NOT patching.`);
    return;
  }
  writeFileSync(GLUE, src.replace(from, to));
  console.log('[patch-occt] glue getHeapMax raised 2 GB → 4 GB.');
}

patchWasm();
patchGlue();
