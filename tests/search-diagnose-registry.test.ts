// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-diagnose-registry.test.ts — provider slot for the AI search
 * (plan-283 §8).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  registerSearchDiagnoseProvider,
  getSearchDiagnoseProvider,
  subscribeSearchDiagnoseProvider,
  getSearchDiagnoseProviderSnapshot,
} from '../src/plugins/diagnose/search-diagnose-registry';
import type { DiagnoseProvider, DiagnoseResult } from '../src/plugins/diagnose/diagnose-provider';

function fakeProvider(): DiagnoseProvider {
  return {
    diagnose: async (): Promise<DiagnoseResult> => ({ cause: '', remedy: '', sources: [] }),
  };
}

describe('search-diagnose-registry', () => {
  it('getSearchDiagnoseProvider() returns null when nothing registered', () => {
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('registerSearchDiagnoseProvider() makes the provider retrievable', () => {
    const provider = fakeProvider();
    const unregister = registerSearchDiagnoseProvider(provider);
    expect(getSearchDiagnoseProvider()).toBe(provider);
    unregister();
  });

  it('unregister function removes the provider', () => {
    const provider = fakeProvider();
    const unregister = registerSearchDiagnoseProvider(provider);
    unregister();
    expect(getSearchDiagnoseProvider()).toBeNull();
    // Unregistering twice is harmless.
    unregister();
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('unregister of a superseded provider does not remove the newer one', () => {
    const first = fakeProvider();
    const second = fakeProvider();
    const unregisterFirst = registerSearchDiagnoseProvider(first);
    const unregisterSecond = registerSearchDiagnoseProvider(second);
    unregisterFirst();                       // stale unregister — must be a no-op
    expect(getSearchDiagnoseProvider()).toBe(second);
    unregisterSecond();
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('subscribe notifies on register/unregister (useSyncExternalStore contract)', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSearchDiagnoseProvider(listener);
    const before = getSearchDiagnoseProviderSnapshot();

    const unregister = registerSearchDiagnoseProvider(fakeProvider());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSearchDiagnoseProviderSnapshot()).not.toBe(before);

    const afterRegister = getSearchDiagnoseProviderSnapshot();
    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSearchDiagnoseProviderSnapshot()).not.toBe(afterRegister);

    unsubscribe();
    registerSearchDiagnoseProvider(fakeProvider())();   // register + immediate unregister
    expect(listener).toHaveBeenCalledTimes(2);           // unsubscribed — no more calls
  });
});
