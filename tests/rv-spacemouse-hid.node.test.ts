// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { RVSpaceMouseParser } from '../src/core/engine/rv-spacemouse-hid';
function packet(values: number[], prefix = false) {
  const d = new DataView(new ArrayBuffer(values.length * 2 + (prefix ? 1 : 0)));
  if (prefix)
    d.setUint8(0, 1);
  values.forEach((v, i) => d.setInt16(i * 2 + (prefix ? 1 : 0), v, true));
  return d;
}
describe('SpaceMouse HID parser', () => {
  it('decodes LE signed translation and rotation, caching each group', () => {
    const p = new RVSpaceMouseParser();
    p.parse(1, packet([350, -175, 0]));
    p.parse(2, packet([-350, 70, -35]));
    expect(p.sample).toEqual({ tx: 1, ty: -0.5, tz: 0, rx: -1, ry: 0.2, rz: -0.1 });
    expect(p.parse(9, packet([1, 2, 3]))).toBe(false);
    expect(p.sample.tx).toBe(1);
  });
  it('handles combined stripped and 13-byte prefixed reports', () => {
    for (const prefix of [false, true]) {
      const p = new RVSpaceMouseParser();
      p.parse(1, packet([350, -350, 175, -175, 70, -70], prefix));
      expect(p.sample).toEqual({ tx: 1, ty: -1, tz: 0.5, rx: -0.5, ry: 0.2, rz: -0.2 });
    }
  });
  it('decodes buttons, rejects short packets and resets all state', () => {
    const p = new RVSpaceMouseParser();
    p.parse(3, new DataView(Uint8Array.of(3, 1).buffer));
    expect(p.buttons).toBe(259);
    expect(p.parse(1, new DataView(new ArrayBuffer(2)))).toBe(false);
    p.reset();
    expect(p.buttons).toBe(0);
    expect(Object.values(p.sample).every(v => v === 0)).toBe(true);
  });
});
