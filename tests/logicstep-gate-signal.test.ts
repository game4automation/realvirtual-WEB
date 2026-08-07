// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVSetSignalBool, RVSetSignalFloat, StepState } from '../src/core/engine/rv-logic-step';
import { clearLiveControl, setSignalLiveControlled } from '../src/core/engine/rv-live-control';

describe('LogicStep signal live-control gate', () => {
  beforeEach(clearLiveControl);

  it('suppresses bool/float writers while live and writes again after unbind', () => {
    const store = new SignalStore();
    store.register('BoolTarget', 'Signals/BoolTarget', false, 'PLCOutputBool');
    store.register('FloatTarget', 'Signals/FloatTarget', 1, 'PLCOutputFloat');
    setSignalLiveControlled('BoolTarget', true);
    setSignalLiveControlled('FloatTarget', true);

    const boolStep = new RVSetSignalBool('Signals/BoolTarget', true, store);
    const floatStep = new RVSetSignalFloat('Signals/FloatTarget', 9, store);
    boolStep.start();
    floatStep.start();

    expect(boolStep.state).toBe(StepState.Finished);
    expect(boolStep.reason).toBe('suppressed-live');
    expect(floatStep.reason).toBe('suppressed-live');
    expect(store.get('BoolTarget')).toBe(false);
    expect(store.get('FloatTarget')).toBe(1);

    setSignalLiveControlled('BoolTarget', false);
    setSignalLiveControlled('FloatTarget', false);
    boolStep.reset();
    floatStep.reset();
    boolStep.start();
    floatStep.start();

    expect(boolStep.reason).toBeUndefined();
    expect(floatStep.reason).toBeUndefined();
    expect(store.get('BoolTarget')).toBe(true);
    expect(store.get('FloatTarget')).toBe(9);
  });
});
