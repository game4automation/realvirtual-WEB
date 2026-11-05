// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Texture budget of the bundled library (`public/library/**.glb`).
 *
 * Library assets are downloaded, decoded and uploaded to the GPU on the first
 * planner drop. Measured 2026-11-05: `CartonBox.glb` (324 triangles) carried a
 * 4096x4096 PNG of 15.6 MB — 349 ms of parse on the first drop and ~85 MB of
 * GPU memory with mipmaps; `EuropalletLoaded.glb` carried the same image. Both
 * now embed it as a 2048x2048 JPEG (195 KB), which is visually identical at
 * planner distances.
 *
 * Budget per embedded image: at most 2048 px per side and at most 2 MB of
 * encoded bytes. A texture above that needs a deliberate exception here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const LIBRARY_ROOT = join(__dirname, '..', 'public', 'library');
const MAX_SIDE_PX = 2048;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function glbFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...glbFiles(p));
    else if (name.toLowerCase().endsWith('.glb')) out.push(p);
  }
  return out;
}

/** Width/height of a PNG (IHDR) or JPEG (first SOFn marker); null if unknown. */
function imageSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

interface EmbeddedImage { file: string; name: string; bytes: number; w: number | null; h: number | null }

function embeddedImages(file: string): EmbeddedImage[] {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) return [];
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8')) as {
    images?: Array<{ name?: string; bufferView?: number }>;
    bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  };
  const binStart = 20 + jsonLen + 8;
  return (json.images ?? []).flatMap((im, idx) => {
    if (im.bufferView === undefined) return [];
    const v = json.bufferViews![im.bufferView];
    const start = binStart + (v.byteOffset ?? 0);
    const size = imageSize(b.subarray(start, start + v.byteLength));
    return [{
      file: relative(LIBRARY_ROOT, file).replace(/\\/g, '/'),
      name: im.name ?? `#${idx}`,
      bytes: v.byteLength,
      w: size?.w ?? null,
      h: size?.h ?? null,
    }];
  });
}

describe('bundled library texture budget', () => {
  const images = glbFiles(LIBRARY_ROOT).flatMap(embeddedImages);

  it('finds the library and its textures', () => {
    expect(images.length).toBeGreaterThan(0);
  });

  it(`no embedded image is larger than ${MAX_SIDE_PX} px per side`, () => {
    const over = images.filter((i) => (i.w ?? 0) > MAX_SIDE_PX || (i.h ?? 0) > MAX_SIDE_PX)
      .map((i) => `${i.file} › ${i.name}: ${i.w}x${i.h}`);
    expect(over).toEqual([]);
  });

  it('no embedded image is larger than 2 MB encoded', () => {
    const over = images.filter((i) => i.bytes > MAX_IMAGE_BYTES)
      .map((i) => `${i.file} › ${i.name}: ${(i.bytes / 1e6).toFixed(1)} MB`);
    expect(over).toEqual([]);
  });
});
