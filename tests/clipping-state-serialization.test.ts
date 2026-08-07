// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  serializeClippingState,
  deserializeClippingState,
  DEFAULT_CLIPPING_STATE,
  type ClippingState,
} from '../src/plugins/rv-clipping-plugin';

describe('ClippingState (de)serialize', () => {
  it('round-trips enabled/position/flip', () => {
    const s: ClippingState = {
      x: { enabled: true, position: 0.5, flip: false },
      y: { enabled: false, position: 0, flip: true },
      z: { enabled: false, position: -0.3, flip: false },
    };
    const r = deserializeClippingState(serializeClippingState(s));
    expect(r.x.enabled).toBe(true);
    expect(r.x.position).toBeCloseTo(0.5);
    expect(r.y.flip).toBe(true);
    expect(r.z.position).toBeCloseTo(-0.3);
  });

  it('falls back to defaults on invalid JSON', () => {
    expect(deserializeClippingState('not-json')).toEqual(DEFAULT_CLIPPING_STATE);
  });

  it('fills missing axes from defaults (partial / old schema)', () => {
    const r = deserializeClippingState(JSON.stringify({ x: { enabled: true } }));
    expect(r.x.enabled).toBe(true);
    expect(r.x.position).toBe(0); // default
    expect(r.y).toEqual(DEFAULT_CLIPPING_STATE.y);
    expect(r.z).toEqual(DEFAULT_CLIPPING_STATE.z);
  });
});
