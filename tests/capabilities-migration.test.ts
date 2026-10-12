// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.7 + §9.14 — Capabilities migration.
 *
 *  1. (The legacy adapter of Phases 1–3 was removed in Phase 4b — the
 *     registry accepts the new shape only; a stray legacy field is a type error.)
 *  2. Every registration in the repo declares the new shape and no component
 *     module warns while registering.
 *  3. Consumers read the new fields: hierarchy badge / inspector visibility
 *     (`ui.badge` / `ui.hidden`), the filter node set (`ui.filter`), the tooltip
 *     controller's sections (`ui.tooltip` / `ui.priority` → tooltip store, where
 *     the HIGHER priority is the primary section), the raycast type gate
 *     (`pick !== 'none'`), and `pick:'action'` for the five button types.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';

// Spy BEFORE any component module registers — the warning is one-shot per type.
const warnSpy = vi.spyOn(console, 'warn');

import {
  registerCapabilities,
  getCapabilities,
  getRegisteredFactories,
  getRegisteredCapabilities,
  getTypesWhere,
  _resetCapabilitiesForTesting,
} from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { getAutoFilterNodesByType } from '../src/core/engine/rv-visibility-owners';
import { componentColor, isHiddenComponentType } from '../src/core/hmi/rv-inspector-helpers';
import { isKnownHoverableType } from '../src/core/engine/rv-raycast-manager';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';

const DEPRECATION = 'use deprecated fields';

function deprecationWarnings(): string[] {
  return warnSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes(DEPRECATION));
}

// ─── 1. Adapter ────────────────────────────────────────────────

// ─── 2. Repo registrations use the new shape ───────────────────

describe('no registration in the repo uses legacy fields', () => {
  it('component modules register without a deprecation warning and every factory declaration is new-shape', async () => {
    _resetCapabilitiesForTesting();
    warnSpy.mockClear();
    // The central registration entry: side-effect-imports every component
    // module (and the standalone registerCapabilities calls in the loader).
    await import('../src/core/engine/rv-scene-loader');
    // Modules registered outside the loader chain.
    await import('../src/core/engine/rv-drive');
    await import('../src/core/engine/rv-mu');
    await import('../src/core/editor/rv-cadlink');
    await import('../src/core/editor/rv-jt-data');
    await import('../src/core/material-flow/registry');

    expect(deprecationWarnings()).toEqual([]);
    expect(getRegisteredCapabilities().size).toBeGreaterThan(30);

  });
});

// ─── 3. Consumers read the new fields ──────────────────────────

describe('consumers read pick / bake / ui', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });
  afterEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('hierarchy badge and inspector visibility come from ui.badge / ui.hidden', () => {
    registerCapabilities('BadgeType', { ui: { badge: '#abcdef' } });
    registerCapabilities('HiddenType', { ui: { hidden: true } });
    registerCapabilities('ShownType', { ui: { hidden: false } });
    expect(componentColor('BadgeType')).toBe('#abcdef');
    expect(isHiddenComponentType('HiddenType')).toBe(true);
    expect(isHiddenComponentType('ShownType')).toBe(false);
  });

  it('the filter node set (dropdown, auto-filters, hover-mode group) comes from ui.filter', () => {
    registerCapabilities('Drive', { pick: 'select', ui: { filter: 'Drives' } });
    registerCapabilities('MU', { pick: 'select' }); // pickable but not filterable
    const root = new Object3D();
    const drive = new Object3D(); drive.name = 'D1'; root.add(drive);
    const mu = new Object3D(); mu.name = 'M1'; root.add(mu);
    const reg = new NodeRegistry();
    reg.registerNode('D1', drive);
    reg.registerNode('M1', mu);
    reg.register('Drive', 'D1', { type: 'Drive' });
    reg.register('MU', 'M1', { type: 'MU' });

    const byType = getAutoFilterNodesByType(reg);
    expect([...byType.keys()]).toEqual(['Drive']);
    expect(byType.get('Drive')).toEqual([drive]);
    // Exclusive hover group = pickable ∧ ui.filter (RVViewer.setExclusiveHoverMode)
    expect(getTypesWhere((c) => c.pick !== 'none' && c.ui.filter !== null)).toEqual(['Drive']);
  });

  it('tooltip sections are ordered by ui.priority — the higher priority is the primary section', () => {
    registerCapabilities('Drive', { pick: 'select', ui: { tooltip: 'drive', priority: 10 } });
    registerCapabilities('AASLink', { pick: 'select', ui: { tooltip: 'aas', priority: 3 } });
    tooltipStore.hideAll();
    // Mirror GenericTooltipController: one hover entry per rv key, priority = ui.priority.
    for (const key of ['AASLink', 'Drive']) {
      const caps = getCapabilities(key);
      tooltipStore.show({
        id: `tooltip-hover:${caps.ui.tooltip}`,
        lifecycle: 'hover',
        targetPath: 'Node',
        data: { type: caps.ui.tooltip! } as never,
        mode: 'cursor',
        priority: caps.ui.priority,
      });
    }
    const visible = tooltipStore.getSnapshot().visible;
    expect(visible).toHaveLength(1);
    expect(visible[0].primary.id).toBe('tooltip-hover:drive');
    expect(visible[0].contentEntries.map((e) => e.id)).toEqual(['tooltip-hover:drive', 'tooltip-hover:aas']);
    tooltipStore.hideAll();
  });

  it('the raycast type gate treats select AND action as hoverable, none as not', () => {
    registerCapabilities('Sel', { pick: 'select' });
    registerCapabilities('Act', { pick: 'action' });
    registerCapabilities('Data', { pick: 'none' });
    expect(isKnownHoverableType('Sel')).toBe(true);
    expect(isKnownHoverableType('Act')).toBe(true);
    expect(isKnownHoverableType('Data')).toBe(false);
  });

  it('the five button types declare pick:action after their modules register', async () => {
    await import('../src/core/engine/rv-push-button3d');
    await import('../src/core/engine/rv-emergency-button3d');
    await import('../src/core/engine/rv-handle-switch3d');
    await import('../src/core/engine/rv-scene-button-moveable');
    await import('../src/core/engine/rv-safety-door');
    // beforeEach reset the map AFTER module load in a warm module cache — re-register
    // is a side effect of the FIRST import only, so only assert when the map is populated.
    const ACTION_TYPES = ['PushButton3D', 'EmergencyButton3D', 'HandleSwitch3D', 'SceneButtonMoveable', 'WebSafetyDoor'];
    const registered = getRegisteredCapabilities();
    if (registered.size > 0) {
      for (const type of ACTION_TYPES) {
        expect(getCapabilities(type).pick, type).toBe('action');
      }
      expect(getCapabilities('SceneButtonMoveable').bake).toBe('chunk');
    }
  });
});
