// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';

const load = () => import('../src/core/drop-detection-settings-store');

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('drop detection browser preference (E5)', () => {
  it('defaults to on for absent, malformed or incorrectly typed storage', async () => {
    const { parseStoredDropDetectionSettings: parse } = await load();
    for (const raw of [null, '', '{', 'null', 'false', '{}', '{"enabled":"false"}']) {
      expect(parse(raw)).toEqual({ enabled: true });
    }
    expect(parse('{"enabled":false}')).toEqual({ enabled: false });
  });

  it('loads and persists the preference across reloads with stable snapshots and unsubscribe', async () => {
    let stored: string | null = '{"enabled":false}';
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => { expect(key).toBe('rv-drop-detection-settings'); return stored; },
      setItem: (_key: string, value: string) => { stored = value; },
    });
    const store = await load();
    expect(store.getDropDetectionSettings().enabled).toBe(false);
    const before = store.getDropDetectionSettings();
    const listener = vi.fn();
    const unsub = store.subscribeDropDetectionSettings(listener);
    store.setDropDetectionEnabled(false);
    expect(store.getDropDetectionSettings()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    store.setDropDetectionEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stored).toBe('{"enabled":true}');
    unsub();
    store.setDropDetectionEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.resetModules();
    expect((await load()).getDropDetectionSettings().enabled).toBe(false);
  });

  it('keeps working when storage access throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('unavailable'); },
      setItem: () => { throw new Error('quota'); },
    });
    const store = await load();
    expect(store.getDropDetectionSettings().enabled).toBe(true);
    expect(() => store.setDropDetectionEnabled(false)).not.toThrow();
    expect(store.getDropDetectionSettings().enabled).toBe(false);
  });
});
