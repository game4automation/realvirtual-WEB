// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-453 — the structural verb COMMANDS of the path visualizer against a
 * real `RvDocument` (op queue, transactions, undo / redo), with a scripted
 * simulation runtime on a stub viewer:
 *  - 9.4  every verb is refused while the simulation runs or is paused after
 *         running (also DES "paused before the first event": simTime 0 but
 *         renderClock > 0); in the reset state all four apply — ONE function;
 *  - 9.7  a chain-start verb shifts `StartPosition` of the vehicles on that
 *         path in the SAME transaction; end / split leave it; undo restores both;
 *  - 9.8  every verb is ONE undoable op; undo / redo restore exactly;
 *  - 9.10 undo / redo of a verb obey the lock and are followed by the reset;
 *  - 9.11 the lock is re-checked at the application point in the queue; an
 *         executor failure / a refusing document leave no trace and no reset;
 *  - 9.12 a sweep drag ends cleanly on a state change (no commit, controls free);
 *  - the endpoint chrome and the split pick of the selected path.
 *
 * The REAL-viewer side (traveler on the NEW geometry, continuous runtime,
 * pause reasons) is in path-segment-verbs-viewer.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { RVPathComponent, type PathArcSpec, type PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getComponentInstances, setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { arcPointAt, cloneSegmentSpecs, readSegmentSpecs, specListLength } from '../../src/core/engine/rv-path-edit';
import {
  PATH_VERB_LABEL_PREFIX,
  PathVisualizerPlugin,
  isStructuralPathEditAllowed,
  type PathVerbResult,
} from '../../src/plugins/path-visualizer-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';

type V3 = [number, number, number];

const LINE: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] };
const ARC: PathArcSpec = { kind: 'arc', center: [4, 0, 2], radius: 2, startAngle: -90, degrees: 90, plane: 'XZ' };

// ─── Rig: stub viewer + scripted runtime + real RvDocument ──────────────

interface Runtime { state: 'running' | 'paused' | 'detached'; desControl: { renderClock: number } | null }

interface Rig {
  scene: Scene;
  nodes: Map<string, Object3D>;
  doc: RvDocument;
  plugin: PathVisualizerPlugin;
  stub: Stub;
  failOn: { field: string | null };
  /** `canApply` of the document (false = a document switch is in progress). */
  canApply: { value: boolean };
}

interface Stub {
  scene: Scene;
  camera: PerspectiveCamera;
  controls: { enabled: boolean };
  renderer: WebGLRenderer | null;
  raycastManager: null;
  registry: { getPathForNode(node: Object3D): string | null };
  runtime: Runtime;
  simTime: number;
  resets: number;
  resetSimulation(): void;
  on: EventEmitter['on'];
  emit(event: string, data?: unknown): void;
  markRenderDirty(): void;
}

function reapply(node: Object3D): void {
  for (const inst of getComponentInstances(node)) {
    if (inst instanceof RVPathComponent) inst.reapplyConfig();
  }
}

function writeField(node: Object3D, comp: string, field: string, value: unknown): void {
  const rv = (node.userData.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
  rv[comp] ??= {};
  if (value === undefined) delete rv[comp][field];
  else rv[comp][field] = JSON.parse(JSON.stringify(value));
  reapply(node);
}

interface FieldOp { kind: 'setField'; nodePath: string; componentType: string; fieldName: string; value: unknown; prev: unknown }

function makeExecutor(nodes: Map<string, Object3D>, failOn: { field: string | null }): RvExecutor {
  const forward = async (op: RvOp): Promise<void> => {
    if (op.kind === 'composite') {
      for (const c of (op as unknown as { ops: RvOp[] }).ops) await forward(c);
      return;
    }
    const f = op as unknown as FieldOp;
    if (failOn.field === f.fieldName) {
      failOn.field = null;
      throw new Error(`refused ${f.fieldName}`);
    }
    const node = nodes.get(f.nodePath);
    if (!node) throw new Error(`no node ${f.nodePath}`);
    writeField(node, f.componentType, f.fieldName, f.value);
  };
  const inverse = async (op: RvOp): Promise<void> => {
    if (op.kind === 'composite') {
      for (const c of [...(op as unknown as { ops: RvOp[] }).ops].reverse()) await inverse(c);
      return;
    }
    const f = op as unknown as FieldOp;
    const node = nodes.get(f.nodePath);
    if (!node) throw new Error(`no node ${f.nodePath}`);
    writeField(node, f.componentType, f.fieldName, f.prev);
  };
  return { applyForward: forward, applyInverse: inverse };
}

function docTarget(doc: RvDocument): EditTarget {
  let n = 0;
  const op = (nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): RvOp =>
    ({ id: `op_${++n}`, ts: Date.now(), schemaV: 1, kind: 'setField', nodePath, componentType, fieldName, value, prev }) as unknown as RvOp;
  return {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: (p, c, f, v, prev) => { void doc.applyOp(op(p, c, f, v, prev)); },
    setFieldAsync: (p, c, f, v, prev) => doc.applyOp(op(p, c, f, v, prev)),
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
}

function addPath(rig: Pick<Rig, 'scene' | 'nodes'>, id: string, segments: PathSegmentSpec[], extra: Record<string, unknown> = {}): Object3D {
  const node = new Object3D();
  node.name = id;
  node.userData.realvirtual = { Path: { id, segments: cloneSegmentSpecs(segments), successors: [], ...extra } };
  rig.scene.add(node);
  rig.nodes.set(`Root/${id}`, node);
  const comp = new RVPathComponent(node);
  comp.init({} as never);
  setComponentInstance(node, comp);
  return node;
}

function makeRig(withRenderer = false): Rig {
  const scene = new Scene();
  const nodes = new Map<string, Object3D>();
  const failOn = { field: null as string | null };
  const canApply = { value: true };
  const doc = new RvDocument({
    id: 'doc', name: 'Paths', mode: 'scene', executor: makeExecutor(nodes, failOn), canApply: () => canApply.value,
  });
  setActiveEditTarget(docTarget(doc));
  const events = new EventEmitter();
  const camera = new PerspectiveCamera(50, 320 / 240, 0.1, 1000);
  camera.position.set(2, 20, 1);
  camera.up.set(0, 0, -1); // looking straight down: the default up would be degenerate
  camera.lookAt(2, 0, 1);
  camera.updateMatrixWorld(true);
  let renderer: WebGLRenderer | null = null;
  if (withRenderer) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px';
    document.body.appendChild(canvas);
    renderer = new WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(320, 240, false);
  }
  const stub: Stub = {
    scene,
    camera,
    controls: { enabled: true },
    renderer,
    raycastManager: null,
    registry: {
      getPathForNode: (node: Object3D) => {
        for (const [p, n] of nodes) if (n === node) return p;
        return null;
      },
    },
    // Reset state: paused, both clocks at 0 (plan-453 §2.4 Option B).
    runtime: { state: 'paused', desControl: null },
    simTime: 0,
    resets: 0,
    resetSimulation() {
      stub.resets++;
      stub.simTime = 0;
      if (stub.runtime.desControl) stub.runtime.desControl.renderClock = 0;
    },
    on: events.on.bind(events) as EventEmitter['on'],
    emit: (e, d) => events.emit(e as never, d as never),
    markRenderDirty: () => {},
  };
  const plugin = new PathVisualizerPlugin();
  plugin.init(stub as unknown as RVViewer);
  return { scene, nodes, doc, plugin, stub, failOn, canApply };
}

const specsOf = (rig: Rig, id: string): PathSegmentSpec[] =>
  readSegmentSpecs(rig.nodes.get(`Root/${id}`) as unknown as { userData: Record<string, unknown> });

/** The four verbs with fixed arguments (path A = [LINE, ARC]). */
const VERBS: Array<[string, (p: PathVisualizerPlugin) => Promise<PathVerbResult>]> = [
  ['arc sweep', (p) => p.setArcSweep('A', 1, 45)],
  ['append', (p) => p.appendPathSegment('A', 'end')],
  ['remove', (p) => p.removePathEndSegment('A', 'start')],
  ['split', (p) => p.splitPathSegment('A', 0, 0.5)],
];

let rig: Rig;

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultSpacingController().clear();
  getDefaultAgvFleet().clear();
  rig = makeRig();
  addPath(rig, 'A', [LINE, ARC]);
  rig.plugin.refresh();
});

afterEach(() => {
  rig.plugin.dispose();
  const canvas = rig.stub.renderer?.domElement;
  rig.stub.renderer?.dispose();
  canvas?.remove();
  setActiveEditTarget(null);
  getDefaultAgvFleet().clear();
});

// ─── 9.4 ────────────────────────────────────────────────────────────────

describe('9.4 every verb is refused while the simulation runs or is paused after running', () => {
  it('the ONE lock function: detached, or paused with simTime 0 AND renderClock 0', () => {
    const v = (state: string, simTime: number, renderClock: number | null) =>
      isStructuralPathEditAllowed({ runtime: { state, desControl: renderClock === null ? null : { renderClock } }, simTime });
    expect(v('detached', 12, 3)).toBe(true);
    expect(v('running', 0, null)).toBe(false);
    expect(v('running', 0, 0)).toBe(false);
    expect(v('paused', 0, null)).toBe(true);          // continuous reset state
    expect(v('paused', 0, 0)).toBe(true);             // DES reset state
    expect(v('paused', 0.5, null)).toBe(false);       // paused after running
    expect(v('paused', 0, 0.25)).toBe(false);         // DES: ticks before the first event
    expect(isStructuralPathEditAllowed(null)).toBe(false);
  });

  const LOCKED: Array<[string, (s: Stub) => void]> = [
    ['running', (s) => { s.runtime.state = 'running'; }],
    ['paused with simTime > 0', (s) => { s.runtime.state = 'paused'; s.simTime = 3.5; }],
    ['DES paused after N ticks before the first event (simTime 0, renderClock > 0)', (s) => {
      s.runtime.state = 'paused'; s.simTime = 0; s.runtime.desControl = { renderClock: 0.05 };
    }],
  ];

  for (const [stateName, setState] of LOCKED) {
    for (const [verbName, verb] of VERBS) {
      it(`${verbName} while ${stateName} → sim-locked, list unchanged, no undo entry, no reset`, async () => {
        setState(rig.stub);
        const before = specsOf(rig, 'A');
        const pathBefore = getDefaultPathNetwork().get('A');
        const r = await verb(rig.plugin);
        expect(r).toEqual({ ok: false, reason: 'sim-locked' });
        expect(specsOf(rig, 'A')).toEqual(before);
        expect(getDefaultPathNetwork().get('A')).toBe(pathBefore);
        expect(rig.doc.opCount).toBe(0);
        expect(rig.stub.resets).toBe(0);
      });
    }
  }

  it('in the reset state (continuous and DES) and detached all four verbs apply', async () => {
    for (const setup of [
      (s: Stub) => { s.runtime = { state: 'paused', desControl: null }; s.simTime = 0; },
      (s: Stub) => { s.runtime = { state: 'paused', desControl: { renderClock: 0 } }; s.simTime = 0; },
      (s: Stub) => { s.runtime = { state: 'detached', desControl: null }; s.simTime = 7; },
    ]) {
      setup(rig.stub);
      for (const [name, verb] of VERBS) {
        const r = await verb(rig.plugin);
        expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
      }
    }
    expect(rig.doc.opCount).toBe(12);
    expect(rig.stub.resets).toBe(12);
  });

  it('the other refusals: not-found, not-an-arc, last-segment, closed-path, degenerate', async () => {
    addPath(rig, 'ONE', [LINE]);
    addPath(rig, 'LOOP', [LINE, { kind: 'line', from: [4, 0, 0], to: [0, 0, 0] }], { closed: true });
    rig.plugin.refresh();
    expect(await rig.plugin.setArcSweep('NOPE', 0, 45)).toEqual({ ok: false, reason: 'not-found' });
    expect(await rig.plugin.setArcSweep('A', 0, 45)).toEqual({ ok: false, reason: 'not-an-arc' });
    expect(await rig.plugin.setArcSweep('A', 9, 45)).toEqual({ ok: false, reason: 'not-found' });
    expect(await rig.plugin.removePathEndSegment('ONE', 'end')).toEqual({ ok: false, reason: 'last-segment' });
    expect(await rig.plugin.appendPathSegment('LOOP', 'end')).toEqual({ ok: false, reason: 'closed-path' });
    expect(await rig.plugin.removePathEndSegment('LOOP', 'start')).toEqual({ ok: false, reason: 'closed-path' });
    expect(await rig.plugin.splitPathSegment('A', 0, 0)).toEqual({ ok: false, reason: 'degenerate' });
    expect(await rig.plugin.splitPathSegment('A', 0, 0.0001)).toEqual({ ok: false, reason: 'degenerate' });
    expect(rig.doc.opCount).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });
});

// ─── 9.8 ────────────────────────────────────────────────────────────────

describe('9.8 every verb is one undoable op', () => {
  for (const [name, verb] of VERBS) {
    it(`${name}: one entry, undo restores exactly, redo re-applies`, async () => {
      const before = specsOf(rig, 'A');
      const r = await verb(rig.plugin);
      expect(r.ok).toBe(true);
      const after = specsOf(rig, 'A');
      expect(after).toEqual((r as { specs: PathSegmentSpec[] }).specs);
      expect(after).not.toEqual(before);
      expect(rig.doc.opCount).toBe(1);
      expect(rig.doc.describeUndo() ?? '').toContain(PATH_VERB_LABEL_PREFIX.trim());
      // The engine path follows the list.
      expect(getDefaultPathNetwork().get('A')!.segments.length).toBe(after.length);
      await rig.doc.undo();
      expect(specsOf(rig, 'A')).toEqual(before);
      expect(getDefaultPathNetwork().get('A')!.segments.length).toBe(before.length);
      await rig.doc.redo();
      expect(specsOf(rig, 'A')).toEqual(after);
    });
  }

  it('split keeps the total length; the sweep changes only degrees', async () => {
    const L0 = getDefaultPathNetwork().get('A')!.length;
    expect((await rig.plugin.splitPathSegment('A', 1, 0.3)).ok).toBe(true);
    expect(Math.abs(getDefaultPathNetwork().get('A')!.length - L0)).toBeLessThan(1e-9);
    expect((await rig.plugin.setArcSweep('A', 2, 200)).ok).toBe(true);
    const arc = specsOf(rig, 'A')[2] as PathArcSpec;
    expect(arc.degrees).toBeCloseTo(200, 12);
    expect(arc.radius).toBe(2);
  });
});

// ─── 9.7 ────────────────────────────────────────────────────────────────

describe('9.7 prepending shifts StartPosition in one transaction', () => {
  function vehicle(name: string, startPathId: string | null, config: Record<string, unknown>): Object3D {
    const n = new Object3D();
    n.name = name;
    n.userData.realvirtual = config;
    rig.scene.add(n);
    rig.nodes.set(`Root/${name}`, n);
    getDefaultAgvFleet().register({
      id: name, assign() {}, clear() {}, task: null, phase: 'cruising', node: n, startPathId,
    });
    return n;
  }
  const sp = (n: Object3D, comp = 'Agv'): unknown =>
    (n.userData.realvirtual as Record<string, Record<string, unknown>>)[comp]?.['StartPosition'];

  it('append / remove at the START shift by ±ΔL (clamped at 0); END and split leave it; undo restores both', async () => {
    const v1 = vehicle('V1', 'A', { Agv: { PathId: 'A', StartPosition: 1000 } });
    const v2 = vehicle('V2', 'B', { Agv: { PathId: 'B', StartPosition: 1000 } }); // another path
    // Empty PathId / unresolvable PathId — resolved to A by the vehicle (startPathId).
    const v3 = vehicle('V3', 'A', { Agv: { PathId: '', StartPosition: 500 } });
    const v4 = vehicle('V4', 'A', { AgvBehavior: { PathId: 'GONE', StartPosition: 2500 } });

    // Append at the start: the line neighbour (4 m) is repeated before it.
    expect((await rig.plugin.appendPathSegment('A', 'start')).ok).toBe(true);
    expect(sp(v1)).toBe(5000);
    expect(sp(v2)).toBe(1000);
    expect(sp(v3)).toBe(4500);
    expect(sp(v4, 'AgvBehavior')).toBe(6500);
    expect(rig.doc.opCount).toBe(1); // ONE transaction for segments + three StartPositions

    // End and split: no shift.
    expect((await rig.plugin.appendPathSegment('A', 'end')).ok).toBe(true);
    expect((await rig.plugin.splitPathSegment('A', 1, 0.5)).ok).toBe(true);
    expect(sp(v1)).toBe(5000);

    // Undo the split and the end-append, then the start-append: StartPosition back.
    await rig.doc.undo();
    await rig.doc.undo();
    await rig.doc.undo();
    expect(specsOf(rig, 'A')).toEqual([LINE, ARC]);
    expect(sp(v1)).toBe(1000);
    expect(sp(v3)).toBe(500);
    expect(sp(v4, 'AgvBehavior')).toBe(2500);

    // Remove at the start: −4 m, clamped at 0 (a vehicle on the removed piece lands on 0).
    expect((await rig.plugin.removePathEndSegment('A', 'start')).ok).toBe(true);
    expect(sp(v1)).toBe(0);
    expect(sp(v3)).toBe(0);
    expect(sp(v4, 'AgvBehavior')).toBe(0);
    await rig.doc.undo();
    expect(sp(v1)).toBe(1000);
    expect(sp(v4, 'AgvBehavior')).toBe(2500);
  });

  it('a vehicle without a StartPosition field gets one; undo removes it again', async () => {
    const v = vehicle('V5', 'A', { Agv: { PathId: 'A' } });
    expect((await rig.plugin.appendPathSegment('A', 'start')).ok).toBe(true);
    expect(sp(v)).toBe(4000);
    await rig.doc.undo();
    expect(sp(v)).toBeUndefined();
  });
});

// ─── 9.10 ───────────────────────────────────────────────────────────────

describe('9.10 undo and redo of a verb obey the lock and reset', () => {
  it('locked → refused (history and list unchanged); reset state → applied and reset', async () => {
    const before = specsOf(rig, 'A');
    expect((await rig.plugin.appendPathSegment('A', 'end')).ok).toBe(true);
    const after = specsOf(rig, 'A');
    expect(rig.stub.resets).toBe(1);

    // Play → undo refused.
    rig.stub.runtime.state = 'running';
    await rig.doc.undo();
    expect(rig.doc.historyHead().undoLen).toBe(1);
    expect(rig.doc.historyHead().redoLen).toBe(0);
    expect(specsOf(rig, 'A')).toEqual(after);
    expect(rig.stub.resets).toBe(1);

    // A paused run (simTime > 0) → still refused.
    rig.stub.runtime.state = 'paused';
    rig.stub.simTime = 2;
    await rig.doc.undo();
    expect(rig.doc.historyHead().undoLen).toBe(1);
    expect(specsOf(rig, 'A')).toEqual(after);

    // Reset state → undo applies, followed by a reset.
    rig.stub.simTime = 0;
    await rig.doc.undo();
    expect(specsOf(rig, 'A')).toEqual(before);
    expect(rig.doc.historyHead().redoLen).toBe(1);
    expect(rig.stub.resets).toBe(2);

    // Redo under the lock refused, in the reset state applied + reset.
    rig.stub.runtime.state = 'running';
    await rig.doc.redo();
    expect(rig.doc.historyHead().redoLen).toBe(1);
    expect(specsOf(rig, 'A')).toEqual(before);
    rig.stub.runtime.state = 'paused';
    await rig.doc.redo();
    expect(specsOf(rig, 'A')).toEqual(after);
    expect(rig.stub.resets).toBe(3);
    expect(rig.plugin.structuralResetCount).toBe(3);
  });

  it('an ordinary (non-verb) entry is not guarded: it undoes while running, without a reset', async () => {
    rig.plugin.setPlannerMode(true);
    expect(rig.plugin.beginHandleDrag('A', 'v0')).toBe(true);
    rig.plugin.updateHandleDrag([0, 0, -1]);
    rig.plugin.endHandleDrag();
    expect((await rig.plugin.whenCommitted())!.ok).toBe(true);
    expect(rig.doc.opCount).toBe(1);
    rig.stub.runtime.state = 'running';
    await rig.doc.undo();
    expect(rig.doc.historyHead().undoLen).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });
});

// ─── 9.11 ───────────────────────────────────────────────────────────────

describe('9.11 async commit: lock rechecked, failure leaves no trace', () => {
  it('the state turns "running" between call and application → sim-locked, nothing recorded', async () => {
    const before = specsOf(rig, 'A');
    let release: (() => void) | null = null;
    const blocker = rig.doc.runExclusive(() => new Promise<void>((r) => { release = r; }));
    // The blocker holds the queue (bounded wait for it to start).
    for (let i = 0; i < 100 && !release; i++) await Promise.resolve();
    expect(release).not.toBeNull();
    // The verb's FIRST lock check runs synchronously at the call and passes.
    const pending = rig.plugin.appendPathSegment('A', 'end');
    // The verb passed its first lock check and waits in the queue.
    rig.stub.runtime.state = 'running';
    (release as unknown as () => void)();
    await blocker;
    expect(await pending).toEqual({ ok: false, reason: 'sim-locked' });
    expect(specsOf(rig, 'A')).toEqual(before);
    expect(rig.doc.opCount).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });

  it('a lock that flips between the writes of ONE transaction rolls the first write back', async () => {
    getDefaultAgvFleet().register({
      id: 'V', assign() {}, clear() {}, task: null, phase: 'cruising',
      node: (() => {
        const n = new Object3D();
        n.userData.realvirtual = { Agv: { PathId: 'A', StartPosition: 1000 } };
        rig.nodes.set('Root/V', n);
        return n;
      })(),
      startPathId: 'A',
    });
    const before = specsOf(rig, 'A');
    // Flip the lock as soon as the segments write applied (before StartPosition is planned).
    const net = getDefaultPathNetwork();
    const unsub = net.onPathChanged(() => { rig.stub.runtime.state = 'running'; });
    const r = await rig.plugin.appendPathSegment('A', 'start');
    unsub();
    expect(r).toEqual({ ok: false, reason: 'sim-locked' });
    expect(specsOf(rig, 'A')).toEqual(before);
    expect(rig.doc.opCount).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });

  it('the executor throws → commit-failed, scene and history unchanged, no reset', async () => {
    const before = specsOf(rig, 'A');
    const pathBefore = getDefaultPathNetwork().get('A');
    rig.failOn.field = 'segments';
    const r = await rig.plugin.splitPathSegment('A', 0, 0.5);
    expect(r).toEqual({ ok: false, reason: 'commit-failed' });
    expect(specsOf(rig, 'A')).toEqual(before);
    expect(getDefaultPathNetwork().get('A')).toBe(pathBefore);
    expect(rig.doc.opCount).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });

  it('the document refuses ops (document switch in progress) → commit-failed, no trace', async () => {
    const before = specsOf(rig, 'A');
    rig.canApply.value = false;
    const r = await rig.plugin.setArcSweep('A', 1, 30);
    expect(r).toEqual({ ok: false, reason: 'commit-failed' });
    expect(specsOf(rig, 'A')).toEqual(before);
    expect(rig.doc.opCount).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });
});

// ─── 9.12 ───────────────────────────────────────────────────────────────

describe('9.12 handle drag ends cleanly on a state change', () => {
  it('the sweep handle exists only in the reset state; a locked begin is refused', () => {
    rig.plugin.setPlannerMode(true);
    expect([...rig.plugin.getHandleObjects().keys()]).toContain('A|s1');
    rig.stub.runtime.state = 'running';
    rig.stub.emit('simulation-pause-changed', { paused: false });
    expect([...rig.plugin.getHandleObjects().keys()]).not.toContain('A|s1');
    expect([...rig.plugin.getHandleObjects().keys()]).toContain('A|r1'); // plan-447 handles stay
    expect(rig.plugin.beginHandleDrag('A', 's1')).toBe(false);
  });

  it('sweep drag → release commits through setArcSweep (one op, reset)', async () => {
    rig.plugin.setPlannerMode(true);
    expect(rig.plugin.beginHandleDrag('A', 's1')).toBe(true);
    // 135° of sweep from -90° → the point at +45° on the circle.
    const p = arcPointAt({ ...ARC, degrees: 135 }, 1);
    rig.plugin.updateHandleDrag(p);
    expect(rig.plugin.endHandleDrag()).not.toBeNull();
    const r = await rig.plugin.whenVerbSettled();
    expect(r?.ok).toBe(true);
    expect((specsOf(rig, 'A')[1] as PathArcSpec).degrees).toBeCloseTo(135, 9);
    expect(rig.doc.opCount).toBe(1);
    expect(rig.stub.resets).toBe(1);
  });

  for (const [how, flip] of [
    ['event', (r: Rig) => { r.stub.runtime.state = 'running'; r.stub.emit('simulation-pause-changed', { paused: false }); }],
    ['render poll', (r: Rig) => { r.stub.runtime.state = 'running'; r.plugin.onRender(); }],
  ] as Array<[string, (r: Rig) => void]>) {
    it(`a running sweep drag is aborted when the simulation starts (${how}): no commit, controls free`, async () => {
      rig.plugin.setPlannerMode(true);
      rig.plugin.setSelectedPath('A');
      const before = specsOf(rig, 'A');
      const lineBefore = rig.plugin.getLineObjects().get('A')!;
      expect(rig.plugin.beginHandleDrag('A', 's1')).toBe(true);
      expect(rig.stub.controls.enabled).toBe(false);
      rig.plugin.updateHandleDrag(arcPointAt({ ...ARC, degrees: 170 }, 1));
      flip(rig);
      expect(rig.plugin.isDragging).toBe(false);
      expect(rig.stub.controls.enabled).toBe(true);
      expect(rig.plugin.endHandleDrag()).toBeNull(); // a late pointerup commits nothing
      expect(await rig.plugin.whenVerbSettled()).toBeNull();
      expect(specsOf(rig, 'A')).toEqual(before);
      expect(rig.doc.opCount).toBe(0);
      // The same renderer object is back on the committed geometry, the selection kept.
      expect(rig.plugin.getLineObjects().get('A')).toBe(lineBefore);
      expect(rig.plugin.selectedPath).toBe('A');
    });
  }

  it('a mode change aborts the sweep drag the same way', () => {
    rig.plugin.setPlannerMode(true);
    expect(rig.plugin.beginHandleDrag('A', 's1')).toBe(true);
    rig.stub.emit('mode-changed', { from: 'planner', to: 'hmi' });
    expect(rig.plugin.isDragging).toBe(false);
    expect(rig.stub.controls.enabled).toBe(true);
    expect(rig.doc.opCount).toBe(0);
  });
});

// ─── Endpoint chrome + split pick (§2.5 / §2.7) ─────────────────────────

describe('endpoint chrome and split picking of the selected path', () => {
  it('chrome appears for the selected path in the reset state only; one segment has no remove', () => {
    addPath(rig, 'ONE', [{ kind: 'line', from: [0, 0, 5], to: [3, 0, 5] }]);
    rig.plugin.refresh();
    rig.plugin.setPlannerMode(true);
    expect(rig.plugin.getChromeObjects().size).toBe(0); // nothing selected
    rig.plugin.setSelectedPath('A');
    expect([...rig.plugin.getChromeObjects().keys()].sort()).toEqual(['A|+end', 'A|+start', 'A|-end', 'A|-start']);
    // The append marker sits beyond the free end, outward.
    const plus = rig.plugin.getChromeObjects().get('A|+start')!;
    expect(plus.position.x).toBeLessThan(0);
    rig.plugin.setSelectedPath('ONE');
    expect([...rig.plugin.getChromeObjects().keys()].sort()).toEqual(['ONE|+end', 'ONE|+start']);
    rig.stub.runtime.state = 'running';
    rig.stub.emit('simulation-pause-changed', { paused: false });
    expect(rig.plugin.getChromeObjects().size).toBe(0);
  });

  it('a selection of a node above / at a path resolves to that path', () => {
    const holder = new Object3D();
    const inner = rig.nodes.get('Root/A')!;
    rig.scene.remove(inner);
    holder.add(inner);
    rig.scene.add(holder);
    rig.stub.emit('selection-changed', { primaryNode: holder, nodes: [holder], selectedPaths: [], primaryPath: null });
    expect(rig.plugin.selectedPath).toBe('A');
    rig.stub.emit('selection-changed', { primaryNode: null, nodes: [], selectedPaths: [], primaryPath: null });
    expect(rig.plugin.selectedPath).toBeNull();
  });
});

describe('split pick against the screen (SPLIT_PICK_PX)', () => {
  it('a click on the line splits there; far away or at a segment end does not', () => {
    rig.plugin.dispose();
    setActiveEditTarget(null);
    rig = makeRig(true);
    addPath(rig, 'A', [LINE, ARC]);
    rig.plugin.refresh();
    rig.plugin.setPlannerMode(true);
    rig.plugin.setSelectedPath('A');
    const canvas = rig.stub.renderer!.domElement;
    const rect = canvas.getBoundingClientRect();
    const toScreen = (p: V3): [number, number] => {
      const v = new Vector3(p[0], p[1] + 0.02, p[2]).project(rig.stub.camera);
      return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
    };
    const [x, y] = toScreen([1, 0, 0]); // 25 % along the line
    const hit = rig.plugin.pickSplitAt(x, y);
    expect(hit).not.toBeNull();
    expect(hit!.segIndex).toBe(0);
    expect(hit!.t01).toBeCloseTo(0.25, 2);
    // On the arc.
    const [ax, ay] = toScreen(arcPointAt(ARC, 0.5));
    expect(rig.plugin.pickSplitAt(ax, ay)?.segIndex).toBe(1);
    // 40 px away from everything.
    expect(rig.plugin.pickSplitAt(x, y - 40)).toBeNull();
    // At the line start (vertex handle territory).
    const [sx, sy] = toScreen([0, 0, 0]);
    expect(rig.plugin.pickSplitAt(sx, sy)).toBeNull();
    expect(specListLength(specsOf(rig, 'A'))).toBeGreaterThan(0);
  });
});
