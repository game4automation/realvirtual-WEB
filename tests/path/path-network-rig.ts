// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared rig of the plan-628 path-network UI tests (copy of the rig in
 * path-block-commands.test.ts, extended with a camera + canvas so the UI
 * controller can raycast): a real RvDocument with a scene-like executor and a
 * stub viewer around the real PathVisualizerPlugin. Not a test file.
 */

import { Object3D, PerspectiveCamera, Scene } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { RVPathComponent } from '../../src/core/engine/rv-path';
import { getComponentInstances, setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';

interface NodeSpecLike {
  parentPath: string; name: string;
  position: number[]; quaternion: number[]; scale: number[];
  components: Record<string, Record<string, unknown>>;
}
type AnyOp = { kind: string; nodePath: string; spec?: NodeSpecLike; componentType?: string; fieldName?: string; value?: unknown; prev?: unknown; ops?: AnyOp[] };

export interface Rig {
  scene: Scene;
  root: Object3D;
  nodes: Map<string, Object3D>;
  doc: RvDocument;
  plugin: PathVisualizerPlugin;
  stub: Stub;
  failOn: { kind: string | null };
}

export interface Stub {
  scene: Scene;
  currentModel: Object3D;
  camera: PerspectiveCamera; controls: { enabled: boolean }; renderer: { domElement: HTMLCanvasElement } | null; raycastManager: null;
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

export function makeRig(canvas: HTMLCanvasElement | null = null): Rig {
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
    camera: makeCamera(), controls: { enabled: true }, renderer: canvas ? { domElement: canvas } : null, raycastManager: null,
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

/** Network fingerprint from the nodes: sorted ids, segments, successors, zones + block extras. */
export function fingerprint(rig: Rig): string {
  const { input } = snapshotNetwork(rig.stub as never);
  const paths = [...input.paths].sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, block: p.block, seg: p.segments, succ: p.successors, zone: p.zone ?? null }));
  const blocks = [...(input.blocks ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((b) => ({ id: b.id, x: b.extras }));
  return JSON.stringify({ paths, blocks, live: getDefaultPathNetwork().all().map((p) => p.id).sort() });
}

/** A top-down camera 20 m above the origin looking down (−Y), +X right on screen. */
function makeCamera(): PerspectiveCamera {
  const c = new PerspectiveCamera(50, 800 / 600, 0.1, 200);
  c.position.set(0, 20, 0);
  c.up.set(0, 0, -1);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
}
