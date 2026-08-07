// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mode UI-gating tests (plan-198).
 *
 * Validates:
 *   - the `shownOnlyInAny` OR-gate in evaluateVisibilityRule (and that the
 *     existing `shownOnlyIn` ALL-gate is unchanged);
 *   - UIPluginRegistry.register compiling `plugin.modes` into a
 *     `shownOnlyInAny` rule + visibilityId on each slot entry, preserving other
 *     pre-existing rule keys (`shownOnlyIn`/`hiddenIn`) while REPLACING any
 *     pre-existing `shownOnlyInAny`, and leaving shared plugins untouched.
 *
 * Note: `register` spreads the old rule and overwrites the single key
 * `shownOnlyInAny` — it is not a merge of that key. The tests below pin both
 * halves of that distinction. See doc-ui-visibility.md.
 */
import { describe, it, expect } from 'vitest';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { pluginParticipatesInMode } from '../src/core/rv-mode-manager';
import type { ModeId } from '../src/core/rv-mode-manager';
import type { UISlotEntry } from '../src/core/rv-ui-plugin';

const ctx = (...c: string[]) => new Set(c);
const Dummy = (() => null) as unknown as UISlotEntry['component'];

describe('evaluateVisibilityRule — shownOnlyInAny (OR)', () => {
  it('visible when ANY listed context is active', () => {
    const rule = { shownOnlyInAny: ['mode:hmi', 'mode:des'] };
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:des'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:planner'))).toBe(false);
    expect(evaluateVisibilityRule(rule, ctx())).toBe(false);
  });

  it('shownOnlyIn keeps ALL semantics (unchanged)', () => {
    const rule = { shownOnlyIn: ['a', 'b'] };
    expect(evaluateVisibilityRule(rule, ctx('a', 'b'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('a'))).toBe(false);
  });

  it('shownOnlyInAny AND-combines with hiddenIn', () => {
    const rule = { shownOnlyInAny: ['mode:hmi'], hiddenIn: ['fpv'] };
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi', 'fpv'))).toBe(false);
    expect(evaluateVisibilityRule(rule, ctx('fpv'))).toBe(false);
  });

  it('shownOnlyInAny AND-combines with shownOnlyIn', () => {
    const rule = { shownOnlyInAny: ['mode:hmi', 'mode:des'], shownOnlyIn: ['kiosk'] };
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi', 'kiosk'))).toBe(true);
    expect(evaluateVisibilityRule(rule, ctx('mode:hmi'))).toBe(false);     // kiosk missing
    expect(evaluateVisibilityRule(rule, ctx('kiosk'))).toBe(false);        // no mode
  });

  it('empty rule is always visible', () => {
    expect(evaluateVisibilityRule({}, ctx())).toBe(true);
  });
});

describe('UIPluginRegistry — modes → visibility compile', () => {
  it('injects shownOnlyInAny + visibilityId for a single-mode plugin', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'layout-planner',
      modes: ['planner'],
      slots: [{ slot: 'button-group', component: Dummy }],
    });
    const [entry] = reg.getSlotComponents('button-group');
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']);
    expect(entry.visibilityId).toBeTruthy(); // required so HMIShell applies the rule
    expect(entry.pluginId).toBe('layout-planner');
  });

  it('maps multi-mode plugin to multiple mode contexts (OR)', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'shared-ish',
      modes: ['hmi', 'des'],
      slots: [{ slot: 'views', component: Dummy }],
    });
    const [entry] = reg.getSlotComponents('views');
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:hmi', 'mode:des']);
  });

  it('keeps other rule keys and visibilityId when adding shownOnlyInAny', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'planner-btn',
      modes: ['planner'],
      slots: [{
        slot: 'button-group',
        component: Dummy,
        visibilityId: 'planner-grid',
        visibilityRule: { shownOnlyIn: ['planner'] }, // legacy context preserved
      }],
    });
    const [entry] = reg.getSlotComponents('button-group');
    expect(entry.visibilityRule?.shownOnlyIn).toEqual(['planner']);          // kept
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']);  // added
    expect(entry.visibilityId).toBe('planner-grid');                         // kept
  });

  it('leaves shared plugins (no modes) untouched', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'shared',
      slots: [{ slot: 'messages', component: Dummy }],
    });
    const [entry] = reg.getSlotComponents('messages');
    expect(entry.visibilityRule).toBeUndefined();
    expect(entry.visibilityId).toBeUndefined();
  });

  // ── plan-391: the two axes, pinned so they cannot drift apart silently ──

  it('core_PlusModes_RuntimeOnUiGated: core runs everywhere, UI stays mode-gated', () => {
    // The rule that was misread twice: `core: true` + `modes: ['hmi']` means
    // "runtime runs in every mode, UI appears only in hmi". `core` governs
    // participation (rv-mode-manager), `modes` governs slot visibility
    // (rv-ui-registry) — and register() never looks at `core`.
    const plugin = { id: 'camera-startpos', core: true, modes: ['hmi'] as ModeId[] };

    // Axis A — participation: true in EVERY mode, including the null baseline.
    const allModes: (ModeId | null)[] = [null, 'hmi', 'planner', 'des'];
    for (const mode of allModes) {
      expect(pluginParticipatesInMode(plugin, mode)).toBe(true);
    }

    // Axis B — presentation: the slot is gated to hmi only, despite core.
    const reg = new UIPluginRegistry();
    reg.register({ ...plugin, slots: [{ slot: 'button-group', component: Dummy }] });
    const [entry] = reg.getSlotComponents('button-group');
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:hmi']);
    expect(entry.visibilityId).toBeTruthy();

    // And the compiled rule really hides it outside hmi.
    expect(evaluateVisibilityRule(entry.visibilityRule!, ctx('mode:hmi'))).toBe(true);
    expect(evaluateVisibilityRule(entry.visibilityRule!, ctx('mode:planner'))).toBe(false);
  });

  it('registry_ShownOnlyInAny_IsOverwritten: the entry\'s own OR-list is replaced', () => {
    // register() spreads the old rule and overwrites this ONE key.
    // The plugin's `modes` win outright; the entry's own list is lost.
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'planner-only',
      modes: ['planner'],
      slots: [{
        slot: 'button-group',
        component: Dummy,
        visibilityRule: { shownOnlyInAny: ['mode:des', 'mode:hmi'] },
      }],
    });
    const [entry] = reg.getSlotComponents('button-group');
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']);
    expect(entry.visibilityRule?.shownOnlyInAny).not.toContain('mode:des');
    expect(entry.visibilityRule?.shownOnlyInAny).not.toContain('mode:hmi');
  });

  it('registry_OtherRuleKeys_Preserved: hiddenIn/shownOnlyIn survive the spread', () => {
    // The exact distinction the old "merging (not clobbering)" comment blurred:
    // other keys survive, only `shownOnlyInAny` is replaced.
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'planner-grid',
      modes: ['planner'],
      slots: [{
        slot: 'views',
        component: Dummy,
        visibilityRule: {
          shownOnlyIn: ['kiosk'],
          hiddenIn: ['fpv'],
          shownOnlyInAny: ['mode:des'],
        },
      }],
    });
    const [entry] = reg.getSlotComponents('views');
    expect(entry.visibilityRule?.shownOnlyIn).toEqual(['kiosk']);      // preserved
    expect(entry.visibilityRule?.hiddenIn).toEqual(['fpv']);           // preserved
    expect(entry.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']); // replaced
  });
});
