// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { slotAcceptsSignal } from '../src/plugins/signal-bind/drop-accept';

describe('binding direction validation', () => {
  it('accepts PLC outputs only for controls and PLC inputs only for feedback', () => {
    const control = { type: 'bool' as const, direction: 'plcOutput' as const };
    const feedback = { type: 'bool' as const, direction: 'plcInput' as const };
    expect(slotAcceptsSignal(control, { plcType: 'PLCOutputBool', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(true);
    expect(slotAcceptsSignal(control, { plcType: 'PLCInputBool', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(false);
    expect(slotAcceptsSignal(feedback, { plcType: 'PLCInputBool', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(true);
    expect(slotAcceptsSignal(feedback, { plcType: 'PLCOutputBool', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(false);
  });
});
