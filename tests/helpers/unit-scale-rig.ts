// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 — the test rig of the unit-aware bind: ONE drive node with its
 * behaviors, a real `RvDocument` over the real scene executors, the real
 * `SignalBindingManager`, the real node persistence and an edit target shaped
 * like the SceneStore adapter (awaitable `setFieldAsync`, `documentKey`).
 * The scene overlay the override rule reads is derived from the document's
 * op log, like the rv-extras editor derives it from the SceneStore.
 *
 * Seams that are test-only live HERE, never in production code: the
 * executor gate (hold an op mid-transaction), the `canApply` switch (a scene
 * load), and the relay-writer spy (every published value, deduplicated or not).
 */

import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../../src/core/engine/rv-signal-construction';
import { resolveComponentRefs, type ComponentContext, type RVComponent } from '../../src/core/engine/rv-component-registry';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp, RvSceneOp } from '../../src/core/ops/rv-unified-ops';
import { freshOpId } from '../../src/core/ops/rv-op-utils';
import { applyForward, applyInverse } from '../../src/core/hmi/scene/rv-scene-executors';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import type { RVExtrasOverlay } from '../../src/core/engine/rv-extras-overlay-store';
import { createSignalBindingPersistence, type SignalBindingPersistenceAdapter } from '../../src/plugins/signal-bind/signal-binding-persistence';
import type { SignalBindTarget } from '../../src/plugins/signal-bind/signal-bind-target';
import type { SignalMapping } from '../../src/plugins/layout-planner/rv-layout-store';
import type { PickerSignal, SlotRow } from '../../src/core/hmi/rv-signal-slot-row';
import type { UnitDef } from '../../src/core/engine/rv-units';
import {
  bindWithUnitScale,
  reconcileUnitProblems,
  resetScaleToAuto,
  type UnitBindResult,
} from '../../src/plugins/signal-bind/unit-scale';
import type { RVViewer } from '../../src/core/rv-viewer';

export type RigRow = Pick<SlotRow, 'slot' | 'componentPath' | 'kind' | 'direction' | 'componentType'>;

export interface UnitRig {
  scene: Scene;
  node: Object3D;
  nodePath: string;
  registry: NodeRegistry;
  store: SignalStore;
  manager: SignalBindingManager;
  drive: RVDrive;
  viewer: RVViewer;
  doc: RvDocument;
  editTarget: EditTarget;
  target: Extract<SignalBindTarget, { kind: 'node' }>;
  /** Live behavior instances by component key. */
  component<T = Record<string, unknown>>(type: string): T & RVComponent;
  persistence(): SignalBindingPersistenceAdapter;
  /** Every value the binding manager's relay writer published, `name=value`, in order. */
  log: string[];
  /** Register a CONNECT-provided signal with an optional source unit. */
  signal(name: string, plcType: 'PLCOutputFloat' | 'PLCInputFloat', unit?: string, unitDef?: UnitDef): PickerSignal;
  /** The resolved row of a slot of this node. */
  row(slot: string): RigRow;
  bind(slot: string, source: PickerSignal, label?: string): Promise<UnitBindResult | null>;
  reset(slot: string): Promise<UnitBindResult | null>;
  /** A user edit of a field (inspector path: one setField op). */
  edit(componentType: string, field: string, value: unknown): Promise<void>;
  /** Current extras value of `componentType.field` on the node. */
  extras(componentType: string, field: string): unknown;
  mapping(slot: string): SignalMapping | undefined;
  /** Move the drive and let it publish its feedback. */
  moveTo(mm: number): void;
  /** Hold the NEXT executor call of an op matching `pred` until `release()`. */
  gate(pred: (op: RvSceneOp) => boolean): { release: () => void; reached: Promise<void> };
  /** Scene-load switch: while false, the document drops ops silently. */
  canApply: { value: boolean };
  dispose(): void;
}

let seq = 0;

function overlayFromOps(ops: readonly RvOp[]): RVExtrasOverlay {
  const nodes: Record<string, Record<string, Record<string, unknown>>> = {};
  const visit = (op: RvOp): void => {
    const o = op as unknown as Record<string, unknown>;
    if (o.kind === 'composite') { for (const c of o.ops as RvOp[]) visit(c); return; }
    const np = o.nodePath as string; const ct = o.componentType as string; const f = o.fieldName as string;
    if (o.kind === 'setField') ((nodes[np] ??= {})[ct] ??= {})[f] = o.value;
    else if (o.kind === 'unsetField') delete nodes[np]?.[ct]?.[f];
  };
  for (const op of ops) visit(op);
  return { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes } as unknown as RVExtrasOverlay;
}

/**
 * Build the rig. `behaviors` are the behavior extras on the drive node
 * (`{ Drive_FollowPosition: {} }`); the drive stands at `startMm`.
 */
export function unitRig(opts: {
  behaviors: Record<string, Record<string, unknown>>;
  direction?: string;
  startMm?: number;
  reconcile?: boolean;
}): UnitRig {
  const scene = new Scene();
  const node = new Object3D();
  // Unique name per rig: the node persistence caches mappings per node object
  // AND the unit problems are keyed by the path.
  node.name = `Axis${++seq}`;
  scene.add(node);
  const nodePath = node.name;
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode(nodePath, node);
  const rv: Record<string, Record<string, unknown>> = { Drive: { Direction: opts.direction ?? 'LinearX' }, ...opts.behaviors };
  node.userData.realvirtual = rv;
  const result = constructDrive(node, rv, rv.Drive, nodePath, registry, store);
  if (!result) throw new Error('could not construct drive');
  const components = new Map<string, RVComponent>();
  for (const pending of result.pendingBehaviors) {
    registry.register(pending.type, pending.path, pending.component);
    resolveComponentRefs(pending.component as unknown as Record<string, unknown>, registry);
    pending.component.init({ registry, signalStore: store, scene, root: node } as ComponentContext);
    components.set(pending.type, pending.component);
  }
  const drive = result.drive;
  drive.StartPosition = opts.startMm ?? 1000;
  drive.reset();

  const manager = new SignalBindingManager(store, registry);
  manager.holdMs = 0;

  let doc!: RvDocument;
  const overlaySource = {
    id: 'rv-extras-editor',
    getSnapshot: () => ({ overlay: overlayFromOps(doc.ops) }),
  };
  const viewer = {
    registry, signalStore: store, signalBindingManager: manager,
    markRenderDirty: () => {}, logicEngine: null,
    modes: { activeMode: 'hmi' }, currentModelRoot: null,
    getPlugin: (id: string) => (id === 'rv-extras-editor' ? overlaySource : undefined),
  } as unknown as RVViewer;

  const gates: Array<{ pred: (op: RvSceneOp) => boolean; wait: Promise<void>; hit: () => void }> = [];
  const canApply = { value: true };
  const run = async (op: RvSceneOp, dir: 'fwd' | 'inv'): Promise<void> => {
    const i = gates.findIndex((g) => op.kind !== 'composite' && g.pred(op));
    if (i >= 0) { const g = gates.splice(i, 1)[0]; g.hit(); await g.wait; }
    if (dir === 'fwd') await applyForward(op, { viewer }); else await applyInverse(op, { viewer });
  };
  doc = new RvDocument({
    id: `unit-rig-${seq}`, name: 'unit rig', mode: 'scene',
    canApply: () => canApply.value,
    executor: {
      applyForward: (op) => run(op as RvSceneOp, 'fwd'),
      applyInverse: (op) => run(op as RvSceneOp, 'inv'),
    },
  });
  const mkOp = (p: string, c: string, f: string, v: unknown, prev: unknown) => ({
    id: freshOpId(), ts: Date.now(), schemaV: 1 as const, kind: 'setField' as const,
    nodePath: p, componentType: c, fieldName: f, value: v, prev,
  });
  const editTarget: EditTarget = {
    available: true,
    documentKey: doc,
    setField(p, c, f, v, prev) { doc.applyOpDetached(mkOp(p, c, f, v, prev)); },
    setFieldAsync(p, c, f, v, prev) { return doc.applyOp(mkOp(p, c, f, v, prev)); },
    unsetField() { throw new Error('unused in the unit rig'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(editTarget);

  const target: Extract<SignalBindTarget, { kind: 'node' }> = { kind: 'node', nodePath, node, label: node.name };
  const persistence = () => createSignalBindingPersistence(viewer, target);

  const log: string[] = [];
  const writer = (manager as unknown as { _writer: { set: (n: string, v: boolean | number, t?: number) => void; setMany: (u: Record<string, boolean | number>, t?: number) => void } })._writer;
  const origSet = writer.set.bind(writer);
  const origMany = writer.setMany.bind(writer);
  writer.set = (n, v, t) => { log.push(`${n}=${Number(v)}`); origSet(n, v, t); };
  writer.setMany = (u, t) => { for (const n of Object.keys(u)) log.push(`${n}=${Number(u[n])}`); origMany(u, t); };

  const offReconcile = opts.reconcile === false
    ? () => {}
    : manager.addBindingsChangedListener((id, mappings) => reconcileUnitProblems(viewer, id, mappings));

  const rig: UnitRig = {
    scene, node, nodePath, registry, store, manager, drive, viewer, doc, editTarget, target,
    component: <T,>(type: string) => components.get(type) as unknown as T & RVComponent,
    persistence,
    log,
    signal(name, plcType, unit, unitDef) {
      store.register(name, `__iface__/${name}`, 0, plcType);
      store.registerSignalProvider({ interfaceId: 'plc', signal: name }, true);
      if (unit) store.setSignalMeta(name, { unit, ...(unitDef ? { unitDef } : {}), source: 'FMU · test' });
      return { name, interfaceId: 'plc', direction: plcType.startsWith('PLCOutput') ? 'output' : 'input', dataType: plcType, origin: 'connect' };
    },
    row(slot) {
      const s = manager.getElementSlots(nodePath, node, 'own').find((x) => x.slot === slot);
      if (!s || s.kind === 'unavailable') throw new Error(`slot ${slot} not bindable`);
      return { slot: s.slot, componentPath: s.componentPath, kind: s.kind, direction: s.direction, componentType: s.componentType };
    },
    bind: (slot, source, label) => bindWithUnitScale(viewer, target, persistence(), rig.row(slot), source, { label }),
    reset: (slot) => resetScaleToAuto(viewer, target, persistence(), rig.row(slot)),
    edit: (componentType, field, value) => editTarget.setFieldAsync!(nodePath, componentType, field, value, rig.extras(componentType, field)),
    extras: (componentType, field) => (node.userData.realvirtual as Record<string, Record<string, unknown> | undefined>)[componentType]?.[field],
    mapping: (slot) => persistence().read().find((m) => m.slot === slot),
    moveTo(mm) { drive.StartPosition = mm; drive.reset(); manager.tick(0.02); },
    gate(pred) {
      let release!: () => void;
      let hit!: () => void;
      const wait = new Promise<void>((r) => { release = r; });
      const reached = new Promise<void>((r) => { hit = r; });
      gates.push({ pred, wait, hit });
      return { release, reached };
    },
    canApply,
    dispose() { offReconcile(); setActiveEditTarget(null); },
  };
  return rig;
}
