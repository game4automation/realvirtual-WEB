// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-runtime.test.ts — a virtual PLC with several programs (one per PLCProgram node).
 *
 *  - programs scan in ascending Order within the same tick (a later program sees
 *    what an earlier one wrote in that tick)
 *  - each program has its own state: stopping or breaking one leaves the others running
 *  - outputs written by more than one program are reported as conflicts
 *  - the live-only program (deployed before its scene node existed) moves to the node
 *  - plugin: every Active program auto-starts, the editor selection decides which
 *    program getPlcControl() addresses, a model clear removes them all
 *
 * Runs only in the private build (imports `@rv-private`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVPlcRuntime, LIVE_PROGRAM } from '@rv-private/plc/rv-plc-runtime';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { resetPlcEditorStore, loadPlcProgram, getPlcEditorState } from '@rv-private/plugins/plc/plc-editor-store';
import { getPlcControl, getPlcRuntime, registerPlcControl, registerPlcRuntime } from '../src/core/plc-control';
import { createTestViewer, type TestViewer, type TestSignalStore } from './helpers/test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;
const prog = (name: string, body: string, ext: string) => `PROGRAM ${name}
VAR_EXTERNAL
${ext}
END_VAR
${body}
END_PROGRAM`;

// A writes X := Go; B copies X to Y — in the same tick only when A runs first.
const A = prog('A', '  X := Go;', '  Go : BOOL;\n  X : BOOL;');
const B = prog('B', '  Y := X;', '  X : BOOL;\n  Y : BOOL;');

let store: SignalStore;
const runtimes: RVPlcRuntime[] = [];
function makeRuntime(): RVPlcRuntime {
  const rt = new RVPlcRuntime(store, { scanDeadlineMs: 50 });
  runtimes.push(rt);
  return rt;
}

beforeEach(() => {
  store = new SignalStore();
  for (const n of ['Go', 'X', 'Y']) store.register(n, `PLC/${n}`, false);
});
afterEach(() => { for (const r of runtimes) r.dispose(); runtimes.length = 0; });

describe('RVPlcRuntime — several programs', () => {
  it('scans programs in ascending Order within one tick', async () => {
    const rt = makeRuntime();
    const b = rt.ensure('PLC_Programs/B', 'B', 1);
    const a = rt.ensure('PLC_Programs/A', 'A', 0);
    await a.deploy(A); await a.run();
    await b.deploy(B); await b.run();
    store.set('Go', true);
    rt.tick(DT);
    expect(store.getBool('Y')).toBe(true); // A ran first in the same tick
    expect(rt.programs().filter((p) => p.path !== LIVE_PROGRAM).map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('a later Order sees the value one tick later', async () => {
    const rt = makeRuntime();
    const a = rt.ensure('A', 'A', 5);
    const b = rt.ensure('B', 'B', 1);
    await a.deploy(A); await a.run();
    await b.deploy(B); await b.run();
    store.set('Go', true);
    rt.tick(DT);
    expect(store.getBool('Y')).toBe(false);
    rt.tick(DT);
    expect(store.getBool('Y')).toBe(true);
  });

  it('each program has its own state', async () => {
    const rt = makeRuntime();
    const a = rt.ensure('A', 'A', 0);
    const b = rt.ensure('B', 'B', 1);
    await a.deploy(A); await a.run();
    await b.deploy(prog('B', '  Y := X; Y := 1 / 0 > 0;', '  X : BOOL;\n  Y : BOOL;'));
    await b.run();
    store.set('Go', true);
    rt.tick(DT);
    expect(b.state).toBe('error');
    expect(a.state).toBe('running');
    expect(store.getBool('X')).toBe(true);
    a.stop();
    store.set('Go', false);
    rt.tick(DT);
    expect(store.getBool('X')).toBe(true); // A stopped: keeps its last output
  });

  it('reports outputs written by more than one program', async () => {
    const rt = makeRuntime();
    const a = rt.ensure('A', 'A', 0);
    const c = rt.ensure('C', 'C', 1);
    await a.deploy(A);
    await c.deploy(prog('C', '  X := FALSE;', '  X : BOOL;'));
    expect(rt.conflicts()).toEqual([{ signal: 'X', programs: ['A', 'C'] }]);
  });

  it('finds programs by name or path and selects one', () => {
    const rt = makeRuntime();
    const selected = vi.fn();
    rt.onSelect = selected;
    const a = rt.ensure('PLC_Programs/Station01', 'Station01', 3);
    expect(rt.program('station01')).toBe(a);
    expect(rt.program('PLC_Programs/Station01')).toBe(a);
    expect(rt.select('PLC_Programs/Station01', 'Station01')).toBe(a);
    expect(selected).toHaveBeenCalledWith(a);
    expect(rt.programs().find((p) => p.selected)?.name).toBe('Station01');
  });

  it('the live-only program moves to its scene node when one is created', async () => {
    const rt = makeRuntime();
    const live = rt.selected;
    await live.deploy(A);
    const moved = rt.select('PLC', 'Main');
    expect(moved).toBe(live);
    expect(rt.program('PLC')).toBe(live);
    expect(rt.programs().some((p) => p.path === LIVE_PROGRAM)).toBe(false);
  });
});

describe('PlcPlugin — several PLCProgram nodes', () => {
  let viewer: TestViewer;
  let plugin: PlcPlugin;
  beforeEach(() => {
    viewer = createTestViewer();
    viewer._setSignalStore(store as unknown as TestSignalStore);
    plugin = new PlcPlugin();
    plugin.init(viewer as unknown as RVViewer);
  });
  afterEach(() => { plugin.dispose(); registerPlcControl(null); registerPlcRuntime(null); resetPlcEditorStore(); });

  function loadScene(): void {
    const root = new Object3D(); root.name = 'Scene';
    const group = new Object3D(); group.name = 'PLC_Programs'; root.add(group);
    for (const [name, code, order] of [['B', B, 1], ['A', A, 0]] as const) {
      const n = new Object3D(); n.name = name;
      n.userData.realvirtual = { PLCProgram: { Active: true, Language: 'st', Name: name, Code: code, Order: order } };
      group.add(n);
    }
    (viewer as unknown as { scene: Object3D }).scene = root;
    plugin.onModelLoaded({} as LoadResult, viewer as unknown as RVViewer);
  }

  it('auto-starts every Active program and scans them in order', async () => {
    loadScene();
    await vi.waitFor(() => expect(getPlcRuntime()!.programs().filter((p) => p.state === 'running')).toHaveLength(2));
    store.set('Go', true);
    viewer._tickOnce(DT);
    expect(store.getBool('Y')).toBe(true);
  });

  it('the editor selection decides which program getPlcControl() addresses', async () => {
    loadScene();
    await vi.waitFor(() => expect(getPlcRuntime()!.programs().filter((p) => p.state === 'running')).toHaveLength(2));
    expect(getPlcEditorState().nodePath).toBe('PLC_Programs/A'); // first in scan order
    expect(getPlcControl()).toBe(getPlcRuntime()!.program('A'));
    loadPlcProgram('PLC_Programs/B', B, 'B');
    expect(getPlcControl()).toBe(getPlcRuntime()!.program('B'));
  });

  it('replaced sequences are suppressed at load; a program that fails to start releases its sequence', async () => {
    const suppressed = new Map<string, boolean>();
    (viewer as unknown as { logicEngine: unknown }).logicEngine = {
      setRootSuppressed: (name: string, on: boolean) => { suppressed.set(name, on); return true; },
    };
    const root = new Object3D(); root.name = 'Scene';
    const ok = new Object3D(); ok.name = 'Ok';
    ok.userData.realvirtual = { PLCProgram: { Active: true, Name: 'Ok', Code: A, Order: 0, Replaces: 'Logic_PLC_A' } };
    const bad = new Object3D(); bad.name = 'Bad';
    bad.userData.realvirtual = { PLCProgram: { Active: true, Name: 'Bad', Code: 'PROGRAM Bad nonsense END_PROGRAM', Order: 1, Replaces: 'Logic_PLC_B' } };
    root.add(ok, bad);
    (viewer as unknown as { scene: Object3D }).scene = root;
    plugin.onModelLoaded({} as LoadResult, viewer as unknown as RVViewer);
    // At once, before any program ran a scan: no hand-over mid-cycle.
    expect([...suppressed]).toEqual([['Logic_PLC_A', true], ['Logic_PLC_B', true]]);
    await vi.waitFor(() => expect(getPlcRuntime()!.program('Ok')!.state).toBe('running'));
    await vi.waitFor(() => expect(getPlcRuntime()!.program('Bad')!.state).toBe('error'));
    expect([...suppressed]).toEqual([['Logic_PLC_A', true], ['Logic_PLC_B', false]]); // B: the sequence is the fallback
  });

  it('a model clear removes every program', async () => {
    loadScene();
    await vi.waitFor(() => expect(getPlcRuntime()!.programs().filter((p) => p.state === 'running')).toHaveLength(2));
    plugin.onModelCleared(viewer as unknown as RVViewer);
    expect(getPlcRuntime()!.program('A')).toBeNull();
    expect(getPlcRuntime()!.program('B')).toBeNull();
  });
});
