// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-502 §9.4 — FMU start-value overrides in the viewer: the override rules,
 * the `setField`/`unsetField` helpers (Undo through the document op protocol),
 * `RVFmu.reapplyConfig()` as the shared change path (seed + `overrides-changed`),
 * the re-attach carry-over with orphaned names, placement isolation, the
 * viewer-owned `Restart` control child and `RestartOnReset`.
 *
 * Fixtures: `tests/fixtures/Feedthrough.fmu` and `BouncingBall.fmu`
 * (Reference-FMUs v0.0.40, BSD-2-Clause).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import {
  RVFmu,
  fmuOf,
  getFmuInstances,
  fmuOverrideAllowed,
  fmuLiveWritable,
  fmuRestartRequired,
  normalizeFmuOverrideValue,
  subscribeFmuOverridesChanged,
  subscribeFmuRestartRequests,
  setFmuDocumentIdProvider,
  RV_FMU_CONTROL,
  RV_FMU_SIGNAL,
  type FmuOverridesChange,
} from '../src/core/engine/rv-fmu';
import type { FmuVariableShape } from '../src/core/engine/rv-extras-validator';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  attachFmu,
  clearFmuStartOverride,
  setFmuStartOverride,
  type FmuPackage,
} from '../src/core/ops/rv-fmu-ops';
import { assetOpHeader } from '../src/core/editor/rv-asset-ops';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import type { EditTarget } from '../src/core/hmi/rv-edit-target';
import { _forgetDraftFmuMemoryForTesting } from '../src/core/editor/rv-asset-draft-storage';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { sha256HexOf } from './helpers/glb-fixture';

// BouncingBall variables as the parser reads them (tests/rv-fmu-model-description.test.ts).
const E: FmuVariableShape = { name: 'e', valueReference: 6, causality: 'parameter', variability: 'tunable', type: 'Real', start: '0.7', min: 0.5, max: 1 };
const G: FmuVariableShape = { name: 'g', valueReference: 5, causality: 'parameter', variability: 'fixed', type: 'Real', start: '-9.81' };
// `v_min` is `constant` (no causality in the XML; modelled as a parameter to prove `constant` alone excludes it).
const VMIN: FmuVariableShape = { name: 'v_min', valueReference: 7, causality: 'parameter', variability: 'constant', type: 'Real', start: '0.1' };

const TUNABLE = 'Float64_tunable_parameter';
const FIXED = 'Float64_fixed_parameter';
const INPUT = 'Float64_continuous_input';

interface MockEnv {
  viewer: RVViewer;
  model: Group;
  store: SignalStore;
  pathOf(name: string): string;
  node(name: string): Object3D;
}

function mockViewer(nodeNames = ['A', 'B']): MockEnv {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  for (const n of nodeNames) {
    const o = new Object3D();
    o.name = n;
    model.add(o);
  }
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const store = new SignalStore();
  const viewer = {
    scene, registry, signalStore: store, transportManager: {},
    get currentModelRoot() { return model; },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; }, rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return {
    viewer, model, store,
    pathOf: (name) => NodeRegistry.computeNodePath(model.getObjectByName(name)!),
    node: (name) => model.getObjectByName(name)!,
  };
}

/** The editor's edit target over an AssetDocument (what the asset-editor mode installs). */
function docTarget(doc: AssetDocument): EditTarget {
  return {
    available: true,
    persistsTo: 'asset',
    setField(nodePath, componentType, fieldName, value, prev) {
      void doc.applyOp({ ...assetOpHeader(), kind: 'setField', nodePath, componentType, fieldName, value, prev });
    },
    unsetField(nodePath, componentType, fieldName, prev) {
      void doc.applyOp({ ...assetOpHeader(), kind: 'unsetField', nodePath, componentType, fieldName, prev });
    },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
}

let pkgCache: FmuPackage | null = null;
async function feedthroughPackage(): Promise<FmuPackage> {
  if (pkgCache) return pkgCache;
  const bytes = new Uint8Array(await (await fetch(feedthroughUrl)).arrayBuffer());
  const { readModelDescription } = await import('../src/core/engine/rv-fmu-model-description');
  pkgCache = { fileName: 'Feedthrough.fmu', sha256: await sha256HexOf(bytes), bytes, description: await readModelDescription(bytes) };
  return pkgCache;
}

function captureChanges(): { changes: Array<{ fmu: RVFmu; change: FmuOverridesChange }>; off: () => void } {
  const changes: Array<{ fmu: RVFmu; change: FmuOverridesChange }> = [];
  const off = subscribeFmuOverridesChanged((fmu, change) => changes.push({ fmu, change }));
  return { changes, off };
}

// Ops on the same field within COALESCE_WINDOW_MS (500 ms) merge into one undo
// entry — a controlled clock keeps the steps below separate unless a test wants them merged.
let clock = 0;
function tick(ms = 1_000): void { clock += ms; }

beforeEach(() => {
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  binaryResources._resetForTesting();
  resetProblemsForTests();
  setFmuDocumentIdProvider(null);
  for (const i of [...getFmuInstances()]) i.dispose();
  _forgetDraftFmuMemoryForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FMU override rules', () => {
  it('e is live-writable, g needs restart, v_min is never overridable', () => {
    expect(fmuOverrideAllowed(E)).toBe(true);
    expect(fmuLiveWritable(E)).toBe(true);
    expect(fmuRestartRequired(E)).toBe(false);
    expect(fmuOverrideAllowed(G)).toBe(true);
    expect(fmuLiveWritable(G)).toBe(false);
    expect(fmuRestartRequired(G)).toBe(true);
    expect(fmuOverrideAllowed(VMIN)).toBe(false);
    expect(fmuRestartRequired(VMIN)).toBe(false);
    // Inputs are live-writable; outputs and calculated parameters are not overridable.
    expect(fmuLiveWritable({ causality: 'input', variability: 'discrete' })).toBe(true);
    expect(fmuOverrideAllowed({ causality: 'calculatedParameter', variability: 'fixed' })).toBe(false);
    expect(fmuOverrideAllowed({ causality: 'output', variability: 'continuous' })).toBe(false);
  });

  it('normalizes values per type (finite Real, int32, bool literal, enum member)', () => {
    expect(normalizeFmuOverrideValue(E, 0.95)).toBe('0.95');
    expect(normalizeFmuOverrideValue(E, '1e-1')).toBe('0.1');
    expect(normalizeFmuOverrideValue(E, Number.NaN)).toBeNull();
    expect(normalizeFmuOverrideValue(E, '')).toBeNull();
    const int: FmuVariableShape = { name: 'i', valueReference: 1, causality: 'input', variability: 'discrete', type: 'Integer' };
    expect(normalizeFmuOverrideValue(int, '3')).toBe('3');
    expect(normalizeFmuOverrideValue(int, 1.5)).toBeNull();
    expect(normalizeFmuOverrideValue(int, 2 ** 31)).toBeNull();
    const bool: FmuVariableShape = { name: 'b', valueReference: 2, causality: 'input', variability: 'discrete', type: 'Boolean' };
    expect(normalizeFmuOverrideValue(bool, true)).toBe('true');
    expect(normalizeFmuOverrideValue(bool, 'yes')).toBeNull();
    const en: FmuVariableShape = {
      name: 'o', valueReference: 3, causality: 'input', variability: 'discrete', type: 'Enumeration',
      enumItems: [{ name: 'Option 1', value: 1 }, { name: 'Option 2', value: 2 }],
    };
    expect(normalizeFmuOverrideValue(en, 2)).toBe('2');
    expect(normalizeFmuOverrideValue(en, 3)).toBeNull();
  });
});

describe('FMU start-value overrides — document ops and reapply', () => {
  it('setFmuStartOverride persists via setField with undo; clear removes the key; last override removed leaves {}', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const a = env.pathOf('A');
    await attachFmu(doc, a, await feedthroughPackage());
    const target = docTarget(doc);
    const fmu = () => fmuOf(env.node('A'))!;
    const stored = () => ((env.node('A').userData.realvirtual as Record<string, Record<string, unknown>>).Fmu.FmuStartOverrides);

    tick();
    expect(setFmuStartOverride(target, a, TUNABLE, 4.5, fmu().FmuStartOverrides)).toBe(true);
    await doc.whenIdle();
    expect(stored()).toEqual({ [TUNABLE]: '4.5' });
    expect(fmu().startOverrides).toEqual({ [TUNABLE]: '4.5' });
    expect(fmu().isOverridden(TUNABLE)).toBe(true);
    expect(doc.getSnapshot().dirty).toBe(true);
    // Same value again: no op.
    expect(setFmuStartOverride(target, a, TUNABLE, '4.5', fmu().FmuStartOverrides)).toBe(false);

    tick();
    setFmuStartOverride(target, a, FIXED, -3, fmu().FmuStartOverrides);
    await doc.whenIdle();
    expect(fmu().startOverrides).toEqual({ [FIXED]: '-3', [TUNABLE]: '4.5' });

    await doc.undo();
    expect(fmu().startOverrides).toEqual({ [TUNABLE]: '4.5' });
    await doc.redo();
    expect(fmu().startOverrides).toEqual({ [FIXED]: '-3', [TUNABLE]: '4.5' });

    tick();
    expect(clearFmuStartOverride(target, a, FIXED, fmu().FmuStartOverrides)).toBe(true);
    await doc.whenIdle();
    expect(stored()).toEqual({ [TUNABLE]: '4.5' });
    expect(clearFmuStartOverride(target, a, FIXED, fmu().FmuStartOverrides)).toBe(false);
    tick();
    clearFmuStartOverride(target, a, TUNABLE, fmu().FmuStartOverrides);
    await doc.whenIdle();
    expect(stored()).toBeUndefined();
    expect(fmu().startOverrides).toEqual({});
    expect(fmu().FmuStartOverrides).toEqual({});

    // Undo of the last clear brings the one-entry map back.
    await doc.undo();
    expect(fmu().startOverrides).toEqual({ [TUNABLE]: '4.5' });
    doc.dispose();
  });

  it('two stores within the coalescing window are ONE undo step (drag / quick edits)', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const a = env.pathOf('A');
    await attachFmu(doc, a, await feedthroughPackage());
    const target = docTarget(doc);
    tick();
    setFmuStartOverride(target, a, TUNABLE, 1, fmuOf(env.node('A'))!.FmuStartOverrides);
    await doc.whenIdle();
    tick(100);
    setFmuStartOverride(target, a, TUNABLE, 2, fmuOf(env.node('A'))!.FmuStartOverrides);
    await doc.whenIdle();
    expect(fmuOf(env.node('A'))!.startOverrides).toEqual({ [TUNABLE]: '2' });
    await doc.undo();
    expect(fmuOf(env.node('A'))!.startOverrides).toEqual({});
    doc.dispose();
  });

  it('RVFmu.reapplyConfig seeds children with override ?? start and reports overrides-changed', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const a = env.pathOf('A');
    await attachFmu(doc, a, await feedthroughPackage());
    const target = docTarget(doc);
    const fmu = fmuOf(env.node('A'))!;
    expect(fmu.state).toBe('standalone');
    expect(env.store.get(`A.${TUNABLE}`)).toBe(0);
    const { changes, off } = captureChanges();
    try {
      tick();
      setFmuStartOverride(target, a, TUNABLE, 2.5, fmu.FmuStartOverrides);
      await doc.whenIdle();
      expect(env.store.get(`A.${TUNABLE}`)).toBe(2.5);
      expect(changes).toHaveLength(1);
      expect(changes[0].fmu).toBe(fmuOf(env.node('A')));
      expect(changes[0].change).toEqual({ restartRequired: [], live: [TUNABLE] });

      tick();
      setFmuStartOverride(target, a, FIXED, 7, fmuOf(env.node('A'))!.FmuStartOverrides);
      await doc.whenIdle();
      expect(changes[1].change).toEqual({ restartRequired: [FIXED], live: [] });

      // Undo: back to the XML start of the input child, reported as a live change.
      await doc.undo();
      await doc.undo();
      expect(env.store.get(`A.${TUNABLE}`)).toBe(0);
      expect(changes.map((c) => c.change)).toEqual([
        { restartRequired: [], live: [TUNABLE] },
        { restartRequired: [FIXED], live: [] },
        { restartRequired: [FIXED], live: [] },
        { restartRequired: [], live: [TUNABLE] },
      ]);

      // A reapply that changes nothing reports nothing.
      fmuOf(env.node('A'))!.reapplyConfig();
      expect(changes).toHaveLength(4);
    } finally {
      off();
      doc.dispose();
    }
  });

  it('a running instance is never re-seeded by the viewer (CONNECT applies start values)', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const a = env.pathOf('A');
    await attachFmu(doc, a, await feedthroughPackage());
    const fmu = fmuOf(env.node('A'))!;
    fmu.setState('running');
    env.store.set(`A.${INPUT}`, 11);
    setFmuStartOverride(docTarget(doc), a, INPUT, 3, fmu.FmuStartOverrides);
    await doc.whenIdle();
    expect(fmu.startOverrides).toEqual({ [INPUT]: '3' });
    expect(env.store.get(`A.${INPUT}`)).toBe(11);
    doc.dispose();
  });

  it('a stored override seeds the child at load (override ?? start)', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const a = env.pathOf('A');
    await attachFmu(doc, a, await feedthroughPackage());
    setFmuStartOverride(docTarget(doc), a, 'Int32_input', 5, fmuOf(env.node('A'))!.FmuStartOverrides);
    await doc.whenIdle();
    // Re-construct (a reload of the same document state): the child starts at the override.
    await doc.undo();
    await doc.redo();
    expect(env.store.get('A.Int32_input')).toBe(5);
    doc.dispose();
  });
});

describe('FMU start-value overrides — re-attach and placements', () => {
  it('attachFmu carries valid overrides over and orphans a missing name', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const a = env.pathOf('A');
    const pkg = await feedthroughPackage();
    await attachFmu(doc, a, pkg);
    const target = docTarget(doc);
    tick();
    setFmuStartOverride(target, a, TUNABLE, 1.25, fmuOf(env.node('A'))!.FmuStartOverrides);
    tick();
    setFmuStartOverride(target, a, 'Gone_parameter', 9, { [TUNABLE]: '1.25' });
    await doc.whenIdle();
    expect(fmuOf(env.node('A'))!.orphanedOverrides.map((o) => o.name)).toEqual(['Gone_parameter']);

    // Re-attach a package whose tunable parameter got another vr: the NAME is the key.
    const renumbered: FmuPackage = {
      ...pkg,
      description: {
        ...pkg.description,
        variables: pkg.description.variables.map((v) => (v.name === TUNABLE ? { ...v, valueReference: 99 } : v)),
      },
    };
    tick();
    await attachFmu(doc, a, renumbered);
    const fmu = fmuOf(env.node('A'))!;
    expect(fmu.variable(TUNABLE)?.valueReference).toBe(99);
    expect(fmu.startOverrides).toEqual({ [TUNABLE]: '1.25' });
    expect(fmu.orphanedOverrides).toEqual([{ name: 'Gone_parameter', value: '9', reason: 'unknown-variable' }]);
    expect(env.store.get(`A.${TUNABLE}`)).toBe(1.25);
    const orphaned = getProblems().filter((p) => p.code === 'fmu-override-orphaned');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].severity).toBe('info');
    expect(orphaned[0].detail).toContain('Gone_parameter');

    // Undo of the re-attach restores the previous record (vr 6) with its map.
    await doc.undo();
    expect(fmuOf(env.node('A'))!.variable(TUNABLE)?.valueReference).toBe(6);
    expect(fmuOf(env.node('A'))!.startOverrides).toEqual({ [TUNABLE]: '1.25' });
    doc.dispose();
  });

  it('two placements of the same FMU keep separate override maps', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const pkg = await feedthroughPackage();
    await attachFmu(doc, env.pathOf('A'), pkg);
    await attachFmu(doc, env.pathOf('B'), pkg);
    const { changes, off } = captureChanges();
    try {
      setFmuStartOverride(docTarget(doc), env.pathOf('A'), TUNABLE, 8, fmuOf(env.node('A'))!.FmuStartOverrides);
      await doc.whenIdle();
      expect(fmuOf(env.node('A'))!.startOverrides).toEqual({ [TUNABLE]: '8' });
      expect(fmuOf(env.node('B'))!.startOverrides).toEqual({});
      expect(env.store.get(`A.${TUNABLE}`)).toBe(8);
      expect(env.store.get(`B.${TUNABLE}`)).toBe(0);
      expect(changes.map((c) => c.fmu.node.name)).toEqual(['A']);
    } finally {
      off();
      doc.dispose();
    }
  });
});

describe('FMU restart control (plan-502 F12)', () => {
  function direct(extras: Record<string, unknown> = {}): { fmu: RVFmu; store: SignalStore; emit(event: string): void } {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Model';
    scene.add(root);
    const node = new Object3D();
    node.name = 'Ball';
    root.add(node);
    registry.registerNode(NodeRegistry.computeNodePath(node), node);
    const listeners = new Map<string, Set<() => void>>();
    const events = {
      on(event: string, cb: () => void) {
        let set = listeners.get(event);
        if (!set) listeners.set(event, set = new Set());
        set.add(cb);
        return () => set!.delete(cb);
      },
    };
    const sha = 'd'.repeat(64);
    binaryResources.put(sha, new Uint8Array([1]), 'doc');
    const data = {
      FmuEmbed: { fileName: 'BouncingBall.fmu', sha256: sha, guid: '{g}', modelName: 'BouncingBall', fmiVersion: '2.0', byteLength: 1, bufferView: -1 },
      FmuVariables: [
        { name: 'h', valueReference: 1, causality: 'output', variability: 'continuous', type: 'Real', start: '1' },
        E, G,
      ],
      ...extras,
    };
    node.userData.realvirtual = { Fmu: data };
    const fmu = new RVFmu(node);
    applySchema(fmu as unknown as Record<string, unknown>, RVFmu.schema, data);
    fmu.init({ registry, signalStore: store, scene, events } as unknown as ComponentContext);
    return { fmu, store, emit: (event) => { for (const cb of listeners.get(event) ?? []) cb(); } };
  }

  it('creates the Restart control child (PLCInputBool, _rvFmuControl) and excludes it from signalNames', () => {
    const { fmu, store } = direct();
    expect(fmu.restartSignalName).toBe('Ball.Restart');
    expect(store.getType('Ball.Restart')).toBe('PLCInputBool');
    expect(store.getPath('Ball.Restart')).toBe('Model/Ball/Signals/Restart');
    expect(store.get('Ball.Restart')).toBe(false);
    const leaf = fmu.node.children.find((c) => c.name === 'Signals')!.children.find((c) => c.name === 'Restart')!;
    expect(leaf.userData[RV_FMU_CONTROL]).toBe(true);
    expect(leaf.userData[RV_FMU_SIGNAL]).toBe(true); // pruned by the writer like a variable leaf
    expect(fmu.signalNames).not.toContain('Ball.Restart');
    expect(fmu.signals.map((s) => s.variable)).not.toContain('Restart');

    const edges: boolean[] = [];
    const off = fmu.subscribeRestartSignal((v) => edges.push(v));
    store.set('Ball.Restart', true);
    fmu.resetRestartSignal();
    off();
    expect(edges).toEqual([true, false]);
    expect(store.get('Ball.Restart')).toBe(false);

    fmu.dispose();
    expect(store.get('Ball.Restart')).toBeUndefined();
  });

  it('simulation-reset triggers a restart request when RestartOnReset is true and the instance runs', () => {
    const requests: string[] = [];
    const off = subscribeFmuRestartRequests((fmu, reason) => requests.push(`${fmu.node.name}:${reason}`));
    try {
      const on = direct();
      expect(on.fmu.RestartOnReset).toBe(true);
      on.emit('simulation-reset');
      expect(requests).toEqual([]); // standalone — nothing to restart
      on.fmu.setState('running');
      on.emit('simulation-reset');
      expect(requests).toEqual(['Ball:reset']);
      on.fmu.dispose();
      on.emit('simulation-reset');
      expect(requests).toEqual(['Ball:reset']); // disposed → unsubscribed

      const offReset = direct({ RestartOnReset: false });
      offReset.fmu.setState('running');
      offReset.emit('simulation-reset');
      expect(requests).toEqual(['Ball:reset']);
      offReset.fmu.dispose();
    } finally {
      off();
    }
  });
});
