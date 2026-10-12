// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-597 §2.3 / §9.6 — the persisted category filter is validated against
 * the MODEL, event-bound: `model-loaded` → `whenSceneReady()` → one FRESH
 * count. Never before the first load, never for an overtaken load, never while
 * an asset document is active or still opening (draft replay, R2-2), never on an
 * in-session edit. Plus the counting rules and the special views the filter id
 * drives.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
// Production capability registrations (side effects) the counts read.
import '../src/core/engine/rv-drive';
import '../src/core/engine/rv-sensor';
import '../src/core/engine/rv-transport-surface';
import { registerCapabilities } from '../src/core/engine/rv-component-registry';
import {
  collectTypeCounts,
  collectTypeRows,
  watchHierarchyFilterValidation,
  type FilterValidationViewer,
  type SceneRowContext,
} from '../src/core/hmi/hierarchy-rows';
import { isLogicFilter, isSignalsFilter, type HierarchyFilterId } from '../src/core/hmi/hierarchy-utils';
import {
  beginAssetDocumentOpen,
  isAssetDocumentBusy,
  setActiveAssetContext,
  type ActiveAssetContext,
} from '../src/core/editor/active-asset-store';
import hierarchyBrowserSource from '../src/core/hmi/rv-hierarchy-browser.tsx?raw';

// ── fixtures ────────────────────────────────────────────────────────────────

interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The slice of the viewer the validation reads; loads are driven by hand. */
class FakeViewer implements FilterValidationViewer {
  readonly scene = new Scene();
  currentModelRoot: Object3D | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly ready: Deferred[] = [];

  on(event: 'model-loaded' | 'model-cleared', handler: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  whenSceneReady(): Promise<void> {
    const d = deferred();
    this.ready.push(d);
    return d.promise;
  }

  emit(event: 'model-loaded' | 'model-cleared'): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  /** Replace the model; returns it. */
  loadModel(withConveyor: boolean): Group {
    if (this.currentModelRoot) this.scene.remove(this.currentModelRoot);
    const model = new Group(); model.name = 'Model';
    const drive = new Group(); drive.name = 'Axis'; drive.userData.realvirtual = { Drive: {} };
    model.add(drive);
    if (withConveyor) model.add(conveyor());
    this.scene.add(model);
    this.currentModelRoot = model;
    return model;
  }

  /** Resolve the n-th pending `whenSceneReady()` (0 = oldest). */
  resolveReady(n = 0): void { this.ready[n]!.resolve(); }
  get pendingReady(): number { return this.ready.length; }
}

function conveyor(): Group {
  const belt = new Group(); belt.name = 'Belt';
  belt.userData.realvirtual = { TransportSurface: {} };
  return belt;
}

const ctx: SceneRowContext = { getPathForNode: () => null, overlay: null, modelRoot: null, hideRuntime: false };

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function watch(viewer: FakeViewer, initial: HierarchyFilterId) {
  const state = { filter: initial };
  const onInvalid = vi.fn(() => { state.filter = 'all'; });
  const stop = watchHierarchyFilterValidation({
    viewer,
    getRoot: () => viewer.scene,
    getCtx: () => ctx,
    getFilter: () => state.filter,
    onInvalid,
    isAssetBusy: isAssetDocumentBusy,
  });
  return { state, onInvalid, stop };
}

let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  setActiveAssetContext(null);
});

// ── validation (§2.3) ───────────────────────────────────────────────────────

describe('filter validation after a model load (§2.3)', () => {
  it('a mount before the first load leaves a persisted cat:transport untouched', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    await flush();
    expect(viewer.pendingReady).toBe(0);
    expect(w.state.filter).toBe('cat:transport');
  });

  it('model-loaded + whenSceneReady on a model without transport resets to all', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    viewer.loadModel(false);
    viewer.emit('model-loaded');
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled(); // not before the scene is ready
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).toHaveBeenCalledTimes(1);
    expect(w.state.filter).toBe('all');
  });

  it('keeps a filter whose category or label the model has', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport/Conveyors'); stops.push(w.stop);
    viewer.loadModel(true);
    viewer.emit('model-loaded');
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
  });

  it('resets a label the model does not have even when the category exists', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport/Chains'); stops.push(w.stop);
    viewer.loadModel(true);
    viewer.emit('model-loaded');
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).toHaveBeenCalledTimes(1);
  });

  it('a second model-loaded before the first resolves discards the first validation', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    viewer.loadModel(false);
    viewer.emit('model-loaded');           // gen 1 — a model WITHOUT transport
    const model = viewer.loadModel(false);
    viewer.emit('model-loaded');           // gen 2 overtakes
    viewer.resolveReady(0);                // the first ready settles…
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled(); // …and is dropped
    model.add(conveyor());                 // the second model has transport
    viewer.resolveReady(1);
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
  });

  it('a model-cleared before the resolve discards the pending validation', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    viewer.loadModel(false);
    viewer.emit('model-loaded');
    viewer.emit('model-cleared');
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
  });

  it('counts FRESH: a reference that materialises before whenSceneReady keeps cat:transport (R2-1)', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    const model = viewer.loadModel(false);
    viewer.emit('model-loaded');
    // A memoised count taken now (no transport) would be stale: the placement
    // materialises its content, then the ready promise resolves — before any
    // animation frame could re-run the panel's memo.
    const stale = collectTypeCounts(viewer.scene, ctx);
    expect(stale.byCategory.get('transport')).toBeUndefined();
    model.add(conveyor());
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
  });

  it('a mount AFTER a completed load validates without an event', async () => {
    const viewer = new FakeViewer();
    viewer.loadModel(false);
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    expect(viewer.pendingReady).toBe(1);
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).toHaveBeenCalledTimes(1);
  });

  it('editor draft replay: a persisted cat:transport stays active while the document opens (R2-2)', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    // The asset editor opens a document: the window starts before its base load.
    const endOpening = beginAssetDocumentOpen();
    const model = viewer.loadModel(false);  // the base has no transport
    viewer.emit('model-loaded');
    viewer.resolveReady();                  // whenSceneReady does NOT wait for the replay
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
    model.add(conveyor());                  // the recovered draft adds a conveyor
    setActiveAssetContext({ viewer: viewer as never, doc: {} as never } as ActiveAssetContext);
    endOpening();
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
    expect(w.state.filter).toBe('cat:transport');
    expect(collectTypeRows(viewer.scene, 'cat:transport', ctx).map((r) => r.name)).toEqual(['Belt']);
  });

  it('does not reset while an asset document is active', async () => {
    const viewer = new FakeViewer();
    setActiveAssetContext({ viewer: viewer as never, doc: {} as never } as ActiveAssetContext);
    const w = watch(viewer, 'cat:transport'); stops.push(w.stop);
    viewer.loadModel(false);
    viewer.emit('model-loaded');
    viewer.resolveReady();
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
  });

  it('the opening window closes even when ended twice', () => {
    const end = beginAssetDocumentOpen();
    expect(isAssetDocumentBusy()).toBe(true);
    end(); end();
    expect(isAssetDocumentBusy()).toBe(false);
  });

  it('an in-session delete of the last conveyor does not validate (stays at 0)', async () => {
    const viewer = new FakeViewer();
    const w = watch(viewer, 'cat:transport/Conveyors'); stops.push(w.stop);
    const model = viewer.loadModel(true);
    viewer.emit('model-loaded');
    viewer.resolveReady();
    await flush();
    model.remove(model.getObjectByName('Belt')!); // only structureTick would change
    await flush();
    expect(w.onInvalid).not.toHaveBeenCalled();
    expect(w.state.filter).toBe('cat:transport/Conveyors');
  });

  it('is wired into the hierarchy browser with the asset busy indicator', () => {
    expect(hierarchyBrowserSource).toContain('watchHierarchyFilterValidation({');
    expect(hierarchyBrowserSource).toContain('isAssetBusy: isAssetDocumentBusy');
    expect(hierarchyBrowserSource).toContain("migrateLegacyFilter(localStorage.getItem('rv-hierarchy-type-filter'))");
  });
});

// ── counting rules (§2.3) ───────────────────────────────────────────────────

describe('category counts (§2.3 counting rule)', () => {
  it('a node with Drive + Sensor counts in both categories', () => {
    const scene = new Scene();
    const n = new Group(); n.userData.realvirtual = { Drive: {}, Sensor: {} };
    scene.add(n);
    const counts = collectTypeCounts(scene, ctx);
    expect(counts.byCategory.get('drives')).toBe(1);
    expect(counts.byCategory.get('sensors')).toBe(1);
  });

  it('two signal types on one node count once in Signals, once per label', () => {
    const scene = new Scene();
    const n = new Group(); n.userData.realvirtual = { PLCOutputBool: {}, PLCOutputInt: {} };
    scene.add(n);
    const counts = collectTypeCounts(scene, ctx);
    expect(counts.byCategory.get('signals')).toBe(1);
    expect(counts.byLabel.get('signals')?.get('PLCOutputBool')).toBe(1);
    expect(counts.byLabel.get('signals')?.get('PLCOutputInt')).toBe(1);
  });

  it('two types sharing one label count once under that label', () => {
    registerCapabilities('P597RollerA', { ui: { filter: 'Rollers597', category: 'transport' } });
    registerCapabilities('P597RollerB', { ui: { filter: 'Rollers597', category: 'transport' } });
    const scene = new Scene();
    const n = new Group(); n.userData.realvirtual = { P597RollerA: {}, P597RollerB: {} };
    scene.add(n);
    expect(collectTypeCounts(scene, ctx).byLabel.get('transport')?.get('Rollers597')).toBe(1);
  });

  it('a known type without category and rule lands in Other — in counts AND rows', () => {
    registerCapabilities('P597Plain', { ui: { filter: 'Plains' } });
    const scene = new Scene();
    const known = new Group(); known.name = 'Known'; known.userData.realvirtual = { P597Plain: {} };
    const unknown = new Group(); unknown.name = 'Unknown'; unknown.userData.realvirtual = { P597NeverRegistered: {} };
    scene.add(known, unknown);
    const counts = collectTypeCounts(scene, ctx);
    expect(counts.byCategory.get('other')).toBe(1);
    expect(counts.byLabel.get('other')?.get('Plains')).toBe(1);
    expect(collectTypeRows(scene, 'cat:other', ctx).map((r) => r.name)).toEqual(['Known']);
  });
});

// ── special views (F7) ──────────────────────────────────────────────────────

describe('special views follow the category, not a single id (F7)', () => {
  it('signal sort applies to cat:signals and any signal label', () => {
    expect(isSignalsFilter('cat:signals')).toBe(true);
    expect(isSignalsFilter('cat:signals/PLCOutputBool')).toBe(true);
    expect(isSignalsFilter('cat:drives')).toBe(false);
    expect(isSignalsFilter('all')).toBe(false);
  });

  it('logic indentation applies to cat:logic and any logic label', () => {
    expect(isLogicFilter('cat:logic')).toBe(true);
    expect(isLogicFilter('cat:logic/Delay')).toBe(true);
    expect(isLogicFilter('cat:signals')).toBe(false);
  });

  it('the browser drives both views through those predicates', () => {
    expect(hierarchyBrowserSource).toContain('const signalsView = isSignalsFilter(typeFilter);');
    expect(hierarchyBrowserSource).toContain('if (signalsView) rows = sortSignalNodes(rows, signalSort);');
    expect(hierarchyBrowserSource).toContain('{signalsView && (');
    expect(hierarchyBrowserSource).toContain('depth={isLogicFilter(typeFilter) ?');
  });
});
