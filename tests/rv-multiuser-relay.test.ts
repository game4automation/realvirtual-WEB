// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-multiuser-relay.test.ts — Unit tests for relay-mode multiuser settings.
 *
 * Tests:
 *   - connectionMode defaults to 'local'
 *   - connectionMode 'relay' persists in localStorage
 *   - relayUrl persists and defaults to portal.realvirtual.io
 *   - backward compat: loading old settings without connectionMode returns 'local'
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadMultiuserSettings,
  saveMultiuserSettings,
  type MultiuserSettings,
} from '../src/core/hmi/multiuser-settings-store';

const LS_KEY = 'rv-multiuser-settings';

describe('MultiuserSettings relay mode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should default connectionMode to local', () => {
    const loaded = loadMultiuserSettings();
    expect(loaded.connectionMode).toBe('local');
  });

  it('should default relayUrl to portal.realvirtual.io', () => {
    const loaded = loadMultiuserSettings();
    expect(loaded.relayUrl).toBe('wss://download.realvirtual.io/relay');
  });

  it('should persist connectionMode relay in localStorage', () => {
    const settings = loadMultiuserSettings();
    settings.connectionMode = 'relay';
    settings.relayUrl = 'wss://example.com/relay';
    saveMultiuserSettings(settings);

    const loaded = loadMultiuserSettings();
    expect(loaded.connectionMode).toBe('relay');
    expect(loaded.relayUrl).toBe('wss://example.com/relay');
  });

  it('should preserve all fields on round-trip', () => {
    const settings: MultiuserSettings = {
      enabled: true,
      connectionMode: 'relay',
      serverUrl: 'ws://192.168.1.5:7000',
      relayUrl: 'wss://custom-relay.com/relay',
      displayName: 'TestUser',
      role: 'operator',
      joinCode: 'ABC123',
    };
    saveMultiuserSettings(settings);

    const loaded = loadMultiuserSettings();
    expect(loaded.enabled).toBe(true);
    expect(loaded.connectionMode).toBe('relay');
    expect(loaded.serverUrl).toBe('ws://192.168.1.5:7000');
    expect(loaded.relayUrl).toBe('wss://custom-relay.com/relay');
    expect(loaded.displayName).toBe('TestUser');
    expect(loaded.role).toBe('operator');
    expect(loaded.joinCode).toBe('ABC123');
  });

  it('should handle old settings without connectionMode (backward compat)', () => {
    // Simulate old format stored in localStorage
    const oldSettings = {
      enabled: true,
      serverUrl: 'ws://old-server:7000',
      displayName: 'OldUser',
      role: 'observer',
      joinCode: '',
    };
    localStorage.setItem(LS_KEY, JSON.stringify(oldSettings));

    const loaded = loadMultiuserSettings();
    expect(loaded.connectionMode).toBe('local');
    expect(loaded.relayUrl).toBe('wss://download.realvirtual.io/relay');
    expect(loaded.serverUrl).toBe('ws://old-server:7000');
    expect(loaded.displayName).toBe('OldUser');
  });

  it('should handle corrupted localStorage gracefully', () => {
    localStorage.setItem(LS_KEY, 'not-valid-json{{{');
    const loaded = loadMultiuserSettings();
    expect(loaded.connectionMode).toBe('local');
    expect(loaded.enabled).toBe(true);
  });
});
