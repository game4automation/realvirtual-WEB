// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.1 — `computeToolSections`, the pure split of the floating tool
 * toolbar (`button-group` slot) into ranked sections, and the `slotKey` the
 * registry stamps so a rendered entry keeps its identity.
 *
 * Phase 1 covers the section logic and the keys; Phase 2 adds the
 * `AUTHORING_TOOL_RULE` cases (below).
 */

import { describe, expect, it } from 'vitest';
import {
  TOOL_GROUP, TOOL_GROUP_LABEL, TOOL_GROUP_RANK, UNGROUPED_SECTION_KEY,
  computeToolSections, countToolEntries, isToolEntryVisible,
} from '../src/core/hmi/button-panel-sections';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import type { UISlotEntry } from '../src/core/rv-ui-plugin';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import { modeContext } from '../src/core/rv-mode-manager';
import { AUTHORING_LIVE_CONTEXT, AUTHORING_MODES, AUTHORING_TOOL_RULE } from '../src/plugins/layout-planner/authoring-modes';

/** A distinguishable dummy component per entry (identity is all the tests need). */
function comp(name: string): UISlotEntry['component'] {
  const c = () => null;
  Object.defineProperty(c, 'name', { value: name });
  return c as unknown as UISlotEntry['component'];
}

function entry(name: string, extra: Partial<UISlotEntry> = {}): UISlotEntry {
  return { slot: 'button-group', component: comp(name), ...extra };
}

const NO_CONTEXTS: ReadonlySet<string> = new Set();

/** Section keys and, per section, the component names in order. */
function shape(sections: ReturnType<typeof computeToolSections>): Array<[string, string[]]> {
  return sections.map((s) => [s.key, s.entries.map((e) => e.entry.component.name)]);
}

function registryEntries(reg: UIPluginRegistry): UISlotEntry[] {
  return reg.getSlotComponents('button-group');
}

describe('computeToolSections', () => {
  it('without any group returns ONE section in registry order (compat)', () => {
    const reg = new UIPluginRegistry();
    reg.register({ id: 'p1', slots: [entry('b', { order: 20 }), entry('a', { order: 10 })] });
    reg.register({ id: 'p2', slots: [entry('c', { order: 15 })] });

    const sections = computeToolSections(registryEntries(reg), NO_CONTEXTS, null);

    expect(shape(sections)).toEqual([[UNGROUPED_SECTION_KEY, ['a', 'c', 'b']]]);
    // The ungrouped section has no accessible name (ButtonPanel gives it no role).
    expect(sections[0].label).toBe('');
  });

  it('orders sections ungrouped → editing → model → analysis → view → unknown', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'p',
      slots: [
        entry('custom', { group: 'my-tools', order: 1 }),
        entry('view', { group: TOOL_GROUP.view, order: 2 }),
        entry('analysis', { group: TOOL_GROUP.analysis, order: 3 }),
        entry('model', { group: TOOL_GROUP.model, order: 4 }),
        entry('editing', { group: TOOL_GROUP.editing, order: 5 }),
        entry('plain', { order: 6 }),
      ],
    });

    const sections = computeToolSections(registryEntries(reg), NO_CONTEXTS, null);

    expect(sections.map((s) => s.key)).toEqual([
      UNGROUPED_SECTION_KEY, 'editing', 'model', 'analysis', 'view', 'my-tools',
    ]);
    expect(sections.map((s) => s.label)).toEqual([
      '', TOOL_GROUP_LABEL.editing, TOOL_GROUP_LABEL.model, TOOL_GROUP_LABEL.analysis,
      TOOL_GROUP_LABEL.view, 'my-tools',
    ]);
    // The rank table is the contract the plan pins (2.3).
    expect(TOOL_GROUP_RANK).toEqual({ editing: 10, model: 20, analysis: 30, view: 40 });
  });

  it('keeps order WITHIN a section and ignores order ACROSS sections', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'p',
      slots: [
        entry('clip', { group: 'view', order: 65 }),
        entry('docMode', { group: 'view', order: 300 }),
        entry('delete', { group: 'editing', order: 270 }),
        entry('undo', { group: 'editing', order: 250 }),
        entry('redo', { group: 'editing', order: 260 }),
      ],
    });

    const sections = computeToolSections(registryEntries(reg), NO_CONTEXTS, null);

    // Clip (65) renders AFTER Delete (270): the section rank wins over `order`.
    expect(shape(sections)).toEqual([
      ['editing', ['undo', 'redo', 'delete']],
      ['view', ['clip', 'docMode']],
    ]);
  });

  it("applies today's filter: rule → evaluate; no rule → hidden in focused modes", () => {
    const all = [
      entry('noRule'),
      entry('plannerOnly', { visibilityRule: { shownOnlyIn: ['planner'] } }),
      entry('notInFpv', { visibilityRule: { hiddenIn: ['fpv'] } }),
    ];

    // Default workspace (hmi) and "no mode yet" (null): rule-less entries show.
    expect(shape(computeToolSections(all, NO_CONTEXTS, 'hmi'))).toEqual([[UNGROUPED_SECTION_KEY, ['noRule', 'notInFpv']]]);
    expect(shape(computeToolSections(all, NO_CONTEXTS, null))).toEqual([[UNGROUPED_SECTION_KEY, ['noRule', 'notInFpv']]]);
    // A focused mode (DES): only entries that opt in through a rule.
    expect(shape(computeToolSections(all, new Set(['planner']), 'des'))).toEqual([[UNGROUPED_SECTION_KEY, ['plannerOnly', 'notInFpv']]]);
    expect(shape(computeToolSections(all, new Set(['fpv']), 'des'))).toEqual([]);

    expect(isToolEntryVisible(all[0], NO_CONTEXTS, 'planner')).toBe(false);
    expect(isToolEntryVisible(all[0], NO_CONTEXTS, 'hmi')).toBe(true);
  });

  it('a section whose entries are all filtered out is left out entirely', () => {
    const all = [
      entry('undo', { group: 'editing', visibilityRule: { shownOnlyIn: ['planner'] } }),
      entry('clip', { group: 'view', visibilityRule: {} }),
    ];
    const sections = computeToolSections(all, NO_CONTEXTS, 'des');
    expect(shape(sections)).toEqual([['view', ['clip']]]);
    expect(countToolEntries(sections)).toBe(1);
  });

  it('keys come from slotKey and survive a plugin registering EARLIER-sorted entries', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'layout-planner',
      slots: [
        entry('snap', { group: 'model', order: 200 }),
        entry('undo', { group: 'editing', order: 250 }),
      ],
    });
    const keysBefore = new Map(
      computeToolSections(registryEntries(reg), NO_CONTEXTS, null)
        .flatMap((s) => s.entries.map((e) => [e.entry.component.name, e.key] as const)),
    );
    expect(keysBefore.get('snap')).toBe('layout-planner:button-group:0');
    expect(keysBefore.get('undo')).toBe('layout-planner:button-group:1');

    // The on-demand DES plugin arrives later with LOWER orders (50-53) in the
    // SAME section family — a list index would shift every planner key.
    reg.register({
      id: 'des-hmi',
      slots: [entry('stats', { group: 'analysis', order: 50 }), entry('lib', { group: 'model', order: 51 })],
    });
    const after = computeToolSections(registryEntries(reg), NO_CONTEXTS, null);
    const keysAfter = new Map(after.flatMap((s) => s.entries.map((e) => [e.entry.component.name, e.key] as const)));

    expect(keysAfter.get('snap')).toBe(keysBefore.get('snap'));
    expect(keysAfter.get('undo')).toBe(keysBefore.get('undo'));
    expect(keysAfter.get('lib')).toBe('des-hmi:button-group:1');
    // `lib` (51) now sorts BEFORE `snap` (200) inside model — the keys did not care.
    expect(shape(after).find(([k]) => k === 'model')?.[1]).toEqual(['lib', 'snap']);
  });

  it('unknown groups sort after view, tie by smallest member order', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'p',
      slots: [
        entry('zeta1', { group: 'zeta', order: 30 }),
        entry('alpha1', { group: 'alpha', order: 80 }),
        entry('view1', { group: 'view', order: 500 }),
        entry('zeta2', { group: 'zeta', order: 90 }),
        entry('alpha2', { group: 'alpha', order: 20 }),
        entry('beta1', { group: 'beta', order: 20 }),
      ],
    });

    const sections = computeToolSections(registryEntries(reg), NO_CONTEXTS, null);

    // alpha (min 20) and beta (min 20) tie on order → first appearance (alpha2
    // sorts before beta1 in the registry); zeta (min 30) follows.
    expect(sections.map((s) => s.key)).toEqual(['view', 'alpha', 'beta', 'zeta']);
    expect(shape(sections).find(([k]) => k === 'alpha')?.[1]).toEqual(['alpha2', 'alpha1']);
  });

  it('group ids that name Object.prototype members are ordinary unknown groups (Codex P1 #3)', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'p',
      slots: [
        entry('ctor', { group: 'constructor', order: 5 }),
        entry('view1', { group: 'view', order: 900 }),
        entry('str', { group: 'toString', order: 6 }),
        entry('proto', { group: '__proto__', order: 7 }),
      ],
    });
    const sections = computeToolSections(registryEntries(reg), NO_CONTEXTS, null);
    // After `view` (rank 1000, not an inherited function), tie on member order.
    expect(sections.map((s) => s.key)).toEqual(['view', 'constructor', 'toString', '__proto__']);
    expect(sections.map((s) => s.label)).toEqual([TOOL_GROUP_LABEL.view, 'constructor', 'toString', '__proto__']);
  });

  it("an empty or explicit 'ungrouped' group joins the implicit first section", () => {
    const all = [entry('a', { group: '' }), entry('b', { group: UNGROUPED_SECTION_KEY }), entry('c')];
    expect(shape(computeToolSections(all, NO_CONTEXTS, null))).toEqual([[UNGROUPED_SECTION_KEY, ['a', 'b', 'c']]]);
  });

  it('falls back to a positional key without slotKey and never yields duplicate keys', () => {
    const shared = entry('x', { slotKey: 'same' });
    const all = [entry('noKey'), shared, { ...shared, component: comp('y') }];
    const keys = computeToolSections(all, NO_CONTEXTS, null)[0].entries.map((e) => e.key);
    expect(keys).toEqual(['idx:0', 'same', 'same#1']);
  });
});

describe('UIPluginRegistry slotKey stamping (plan-2010)', () => {
  it('stamps `${pluginId}:${slot}:${declarationIndex}` on its copy, never on the plugin object', () => {
    const reg = new UIPluginRegistry();
    const slots = [
      entry('a', { order: 10 }),
      { slot: 'kpi-bar' as const, component: comp('k'), order: 5 },
      entry('b', { order: 1 }),
    ];
    reg.register({ id: 'demo', slots });

    expect(registryEntries(reg).map((e) => e.slotKey)).toEqual(['demo:button-group:2', 'demo:button-group:0']);
    expect(reg.getSlotComponents('kpi-bar')[0].slotKey).toBe('demo:kpi-bar:1');
    // NON-MUTATING (plan-435): the declaration stays pristine.
    expect(slots.every((s) => !('slotKey' in s))).toBe(true);
  });

  it('a re-registered plugin keeps the same keys', () => {
    const reg = new UIPluginRegistry();
    const plugin = { id: 'demo', slots: [entry('a'), entry('b')] };
    reg.register(plugin);
    const first = registryEntries(reg).map((e) => e.slotKey);
    reg.unregister('demo');
    reg.register(plugin);
    expect(registryEntries(reg).map((e) => e.slotKey)).toEqual(first);
  });

  it('anonymous entries get unique `anon:` keys', () => {
    const reg = new UIPluginRegistry();
    reg.register({ slots: [entry('a'), entry('b')] });
    reg.register({ slots: [entry('c')] });
    const keys = registryEntries(reg).map((e) => e.slotKey!);
    expect(keys.every((k) => k.startsWith('anon:'))).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });

  it('a plugin-declared group survives registration unchanged', () => {
    const reg = new UIPluginRegistry();
    reg.register({ id: 'p', modes: ['planner'], slots: [entry('a', { group: 'model' })] });
    const [e] = registryEntries(reg);
    expect(e.group).toBe('model');
    expect(e.visibilityRule?.shownOnlyInAny).toEqual(['mode:planner']);
  });
});

describe('AUTHORING_TOOL_RULE', () => {
  it('equals shownOnlyIn planner + shownOnlyInAny of modeContext(planner|des)', () => {
    expect(AUTHORING_LIVE_CONTEXT).toBe('planner');
    expect(AUTHORING_TOOL_RULE.shownOnlyIn).toEqual([AUTHORING_LIVE_CONTEXT]);
    expect(AUTHORING_TOOL_RULE.shownOnlyInAny).toEqual(AUTHORING_MODES.map((m) => modeContext(m)));
    expect(AUTHORING_TOOL_RULE.shownOnlyInAny).toEqual(['mode:planner', 'mode:des']);
  });

  it('is visible in planner and des with authoring live, hidden elsewhere', () => {
    const live = (mode: string) => new Set<string>([AUTHORING_LIVE_CONTEXT, `mode:${mode}`]);
    expect(evaluateVisibilityRule(AUTHORING_TOOL_RULE, live('planner'))).toBe(true);
    expect(evaluateVisibilityRule(AUTHORING_TOOL_RULE, live('des'))).toBe(true);
    for (const mode of ['hmi', 'editor', 'commissioning', 'viewer']) {
      // even a stale authoring context must not show the tools outside the authoring modes
      expect(evaluateVisibilityRule(AUTHORING_TOOL_RULE, live(mode))).toBe(false);
    }
    // the mode alone is not enough: authoring has to be live
    expect(evaluateVisibilityRule(AUTHORING_TOOL_RULE, new Set(['mode:planner']))).toBe(false);
  });

  it('survives registration in a plugin WITH and WITHOUT `modes` (spread copy, no shared arrays)', () => {
    const reg = new UIPluginRegistry();
    reg.register({
      id: 'with-modes', modes: ['planner', 'des'],
      slots: [entry('a', { group: 'model', visibilityRule: { ...AUTHORING_TOOL_RULE } })],
    });
    reg.register({ id: 'core-plugin', slots: [entry('b', { group: 'model', visibilityRule: { ...AUTHORING_TOOL_RULE } })] });
    const live = new Set<string>([AUTHORING_LIVE_CONTEXT, 'mode:des']);
    const sections = computeToolSections(registryEntries(reg), live, 'des');
    expect(shape(sections)).toEqual([['model', ['a', 'b']]]);
    expect(computeToolSections(registryEntries(reg), new Set(['mode:hmi']), 'hmi')).toEqual([]);
    // the shared constant was never mutated
    expect(AUTHORING_TOOL_RULE.shownOnlyInAny).toEqual(['mode:planner', 'mode:des']);
  });
});
