// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.8 — the shipped part library (`public/knowledge/parts.json`) and
 * `lookupPart` behind `web_part_lookup`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPartLibrary, lookupPart, parsePartLibrary, _resetPartLibraryForTest } from '../src/core/knowledge/rv-part-library';

const lib = parsePartLibrary(JSON.parse(readFileSync(resolve(__dirname, '../public/knowledge/parts.json'), 'utf-8')));

describe('part library', () => {
  it('ships the seven Festo families, every pattern valid', () => {
    expect(lib.parts.map((p) => p.family).sort()).toEqual(['ADN', 'DFM', 'DGC', 'DGST', 'EHPS', 'ELGC', 'ERMO']);
  });

  it('DFM-6-5 → stroke 5, moving (K), fixed (Z), citable source', () => {
    const [m] = lookupPart('DFM-6-5', lib);
    expect(m).toMatchObject({ family: 'DFM', typeCode: 'DFM-6-5', size: 6, stroke_mm: 5, motion: 'linear', source: 'parts:DFM-6-5' });
    expect(m.moving).toContain('(K)');
    expect(m.fixed).toContain('(Z)');
  });

  it('reads the type code out of a CAD node name; stroke from the type number', () => {
    expect(lookupPart('DFM-12-50-P-A-GF (K)', lib)[0]).toMatchObject({ family: 'DFM', stroke_mm: 50, size: 12 });
    expect(lookupPart('adn-20-25-a-p-a_Zylinder (Z)', lib)[0]).toMatchObject({ family: 'ADN', stroke_mm: 25 });
    expect(lookupPart('DGC-18-500-G-P-A', lib)[0]).toMatchObject({ family: 'DGC', size: 18, stroke_mm: 500 });
    expect(lookupPart('DGST-10-40-PA', lib)[0]).toMatchObject({ family: 'DGST', stroke_mm: 40 });
    expect(lookupPart('ELGC-TB-KF-45-500', lib)[0]).toMatchObject({ family: 'ELGC', size: 45, stroke_mm: 500 });
  });

  it('a gripper or a rotary drive has no stroke in its code — null plus a hint, never a guess', () => {
    const g = lookupPart('EHPS-16-A-LK', lib)[0];
    expect(g).toMatchObject({ family: 'EHPS', size: 16, stroke_mm: null });
    expect(g.strokeHint).toMatch(/datasheet/);
    expect(lookupPart('ERMO-25-LKF-ST', lib)[0]).toMatchObject({ family: 'ERMO', motion: 'rotary', stroke_mm: null });
  });

  it('unknown numbers and glued prefixes are no match', () => {
    expect(lookupPart('XYZ-12-50', lib)).toEqual([]);
    expect(lookupPart('XDFM-6-5', lib)).toEqual([]);
    expect(lookupPart('', lib)).toEqual([]);
  });

  it('a malformed row is dropped, not thrown', () => {
    const l = parsePartLibrary({ parts: [{ family: 'A', pattern: '(' }, { pattern: 'x' }, { family: 'B', pattern: 'B-(\\d+)' }] });
    expect(l.parts.map((p) => p.family)).toEqual(['B']);
  });

  it('loadPartLibrary fetches knowledge/parts.json once', async () => {
    _resetPartLibraryForTest();
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      expect(url).toMatch(/knowledge\/parts\.json$/);
      return { ok: true, status: 200, json: async () => ({ parts: [{ family: 'DFM', pattern: 'DFM-(\\d+)-(\\d+)', stroke_mm: '$2' }] }) };
    }) as unknown as typeof fetch;
    const a = await loadPartLibrary(fake);
    await loadPartLibrary(fake);
    expect(calls).toBe(1);
    expect(lookupPart('DFM-6-5', a)[0].stroke_mm).toBe(5);
    _resetPartLibraryForTest();
  });
});
