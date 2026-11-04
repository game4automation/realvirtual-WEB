// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 Phase 3 (§9.5) — the path-network COMMANDS against a real
 * `RvDocument` (op queue, transactions, undo / redo) with a scripted runtime on
 * a stub viewer and an executor that creates / removes / writes nodes the way
 * the scene executor does (addNode → `__rvAdded` node with an `RVPathComponent`):
 *  - every writing command = ONE undo step labelled `Path verb: …`; undo
 *    restores the network fingerprint exactly, redo again;
 *  - the `PathNetwork` node is created on demand in the same step;
 *  - the 453 lock: refused while running / paused after running, re-checked
 *    in the queue; an executor failure = `commit-failed`, nothing recorded,
 *    no reset; success = exactly one `resetSimulation()`;
 *  - refusals of the pure ops before any change (`imported-path`);
 *  - the registry path (`web_execute`) answers the same ids;
 *  - `networkEditToOps` books vehicle rewrites as `PathId` / `StartPosition`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { RVPathComponent, type PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getComponentInstances, setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { PathVisualizerPlugin, PATH_VERB_LABEL_PREFIX } from '../../src/plugins/path-visualizer-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { CommandRegistry, type CommandContext, type CommandImpl } from '../../src/core/hmi/rv-command-registry';
import {
  createPathNetworkCommandDescriptors,
  ensurePathNetworkCommandsRegistered,
  onPathNetworkChanged,
  PATH_NETWORK_COMMAND_IDS,
  type PathCommandResult,
} from '../../src/plugins/path-network/path-network-commands';
import { networkEditToOps, snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { resolvePathEnvelope } from '../../src/plugins/path-network/path-network-validation';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';

// ─── Rig ────────────────────────────────────────────────────────────────

interface NodeSpecLike {
  parentPath: string; name: string;
  position: number[]; quaternion: number[]; scale: number[];
  components: Record<string, Record<string, unknown>>;
}
type AnyOp = { kind: string; nodePath: string; spec?: NodeSpecLike; componentType?: string; fieldName?: string; value?: unknown; prev?: unknown; ops?: AnyOp[] };

interface Rig {
  scene: Scene;
  root: Object3D;
  nodes: Map<string, Object3D>;
  doc: RvDocument;
  plugin: PathVisualizerPlugin;
  stub: Stub;
  failOn: { kind: string | null };
}

interface Stub {
  scene: Scene;
  currentModel: Object3D;
  camera: null; controls: { enabled: boolean }; renderer: null; raycastManager: null;
  registry: { getPathForNode(node: Object3D): string | null };
  runtime: { state: 'running' | 'paused' | 'detached'; desControl: { renderClock: number } | null };
  simTime: number;
  resets: number;
  resetSimulation(): void;
  on: EventEmitter['on'];
  emit(event: string, data?: unknown): void;
  markRenderDirty(): void;
}

function attachPath(node: Object3D): void {
  if (!node.userData.realvirtual?.Path) return;
  const comp = new RVPathComponent(node);
  comp.init({} as never);
  setComponentInstance(node, comp);
}

function detachPath(node: Object3D): void {
  node.traverse((n) => {
    for (const inst of getComponentInstances(n)) if (inst instanceof RVPathComponent) inst.dispose();
  });
}

function makeExecutor(rig: () => Rig): RvExecutor {
  const create = (spec: NodeSpecLike): void => {
    const r = rig();
    const parent = r.nodes.get(spec.parentPath);
    if (!parent) throw new Error(`no parent ${spec.parentPath}`);
    const n = new Object3D();
    n.name = spec.name;
    n.userData.realvirtual = JSON.parse(JSON.stringify(spec.components));
    n.userData.__rvAdded = true;
    parent.add(n);
    r.nodes.set(`${spec.parentPath}/${spec.name}`, n);
    attachPath(n);
  };
  const drop = (nodePath: string): void => {
    const r = rig();
    const n = r.nodes.get(nodePath);
    if (!n) throw new Error(`no node ${nodePath}`);
    detachPath(n);
    n.removeFromParent();
    for (const k of [...r.nodes.keys()]) if (k === nodePath || k.startsWith(`${nodePath}/`)) r.nodes.delete(k);
  };
  const write = (nodePath: string, comp: string, field: string, value: unknown): void => {
    const n = rig().nodes.get(nodePath);
    if (!n) throw new Error(`no node ${nodePath}`);
    const rv = (n.userData.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
    rv[comp] ??= {};
    if (value === undefined || value === null) delete rv[comp][field];
    else rv[comp][field] = JSON.parse(JSON.stringify(value));
    for (const inst of getComponentInstances(n)) if (inst instanceof RVPathComponent) inst.reapplyConfig();
  };
  const forward = async (op: RvOp): Promise<void> => {
    const o = op as unknown as AnyOp;
    if (o.kind === 'composite') { for (const c of o.ops!) await forward(c as unknown as RvOp); return; }
    if (rig().failOn.kind === o.kind) { rig().failOn.kind = null; throw new Error(`refused ${o.kind}`); }
    if (o.kind === 'addNode') create(o.spec!);
    else if (o.kind === 'removeNode') drop(o.nodePath);
    else if (o.kind === 'setField') write(o.nodePath, o.componentType!, o.fieldName!, o.value);
  };
  const inverse = async (op: RvOp): Promise<void> => {
    const o = op as unknown as AnyOp;
    if (o.kind === 'composite') { for (const c of [...o.ops!].reverse()) await inverse(c as unknown as RvOp); return; }
    if (o.kind === 'addNode') drop(o.nodePath);
    else if (o.kind === 'removeNode') create(o.spec!);
    else if (o.kind === 'setField') write(o.nodePath, o.componentType!, o.fieldName!, o.prev);
  };
  return { applyForward: forward, applyInverse: inverse };
}

function docTarget(doc: RvDocument): EditTarget {
  return {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: () => { throw new Error('unused'); },
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
}

function makeRig(): Rig {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const nodes = new Map<string, Object3D>([['Root', root]]);
  let r: Rig | null = null;
  const doc = new RvDocument({ id: 'doc', name: 'Layout', mode: 'scene', executor: makeExecutor(() => r!) });
  setActiveEditTarget(docTarget(doc));
  const events = new EventEmitter();
  const stub: Stub = {
    scene,
    currentModel: root,
    camera: null, controls: { enabled: true }, renderer: null, raycastManager: null,
    registry: {
      getPathForNode: (node) => {
        for (const [p, n] of nodes) if (n === node) return p;
        return null;
      },
    },
    runtime: { state: 'paused', desControl: null },
    simTime: 0,
    resets: 0,
    resetSimulation() { stub.resets++; stub.simTime = 0; },
    on: events.on.bind(events) as EventEmitter['on'],
    emit: (e, d) => events.emit(e as never, d as never),
    markRenderDirty: () => {},
  };
  const plugin = new PathVisualizerPlugin();
  plugin.init(stub as unknown as RVViewer);
  r = { scene, root, nodes, doc, plugin, stub, failOn: { kind: null } };
  return r;
}

/** An imported (not editor-added) 10-m straight `H` along +X. */
function addImported(rig: Rig, id: string, segments: PathSegmentSpec[]): void {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = { Path: { id, segments, successors: [] } };
  rig.root.add(n);
  rig.nodes.set(`Root/${id}`, n);
  attachPath(n);
}

const IMPLS = new Map(createPathNetworkCommandDescriptors().map((d) => [d.id, d.eagerImpl as CommandImpl<unknown, unknown>]));

function ctxOf(rig: Rig): CommandContext {
  return { viewer: rig.stub as unknown as RVViewer, doc: null, selection: [], mode: 'planner', handle: null };
}

/** Run a command directly through its implementation (enabled → run). */
async function cmd(rig: Rig, id: string, args: Record<string, unknown>): Promise<PathCommandResult> {
  const impl = IMPLS.get(id)!;
  const ctx = ctxOf(rig);
  const en = impl.enabled(ctx, args);
  if (en !== true) throw new Error(en.reason);
  return await impl.run(ctx, args) as PathCommandResult;
}

/** Network fingerprint from the nodes: sorted ids, segments, successors, zones + block extras. */
function fingerprint(rig: Rig): string {
  const { input } = snapshotNetwork(rig.stub as never);
  const paths = [...input.paths].sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, block: p.block, seg: p.segments, succ: p.successors, zone: p.zone ?? null }));
  const blocks = [...(input.blocks ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((b) => ({ id: b.id, x: b.extras }));
  return JSON.stringify({ paths, blocks, live: getDefaultPathNetwork().all().map((p) => p.id).sort() });
}

const head = (rig: Rig): { undoLen: number; redoLen: number } => rig.doc.historyHead();

let rig: Rig;

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  rig = makeRig();
});

afterEach(() => {
  rig.plugin.dispose();
  setActiveEditTarget(null);
  getDefaultPathNetwork().clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('plan-628 9.5 path-network commands', () => {
  it('registers the commands; writers are macro-capable, list is read-only', () => {
    const reg = new CommandRegistry();
    ensurePathNetworkCommandsRegistered(reg);
    ensurePathNetworkCommandsRegistered(reg);
    expect(reg.list().map((d) => d.id).sort()).toEqual([...PATH_NETWORK_COMMAND_IDS].sort());
    for (const d of reg.list()) {
      expect(d.macro === true).toBe(!d.readOnly);
      if (d.macro) expect(typeof IMPLS.get(d.id)!.resolveArgs).toBe('function');
    }
    expect(reg.get('layout.path.list')!.readOnly).toBe(true);
    expect(reg.get('layout.path.remove')!.destructive).toBe(true);
  });

  it('place (free) = ONE undo step, creates PathNetwork + block + path, resets once; undo/redo exact', async () => {
    const empty = fingerprint(rig);
    const r = await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 90 });
    expect(r.blockId).toBe('PN_Block_1');
    expect(r.createdPaths).toEqual(['PN_S1']);
    expect(rig.nodes.has('Root/PathNetwork/PN_Block_1/PN_S1')).toBe(true);
    expect(getDefaultPathNetwork().get('PN_S1')?.length).toBeCloseTo(4, 6);
    expect(head(rig).undoLen).toBe(1);
    expect((rig.doc.ops[rig.doc.ops.length - 1] as { label?: string }).label).toBe(`${PATH_VERB_LABEL_PREFIX}place straight`);
    expect(rig.stub.resets).toBe(1);
    const placed = fingerprint(rig);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(empty);
    expect(rig.nodes.has('Root/PathNetwork')).toBe(false);
    await rig.doc.redo();
    expect(fingerprint(rig)).toBe(placed);
  });

  it('place at an end links automatically; the second place reuses the PathNetwork node', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 90 });
    const r = await cmd(rig, 'layout.path.place', { block: 'curve', radiusM: 1.5, degrees: 90, side: 'left', atPath: 'PN_S1', atEnd: 'end' });
    expect(r.createdPaths).toEqual(['PN_C1']);
    expect(r.linked).toContainEqual(['PN_S1', 'PN_C1']);
    expect(getDefaultPathNetwork().get('PN_S1')?.successorIds).toEqual(['PN_C1']);
    expect(head(rig).undoLen).toBe(2);
  });

  it('junction (stub) on an editor path = ONE step with zones and renamedFront; undo exact', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 90 });
    const before = fingerprint(rig);
    const r = await cmd(rig, 'layout.path.junction', { kind: 'stub', pathId: 'PN_S1', s: 5, side: 'left' });
    expect(r.blockId).toBeTruthy();
    expect(r.renamedFront).toBeTruthy();
    expect(r.zones.length).toBeGreaterThan(0);
    expect(getDefaultPathNetwork().get('PN_S1')).not.toBeNull(); // the original id stays on the rest (P7)
    expect(head(rig).undoLen).toBe(2);
    const after = fingerprint(rig);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(before);
    await rig.doc.redo();
    expect(fingerprint(rig)).toBe(after);
  });

  it('move (translate + rotate a host with a stub) = ONE step; undo exact', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 90 });
    await cmd(rig, 'layout.path.junction', { kind: 'stub', pathId: 'PN_S1', s: 5 });
    const before = fingerprint(rig);
    const n0 = head(rig).undoLen;
    await cmd(rig, 'layout.path.move', { blockId: 'PN_Block_1', dx: 1, dz: 2, dHeadingDeg: 15 });
    expect(head(rig).undoLen).toBe(n0 + 1);
    expect(fingerprint(rig)).not.toBe(before);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(before);
  });

  it('remove of a junction heals its host; undo / redo exact; multi-id remove = ONE step', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 90 });
    const single = fingerprint(rig);
    const j = await cmd(rig, 'layout.path.junction', { kind: 'diverge', pathId: 'PN_S1', s: 4 });
    const withJ = fingerprint(rig);
    const n0 = head(rig).undoLen;
    await cmd(rig, 'layout.path.remove', { ids: j.blockId! });
    expect(head(rig).undoLen).toBe(n0 + 1);
    const { input } = snapshotNetwork(rig.stub as never);
    expect(input.paths.map((p) => p.id)).toEqual(['PN_S1']);
    expect(getDefaultPathNetwork().get('PN_S1')?.length).toBeCloseTo(10, 6);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(withJ);
    await rig.doc.redo();
    await rig.doc.undo();
    // Block + its junction in ONE remove.
    await cmd(rig, 'layout.path.remove', { ids: `${j.blockId}, PN_Block_1` });
    expect(snapshotNetwork(rig.stub as never).input.paths).toEqual([]);
    await rig.doc.undo();
    expect(fingerprint(rig)).toBe(withJ);
    expect(single).not.toBe(withJ);
  });

  it('the lock: running / paused after running refuse before anything is recorded', async () => {
    rig.stub.runtime.state = 'running';
    const impl = IMPLS.get('layout.path.place')!;
    const en = impl.enabled(ctxOf(rig), { block: 'straight', x: 0, z: 0 });
    expect(en).not.toBe(true);
    expect((en as { reason: string }).reason).toMatch(/^sim-locked/);
    await expect(impl.run(ctxOf(rig), { block: 'straight', x: 0, z: 0 })).rejects.toThrow(/sim-locked/);
    rig.stub.runtime.state = 'paused';
    rig.stub.simTime = 2;
    await expect(impl.run(ctxOf(rig), { block: 'straight', x: 0, z: 0 })).rejects.toThrow(/sim-locked/);
    expect(head(rig).undoLen).toBe(0);
    expect(rig.stub.resets).toBe(0);
  });

  it('the lock is re-checked in the queue: a flip while queued = sim-locked, nothing recorded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    // Hold the document queue with a planned no-op until the state flipped.
    const blocker = rig.doc.withTransaction('hold', async () => { await gate; });
    const p = cmd(rig, 'layout.path.place', { block: 'straight', x: 0, z: 0 });
    rig.stub.runtime.state = 'running';
    release();
    await blocker;
    await expect(p).rejects.toThrow(/sim-locked/);
    expect(snapshotNetwork(rig.stub as never).input.paths).toEqual([]);
    expect(rig.stub.resets).toBe(0);
  });

  it('an executor failure = commit-failed: no node, no history entry, no reset', async () => {
    rig.failOn.kind = 'addNode';
    await expect(cmd(rig, 'layout.path.place', { block: 'straight', x: 0, z: 0 })).rejects.toThrow(/commit-failed/);
    expect(head(rig).undoLen).toBe(0);
    expect(rig.stub.resets).toBe(0);
    expect(getDefaultPathNetwork().all()).toEqual([]);
  });

  it('undo / redo of a command are locked while running and followed by the reset', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', x: 0, z: 0 });
    rig.stub.runtime.state = 'running';
    await rig.doc.undo();
    expect(head(rig).undoLen).toBe(1);
    rig.stub.runtime.state = 'paused';
    const resets = rig.stub.resets;
    let changed = 0;
    const off = onPathNetworkChanged(() => { changed++; });
    await rig.doc.undo();
    off();
    expect(head(rig).undoLen).toBe(0);
    expect(rig.stub.resets).toBe(resets + 1);
    expect(changed).toBe(1);
  });

  it('an imported path is refused (imported-path), the network is unchanged', async () => {
    addImported(rig, 'H', [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }]);
    const before = fingerprint(rig);
    await expect(cmd(rig, 'layout.path.remove', { ids: 'H' })).rejects.toThrow(/imported-path/);
    expect(fingerprint(rig)).toBe(before);
    expect(head(rig).undoLen).toBe(0);
  });

  it('list reports blocks, paths, free ports and the edit state', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 3, x: 0, z: 0, headingDeg: 90 });
    const l = await IMPLS.get('layout.path.list')!.run(ctxOf(rig), {}) as Record<string, unknown>;
    expect((l.blocks as { id: string; edited: boolean }[]).map((b) => [b.id, b.edited])).toEqual([['PN_Block_1', false]]);
    expect((l.paths as { id: string; lengthM: number }[])[0]).toMatchObject({ id: 'PN_S1', lengthM: 3 });
    expect((l.freePorts as unknown[]).length).toBe(2);
    expect(l.editable).toBe(true);
  });

  it('the registry (web_execute path) answers the same ids as the implementation', async () => {
    const reg = new CommandRegistry();
    ensurePathNetworkCommandsRegistered(reg);
    reg.attachViewer(rig.stub as unknown as RVViewer);
    const res = await reg.execute('layout.path.place', { block: 'straight', x: 0, z: 0 }, { origin: 'mcp' });
    expect(res.ok).toBe(true);
    expect((res as { value: PathCommandResult }).value.createdPaths).toEqual(['PN_S1']);
    const bad = await reg.execute('layout.path.junction', { kind: 'stub', pathId: 'nope', s: 1 }, { origin: 'mcp' });
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toMatch(/unknown-path/);
  });

  it('networkEditToOps books vehicle rewrites as PathId + StartPosition writes', () => {
    const loc = {
      rootPath: 'Root', networkPath: 'Root/PathNetwork', pathNodes: new Map(), blockNodes: new Map(),
      specs: new Map(), vehicleComponent: new Map([['Root/Agv1', 'AgvBehavior']]),
    };
    const ops = networkEditToOps({
      addBlocks: [], add: [], set: [], setBlocks: [], remove: [], removeBlocks: [],
      agvRewrites: [{ agvNode: 'Root/Agv1', pathId: 'B', startPositionMm: 500, prevPathId: 'A', prevStartPositionMm: 2500 }],
    }, loc) as unknown as AnyOp[];
    expect(ops.map((o) => [o.kind, o.nodePath, o.componentType, o.fieldName, o.value, o.prev])).toEqual([
      ['setField', 'Root/Agv1', 'AgvBehavior', 'PathId', 'B', 'A'],
      ['setField', 'Root/Agv1', 'AgvBehavior', 'StartPosition', 500, 2500],
    ]);
  });
});

// ─── Phase 4: validation (§2.8, R1 #8) ──────────────────────────────────

describe('plan-628 Phase 4 path-network validation', () => {
  const ids = (): string[] => getProblems().map((p) => p.id).filter((id) => id.startsWith('path-network:')).sort();
  const markers = (): number => rig.scene.getObjectByName('__pathMarkers')!.children.length;
  const live = () => rig.plugin.liveValidation!;

  beforeEach(() => resetProblemsForTests());

  it('layout.path.validate answers sorted issues; envelope fleet > explicit > none', async () => {
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 90 });
    await cmd(rig, 'layout.path.junction', { kind: 'merge', pathId: 'PN_S1', s: 6 });
    const v = IMPLS.get('layout.path.validate')!;
    const none = await v.run(ctxOf(rig), {}) as { issues: { code: string }[]; envelopeSource: string; skipped: string | null };
    expect(none.envelopeSource).toBe('none');
    expect(none.skipped).toBe('no-envelope');
    expect(none.issues.map((i) => i.code)).toContain('agv-merge-check-skipped');
    const ex = await v.run(ctxOf(rig), { front: 0.9, rear: 0.9, width: 0.8 }) as { envelopeSource: string; skipped: string | null };
    expect(ex.envelopeSource).toBe('explicit');
    expect(ex.skipped).toBeNull();
    expect(resolvePathEnvelope(null)).toEqual({ env: null, source: 'none' });
    expect(head(rig).undoLen).toBe(2); // read-only
  });

  it('live: problems + markers follow commit, remove, undo; leaving authoring clears', async () => {
    rig.plugin.setPlannerMode(true);
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 90 });
    live().tick();
    expect(ids()).toEqual(['path-network:path-open-end:PN_S1', 'path-network:path-unreachable-start:PN_S1']);
    expect(markers()).toBe(2);
    const runs = live().runs;
    live().tick(); // not dirty → no run (one per change)
    expect(live().runs).toBe(runs);
    // R1 #8: the last faulty block is removed → entries and markers vanish.
    await cmd(rig, 'layout.path.remove', { ids: 'PN_Block_1' });
    live().tick();
    expect(ids()).toEqual([]);
    expect(markers()).toBe(0);
    await rig.doc.undo();
    live().tick();
    expect(ids().length).toBe(2);
    rig.plugin.setPlannerMode(false);
    expect(ids()).toEqual([]);
    expect(markers()).toBe(0);
  });

  it('live: a node transform on a block reports path-block-transform-not-identity', async () => {
    rig.plugin.setPlannerMode(true);
    await cmd(rig, 'layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 90 });
    rig.nodes.get('Root/PathNetwork/PN_Block_1')!.position.x = 1;
    live().markDirty();
    live().tick();
    expect(ids()).toContain('path-network:path-block-transform-not-identity:PN_Block_1');
    await expect(cmd(rig, 'layout.path.move', { blockId: 'PN_Block_1', dx: 1 })).rejects.toThrow(/transform-not-identity/);
  });
});
