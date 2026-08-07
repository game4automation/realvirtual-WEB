// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';

describe('RVLamp schema', () => {
  it('loads ComponentReference signals while leaving OnColor raw', () => {
    const schema = loadSchemaFromSpec('Lamp');

    expect(schema.SignalLampOn).toEqual({
      type: 'componentRef',
      signal: 'PLCOutputBool',
    });
    expect(schema.SingalLampFlashing).toEqual({
      type: 'componentRef',
      signal: 'PLCOutputBool',
      aliases: ['SignalLampFlashing'],
    });
    expect(schema.OnColor).toBeUndefined();
  });
});
