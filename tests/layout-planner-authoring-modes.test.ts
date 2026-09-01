// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Authoring modes — the planner participates in DES as well as in planner mode.
 *
 * ## Why this test exists
 *
 * Magnetic snap does not own a drag. It arms on `layout-drag-start/tick/end`,
 * and those three events are emitted from exactly one place: the layout
 * planner's TransformControls handler. So "enable magnetic snap in DES" is not
 * a snap-point change at all — it is the question of whether the PLANNER runs
 * in DES. If it does not, there is no drag in that mode and nothing for the
 * snap system to attach to; gating the snap system alone would be dead code.
 *
 * These tests pin the two independent gates that both resolve from
 * {@link AUTHORING_MODES} (doc-ui-visibility.md):
 *   - participation — `modes` → `pluginParticipatesInMode`;
 *   - presentation — the UI registry compiling `modes` into `shownOnlyInAny`.
 *
 * The third gate, the legacy `'planner'` UI CONTEXT, is deliberately NOT
 * per-mode: `setActive()` sets it, and everything downstream (the toolbar
 * slots, snap-point's `_applyMode`, its magnetic arming and its chain preview)
 * reads it as "authoring is live". That is why enabling participation was
 * enough and no snap-point file needed touching.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTHORING_MODES,
  isAuthoringMode,
  LayoutPlannerPlugin,
} from '../src/plugins/layout-planner';
import { pluginParticipatesInMode } from '../src/core/rv-mode-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { modeContext } from '../src/core/rv-mode-manager';

describe('AUTHORING_MODES', () => {
  it('is the planner and DES workspaces', () => {
    expect([...AUTHORING_MODES]).toEqual(['planner', 'des']);
  });

  it('isAuthoringMode answers for every mode and for null', () => {
    expect(isAuthoringMode('planner')).toBe(true);
    expect(isAuthoringMode('des')).toBe(true);
    expect(isAuthoringMode('hmi')).toBe(false);
    expect(isAuthoringMode('editor')).toBe(false);
    expect(isAuthoringMode(null)).toBe(false);
    expect(isAuthoringMode(undefined)).toBe(false);
  });
});

describe('LayoutPlannerPlugin participation', () => {
  const plugin = new LayoutPlannerPlugin();

  it('participates in every authoring mode', () => {
    for (const m of AUTHORING_MODES) {
      expect(pluginParticipatesInMode(plugin, m)).toBe(true);
    }
  });

  it('does NOT participate outside them — the drag must stay out of HMI', () => {
    expect(pluginParticipatesInMode(plugin, 'hmi')).toBe(false);
    expect(pluginParticipatesInMode(plugin, 'editor')).toBe(false);
    expect(pluginParticipatesInMode(plugin, null)).toBe(false);
  });

  it('declares its modes FROM the shared set, not a second literal list', () => {
    // A copy is fine (readonly → mutable array); a divergent list is not. This
    // is the guard against a fifth place spelling the modes out again.
    expect(plugin.modes).toEqual([...AUTHORING_MODES]);
  });
});

describe('UI slot gating follows the same set', () => {
  it('compiles every slot to shownOnlyInAny over the authoring mode contexts', () => {
    const plugin = new LayoutPlannerPlugin();
    const registry = new UIPluginRegistry();
    registry.register(plugin);

    const expected = AUTHORING_MODES.map((m) => modeContext(m));
    const slots = [...new Set(plugin.slots.map((s) => s.slot))];
    expect(slots.length).toBeGreaterThan(0);

    let seen = 0;
    for (const slot of slots) {
      for (const entry of registry.getSlotComponents(slot)) {
        seen += 1;
        expect(entry.visibilityRule?.shownOnlyInAny).toEqual(expected);
      }
    }
    // Every declared slot came back — otherwise the assertion above could pass
    // vacuously on an empty registry.
    expect(seen).toBe(plugin.slots.length);
  });

  it('leaves the legacy shownOnlyIn planner-context gate alone', () => {
    // The toolbar buttons gate on the 'planner' CONTEXT, which setActive sets
    // in every authoring mode. Rewriting it per-mode would have been the wrong
    // fix — the context means "authoring is live", not "mode is planner".
    const plugin = new LayoutPlannerPlugin();
    const legacy = plugin.slots.filter((s) => s.visibilityRule?.shownOnlyIn);
    expect(legacy.length).toBeGreaterThan(0);
    for (const entry of legacy) {
      expect(entry.visibilityRule?.shownOnlyIn).toEqual(['planner']);
    }
  });
});
