// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { postProcessModelUsda, postProcessModelUsdaChunks, type StagePostOptions } from '../src/core/usd/usd-stage-post';

function expectSameBytes(source: string, options: StagePostOptions): void {
  const text = postProcessModelUsda(source, options), binary = postProcessModelUsdaChunks(source, options);
  const bytes = Buffer.concat(binary.chunks);
  expect(bytes).toEqual(Buffer.from(text.text, 'utf8'));
  expect(binary.renamed).toBe(text.renamed); expect(binary.unmatched).toEqual(text.unmatched);
  expect(bytes.toString('utf8')).not.toContain('\ufffd');
}

describe('bounded UTF-8 stage post-pass', () => {
  it('preserves Unicode source ranges and address metadata across chunk boundaries', () => {
    const note = 'x'.repeat(8173) + '🚚設備漢字'.repeat(1900);
    const address = '工場/設備#' + 'a'.repeat(8181) + '🚚部品'.repeat(1800);
    const source = `#usda 1.0\n( defaultPrim = "Root" )\ndef Xform "_rvN0" { string note = "${note}" }`;
    expectSameBytes(source, { finalNames: ['Root'], prims: new Map([[0, { customData: { address } }]]) });
    expectSameBytes(source, { finalNames: ['Root'], prims: new Map([[0, { customData: { address } }]]), writeAddresses: false });
  });

  it('keeps the exact finite-double spelling, including exponent boundaries and signed zero', () => {
    const values = new Float64Array([0, -0, Number.MIN_VALUE, 1e-7, 1e-6, 1e20, 1e21, Number.MAX_VALUE, -Math.PI]);
    const channel = { frames: new Uint32Array([0, 964, 994]), defaultValue: values.slice(0, 3), values };
    const source = 'def Xform "_rvN0" { float3 xformOp:translate = (0, 0, 0) }';
    const options = { finalNames: ['Axis'], prims: new Map([[0, { translate: channel }]]) };
    expectSameBytes(source, options);
    const text = postProcessModelUsda(source, options).text;
    const tuples = [...text.matchAll(/\d+: \(([^)]+)\)/g)];
    expect(tuples).toHaveLength(3);
    tuples.forEach((tuple, i) => expect(tuple[1]).toBe([...values.slice(i * 3, i * 3 + 3)].map((v) => String(v)).join(', ')));
  });

  it('matches identity/visibility edits at the same position and the unmodified source path', () => {
    const source = '#usda 1.0\n( upAxis = "Y" )\ndef Xform "_rvN0" { matrix4d xformOp:transform = ((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1)) uniform token[] xformOpOrder = ["xformOp:transform"] }';
    expectSameBytes(source, { finalNames: ['Axis'], time: { fps: 30, endTimeCode: 994 }, blenderVisibilityCompat: true,
      prims: new Map([[0, { customData: { address: 'p#設備' }, visibilitySamples: [[0, 'invisible'], [964, 'inherited'], [994, 'invisible']] }]]) });
    expectSameBytes('#usda 1.0\n( customLayerData = { string note = "工場🚚" } )', { finalNames: [] });
  });
});
