// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { applySchema, loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';

function read(extras: Record<string, unknown>): unknown {
  const instance: Record<string, unknown> = {};
  applySchema(instance, loadSchemaFromSpec('Lamp'), extras);
  return instance.SingalLampFlashing;
}

describe('RVLamp flashing signal alias', () => {
  it('accepts the Unity misspelling', () => {
    const ref = { type: 'ComponentReference', path: 'Signals/FlashA' };
    expect(read({ SingalLampFlashing: ref })).toEqual(ref);
  });

  it('accepts the corrected spelling as alias', () => {
    const ref = { type: 'ComponentReference', path: 'Signals/FlashB' };
    expect(read({ SignalLampFlashing: ref })).toEqual(ref);
  });

  it('prefers the Unity primary field when both are present', () => {
    const primary = { type: 'ComponentReference', path: 'Signals/Primary' };
    const alias = { type: 'ComponentReference', path: 'Signals/Alias' };
    expect(read({ SingalLampFlashing: primary, SignalLampFlashing: alias })).toEqual(primary);
  });
});
