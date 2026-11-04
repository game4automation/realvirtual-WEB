// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The HMI guard rail (plan-423 §9.2, F3).
 *
 * The user's hard constraint for plan-423 was one sentence: *"aber hmi soll so
 * bleiben wie es ist (war)"*. The lean commissioning surface had to be built by
 * ADDING a workspace, never by taking anything out of the HMI. This file is the
 * permanent pin for that promise, and it is deliberately blunt: it writes down
 * the FULL expected `hiddenIn` list of every rule the plan touched, so a future
 * edit that reorders, drops or re-purposes one of those strings fails here with
 * the diff in the message — not three workspaces later in a customer deploy.
 *
 * Why the rules are read out of the SOURCE: they are literals inside
 * `App.tsx` / `TopBar.tsx` / `ActivityBar.tsx`, and rendering the real shell
 * needs a viewer, a renderer and a model. `?raw` + `evaluateVisibilityRule` is
 * the established precedent in this suite (rv-viewer-mode.test.ts) and it
 * evaluates the shipped rule rather than a copy of it.
 */
import { describe, it, expect } from 'vitest';
import { evaluateVisibilityRule, type UIVisibilityRule } from '../src/core/hmi/ui-context-store';
import { modeContext, type ModeId } from '../src/core/rv-mode-manager';
import { LEFT_PANEL_GATES } from '../src/core/hmi/left-panel-visibility';
import { KPI_BAR_DEFAULT_RULE } from '../src/core/hmi/KpiBar';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import type { UISlot, UISlotEntry } from '../src/core/rv-ui-plugin';

import appSource from '../src/core/hmi/App.tsx?raw';
import topBarSource from '../src/core/hmi/TopBar.tsx?raw';
import activityBarSource from '../src/core/hmi/ActivityBar.tsx?raw';

import { DemoHMIPlugin } from '../src/plugins/demo/demo-hmi-plugin';
import { KioskPlugin } from '../src/plugins/kiosk-plugin';
import { WebComponentPlugin } from '../src/plugins/web-component-plugin';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';

/**
 * Rules the shell no longer spells out inline but registers through an exported
 * constant, because something else has to read the same default (plan-2047:
 * `14706193` moved the KPI rule into `KPI_BAR_DEFAULT_RULE` so
 * `SimulatedKpiPlugin` could lift single contexts from it).
 *
 * The constant is IMPORTED here, so this file compares against the shipped
 * value rather than a copy of its source text. The wiring — that `App.tsx`
 * really registers this id with THIS constant — is still read out of the
 * source below; without that half the comparison would only check the constant
 * against itself.
 */
const RULE_CONSTANTS: Record<string, UIVisibilityRule> = {
  KPI_BAR_DEFAULT_RULE,
};

function hiddenInOf(source: string, id: string): string[] {
  const inline = new RegExp(`useUIVisible\\('${id}',\\s*\\{\\s*hiddenIn:\\s*\\[([^\\]]*)\\]`);
  const m = inline.exec(source);
  if (m) return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  // Second accepted form: the rule is a named constant this file imports.
  const named = new RegExp(`useUIVisible\\('${id}',\\s*([A-Z][A-Z0-9_]*)\\s*\\)`).exec(source);
  if (named) {
    const rule = RULE_CONSTANTS[named[1]];
    if (!rule) {
      throw new Error(
        `useUIVisible('${id}', ${named[1]}) registers a constant this test does not import — ` +
        `add it to RULE_CONSTANTS so its value is pinned`);
    }
    return [...(rule.hiddenIn ?? [])];
  }
  throw new Error(`no useUIVisible('${id}', …) with an inline rule or a known constant in source`);
}

const HMI = new Set([modeContext('hmi')]);

function entriesFor(plugin: object, slot: UISlot): UISlotEntry[] {
  const reg = new UIPluginRegistry();
  reg.register(plugin as Parameters<UIPluginRegistry['register']>[0]);
  return reg.getSlotComponents(slot);
}

/** ButtonPanel.tsx — ruleless entries are hidden in any focused (non-hmi) mode. */
function buttonPanelShows(
  entry: UISlotEntry, contexts: ReadonlySet<string>, activeMode: ModeId | null,
): boolean {
  if (entry.visibilityRule) return evaluateVisibilityRule(entry.visibilityRule, contexts);
  return !(activeMode !== null && activeMode !== 'hmi');
}

// ─── The exact rules, as they must read ───────────────────────────────────

/**
 * Every rule plan-423 appended a string to, with its COMPLETE expected list.
 * The 'mode:commissioning' entry is last in each — it was appended, and the
 * order proves it: nothing before it moved.
 */
const TOUCHED_RULES: Array<[string, string, string[]]> = [
  ['kpi-bar', appSource,
    ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning']],
  ['message-panel', appSource,
    ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning']],
  ['views-slot', appSource,
    ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning']],
  ['ai-activity-overlay', appSource, ['mode:viewer', 'mode:commissioning']],
];

/** Rules the plan must NOT have touched — pinned in full for the same reason. */
const UNTOUCHED_RULES: Array<[string, string, string[]]> = [
  ['top-bar', appSource, ['xr']],
  ['activity-bar', appSource, ['fpv', 'xr']],
  ['button-panel', appSource, ['fpv', 'xr', 'mode:viewer']],
  ['search-bar', appSource, ['fpv', 'xr', 'mode:viewer']],
  ['sensor-history-panel', appSource, ['mode:viewer']],
  ['context-menu', appSource, ['mode:viewer']],
  ['sig-warning-banner', appSource, ['mode:viewer']],
  ['news-dialog', appSource, ['mode:viewer']],
  ['property-inspector', topBarSource, ['mode:viewer']],
  ['aas-detail-panel', topBarSource, ['mode:viewer']],
  ['activity-hierarchy', activityBarSource, ['mode:viewer']],
  ['activity-ai-bridge', activityBarSource, ['mode:viewer']],
  ['activity-projects', activityBarSource, ['mode:viewer']],
];

describe('hmiMode_ElementMatrixUnchanged', () => {
  for (const [id, source] of [...TOUCHED_RULES, ...UNTOUCHED_RULES]) {
    it(`'${id}' is visible in HMI`, () => {
      expect(evaluateVisibilityRule({ hiddenIn: hiddenInOf(source, id) }, HMI)).toBe(true);
    });
  }

  it('no rule in the HMI shell mentions hmi — the workspace is gated by nobody', () => {
    // The single sharpest way the guard rail could be broken: someone "cleans
    // up" by hiding an element in hmi instead of adding it to a new mode.
    for (const [id, source] of [...TOUCHED_RULES, ...UNTOUCHED_RULES]) {
      expect(hiddenInOf(source, id), id).not.toContain('mode:hmi');
    }
  });

  it('the four touched rules read exactly as expected — commissioning APPENDED', () => {
    for (const [id, source, expected] of TOUCHED_RULES) {
      expect(hiddenInOf(source, id), id).toEqual(expected);
      expect(expected[expected.length - 1]).toBe('mode:commissioning');
    }
  });

  // plan-2047 §9.2(b) — the WIRING half, kept separate so it cannot quietly be
  // lost. The assertion above now compares against an imported constant; on its
  // own that would only check the constant against itself. This one states what
  // the pin was always for: App.tsx registers 'kpi-bar' with THAT constant.
  it('App.tsx registers kpi-bar with the exported default rule, not a private copy', () => {
    expect(appSource).toContain("useUIVisible('kpi-bar', KPI_BAR_DEFAULT_RULE)");
    expect(appSource).toContain("from './KpiBar'");
    // And the constant's value is the list plan-423 promised, last entry included.
    expect(KPI_BAR_DEFAULT_RULE.hiddenIn).toEqual(
      ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning']);
  });

  it('every other gated element is untouched, string for string', () => {
    for (const [id, source, expected] of UNTOUCHED_RULES) {
      expect(hiddenInOf(source, id), id).toEqual(expected);
      expect(hiddenInOf(source, id), id).not.toContain('mode:commissioning');
    }
  });

  it('the left panels are all reachable in HMI and none gained a rule', () => {
    for (const gate of LEFT_PANEL_GATES) {
      expect(evaluateVisibilityRule(gate.rule, HMI), gate.id).toBe(true);
      expect(gate.rule.hiddenIn, gate.id).toEqual(['mode:viewer']);
    }
  });
});

describe('hmiMode_ButtonPanelUnchanged', () => {
  it('the operator buttons still show in HMI and still carry no rule', () => {
    for (const plugin of [new DemoHMIPlugin(), new KioskPlugin(), new WebComponentPlugin({ allowScripts: true })]) {
      for (const entry of entriesFor(plugin, 'button-group')) {
        expect(entry.visibilityRule).toBeUndefined();
        expect(buttonPanelShows(entry, HMI, 'hmi')).toBe(true);
      }
    }
  });

  it('the three tools still show in HMI after the opt-in edits', () => {
    const tools: Array<[string, object]> = [
      ['test-axes', new TestAxesPlugin()],
      ['measurements', new MeasurementPlugin()],
      ['clipping', new ClippingPlugin()],
    ];
    for (const [name, plugin] of tools) {
      const [entry] = entriesFor(plugin, 'button-group');
      expect(buttonPanelShows(entry, HMI, 'hmi'), name).toBe(true);
    }
  });

  it('signal linking is NOT in HMI — link mode and bindings overview (Thomas, 2026-10-24)', () => {
    // "Im HMI-Modus hat Signal-Linking nichts zu suchen." The one deliberate
    // exception to the plan-423 promise above: signal linking is engineering
    // work and lives in commissioning / editor / planner / des only.
    const entries = entriesFor(new SignalBindPlugin(), 'button-group');
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(buttonPanelShows(entry, HMI, 'hmi')).toBe(false);
      expect(buttonPanelShows(entry, new Set([modeContext('commissioning')]), 'commissioning')).toBe(true);
    }
  });

  it('the KPI cards and message entries of the demo HMI are all still there', () => {
    const demo = new DemoHMIPlugin();
    expect(entriesFor(demo, 'kpi-bar')).toHaveLength(4);
    expect(entriesFor(demo, 'button-group')).toHaveLength(5);
    expect(entriesFor(demo, 'messages').length).toBeGreaterThan(0);
    for (const slot of ['kpi-bar', 'messages'] as UISlot[]) {
      for (const entry of entriesFor(demo, slot)) {
        // KpiBar does not filter at all and MessagePanel shows ruleless entries
        // unconditionally — a rule appearing here would be a behaviour change.
        expect(entry.visibilityRule, slot).toBeUndefined();
      }
    }
  });
});
