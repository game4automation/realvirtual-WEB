// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  isProtected,
  protectedReason,
  protectedTooltip,
  PROTECTED_PLUGIN_IDS,
  type ProtectedReason,
} from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/feature-matrix-guards';
import { isPluginOverrideProtected } from '../src/core/plugin-overrides/rv-plugin-override-store';

/**
 * plan-436 T7 — the full lock table. Every protected ID carries BOTH a coarse
 * category and a concrete sentence; nothing is locked "for reasons".
 */
const EXPECTED: Record<string, ProtectedReason> = {
  // The control surface and the one lifecycle that cannot be cut mid-flight.
  'feature-matrix': 'lifecycle',
  'asset-editor': 'lifecycle',
  // plan-436 §2.3 — deliberate, final. `interface-manager` moved here out of
  // LIFECYCLE_PROTECTED: its reason is infrastructure, not interruptibility.
  'interface-manager': 'permanent',
  'connection-system': 'permanent',
  'web-component': 'permanent',
  'signal-bind': 'permanent',
  // plan-436 §2.4 — provisional, the rebuild is real design work.
  'snap-point': 'teardown-missing',
  'ik-target-edit': 'teardown-missing',
};

/** plan-436 Phase 1 — the three that gained onDeactivate/onActivate. */
const MIGRATED = ['drive-axis-gizmo', 'ik-path-visualizer', 'connection-gizmo'];

describe('feature matrix toggle guards', () => {
  it('locks exactly the expected IDs, each with its category', () => {
    for (const [id, reason] of Object.entries(EXPECTED)) {
      expect(isProtected(id), id).toBe(true);
      expect(protectedReason(id), id).toBe(reason);
    }
    expect([...PROTECTED_PLUGIN_IDS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('gives every locked plugin its own explanation', () => {
    const seen = new Map<string, string>();
    for (const id of Object.keys(EXPECTED)) {
      const tooltip = protectedTooltip(id);
      expect(tooltip.length, id).toBeGreaterThan(20);
      // Not a shared boilerplate line — the point of plan-436 F6.
      expect(seen.has(tooltip), `${id} shares its tooltip with ${seen.get(tooltip)}`).toBe(false);
      seen.set(tooltip, id);
    }
  });

  it('does not describe a permanent lock as "not implemented yet"', () => {
    for (const [id, reason] of Object.entries(EXPECTED)) {
      const provisional = /noch nicht implementiert|not implemented yet/i.test(protectedTooltip(id));
      expect(provisional, id).toBe(reason === 'teardown-missing');
    }
  });

  it('releases the three plugins migrated in plan-436', () => {
    for (const id of MIGRATED) {
      expect(isProtected(id), id).toBe(false);
      expect(protectedReason(id), id).toBeNull();
      expect(isPluginOverrideProtected(id), id).toBe(false);
    }
  });

  it('leaves other and unknown plugins toggleable', () => {
    expect(isProtected('des-plugin')).toBe(false);
    expect(isProtected('unknown')).toBe(false);
    expect(protectedReason('unknown')).toBeNull();
    expect(protectedTooltip('unknown')).toBe('');
  });

  it('hands the public override store plain IDs, not [id, reason] pairs', () => {
    // `registerProtectedPluginIds(ids: Iterable<string>)` receives the derived
    // SET. Handing it a Map would iterate `[id, reason]` ARRAYS and register no
    // usable ID — after which a persisted override could disable a protected
    // plugin (plan-436 §2.5). Every locked ID must answer true, and a
    // stringified pair must NOT be in the store.
    for (const id of Object.keys(EXPECTED)) {
      expect(isPluginOverrideProtected(id), id).toBe(true);
    }
    expect(isPluginOverrideProtected('feature-matrix,lifecycle')).toBe(false);
    expect(isPluginOverrideProtected('des-plugin')).toBe(false);
  });
});
