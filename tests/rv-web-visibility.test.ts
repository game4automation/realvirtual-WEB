// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVWebVisibility } from '../src/core/engine/rv-web-visibility';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

interface SetupOpts {
  visibleSignal?: string | null;
  errorSignal?: string | null;
  invert?: boolean;
  defaultVisible?: boolean;
  text?: string;
  /** Initial signal values registered BEFORE init (no-race read). */
  initVisible?: boolean;
  initError?: boolean;
  additionalTargets?: string[];
  gizmoManager?: GizmoOverlayManager;
}

function setup(opts: SetupOpts = {}) {
  const scene = new Scene();
  const mgr = opts.gizmoManager === undefined ? new GizmoOverlayManager(scene) : opts.gizmoManager;
  const store = new SignalStore();
  const errorStore = new ErrorStore();
  const registry = new NodeRegistry();

  if (opts.visibleSignal) store.register(opts.visibleSignal, opts.visibleSignal, opts.initVisible ?? false);
  if (opts.errorSignal) store.register(opts.errorSignal, opts.errorSignal, opts.initError ?? false);

  const node = new Mesh(new BoxGeometry(1, 1, 1));
  node.name = 'Part';
  scene.add(node);
  registry.registerNode('Part', node);

  // Optional additional target nodes.
  const targetNodes: Mesh[] = [];
  if (opts.additionalTargets) {
    for (const p of opts.additionalTargets) {
      const t = new Mesh(new BoxGeometry(1, 1, 1));
      t.name = p;
      scene.add(t);
      registry.registerNode(p, t);
      targetNodes.push(t);
    }
  }

  const comp = new RVWebVisibility(node);
  comp.SignalVisible = opts.visibleSignal ?? null;
  comp.SignalError = opts.errorSignal ?? null;
  comp.InvertSignal = opts.invert ?? false;
  comp.DefaultVisible = opts.defaultVisible ?? true;
  comp.ErrorText = opts.text ?? '';
  if (opts.additionalTargets) {
    // Seed both the raw rv_extras (preferred path) and the instance field.
    node.userData.realvirtual = {
      WebVisibility: { AdditionalTargets: opts.additionalTargets.slice() },
    };
    comp.AdditionalTargets = opts.additionalTargets.slice();
  }

  const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore, registry } as any;
  comp.init(ctx);
  if (typeof comp.onSceneReady === 'function') comp.onSceneReady(ctx);

  return { comp, signalStore: store, errorStore, mgr, scene, node, targetNodes };
}

describe('RVWebVisibility — visibility', () => {
  it('SignalVisible true → visible, false → hidden', () => {
    const { comp, signalStore, node } = setup({ visibleSignal: 'V', initVisible: true });
    expect(node.visible).toBe(true);
    expect(comp.isVisibleNow()).toBe(true);
    signalStore.set('V', false);
    expect(node.visible).toBe(false);
    expect(comp.isVisibleNow()).toBe(false);
    signalStore.set('V', true);
    expect(node.visible).toBe(true);
  });

  it('InvertSignal flips the logic (signal false → visible)', () => {
    const { signalStore, node } = setup({ visibleSignal: 'V', invert: true, initVisible: false });
    // signal false XOR invert true → visible
    expect(node.visible).toBe(true);
    signalStore.set('V', true);
    expect(node.visible).toBe(false);
  });

  it('no signal → DefaultVisible applied once', () => {
    const { node: hidden } = setup({ defaultVisible: false });
    expect(hidden.visible).toBe(false);
    const { node: shown } = setup({ defaultVisible: true });
    expect(shown.visible).toBe(true);
  });

  it('AdditionalTargets switch together with the node', () => {
    const { signalStore, node, targetNodes } = setup({
      visibleSignal: 'V', initVisible: true, additionalTargets: ['T1', 'T2'],
    });
    expect(targetNodes).toHaveLength(2);
    expect(node.visible).toBe(true);
    expect(targetNodes.every(t => t.visible)).toBe(true);
    signalStore.set('V', false);
    expect(targetNodes.every(t => !t.visible)).toBe(true);
  });
});

describe('RVWebVisibility — error', () => {
  it('SignalError high → ErrorStore active + highlight visible', () => {
    const { comp, signalStore, errorStore, mgr } = setup({ errorSignal: 'E', text: 'Jam' });
    expect(errorStore.getActive()).toHaveLength(0);
    signalStore.set('E', true);
    expect(errorStore.getActive().map(e => e.path)).toContain(comp.path);
    expect(errorStore.getActive()[0].text).toBe('Jam');
    expect(comp.isErrorActive()).toBe(true);
    // highlight + badge gizmos exist
    expect((mgr as any)._entries.size).toBeGreaterThanOrEqual(2);
  });

  it('SignalError low → error cleared', () => {
    const { signalStore, errorStore } = setup({ errorSignal: 'E', text: 'x' });
    signalStore.set('E', true);
    expect(errorStore.getActive()).toHaveLength(1);
    signalStore.set('E', false);
    expect(errorStore.getActive()).toHaveLength(0);
  });

  it('reads an initial-high error signal at init', () => {
    const { comp, errorStore } = setup({ errorSignal: 'E', text: 'boot', initError: true });
    expect(errorStore.getActive().map(e => e.path)).toContain(comp.path);
  });
});

describe('RVWebVisibility — priority rule (hidden ⇒ no error)', () => {
  it('hidden + error → no highlight, no active ErrorStore entry', () => {
    const { comp, signalStore, errorStore } = setup({
      visibleSignal: 'V', initVisible: true, errorSignal: 'E', text: 'x',
    });
    signalStore.set('E', true);
    expect(errorStore.getActive()).toHaveLength(1);
    expect(comp.isErrorActive()).toBe(true);
    // Hide the part → error must clear (visibility wins).
    signalStore.set('V', false);
    expect(errorStore.getActive()).toHaveLength(0);
    expect(comp.isErrorActive()).toBe(false);
    expect((comp as any)._highlightGizmo.root.visible).toBe(false);
    // Show again → error re-appears.
    signalStore.set('V', true);
    expect(errorStore.getActive()).toHaveLength(1);
    expect(comp.isErrorActive()).toBe(true);
  });

  it('error signal high WHILE hidden never activates', () => {
    const { signalStore, errorStore } = setup({
      visibleSignal: 'V', initVisible: false, errorSignal: 'E', text: 'x',
    });
    // part is hidden from the start
    signalStore.set('E', true);
    expect(errorStore.getActive()).toHaveLength(0);
  });
});

describe('RVWebVisibility — lifecycle', () => {
  it('dispose removes from ErrorStore and stops reacting', () => {
    const { comp, signalStore, errorStore } = setup({ errorSignal: 'E', text: 'x' });
    signalStore.set('E', true);
    expect(errorStore.getActive()).toHaveLength(1);
    comp.dispose();
    expect(errorStore.getActive()).toHaveLength(0);
    // Further signal changes are ignored (unsubscribed).
    signalStore.set('E', false);
    signalStore.set('E', true);
    expect(errorStore.getActive()).toHaveLength(0);
  });

  it('does not throw when gizmoManager is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => setup({ errorSignal: 'E', text: 'x', gizmoManager: undefined as any })).not.toThrow();
    errSpy.mockRestore();
  });

  it('no signals bound → ErrorStore stays empty', () => {
    const { errorStore } = setup({ defaultVisible: true });
    expect(errorStore.getActive()).toHaveLength(0);
  });
});
