// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-2011 §9.7: real contributors share one analysis toolbar entry. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { computeToolSections, countToolEntries } from '../src/core/hmi/button-panel-sections';
import { modeContext } from '../src/core/rv-mode-manager';
import { StatsRegistry } from '../src/core/stats/rv-stats-registry';
import { StatsHubPlugin } from '../src/core/stats/stats-hub-plugin';
import { isStatsHubOpen, resetStatsHubStore } from '../src/core/stats/stats-hub-store';
import { STATS_HUB_KEY } from '../src/core/hmi/rv-storage-keys';
import { DESHMIPlugin } from '../src/plugins/des/hmi/des-hmi-plugin';
import { PathTracePlugin } from '../src/plugins/path-trace-plugin';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { PathNetworkUiPlugin } from '../src/plugins/path-network/path-network-ui-plugin';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';
import { DemoHMIPlugin } from '../src/plugins/demo/demo-hmi-plugin';
import { UnifiedImportPlugin } from '../src/plugins/unified-import';
import { parsePathExtras } from '../src/core/engine/rv-path';
import { makeRunner, makeViewer } from './helpers/des-stats-chart-fixture';

let des: DESHMIPlugin;
let path: PathTracePlugin;
beforeEach(() => {
  localStorage.removeItem(STATS_HUB_KEY);
  resetStatsHubStore();
  des = new DESHMIPlugin();
  path = new PathTracePlugin();
});
afterEach(() => {
  path.dispose();
  des.dispose();
  vi.restoreAllMocks();
  localStorage.removeItem(STATS_HUB_KEY);
  resetStatsHubStore();
});

describe('statistics hub composition', () => {
  it('has five DES analysis entries, thirteen total, and ordered DES/path contributions', () => {
    const viewer = makeViewer(makeRunner(['Source', 'Station']));
    viewer.stats = new StatsRegistry();
    viewer.modes = { activeMode: 'des' };
    viewer.getPlugin = (id: string) => id === 'path-trace' ? path : undefined;
    viewer.markRenderDirty = () => {};
    // Fake only the trace availability input; registration and plugin lifecycle are real.
    const tracePath = parsePathExtras({
      type: 'Path', version: 1, id: 'A', closed: false, align: [0, 1, 0], successors: [],
      segments: [{ kind: 'line', from: [0, 0, 0], to: [24, 0, 0] }],
    }, 'A')!;
    vi.spyOn(path.trace, 'paths', 'get').mockReturnValue([tracePath]);
    // Reverse section order proves that registry order, not init order, wins.
    path.init(viewer);
    des.init(viewer);
    const registry = new UIPluginRegistry();
    for (const plugin of [
      new DemoHMIPlugin(), new MeasurementPlugin(), new TestAxesPlugin(),
      new ClippingPlugin(), new UnifiedImportPlugin(), new SignalBindPlugin(),
      new PathNetworkUiPlugin(), des, path, new StatsHubPlugin(), new LayoutPlannerPlugin(),
    ]) registry.register(plugin);
    const sections = computeToolSections(
      registry.getSlotComponents('button-group'), new Set([modeContext('des'), 'planner']), 'des',
    );
    expect(sections.map(section => section.key)).toEqual(['editing', 'model', 'analysis', 'view']);
    expect(countToolEntries(sections)).toBe(13);
    const names = (section: typeof sections[number]) => section.entries.map(e => e.entry.component.name);
    expect(names(sections.find(section => section.key === 'analysis')!)).toEqual([
      'StatsHubButton', 'DESEventQueueButton', 'DESSnapshotMenu',
      'DesExperimentsSideButton', 'PlannerVanishMUsButton',
    ]);
    expect(sections.flatMap(names)).not.toContain('DESStatsButton');
    expect(sections.flatMap(names)).not.toContain('DESStatsGizmoButton');
    expect(isStatsHubOpen()).toBe(false);
    expect(viewer.stats.available().map(({ id, order }: { id: string; order?: number }) => ({ id, order })))
      .toEqual([{ id: 'des.utilization', order: 10 }, { id: 'path.traffic', order: 20 }]);
    path.dispose();
    des.dispose();
    expect(viewer.stats.list()).toEqual([]);
  });
});
