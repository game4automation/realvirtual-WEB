// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T4 — UI slots follow the user toggle: they disappear on off, come
 * back in their original position on on, never duplicate, keep their
 * visibility semantics, and survive a later `removePlugin()`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { UISlotEntry } from '../src/core/rv-ui-plugin';
import { createCoreViewer, resetModeStorage } from './helpers/core-toggle-viewer';

const CompA = (() => null) as never;
const CompB = (() => null) as never;
const CompC = (() => null) as never;

beforeEach(() => {
  resetModeStorage();
});

function ids(entries: UISlotEntry[]): (string | undefined)[] {
  return entries.map((e) => e.pluginId);
}

describe('plugin toggle and UI slots', () => {
  it('unregisters slots on off and restores them in place on on', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'a', slots: [{ slot: 'button-group', component: CompA, order: 10 }] });
    viewer.use({ id: 'b', slots: [{ slot: 'button-group', component: CompB, order: 10 }] });
    viewer.use({ id: 'c', slots: [{ slot: 'button-group', component: CompC, order: 10 }] });
    modes.setMode('hmi');
    expect(ids(viewer.uiRegistry.getSlotComponents('button-group'))).toEqual(['a', 'b', 'c']);

    viewer.setPluginUserEnabled('a', false);
    expect(ids(viewer.uiRegistry.getSlotComponents('button-group'))).toEqual(['b', 'c']);

    viewer.setPluginUserEnabled('a', true);
    // Same `order`, so only the stable per-plugin sequence can put 'a' first again.
    expect(ids(viewer.uiRegistry.getSlotComponents('button-group'))).toEqual(['a', 'b', 'c']);
  });

  it('never duplicates slots, no matter how often the toggle is flipped', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'a', slots: [{ slot: 'kpi-bar', component: CompA, order: 10 }] });
    modes.setMode('hmi');

    for (let i = 0; i < 5; i++) {
      viewer.setPluginUserEnabled('a', false);
      viewer.setPluginUserEnabled('a', true);
    }
    expect(viewer.uiRegistry.getSlotComponents('kpi-bar')).toHaveLength(1);

    // A redundant direct register() must not duplicate either.
    viewer.uiRegistry.register(viewer.getPlugin('a')!);
    expect(viewer.uiRegistry.getSlotComponents('kpi-bar')).toHaveLength(1);
  });

  it('keeps the visibility semantics identical across a toggle', () => {
    const { viewer, modes } = createCoreViewer();
    const declared: UISlotEntry[] = [{
      slot: 'views',
      component: CompA,
      order: 20,
      visibilityId: 'my-view',
      visibilityRule: { hiddenIn: ['ctx:viewer'], shownOnlyIn: ['ctx:expert'], shownOnlyInAny: ['ctx:legacy'] },
    }];
    viewer.use({ id: 'gated', modes: ['hmi'], slots: declared });
    modes.setMode('hmi');
    const before = structuredClone(viewer.uiRegistry.getSlotComponents('views')[0].visibilityRule);

    viewer.setPluginUserEnabled('gated', false);
    viewer.setPluginUserEnabled('gated', true);
    const after = viewer.uiRegistry.getSlotComponents('views')[0].visibilityRule;

    expect(after).toEqual(before);
    // The `modes` gate replaced the entry's own OR-list — once, not cumulatively.
    expect(after?.shownOnlyInAny).toEqual(['mode:hmi']);
    expect(after?.hiddenIn).toEqual(['ctx:viewer']);
    expect(after?.shownOnlyIn).toEqual(['ctx:expert']);
  });

  it('never mutates the plugin-owned slot objects', () => {
    const { viewer, modes } = createCoreViewer();
    const declared: UISlotEntry[] = [{
      slot: 'views',
      component: CompA,
      order: 20,
      visibilityRule: { shownOnlyInAny: ['ctx:legacy'] },
    }];
    const pristineRule = structuredClone(declared[0].visibilityRule);
    viewer.use({ id: 'gated', modes: ['hmi'], slots: declared });
    modes.setMode('hmi');
    viewer.setPluginUserEnabled('gated', false);
    viewer.setPluginUserEnabled('gated', true);

    expect(declared[0].pluginId).toBeUndefined();
    expect(declared[0].visibilityId).toBeUndefined();
    expect(declared[0].visibilityRule).toEqual(pristineRule);
  });

  it('removePlugin() after a toggle leaves no slots behind', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'a', slots: [{ slot: 'kpi-bar', component: CompA, order: 10 }] });
    viewer.use({ id: 'b', slots: [{ slot: 'kpi-bar', component: CompB, order: 20 }] });
    modes.setMode('hmi');

    viewer.setPluginUserEnabled('a', false);
    expect(viewer.removePlugin('a')).toBe(true);
    expect(ids(viewer.uiRegistry.getSlotComponents('kpi-bar'))).toEqual(['b']);

    viewer.setPluginUserEnabled('b', false);
    viewer.setPluginUserEnabled('b', true);
    expect(viewer.removePlugin('b')).toBe(true);
    expect(viewer.uiRegistry.getSlotComponents('kpi-bar')).toHaveLength(0);
  });
});
