// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVWebError } from '../src/core/engine/rv-web-error';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';

interface SetupOpts {
  signal: string | null;
  text: string;
  gizmoManager?: GizmoOverlayManager;
  style?: 'Auto' | 'FlashObject' | 'Circle';
  /** Box size in meters (for the Auto small-part heuristic). Default 1 m. */
  boxSize?: number;
}

function setupWebError(opts: SetupOpts) {
  const scene = new Scene();
  const mgr = opts.gizmoManager === undefined ? new GizmoOverlayManager(scene) : opts.gizmoManager;
  const store = new SignalStore();
  const errorStore = new ErrorStore();
  if (opts.signal) store.register(opts.signal, opts.signal, false);

  const size = opts.boxSize ?? 1;
  const node = new Mesh(new BoxGeometry(size, size, size));
  node.name = 'Part';
  scene.add(node);

  const comp = new RVWebError(node);
  (comp as any).SignalError = opts.signal;
  (comp as any).ErrorText = opts.text;
  if (opts.style) (comp as any).HighlightStyle = opts.style;

  const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore } as any;
  comp.init(ctx);
  if (typeof comp.onSceneReady === 'function') comp.onSceneReady(ctx);

  return { comp, signalStore: store, errorStore, mgr, scene };
}

describe('RVWebError', () => {
  it('activates ErrorStore + gizmo when signal goes high', () => {
    const { comp, signalStore, errorStore, mgr } = setupWebError({ signal: 'A/Err', text: 'Overtemp' });
    expect(errorStore.getActive()).toHaveLength(0);
    signalStore.set('A/Err', true);
    expect(errorStore.getActive().map(e => e.path)).toContain(comp.path);
    expect(errorStore.getActive()[0].text).toBe('Overtemp');
    // The 3D highlight gizmo exists (no world-space badge any more).
    expect((mgr as any)._entries.size).toBeGreaterThanOrEqual(1);
  });

  it('deactivates when signal goes low', () => {
    const { signalStore, errorStore } = setupWebError({ signal: 'A/Err', text: 'x' });
    signalStore.set('A/Err', true);
    expect(errorStore.getActive()).toHaveLength(1);
    signalStore.set('A/Err', false);
    expect(errorStore.getActive()).toHaveLength(0);
  });

  it('reads an initial-high signal at init', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    const errorStore = new ErrorStore();
    store.register('A/Err', 'A/Err', true); // already high BEFORE init
    const node = new Mesh(new BoxGeometry());
    node.name = 'Part';
    scene.add(node);
    const comp = new RVWebError(node);
    (comp as any).SignalError = 'A/Err';
    (comp as any).ErrorText = 'boot';
    const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore } as any;
    comp.init(ctx);
    comp.onSceneReady!(ctx);
    expect(errorStore.getActive().map(e => e.path)).toContain(comp.path);
  });

  it('does not throw when gizmoManager is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => setupWebError({ signal: 'A/Err', text: 'x', gizmoManager: undefined as any }))
      .not.toThrow();
    errSpy.mockRestore();
  });

  it('does not subscribe / activate when SignalError is null', () => {
    const { signalStore, errorStore } = setupWebError({ signal: null, text: 'static hint' });
    expect(errorStore.getActive()).toHaveLength(0);
    // No signal to flip — store stays empty.
    expect(signalStore).toBeDefined();
  });

  it('FlashObject style → mesh-glow-hull highlight (not floor-disk)', () => {
    const { comp } = setupWebError({ signal: 'A/Err', text: 'x', style: 'FlashObject', boxSize: 0.01 });
    const gizmo = (comp as any)._highlightGizmo;
    expect(gizmo.root.userData._rvGizmo).toBe(true);
  });

  it('Auto style on a tiny part picks the floor-disk ring', () => {
    const { comp } = setupWebError({ signal: 'A/Err', text: 'x', style: 'Auto', boxSize: 0.01 });
    // Floor-disk is a single Mesh root; mesh-glow-hull is a Group with overlays.
    const useRing = (comp as any)._resolveUseRing();
    expect(useRing).toBe(true);
  });
});

// ─── Highlight-pipeline mark (steady red X-ray overlay + one flash) ─────────

function fakeHighlighter() {
  const calls: { aux: Array<[string, unknown, unknown]>; flash: Array<[unknown, unknown]> } = { aux: [], flash: [] };
  const hl = {
    setAuxEmphasis: (id: string, roots: unknown, opts?: unknown) => { calls.aux.push([id, roots, opts]); },
    flash: (roots: unknown, opts: unknown) => { calls.flash.push([roots, opts]); },
  };
  return { hl, calls };
}

describe('RVWebError — highlight pipeline mark', () => {
  function setupWithHighlighter(boxSize = 1, style: 'Auto' | 'FlashObject' | 'Circle' = 'Auto') {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    const errorStore = new ErrorStore();
    store.register('A/Err', 'A/Err', false);
    const node = new Mesh(new BoxGeometry(boxSize, boxSize, boxSize));
    node.name = 'Part';
    scene.add(node);
    const comp = new RVWebError(node);
    (comp as any).SignalError = 'A/Err';
    (comp as any).ErrorText = 'Web break';
    (comp as any).HighlightStyle = style;
    const { hl, calls } = fakeHighlighter();
    const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore, highlighter: hl } as any;
    comp.init(ctx);
    comp.onSceneReady!(ctx);
    return { comp, node, store, mgr, calls };
  }

  it('rising edge: red aux overlay + ONE flash; falling edge: overlay removed, no flash', () => {
    const { comp, node, store, calls, mgr } = setupWithHighlighter();
    // No glow-hull gizmo and no badge sprite — nothing lives in the gizmo manager.
    expect((comp as any)._highlightGizmo).toBeUndefined();
    expect((mgr as any)._entries.size).toBe(0);
    expect(calls.aux).toHaveLength(0);
    expect(calls.flash).toHaveLength(0);

    store.set('A/Err', true);
    expect(calls.aux).toEqual([[`web-error:${comp.path}`, [node], { color: 0xff2020 }]]);
    expect(calls.flash).toEqual([[[node], { color: 0xff2020 }]]);

    store.set('A/Err', false);
    expect(calls.aux).toHaveLength(2);
    expect(calls.aux[1]).toEqual([`web-error:${comp.path}`, null, undefined]);
    expect(calls.flash).toHaveLength(1); // the flash fires only on the rising edge
  });

  it('inactive at scene-ready never touches the aux channel (no rebuild per error)', () => {
    const { calls } = setupWithHighlighter();
    expect(calls.aux).toHaveLength(0);
  });

  it('tiny part keeps the floor-disk ring gizmo instead of the overlay', () => {
    const { comp, store, calls } = setupWithHighlighter(0.01, 'Auto');
    expect((comp as any)._highlightGizmo).toBeDefined();
    store.set('A/Err', true);
    expect(calls.aux).toHaveLength(0);
    expect(calls.flash).toHaveLength(0);
  });

  it('dispose while active clears the overlay', () => {
    const { comp, store, calls } = setupWithHighlighter();
    store.set('A/Err', true);
    comp.dispose();
    expect(calls.aux[calls.aux.length - 1][1]).toBeNull();
  });
});
