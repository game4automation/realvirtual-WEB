// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
// Plain Node ESM script; deliberately has no application/runtime dependencies.
// @ts-expect-error The standalone inventory script has no declaration file.
import { scanGlb } from '../../scripts/des-legacy-inventory.mjs';

function glb(nodes: unknown[]): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, nodes }));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + length, 0x20);
  bytes.write('glTF', 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}

describe('DES legacy GLB inventory', () => {
  it('finds native keys, nested type names and markers without exposing extras', () => {
    const result = scanGlb(glb([
      { name: 'Source', extras: { realvirtual: { DESSource: { secret: 'do not report' } } } },
      { name: 'Station', extras: { rv_extras: [{ type: 'DESStation' }] } },
      { name: 'Marker', extras: { nested: { _desComponent: true } } },
    ]));
    expect(result).toEqual({ status: 'scanned', hits: [
      { node: 'Source', type: 'DESSource' },
      { node: 'Station', type: 'DESStation' },
      { node: 'Marker', type: '_desComponent' },
    ] });
  });

  it('accepts a clean material-flow model', () => {
    expect(scanGlb(glb([{ name: 'Source', extras: { realvirtual: { Source: {} } } }])))
      .toEqual({ status: 'scanned', hits: [] });
  });

  it('reports LFS pointers separately from clean models', () => {
    expect(scanGlb(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 100\n')))
      .toEqual({ status: 'lfs-pointer', hits: [] });
  });

  it('rejects malformed headers and truncated chunks', () => {
    const valid = glb([]);
    expect(scanGlb(valid.subarray(0, valid.length - 1)).status).toBe('invalid');
    const wrongType = Buffer.from(valid);
    wrongType.writeUInt32LE(0x004e4942, 16);
    expect(scanGlb(wrongType).status).toBe('invalid');
    expect(scanGlb(Buffer.from('not a GLB')).status).toBe('invalid');
  });
});
