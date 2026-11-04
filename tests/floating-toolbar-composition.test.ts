// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.7 — the composition guard of the floating tool toolbar, on the
 * DECLARATION level: the REAL plugins register their `button-group` entries in
 * one `UIPluginRegistry`, and for each workspace mode `computeToolSections`
 * says what the toolbar is made of.
 *
 * It pins what the plan promises: DES 13 entries / Planner 13 entries (12
 * without the private PLC plugin), both in the same section order
 * `editing → model → analysis → view`, no group torn apart by a foreign one,
 * and the side effects on HMI / commissioning / editor. What actually renders
 * (an entry can render `null`; a slot entry can draw two buttons) is the job of
 * `floating-toolbar-render.test.tsx`.
 */

import { describe, expect, it } from 'vitest';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { computeToolSections, countToolEntries, type ToolSection } from '../src/core/hmi/button-panel-sections';
import { modeContext, type ModeId } from '../src/core/rv-mode-manager';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { PathNetworkUiPlugin } from '../src/plugins/path-network/path-network-ui-plugin';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { StatsHubPlugin } from '../src/core/stats/stats-hub-plugin';
import { DESHMIPlugin } from '../src/plugins/des/hmi/des-hmi-plugin';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';
import { DemoHMIPlugin } from '../src/plugins/demo/demo-hmi-plugin';
import { UnifiedImportPlugin } from '../src/plugins/unified-import';

// The private PLC plugin is a sibling repo: present in the development tree,
// absent in a community checkout. `import.meta.glob` is empty then.
const plcModules = import.meta.glob('../../realvirtual-WebViewer-Private~/src/plugins/plc/plc-plugin.ts');
const plcLoader = Object.values(plcModules)[0] as (() => Promise<{ PlcPlugin: new () => { slots?: unknown[] } }>) | undefined;
const HAS_PLC = plcLoader !== undefined;

async function buildRegistry(): Promise<UIPluginRegistry> {
  const reg = new UIPluginRegistry();
  // Registration order is deliberately NOT the sort order — the registry sorts.
  reg.register(new DemoHMIPlugin());
  reg.register(new MeasurementPlugin());
  reg.register(new TestAxesPlugin());
  reg.register(new ClippingPlugin());
  reg.register(new UnifiedImportPlugin());
  reg.register(new SignalBindPlugin());
  reg.register(new PathNetworkUiPlugin());
  reg.register(new DESHMIPlugin());
  reg.register(new StatsHubPlugin());
  reg.register(new LayoutPlannerPlugin());
  if (plcLoader) {
    const mod = await plcLoader();
    const Plc = (mod as unknown as Record<string, new () => never>)[Object.keys(mod).find((k) => /Plc.*Plugin$/i.test(k)) ?? ''];
    if (Plc) reg.register(new Plc());
  }
  return reg;
}

/** The contexts a mode carries (the `planner` UI context = "authoring is live", set in planner AND des). */
function contextsFor(mode: ModeId): ReadonlySet<string> {
  const ctx = new Set<string>([modeContext(mode)]);
  if (mode === 'planner' || mode === 'des') ctx.add('planner');
  return ctx;
}

const nameOf = (e: { entry: { component: unknown } }): string => (e.entry.component as { name: string }).name;

/** `[sectionKey, [component names]]` for a mode. */
async function toolbarOf(mode: ModeId): Promise<ToolSection[]> {
  const reg = await buildRegistry();
  return computeToolSections(reg.getSlotComponents('button-group'), contextsFor(mode), mode);
}

function shape(sections: readonly ToolSection[]): Array<[string, string[]]> {
  return sections.map((s) => [s.key, s.entries.map(nameOf)]);
}

const GROUP_ORDER = ['editing', 'model', 'analysis', 'view'];

describe('DES toolbar', () => {
  it('13 entries in four sections, ordered as the plan table says', async () => {
    const sections = await toolbarOf('des');
    expect(sections.map((s) => s.key)).toEqual(GROUP_ORDER);
    expect(countToolEntries(sections)).toBe(13);
    expect(shape(sections)).toEqual([
      ['editing', ['PlannerUndoButton', 'PlannerRedoButton', 'PlannerDeleteButton']],
      ['model', ['PlannerSnapFlyout', 'PathNetworkToolButton', 'PlannerLibraryButton']],
      ['analysis', [
        'StatsHubButton', 'DESEventQueueButton', 'DESSnapshotMenu',
        'DesExperimentsSideButton', 'PlannerVanishMUsButton',
      ]],
      ['view', ['ClipButton', 'PlannerDocModeButton']],
    ]);
  });

  it('has no signal-linking entry', async () => {
    const names = (await toolbarOf('des')).flatMap((s) => s.entries.map(nameOf));
    expect(names).not.toContain('SignalLinkModeButton');
    expect(names).not.toContain('BindingsOverviewButton');
  });
});

describe('Planner toolbar', () => {
  it(`${HAS_PLC ? 14 : 13} entries, the same section order as DES`, async () => {
    const sections = await toolbarOf('planner');
    expect(sections.map((s) => s.key)).toEqual(GROUP_ORDER);
    expect(countToolEntries(sections)).toBe(HAS_PLC ? 14 : 13);
    const model = [
      ...(HAS_PLC ? [expect.stringMatching(/Plc/i)] : []),
      'SignalLinkModeButton', 'BindingsOverviewButton',
      'PlannerSnapFlyout', 'PathNetworkToolButton', 'PlannerLibraryButton',
      'PlannerAlignButton', // plan-779: Planner only
    ];
    expect(shape(sections)).toEqual([
      ['editing', ['PlannerUndoButton', 'PlannerRedoButton', 'PlannerDeleteButton']],
      ['model', model],
      ['analysis', ['StatsHubButton', 'PlannerVanishMUsButton']],
      ['view', ['ClipButton', 'PlannerDocModeButton']],
    ]);
  });
});

describe('both authoring modes', () => {
  it('list every shared entry in the same relative order', async () => {
    const des = (await toolbarOf('des')).flatMap((s) => s.entries.map(nameOf));
    const planner = (await toolbarOf('planner')).flatMap((s) => s.entries.map(nameOf));
    const shared = des.filter((n) => planner.includes(n));
    expect(planner.filter((n) => shared.includes(n))).toEqual(shared);
  });

  it('no group is torn apart by a foreign one (each key appears once, sections are contiguous)', async () => {
    for (const mode of ['des', 'planner'] as ModeId[]) {
      const keys = (await toolbarOf(mode)).map((s) => s.key);
      expect(new Set(keys).size, mode).toBe(keys.length);
    }
  });
});

describe('side effects outside planner / DES (documented, plan §2.3)', () => {
  it('HMI: operator buttons first, then statistics and Clip sections', async () => {
    const sections = await toolbarOf('hmi');
    expect(sections.map((s) => s.key)).toEqual(['ungrouped', 'analysis', 'view']);
    const [ungrouped, analysis, view] = shape(sections);
    expect(analysis).toEqual(['analysis', ['StatsHubButton']]);
    expect(ungrouped[1].slice(0, 5)).toEqual([
      'MachineControlButton', 'DrivesButton', 'SensorsButton', 'AlarmsButton', 'MaintenanceButton',
    ]);
    expect(ungrouped[1]).toContain('MeasureButton');
    expect(view).toEqual(['view', ['ClipButton']]);
  });

  it('commissioning: measure/test-axes, model tools, statistics, and Clip', async () => {
    expect(shape(await toolbarOf('commissioning'))).toEqual([
      ['ungrouped', ['MeasureButton', 'TestAxesButton']],
      ['model', ['SignalLinkModeButton', 'BindingsOverviewButton']],
      ['analysis', ['StatsHubButton']],
      ['view', ['ClipButton']],
    ]);
  });

  it('editor (public plugins): import + measure first, Clip is the last section', async () => {
    const sections = shape(await toolbarOf('editor'));
    expect(sections[0]).toEqual(['ungrouped', ['UnifiedImportButton', 'MeasureButton']]);
    expect(sections[sections.length - 1]).toEqual(['view', ['ClipButton']]);
    expect(sections.map(([k]) => k)).toEqual(['ungrouped', 'model', 'analysis', 'view']);
  });

  it('viewer: Measure (rule-based) and Clip only — a focused mode hides ruleless entries', async () => {
    const sections = shape(await toolbarOf('viewer'));
    expect(sections).toEqual([['ungrouped', ['MeasureButton']], ['analysis', ['StatsHubButton']], ['view', ['ClipButton']]]);
  });
});
