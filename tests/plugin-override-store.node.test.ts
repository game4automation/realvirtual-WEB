// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T8 — the persisted override store: round-trip, filters, resilience.
 * plan-436 T8 — a legacy record naming a now-permanently-protected plugin.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installMemoryLocalStorage } from './helpers/memory-local-storage';
import {
  clearAllOverrides,
  clearOverrides,
  loadOverrides,
  LS_KEY_PLUGIN_OVERRIDES_PREFIX,
  overrideScopeKey,
  registerProtectedPluginIds,
  saveOverrides,
} from '../src/core/plugin-overrides/rv-plugin-override-store';
// Importing the private guards module is what registers the real lock list:
// `registerProtectedPluginIds(PROTECTED_PLUGIN_IDS)` runs as a load side effect.
import { protectedReason } from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/feature-matrix-guards';

beforeAll(() => {
  installMemoryLocalStorage();
});

beforeEach(() => {
  localStorage.clear();
});

describe('plugin override store', () => {
  it('round-trips per scope without leaking between scopes', () => {
    saveOverrides('project-a', ['alpha', 'beta']);
    saveOverrides('project-b', ['gamma']);

    expect(loadOverrides('project-a')).toEqual(['alpha', 'beta']);
    expect(loadOverrides('project-b')).toEqual(['gamma']);
    expect(loadOverrides('project-c')).toEqual([]);
  });

  it('scopes to project first, model second, and refuses an empty scope', () => {
    expect(overrideScopeKey('proj', 'model.glb')).toBe('proj');
    expect(overrideScopeKey(null, 'model.glb')).toBe('model.glb');
    expect(overrideScopeKey(null, null)).toBeNull();
    expect(overrideScopeKey(null, '   ')).toBeNull();
  });

  it('never persists or returns a protected plugin', () => {
    registerProtectedPluginIds(['feature-matrix']);
    saveOverrides('scope', ['feature-matrix', 'harmless']);
    expect(loadOverrides('scope')).toEqual(['harmless']);

    // Even a hand-edited record cannot smuggle one back in.
    localStorage.setItem(
      `${LS_KEY_PLUGIN_OVERRIDES_PREFIX}scope`,
      JSON.stringify({ v: 1, disabled: ['feature-matrix', 'harmless'] }),
    );
    expect(loadOverrides('scope')).toEqual(['harmless']);
  });

  it('removes the entry instead of storing an empty list', () => {
    saveOverrides('scope', ['alpha']);
    saveOverrides('scope', []);
    expect(localStorage.getItem(`${LS_KEY_PLUGIN_OVERRIDES_PREFIX}scope`)).toBeNull();
  });

  it('returns an empty list for broken, foreign or future records', () => {
    const key = `${LS_KEY_PLUGIN_OVERRIDES_PREFIX}scope`;
    for (const raw of ['{not json', '{"v":2,"disabled":["a"]}', '{"v":1}', 'null', '[]']) {
      localStorage.setItem(key, raw);
      expect(() => loadOverrides('scope')).not.toThrow();
      expect(loadOverrides('scope')).toEqual([]);
    }
  });

  // plan-436 T8
  it('discards a legacy record naming a now-permanently-protected plugin', () => {
    // A record written before plan-435/436, when nothing was protected yet.
    localStorage.setItem(
      `${LS_KEY_PLUGIN_OVERRIDES_PREFIX}legacy`,
      JSON.stringify({ v: 1, disabled: ['signal-bind', 'interface-manager', 'drive-axis-gizmo'] }),
    );

    // The two permanently protected ones are dropped on APPLY, not merely on
    // save — a hand-written or stale record must not be able to cripple the
    // viewer. The migrated one survives: it is legitimately switchable now.
    expect(loadOverrides('legacy')).toEqual(['drive-axis-gizmo']);
    expect(protectedReason('signal-bind')).toBe('permanent');
    expect(protectedReason('interface-manager')).toBe('permanent');

    // …and re-saving cannot smuggle them back in either.
    saveOverrides('legacy', ['signal-bind', 'drive-axis-gizmo']);
    expect(loadOverrides('legacy')).toEqual(['drive-axis-gizmo']);
  });

  it('clears one scope and all scopes', () => {
    saveOverrides('a', ['x']);
    saveOverrides('b', ['y']);
    clearOverrides('a');
    expect(loadOverrides('a')).toEqual([]);
    expect(loadOverrides('b')).toEqual(['y']);

    clearAllOverrides();
    expect(loadOverrides('b')).toEqual([]);
  });
});
