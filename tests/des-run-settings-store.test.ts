// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-260 tests §9.4 — run-settings store (create-store pattern):
 * defaults, patch + localStorage persistence, subscribe/notify, rollSeed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  desRunSettingsStore, getDesRunSettings, updateDesRunSettings,
  rollSeed, __resetDesRunSettingsForTest,
} from '../src/core/hmi/des-run-settings-store';

describe('des-run-settings-store (plan-260 §9.4)', () => {
  beforeEach(() => {
    localStorage.removeItem('rv.des-run-settings');
    __resetDesRunSettingsForTest();
  });

  it('provides conservative defaults (autosave off, fixed seed)', () => {
    const s = getDesRunSettings();
    expect(s.seedMode).toBe('fixed');
    expect(s.autoSaveInterval).toBe(0);
    expect(s.checkpointMax).toBe(10);
    expect(s.retentionMax).toBe(50);
    expect(s.activeProjectId).toBeNull();
  });

  it('patches settings and persists them to localStorage', () => {
    updateDesRunSettings({ seedMode: 'auto', autoSaveInterval: 60 });
    expect(getDesRunSettings().seedMode).toBe('auto');
    expect(getDesRunSettings().autoSaveInterval).toBe(60);
    const raw = JSON.parse(localStorage.getItem('rv.des-run-settings') ?? '{}');
    expect(raw.seedMode).toBe('auto');
    expect(raw.autoSaveInterval).toBe(60);
  });

  it('notifies subscribers on update; snapshot is referentially stable', () => {
    let fired = 0;
    const before = desRunSettingsStore.getSnapshot();
    const unsub = desRunSettingsStore.subscribe(() => fired++);
    expect(desRunSettingsStore.getSnapshot()).toBe(before); // stable until set
    updateDesRunSettings({ checkpointMax: 5 });
    expect(fired).toBe(1);
    expect(desRunSettingsStore.getSnapshot()).not.toBe(before);
    unsub();
    updateDesRunSettings({ checkpointMax: 6 });
    expect(fired).toBe(1);
  });

  it('rollSeed returns positive 31-bit integers (GLB-field safe)', () => {
    for (let i = 0; i < 50; i++) {
      const seed = rollSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThan(0);
      expect(seed).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});
