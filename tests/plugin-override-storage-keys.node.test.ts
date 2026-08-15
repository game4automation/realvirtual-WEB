// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T9 — the override prefix is a known RV storage key.
 *
 * Without the entry in `RV_DYNAMIC_PREFIXES` a "Reset all" would wipe
 * everything EXCEPT the plugin overrides, leaving a plugin the user switched
 * off switched off forever with no visible cause.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installMemoryLocalStorage } from './helpers/memory-local-storage';
import { clearAllRVStorage, RV_DYNAMIC_PREFIXES } from '../src/core/hmi/rv-storage-keys';
import {
  LS_KEY_PLUGIN_OVERRIDES_PREFIX,
  loadOverrides,
  saveOverrides,
} from '../src/core/plugin-overrides/rv-plugin-override-store';

beforeAll(() => {
  installMemoryLocalStorage();
});

beforeEach(() => {
  localStorage.clear();
});

describe('plugin override storage keys', () => {
  it('lists the override prefix among the dynamic RV prefixes', () => {
    expect(RV_DYNAMIC_PREFIXES).toContain(LS_KEY_PLUGIN_OVERRIDES_PREFIX);
  });

  it('is swept by clearAllRVStorage() across every scope', () => {
    saveOverrides('project-a', ['alpha']);
    saveOverrides('project-b', ['beta']);
    localStorage.setItem('unrelated-key', 'keep me');

    clearAllRVStorage();

    expect(loadOverrides('project-a')).toEqual([]);
    expect(loadOverrides('project-b')).toEqual([]);
    // A foreign key must survive — the sweep is prefix-scoped, not a wipe.
    expect(localStorage.getItem('unrelated-key')).toBe('keep me');
  });
});
