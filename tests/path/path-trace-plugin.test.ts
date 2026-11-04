// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-629 §9.6 / §9.7 — the congestion trace plugin (bands, overlay
 * categories, range chip, lifecycle) and its MCP tools through the real
 * discover / dispatch path of McpBridgePlugin.
 *
 * Measured in authority / trace time only, never against drawn poses (#202).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Scene, type InterleavedBufferAttribute, type Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { TRACE_SAMPLE_SEC, type TraceSink } from '../../src/core/engine/rv-path-trace';
import {
  PathTracePlugin, traceColor, TRACE_COLOR_YELLOW, TRACE_COLOR_RED, TRACE_COLOR_NO_DATA,
} from '../../src/plugins/path-trace-plugin';
import {
  getOverlaySnapshot, isOverlayVisible, resetOverlayProducers, resolveStoredHidden, setOverlayVisible,
} from '../../src/core/overlay-visibility-store';
import {
  getTraceLegend, getTraceSettings, resetTraceSettings, setTraceRange, setTraceWindowSec, tracePresetOf,
} from '../../src/core/trace-settings-store';
import { StatsRegistry } from '../../src/core/stats/rv-stats-registry';
import { StatsHubWindow } from '../../src/core/stats/StatsHubWindow';
import { openStatsHub, closeStatsHub } from '../../src/core/stats/stats-hub-store';
import { GroupsListContent } from '../../src/core/hmi/GroupsListContent';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { McpBridgePlugin } from '../../src/plugins/mcp-bridge-plugin';
import { McpCommandTools } from '../../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ensureSessionOverlayCommandsRegistered } from '../../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../../src/core/hmi/signal-automap-commands';
import { buildMultiDispatcher, generateToolSchemasMulti } from '../../src/core/engine/rv-mcp-tools';
import type { RVViewer } from '../../src/core/rv-viewer';
import { makeHost, makeAgvRoot, bindContinuous, clearShared } from '../helpers/agv-harness';

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Piece A: 10 m (5 buckets), piece B: 3 m (2 buckets) — 7 buckets. */
function layout(extra?: { id: string; to: number }): void {
  const net = getDefaultPathNetwork();
  const add = (id: string, from: number[], to: number[], succ: string[]): void => {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id, closed: false, align: [0, 1, 0], successors: succ,
      segments: [{ kind: 'line', from, to }],
    }, id)!);
  };
  add('A', [0, 0, 0], [10, 0, 0], ['B']);
  add('B', [10, 0, 0], [13, 0, 0], []);
  if (extra) add(extra.id, [0, 0, 5], [extra.to, 0, 5], []);
  net.resolveGraph();
}

interface FakeViewer {
  viewer: RVViewer;
  scene: Scene;
  emit(ev: string): void;
  setMode(mode: 'continuous' | 'discrete', des?: unknown): void;
}

function makeViewer(): FakeViewer {
  const scene = new Scene();
  const listeners = new Map<string, Set<() => void>>();
  const runtime = { mode: 'continuous' as string, desControl: null as unknown };
  let plugin: PathTracePlugin | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = {
    scene,
    stats: new StatsRegistry(),
    runtime,
    markRenderDirty() {},
    markShadowsDirty() {},
    on(ev: string, cb: () => void) {
      let set = listeners.get(ev);
      if (!set) { set = new Set(); listeners.set(ev, set); }
      set.add(cb);
      return () => set!.delete(cb);
    },
    getPlugin(id: string) { return id === 'path-trace' ? plugin : undefined; },
    _setPlugin(p: PathTracePlugin) { plugin = p; },
  };
  return {
    viewer: v as RVViewer,
    scene,
    emit: (ev) => listeners.get(ev)?.forEach((cb) => cb()),
    setMode: (mode, des) => { runtime.mode = mode; runtime.desControl = des ?? null; },
  };
}

function bandObjects(scene: Scene): Object3D[] {
  const out: Object3D[] = [];
  scene.traverse((o) => { if (o.name.startsWith('__pathTrace:')) out.push(o); });
  return out;
}

function colorAt(p: PathTracePlugin, view: 'blocked' | 'utilization', bucket: number): number[] {
  const line = p.bandOf(view)!;
  const attr = line.geometry.getAttribute('instanceColorStart') as InterleavedBufferAttribute;
  const arr = attr.data.array as Float32Array;
  const k = p.segmentStarts(view)![bucket] * 6;
  return [arr[k], arr[k + 1], arr[k + 2], arr[k + 3], arr[k + 4], arr[k + 5]];
}

const near = (a: number[], b: readonly number[]): void => {
  for (let i = 0; i < 3; i++) {
    expect(a[i]).toBeCloseTo(b[i], 5);
    expect(a[i + 3]).toBeCloseTo(b[i], 5);
  }
};

let fake: FakeViewer;
let plugin: PathTracePlugin;

function setup(withVehicle: boolean): void {
  clearShared();
  layout();
  if (withVehicle) {
    const host = makeHost();
    bindContinuous(makeAgvRoot('T1', { PathId: 'A', StartPosition: 1000, TargetSpeed: 1000, VehicleLength: 1200, VehicleWidth: 800 }), host);
  }
  fake = makeViewer();
  plugin = new PathTracePlugin();
  (fake.viewer as unknown as { _setPlugin(p: PathTracePlugin): void })._setPlugin(plugin);
  plugin.init(fake.viewer);
  plugin.poll();
}

beforeEach(() => {
  resetOverlayProducers();
  setOverlayVisible('trace-blocked', false);
  setOverlayVisible('trace-utilization', false);
  resetTraceSettings();
});

afterEach(() => {
  cleanup();
  closeStatsHub();
  plugin?.dispose();
  clearShared();
  resetOverlayProducers();
});

// ── 9.6 ───────────────────────────────────────────────────────────────────

describe('PathTracePlugin (plan-629 §9.6)', () => {
  it('both categories are default-hidden and present only with a vehicle AND a path', () => {
    expect(resolveStoredHidden(null)).toEqual(expect.arrayContaining(['trace-blocked', 'trace-utilization']));
    setup(false);
    const ids = (): string[] => getOverlaySnapshot().present.map((c) => c.id);
    expect(ids()).not.toContain('trace-blocked');
    plugin.dispose();

    setup(true);
    expect(ids()).toEqual(expect.arrayContaining(['trace-blocked', 'trace-utilization']));
    expect(isOverlayVisible('trace-blocked')).toBe(false);
    expect(plugin.bandOf('blocked')!.visible).toBe(false);

    plugin.onModelCleared();
    expect(ids()).not.toContain('trace-blocked');
    expect(ids()).not.toContain('trace-utilization');
  });

  it('one LineSegments2 per view; segments = the sum of the buckets\' sub-segments', () => {
    setup(true);
    const objs = bandObjects(fake.scene);
    expect(objs.map((o) => o.name).sort()).toEqual(['__pathTrace:blocked', '__pathTrace:utilization']);
    expect(plugin.trace.bucketCount).toBe(7);
    for (const view of ['blocked', 'utilization'] as const) {
      const starts = plugin.segmentStarts(view)!;
      expect(starts.length).toBe(8);
      let sum = 0;
      for (let b = 0; b < 7; b++) {
        const [from, to] = plugin.trace.bucketRange(b);
        sum += Math.max(1, Math.ceil((to - from) * 4));
      }
      const inst = plugin.bandOf(view)!.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
      expect(starts[7]).toBe(sum);
      expect(inst.count).toBe(sum);
    }
    // Offsets: utilization left of +X (−Z), blocked right (+Z).
    const z = (view: 'blocked' | 'utilization'): number =>
      (plugin.bandOf(view)!.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute).getZ(0);
    expect(z('utilization')).toBeCloseTo(-0.2, 5);
    expect(z('blocked')).toBeCloseTo(0.2, 5);
  });

  it('colours: no data / no load = grey; relative to the run: lowest load yellow, maximum red (attribute values)', () => {
    setup(true);
    setOverlayVisible('trace-blocked', true);
    near(colorAt(plugin, 'blocked', 0), TRACE_COLOR_NO_DATA);
    // 8 grid points: bucket 0 occupied only, bucket 1 blocked once, bucket 2 blocked twice.
    plugin.trace.advanceTo(8 * TRACE_SAMPLE_SEC + 0.25, (tk: number, sink: TraceSink) => {
      sink.cover(0, 0.5, 1.5, false);
      if (tk <= 0.5) sink.cover(0, 2.5, 3.5, true);
      if (tk <= 1.0) sink.cover(0, 4.5, 5.5, true);
    });
    expect(plugin.trace.samplesTotal).toBe(8);
    plugin.refreshColors(false);
    near(colorAt(plugin, 'blocked', 0), TRACE_COLOR_NO_DATA); // occupied, never blocked: no load
    near(colorAt(plugin, 'blocked', 1), TRACE_COLOR_YELLOW);  // 0.125 = the run's lowest load
    near(colorAt(plugin, 'blocked', 2), TRACE_COLOR_RED);     // 0.25 = the run's maximum
    expect(getTraceLegend().blocked).toEqual({ lo: 0.125, hi: 0.25 });
    // The pure mapping: continuous between the anchors, clamped, one level = red.
    const out: [number, number, number] = [0, 0, 0];
    expect(traceColor(0.9, 0.1, 0.5, out)).toEqual([...TRACE_COLOR_RED]);
    expect(traceColor(0.1, 0.1, 0.5, out)).toEqual([...TRACE_COLOR_YELLOW]);
    const mid = traceColor(0.3, 0.1, 0.5, [0, 0, 0]);
    for (let i = 0; i < 3; i++) expect(mid[i]).toBeCloseTo((TRACE_COLOR_YELLOW[i] + TRACE_COLOR_RED[i]) / 2, 6);
    expect(traceColor(0.2, 0.2, 0.2, out)).toEqual([...TRACE_COLOR_RED]);
    expect(traceColor(0, 0.1, 0.5, out)).toEqual([...TRACE_COLOR_NO_DATA]);
  });

  it('gate R1-9: switching range or window re-colours a PAUSED trace (no counter change)', () => {
    setup(true);
    setOverlayVisible('trace-blocked', true);
    // Blocked for the first 60 s on bucket 0, then free for 3600 s → last hour 0, total > 0.
    plugin.trace.advanceTo(3660.25, (tk: number, sink: TraceSink) => {
      sink.cover(0, 0.5, 1.5, tk <= 60);
    });
    expect(plugin.trace.value('blocked', 'window', 0)).toBe(0);
    expect(plugin.trace.value('blocked', 'start', 0)).toBeGreaterThan(0);
    plugin.refreshColors(false);
    near(colorAt(plugin, 'blocked', 0), TRACE_COLOR_NO_DATA); // window: no load
    const version = plugin.trace.version;
    setTraceRange('start');
    expect(plugin.trace.version).toBe(version); // no counter change …
    near(colorAt(plugin, 'blocked', 0), TRACE_COLOR_RED); // … but the band changed
    setTraceRange('window');
    near(colorAt(plugin, 'blocked', 0), TRACE_COLOR_NO_DATA);
    // Last day still holds the first minute — selecting it re-colours at once, nothing emptied.
    setTraceWindowSec(86400);
    expect(plugin.trace.windowSec).toBe(86400);
    near(colorAt(plugin, 'blocked', 0), TRACE_COLOR_RED);
  });

  it('two path changes: still exactly two band objects, counters 0; a change at 3600 s measures from NOW (R1-5)', () => {
    setup(true);
    plugin.trace.advanceTo(3600, (_tk: number, sink: TraceSink) => sink.cover(0, 0.5, 1.5, true));
    expect(plugin.trace.samplesTotal).toBeGreaterThan(7000);
    getDefaultPathNetwork().clear();
    layout({ id: 'C', to: 6 });
    plugin.poll();
    expect(plugin.trace.bucketCount).toBe(10);
    expect(plugin.trace.samplesTotal).toBe(0);
    getDefaultPathNetwork().clear();
    layout({ id: 'C', to: 9 });
    plugin.poll();
    expect(bandObjects(fake.scene)).toHaveLength(2);
    expect(plugin.bandCount).toBe(2);
    expect(plugin.trace.samplesTotal).toBe(0);
    let calls = 0;
    plugin.trace.advanceTo(3610, () => { calls++; });
    expect(calls).toBeLessThanOrEqual(10 / TRACE_SAMPLE_SEC + 1);
    expect(plugin.trace.samplesTotal).toBe(calls);
    expect(plugin.trace.samplesWindow).toBe(calls);
  });

  it('drives the continuous clock: attaches on render, samples in fixed ticks, resets on simulation-start, detaches on clear', () => {
    setup(true);
    plugin.onRender();
    expect(plugin.attachedTo).toBe('continuous');
    expect(getDefaultAgvFleet().get('T1')).toBeTruthy();
    const mb = getDefaultMovementAuthority('continuous');
    // The authority clock drives the trace (onBeforeAdvance); tickFixed then adds nothing twice.
    for (let i = 0; i < 300; i++) {
      mb.clock.advanceTo(mb.clock.now + 1 / 60);
      plugin.onFixedUpdatePost(1 / 60);
    }
    expect(plugin.trace.samplesTotal).toBeGreaterThan(0);
    fake.emit('simulation-start');
    expect(plugin.trace.samplesTotal).toBe(0);
    plugin.onModelCleared();
    expect(plugin.attachedTo).toBeNull();
    const before = plugin.trace.samplesTotal;
    mb.clock.advanceTo(mb.clock.now + 5);
    expect(plugin.trace.samplesTotal).toBe(before); // detached: the clock listener is gone
    expect(bandObjects(fake.scene)).toHaveLength(0);
  });

  it('the Groups panel has no trace controls, legends or categories', () => {
    setup(true);
    setOverlayVisible('trace-blocked', true);
    setOverlayVisible('trace-utilization', true);
    plugin.trace.advanceTo(1, (_tk, sink) => sink.cover(0, 0.5, 1.5, true));
    plugin.refreshColors(true);
    const { container } = render(createElement(RVViewerProvider, { value: fake.viewer }, createElement(GroupsListContent)));
    expect(getOverlaySnapshot().present.map(c => c.id)).toEqual(expect.arrayContaining(['trace-blocked', 'trace-utilization']));
    expect(container.querySelector('[data-testid^="trace-range-"]')).toBeNull();
    expect(container.querySelector('[data-testid^="trace-legend-"]')).toBeNull();
    expect(screen.queryByText('Blockage trace')).toBeNull();
    expect(screen.queryByText('Utilization trace')).toBeNull();
  });

  it('the hub range chips: last hour (default) / last day / since start', async () => {
    setup(true);
    openStatsHub('path.traffic');
    render(createElement(StatsHubWindow, { viewer: fake.viewer }));
    await screen.findByTestId('trace-range-hour', {}, { timeout: 30_000 });
    expect(screen.getByRole('switch', { name: 'Blocked share' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Utilization' })).toBeTruthy();
    expect(screen.getByTestId('trace-range-hour').textContent).toBe('Last hour');
    expect(screen.getByTestId('trace-range-hour').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('10 min')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId('trace-range-day')); });
    expect(getTraceSettings()).toMatchObject({ range: 'window', windowSec: 86400 });
    expect(plugin.trace.windowSec).toBe(86400);
    act(() => { fireEvent.click(screen.getByTestId('trace-range-total')); });
    expect(getTraceSettings().range).toBe('start');
    expect(tracePresetOf(getTraceSettings())).toBe('total');
    act(() => { fireEvent.click(screen.getByTestId('trace-range-hour')); });
    expect(getTraceSettings()).toMatchObject({ range: 'window', windowSec: 3600 });
  });
});

// ── 9.7 — through the real discover / dispatch path ───────────────────────

describe('web_trace_top / web_trace_set (plan-629 §9.7)', () => {
  function bridgeCall(): (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> {
    const bridge = new McpBridgePlugin();
    (bridge as unknown as { viewer: RVViewer }).viewer = fake.viewer;
    const names = generateToolSchemasMulti(bridge.mcpToolInstances).map((s) => s.name);
    expect(names).not.toContain('web_trace_top');
    // plan-2007 Phase 1: web_trace_set moved to the command trace.set (run through web_execute).
    expect(names).not.toContain('web_trace_set');
    ensureSessionOverlayCommandsRegistered();
    ensureComponentCommandsRegistered();
    ensureQueryCommandsRegistered();
    ensureDocumentCommandsRegistered();
    ensureSignalAutomapCommandsRegistered();
    const commands = new McpCommandTools(() => fake.viewer);
    const dispatcher = buildMultiDispatcher(bridge.mcpToolInstances);
    return async (tool, args) => {
      if (tool === 'web_trace_set') {
        const r = JSON.parse(await commands.webExecute('trace.set', JSON.stringify(args))) as Record<string, unknown>;
        return (r.value ?? { error: r.error }) as Record<string, unknown>;
      }
      if (tool === 'trace.top') {
        const r = JSON.parse(await commands.webQuery('trace.top', JSON.stringify(args)));
        return r.value;
      }
      const entry = dispatcher.get(tool)!;
      const method = (entry.instance as Record<string, (...a: unknown[]) => Promise<string>>)[entry.methodKey];
      const res = await method.apply(entry.instance, entry.paramNames.map((n) => args[n]));
      return JSON.parse(res) as Record<string, unknown>;
    };
  }

  it('web_trace_top lists sorted rows with pathId / fromM / toM / value / pos, limited by n', async () => {
    setup(true);
    const call = bridgeCall();
    plugin.trace.advanceTo(4 * TRACE_SAMPLE_SEC + 0.25, (tk: number, sink: TraceSink) => {
      sink.cover(0, 0.5, 1.5, true);            // A bucket 0: 4/4
      if (tk <= 1.0) sink.cover(1, 0.5, 1.0, true); // B bucket 0: 2/4
      if (tk <= 0.5) sink.cover(0, 6.5, 7.0, true); // A bucket 3: 1/4
    });
    const r = await call('trace.top', { view: 'blocked', range: 'start', n: 2 });
    expect(r.samples).toBe(4);
    expect(r.range).toBe('start');
    const rows = r.rows as Array<{ pathId: string; fromM: number; toM: number; value: number; pos: number[] }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ pathId: 'A', fromM: 0, toM: 2, value: 1, pos: [1, 0, 0] });
    expect(rows[1].pathId).toBe('B');
    expect(rows[1].value).toBe(0.5);
    const bad = await call('trace.top', { view: 'nope' });
    expect(bad.error).toMatch(/Unknown view/);
  });

  it('web_trace_set({ blocked: true, range: "start" }) switches the category and the range', async () => {
    setup(true);
    const call = bridgeCall();
    const r = await call('web_trace_set', { blocked: true, range: 'start' });
    expect(isOverlayVisible('trace-blocked')).toBe(true);
    expect(isOverlayVisible('trace-utilization')).toBe(false);
    expect(getTraceSettings().range).toBe('start');
    expect(r).toMatchObject({ blocked: true, utilization: false, range: 'start', windowSec: 3600 });
    expect(plugin.bandOf('blocked')!.visible).toBe(true);
    const w = await call('web_trace_set', { windowSec: 86400 });
    expect(w.windowSec).toBe(86400);
    expect(plugin.trace.windowSec).toBe(86400);
    expect((await call('web_trace_set', { windowSec: 90 })).windowSec).toBe(3600); // snaps to the nearer
    expect((await call('web_trace_set', { range: 'later' })).error).toMatch(/Unknown range/);
  });
});
