// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Commissioning-mode tests (plan-423 §9.1, F1/F2/F4).
 *
 * `commissioning` is the Viewer's counterpart for virtual commissioning: the
 * OPERATOR HMI is gone (KPI cards, message stack, views slot, AI activity
 * overlay), everything an integrator needs stays (Inspector, Hierarchy,
 * CONNECT, AI bridge, ButtonPanel + its tools).
 *
 * Like `rv-viewer-mode.test.ts` this file re-implements the slot-host filter
 * semantics instead of rendering each host, because the same `UIVisibilityRule`
 * means different things depending on who evaluates it (doc-ui-visibility.md §2).
 * The one that decides this plan is ButtonPanel's: a `button-group` entry
 * WITHOUT a rule is auto-hidden in every focused (non-hmi) mode, so the
 * commissioning tools are visible only because they opt IN. That inversion —
 * "operator buttons need nothing, tools need a rule" — is what §9.1 pins.
 */
import { describe, it, expect } from 'vitest';
import {
  ModeManager, modeContext, type ModeHost, type ModePluginSets, type ModeId,
} from '../src/core/rv-mode-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import {
  HIERARCHY_BROWSER_GATE, CONNECT_PANEL_GATE, LEFT_PANEL_GATES,
} from '../src/core/hmi/left-panel-visibility';
import type { UISlot, UISlotEntry } from '../src/core/rv-ui-plugin';

import mainSource from '../src/main.ts?raw';
import appSource from '../src/core/hmi/App.tsx?raw';
import topBarSource from '../src/core/hmi/TopBar.tsx?raw';
import activityBarSource from '../src/core/hmi/ActivityBar.tsx?raw';
import modeDropdownSource from '../src/core/hmi/ModeDropdown.tsx?raw';

import { ConnectPlugin } from '../src/plugins/connect-plugin';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { DemoHMIPlugin } from '../src/plugins/demo/demo-hmi-plugin';
import { KioskPlugin } from '../src/plugins/kiosk-plugin';
import { WebComponentPlugin } from '../src/plugins/web-component-plugin';

// ─── Harness ──────────────────────────────────────────────────────────────

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

/** The descriptor main.ts registers — kept here so the contract is asserted. */
const COMMISSIONING_DESCRIPTOR = {
  id: 'commissioning', label: 'Commissioning', icon: 'Handyman', order: 35,
} as const;

/** Every workspace that existed BEFORE plan-423. */
const PRE_423_MODES: ModeId[] = ['viewer', 'hmi', 'des', 'planner', 'editor'];

function makeModes(): ModeManager {
  const host: ModeHost = {
    viewer: {} as never,
    pluginsForMode: () => EMPTY,
    enablePlugin: () => {}, disablePlugin: () => {}, callPlugin: () => {},
    setContext: () => {}, emit: () => {},
  };
  return new ModeManager(host)
    .register({ id: 'viewer', label: 'Viewer', icon: 'ViewInAr', order: 5 })
    .register({ id: 'hmi', label: 'HMI', icon: 'ViewQuilt', order: 10 })
    .register({ id: 'des', label: 'DES', icon: 'AccountTree', order: 20 })
    .register({ id: 'planner', label: 'Planner', icon: 'GridView', order: 30 })
    .register(COMMISSIONING_DESCRIPTOR)
    .register({ id: 'editor', label: 'Editor', icon: 'Edit', order: 40, runtime: 'detached' });
}

const ctxFor = (mode: ModeId, ...extra: string[]) => new Set([modeContext(mode), ...extra]);
const COMMISSIONING = ctxFor('commissioning');

/** ButtonPanel.tsx — ruleless entries are hidden in any focused (non-hmi) mode. */
function buttonPanelShows(
  entry: UISlotEntry, contexts: ReadonlySet<string>, activeMode: ModeId | null,
): boolean {
  if (entry.visibilityRule) return evaluateVisibilityRule(entry.visibilityRule, contexts);
  return !(activeMode !== null && activeMode !== 'hmi');
}

/** ActivityBar.tsx / MessagePanel.tsx — ruleless entries are ALWAYS visible. */
function activityBarShows(entry: UISlotEntry, contexts: ReadonlySet<string>): boolean {
  return !entry.visibilityRule || evaluateVisibilityRule(entry.visibilityRule, contexts);
}

function entriesFor(plugin: object, slot: UISlot): UISlotEntry[] {
  const reg = new UIPluginRegistry();
  reg.register(plugin as Parameters<UIPluginRegistry['register']>[0]);
  return reg.getSlotComponents(slot);
}

/**
 * The `hiddenIn` list a `useUIVisible(id, …)` call declares, read out of the
 * component SOURCE.
 *
 * These rules are literals inside App/TopBar/ActivityBar, not exported values —
 * and rendering the real shell would need a viewer, a renderer and a model. The
 * established precedent for "this line must keep saying this" in this suite is a
 * `?raw` import (see rv-viewer-mode.test.ts), and reading the list back means
 * the assertions below evaluate the REAL rule instead of a copy of it.
 */
function hiddenInOf(source: string, id: string): string[] {
  const re = new RegExp(`useUIVisible\\('${id}',\\s*\\{\\s*hiddenIn:\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(source);
  if (!m) throw new Error(`no useUIVisible('${id}', { hiddenIn: […] }) in source`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const shellShows = (source: string, id: string, ctx: ReadonlySet<string>) =>
  evaluateVisibilityRule({ hiddenIn: hiddenInOf(source, id) }, ctx);

// ─── F1 — registration ────────────────────────────────────────────────────

describe('commissioningMode_IsRegistered', () => {
  it('registers `commissioning` with order 35 and the default simulation runtime', () => {
    const modes = makeModes();
    expect(modes.has('commissioning')).toBe(true);

    const d = modes.descriptor('commissioning')!;
    expect(d.label).toBe('Commissioning');
    expect(d.order).toBe(35);
    // Commissioning means watching a machine RUN while you connect to it — the
    // kinematics must integrate time, so `runtime` stays unset (= 'simulation'),
    // unlike the detached Editor.
    expect(d.runtime).toBeUndefined();
    expect(modes.descriptor('editor')!.runtime).toBe('detached');
  });

  it('sorts between Planner and Editor (user decision, 2026-08-11)', () => {
    expect(makeModes().list().map((m) => m.id))
      .toEqual(['viewer', 'hmi', 'des', 'planner', 'commissioning', 'editor']);
  });

  it('uses an icon name the ModeDropdown can actually resolve', () => {
    // ModeDropdown falls back to a generic Dashboard icon WITHOUT warning when
    // the name is missing from its ICONS map.
    expect(COMMISSIONING_DESCRIPTOR.icon).toBe('Handyman');
    expect(modeDropdownSource).toContain('commissioning: Handyman');
    expect(modeDropdownSource).toMatch(/import \{[^}]*\bHandyman\b[^}]*\} from '@mui\/icons-material'/s);
  });

  it('main.ts registers exactly this descriptor', () => {
    // Source guard: main.ts cannot be booted in a unit test (renderer, project
    // store, thirty plugins), and a mode that is written and never registered
    // looks finished and shows nothing.
    expect(mainSource).toContain(
      "register({ id: 'commissioning', label: 'Commissioning', icon: 'Handyman', order: 35 })",
    );
  });

  it('activates the mode:commissioning context on switch', () => {
    const seen: Array<[string, boolean]> = [];
    const host: ModeHost = {
      viewer: {} as never,
      pluginsForMode: () => EMPTY,
      enablePlugin: () => {}, disablePlugin: () => {}, callPlugin: () => {},
      setContext: (c, a) => { seen.push([c, a]); }, emit: () => {},
    };
    const m = new ModeManager(host);
    m.register(COMMISSIONING_DESCRIPTOR);
    m.setMode('commissioning');
    expect(seen).toContainEqual(['mode:commissioning', true]);
  });
});

describe('commissioningMode_DeepLinkParam', () => {
  it('?mode=commissioning resolves through the generic boot path', () => {
    // main.ts boots with: `if (urlMode && viewer.modes.has(urlMode)) setMode(urlMode)`.
    const modes = makeModes();
    const urlMode = new URLSearchParams('?mode=commissioning').get('mode')!;
    expect(modes.has(urlMode)).toBe(true);
    modes.setMode(urlMode);
    expect(modes.activeMode).toBe('commissioning');
  });
});

// ─── F2 — what is OFF ─────────────────────────────────────────────────────

describe('commissioningMode_OperatorHmiIsOff', () => {
  const OFF: Array<[string, string]> = [
    ['kpi-bar', appSource],
    ['message-panel', appSource],
    ['views-slot', appSource],
    ['ai-activity-overlay', appSource],
  ];

  for (const [id, source] of OFF) {
    it(`hides '${id}'`, () => {
      expect(hiddenInOf(source, id)).toContain('mode:commissioning');
      expect(shellShows(source, id, COMMISSIONING)).toBe(false);
    });
  }

  it('the KPI bar has to be gated as a WHOLE — its host does not filter entries', () => {
    // KpiBar applies no rule to its slot entries at all (doc-ui-visibility §2),
    // so a per-entry gate would leak all four demo cards into commissioning.
    const kpis = entriesFor(new DemoHMIPlugin(), 'kpi-bar');
    expect(kpis.length).toBeGreaterThan(0);
    for (const entry of kpis) expect(entry.visibilityRule).toBeUndefined();
    expect(shellShows(appSource, 'kpi-bar', COMMISSIONING)).toBe(false);
  });
});

// ─── F2 — what is ON ──────────────────────────────────────────────────────

describe('commissioningMode_IntegratorToolsAreOn', () => {
  const ON: Array<[string, string]> = [
    ['property-inspector', topBarSource],
    ['context-menu', appSource],
    ['sig-warning-banner', appSource],
    ['button-panel', appSource],
    ['top-bar', appSource],
    ['activity-bar', appSource],
    ['search-bar', appSource],
    ['activity-hierarchy', activityBarSource],
    ['activity-ai-bridge', activityBarSource],
  ];

  for (const [id, source] of ON) {
    it(`keeps '${id}' visible`, () => {
      expect(hiddenInOf(source, id)).not.toContain('mode:commissioning');
      expect(shellShows(source, id, COMMISSIONING)).toBe(true);
    });
  }

  it('keeps the Hierarchy and CONNECT left panels — and reserves no orphaned slot', () => {
    expect(evaluateVisibilityRule(HIERARCHY_BROWSER_GATE.rule, COMMISSIONING)).toBe(true);
    expect(evaluateVisibilityRule(CONNECT_PANEL_GATE.rule, COMMISSIONING)).toBe(true);
    // Every left panel stays open in commissioning: the workspace hides operator
    // chrome, not the docked windows, so none of the five gates can strand a slot.
    for (const gate of LEFT_PANEL_GATES) {
      expect(evaluateVisibilityRule(gate.rule, COMMISSIONING), gate.id).toBe(true);
    }
  });

  it('keeps the CONNECT window-opener in the activity bar', () => {
    const [entry] = entriesFor(new ConnectPlugin(), 'activity-bar');
    expect(activityBarShows(entry, COMMISSIONING)).toBe(true);
  });
});

// ─── F2 — the ButtonPanel opt-in matrix ───────────────────────────────────

describe('commissioningMode_ButtonPanelMatrix', () => {
  it('ButtonPanel itself stays mounted', () => {
    expect(shellShows(appSource, 'button-panel', COMMISSIONING)).toBe(true);
  });

  it('Signal Link mode is reachable — the central VIB workflow', () => {
    const [entry] = entriesFor(new SignalBindPlugin(), 'button-group');
    expect(buttonPanelShows(entry, COMMISSIONING, 'commissioning')).toBe(true);
  });

  it('Test Axes is reachable', () => {
    const [entry] = entriesFor(new TestAxesPlugin(), 'button-group');
    expect(buttonPanelShows(entry, COMMISSIONING, 'commissioning')).toBe(true);
  });

  it('Measure distance and Section/Clip were already reachable — unchanged', () => {
    // Both carry a rule that admits commissioning for free (a `hiddenIn` naming
    // planner/des, and an empty rule). They are testpins, not edits.
    const [measure] = entriesFor(new MeasurementPlugin(), 'button-group');
    expect(measure.visibilityRule).toEqual({
      hiddenIn: [modeContext('planner'), modeContext('des')],
    });
    expect(buttonPanelShows(measure, COMMISSIONING, 'commissioning')).toBe(true);

    const [clip] = entriesFor(new ClippingPlugin(), 'button-group');
    expect(clip.visibilityRule).toEqual({});
    expect(buttonPanelShows(clip, COMMISSIONING, 'commissioning')).toBe(true);
  });

  it('operator buttons stay away by themselves — no rule, no edit', () => {
    // The inverse semantics that decided the design: a ruleless `button-group`
    // entry is auto-hidden in every focused mode. Adding rules to switch these
    // OFF would have been the wrong direction and would have un-hidden them in
    // DES/Planner/Editor (the plan-387 B2 trap).
    const cases: Array<[string, object]> = [
      ['demo-hmi', new DemoHMIPlugin()],
      ['kiosk', new KioskPlugin()],
      ['web-component', new WebComponentPlugin({ allowScripts: true })],
    ];
    for (const [name, plugin] of cases) {
      const entries = entriesFor(plugin, 'button-group');
      expect(entries.length, `${name} must contribute button-group entries`).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.visibilityRule, `${name} must stay ruleless`).toBeUndefined();
        expect(buttonPanelShows(entry, COMMISSIONING, 'commissioning')).toBe(false);
      }
    }
  });
});

// ─── F4 — nothing else moved ──────────────────────────────────────────────

describe('commissioningMode_OtherWorkspacesUnaffected', () => {
  it('the five pre-423 modes keep their descriptors, order and runtime', () => {
    const modes = makeModes();
    const expected: Record<string, number> = { viewer: 5, hmi: 10, des: 20, planner: 30, editor: 40 };
    for (const m of PRE_423_MODES) {
      expect(modes.descriptor(m)!.order, m).toBe(expected[m]);
      expect(modes.descriptor(m)!.runtime ?? 'simulation', m)
        .toBe(m === 'editor' ? 'detached' : 'simulation');
    }
  });

  it('signal-bind keeps its four original modes and stays out of the viewer', () => {
    const [entry] = entriesFor(new SignalBindPlugin(), 'button-group');
    expect(entry.visibilityRule).toEqual({
      shownOnlyInAny: [
        modeContext('hmi'), modeContext('planner'), modeContext('des'),
        modeContext('editor'), modeContext('commissioning'),
      ],
    });
    for (const m of ['hmi', 'planner', 'des', 'editor'] as ModeId[]) {
      expect(buttonPanelShows(entry, ctxFor(m), m), m).toBe(true);
    }
    expect(buttonPanelShows(entry, ctxFor('viewer'), 'viewer')).toBe(false);
  });

  it('test-axes keeps EXACTLY its pre-423 reach and adds only commissioning', () => {
    const [entry] = entriesFor(new TestAxesPlugin(), 'button-group');
    // Visible before: hmi and the no-mode window (CONNECT embed / pre-mode-boot).
    expect(buttonPanelShows(entry, ctxFor('hmi'), 'hmi')).toBe(true);
    expect(buttonPanelShows(entry, new Set<string>(), null)).toBe(true);
    // Hidden before, and still hidden: the ruleless auto-hide's four modes.
    for (const m of ['des', 'planner', 'editor', 'viewer'] as ModeId[]) {
      expect(buttonPanelShows(entry, ctxFor(m), m), m).toBe(false);
    }
  });

  it('the viewer workspace is byte-for-byte unaffected by the new strings', () => {
    // Every rule this plan touched must still hide/show the same thing in the
    // viewer: the plan only ever APPENDED 'mode:commissioning'.
    for (const id of ['kpi-bar', 'message-panel', 'views-slot', 'ai-activity-overlay']) {
      expect(hiddenInOf(appSource, id)).toContain('mode:viewer');
      expect(shellShows(appSource, id, ctxFor('viewer'))).toBe(false);
    }
  });

  it('fails OPEN when no mode has booted (CONNECT embed path)', () => {
    // `hiddenIn`, not `shownOnlyInAny`: the embed shell skips mode boot
    // entirely, and a positive gate would have blanked the whole HMI there.
    const NONE = new Set<string>();
    for (const id of ['kpi-bar', 'message-panel', 'views-slot', 'ai-activity-overlay']) {
      expect(shellShows(appSource, id, NONE), id).toBe(true);
    }
  });
});
