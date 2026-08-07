// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * interface-settings-store tests — persistence of the signal-table import
 * "last-used" fields (lastSignalTableName / lastSheetPattern / lastTopicPrefix)
 * and forward-compatible default merge for older persisted blobs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadInterfaceSettings,
  saveInterfaceSettings,
  INTERFACE_DEFAULTS,
} from '../src/interfaces/interface-settings-store';

const STORAGE_KEY = 'rv-interface-settings';

describe('interface-settings-store — import last-used fields', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('defaults the new import fields to empty strings', () => {
    expect(INTERFACE_DEFAULTS.lastSignalTableName).toBe('');
    expect(INTERFACE_DEFAULTS.lastSheetPattern).toBe('');
    expect(INTERFACE_DEFAULTS.lastTopicPrefix).toBe('');

    const settings = loadInterfaceSettings();
    expect(settings.lastSignalTableName).toBe('');
    expect(settings.lastSheetPattern).toBe('');
    expect(settings.lastTopicPrefix).toBe('');
  });

  it('persists and reloads the import last-used fields', () => {
    const settings = loadInterfaceSettings();
    saveInterfaceSettings({
      ...settings,
      lastSignalTableName: 'plc-tags.xlsx',
      lastSheetPattern: 'Data_Q*',
      lastTopicPrefix: 'rv/plc/',
    });

    const reloaded = loadInterfaceSettings();
    expect(reloaded.lastSignalTableName).toBe('plc-tags.xlsx');
    expect(reloaded.lastSheetPattern).toBe('Data_Q*');
    expect(reloaded.lastTopicPrefix).toBe('rv/plc/');
  });

  it('merges defaults for an older persisted blob missing the new fields', () => {
    // Simulate a pre-existing persisted settings object without the new keys.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeType: 'mqtt',
      mqttTopicPrefix: 'legacy/',
    }));

    const settings = loadInterfaceSettings();
    expect(settings.activeType).toBe('mqtt');
    expect(settings.mqttTopicPrefix).toBe('legacy/');
    // New fields fall back to defaults — no migration needed.
    expect(settings.lastSignalTableName).toBe('');
    expect(settings.lastSheetPattern).toBe('');
    expect(settings.lastTopicPrefix).toBe('');
  });
});
