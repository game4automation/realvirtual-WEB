// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * occt-memory-patch.node.test.ts — guard the 2 GB → 4 GB heap patch.
 *
 * `scripts/patch-occt-memory.mjs` raises occt-import-js's WASM heap ceiling to
 * 4 GB (see that file for why). It runs on `postinstall` + `prebuild`, but it
 * operates on a node_modules artifact — so a version bump, a lockfile change, or
 * a skipped postinstall could silently drop us back to 2 GB and reintroduce the
 * "large STEP imports as an invisible object" bug.
 *
 * This test fails loudly if the installed occt-import-js is NOT patched, telling
 * the developer to run `npm run patch:occt`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, '../node_modules/occt-import-js/dist/occt-import-js.wasm');
const GLUE = resolve(here, '../node_modules/occt-import-js/dist/occt-import-js.js');

const EXPECTED_MAX_PAGES = 65536; // 4 GB / 64 KiB
const EXPECTED_HEAP_MAX = '4294967296'; // 4 GB, in getHeapMax()

/** Decode the memory section's declared `maximum`, in pages. */
function wasmMemoryMaxPages(buf: Buffer): number | null {
  let p = 8; // magic + version
  const readU = () => {
    let r = 0, s = 0, b;
    do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return r >>> 0;
  };
  while (p < buf.length) {
    const id = buf[p++];
    const size = readU();
    const end = p + size;
    if (id === 5) {
      const count = readU();
      if (count < 1) return null;
      const flags = buf[p++];
      readU(); // initial
      return (flags & 1) ? readU() : null;
    }
    p = end;
  }
  return null;
}

describe('occt-import-js 4 GB heap patch', () => {
  it('the installed .wasm declares a 4 GB memory maximum', () => {
    expect(existsSync(WASM), `occt-import-js wasm missing at ${WASM}`).toBe(true);
    const pages = wasmMemoryMaxPages(readFileSync(WASM));
    expect(
      pages,
      `occt wasm heap ceiling is ${pages} pages, expected ${EXPECTED_MAX_PAGES} (4 GB). ` +
      'Run `npm run patch:occt` (normally automatic on install/build).',
    ).toBe(EXPECTED_MAX_PAGES);
  });

  it('the glue getHeapMax() reports 4 GB', () => {
    expect(existsSync(GLUE)).toBe(true);
    const src = readFileSync(GLUE, 'utf8');
    expect(
      src.includes(`getHeapMax=()=>${EXPECTED_HEAP_MAX}`),
      'occt glue getHeapMax() is not 4 GB. Run `npm run patch:occt`.',
    ).toBe(true);
    // And the old 2 GB value must be gone (both artifacts move together).
    expect(src.includes('getHeapMax=()=>2147483648')).toBe(false);
  });
});
