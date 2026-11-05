// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-bind-batch.node.test.ts — the batch form of `signal.bind` (plan-2233 F6).
 *
 * Real classes end to end: SignalStore, SignalBindingManager, resolver, SlotIO, RvDocument with
 * the scene executors (SignalLinks executor), node persistence, `bindWithUnitScale` and the
 * registry command. The only stand-in is the component: a probe with slot fields, declared
 * `poll` like any slot component (plan-2233 spike rig).
 *
 * Checks: byte-identical to binding the slots one by one, ONE undo step, a refused entry
 * touches nothing, a failure mid-batch rolls the whole batch back, a picker bind started while
 * the batch runs lands after it (never inside it, commands-mcp 3), `interfaceId` always set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  registerComponentSchema, resolveComponentRefs, type ComponentSchema,
} from '../src/core/engine/rv-component-registry';
import { slotDeclare, slotTryRead } from '../src/core/engine/rv-slot-io';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvSceneOp } from '../src/core/ops/rv-unified-ops';
import { freshOpId } from '../src/core/ops/rv-op-utils';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { createSignalBindCommandDescriptors } from '../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import { bindWithUnitScale } from '../src/plugins/signal-bind/unit-scale';
import { runInBindQueue } from '../src/core/hmi/rv-bind-queue';
import type { PickerSignal } from '../src/core/hmi/rv-signal-slot-row';
import type { RVViewer } from '../src/core/rv-viewer';

const TYPE = 'BatchProbe2233';
const SLOTS = ['A', 'B', 'C', 'Flag'] as const;
registerComponentSchema(TYPE, {
  A: { type: 'componentRef', signal: 'PLCOutputFloat', default: null },
  B: { type: 'componentRef', signal: 'PLCOutputFloat', default: null },
  C: { type: 'componentRef', signal: 'PLCOutputFloat', default: null },
  Flag: { type: 'componentRef', signal: 'PLCOutputBool', default: null },
} as ComponentSchema);

class Probe {
  [k: string]: unknown;
  constructor(readonly node: Object3D) { for (const s of SLOTS) this[s] = null; }
  init(registry: NodeRegistry): void {
    resolveComponentRefs(this as unknown as Record<string, unknown>, registry);
    for (const s of SLOTS) slotDeclare(this, s, 'poll');
  }
}

type Row = { slot: string; componentPath: string; kind: 'direct-property'; direction: 'plcOutput' | 'plcInput'; componentType?: string };

let seq = 0;
function rig() {
  const scene = new Scene();
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const nodes: Object3D[] = [];
  for (const name of ['P1', 'P2']) {
    const node = new Object3D();
    node.name = `${name}_${++seq}`;
    scene.add(node);
    registry.registerNode(node.name, node);
    node.userData.realvirtual = { [TYPE]: Object.fromEntries(SLOTS.map((s) => [s, null])) };
    const probe = new Probe(node);
    registry.register(TYPE, node.name, probe as never);
    probe.init(registry);
    nodes.push(node);
  }
  const manager = new SignalBindingManager(store, registry);
  manager.holdMs = 0;
  const viewer = {
    registry, signalStore: store, signalBindingManager: manager, scene,
    markRenderDirty: () => {}, logicEngine: null, modes: { activeMode: 'hmi' }, currentModelRoot: scene,
    on: () => () => {}, emit: () => {}, getPlugin: () => undefined, behaviors: { getActiveBinds: () => [] },
  } as unknown as RVViewer;
  const doc = new RvDocument({
    id: `batch-${seq}`, name: 'batch', mode: 'scene', canApply: () => true,
    executor: {
      applyForward: (op) => applyForward(op as RvSceneOp, { viewer }),
      applyInverse: (op) => applyInverse(op as RvSceneOp, { viewer }),
    },
  });
  const mkOp = (p: string, c: string, f: string, v: unknown, prev: unknown) => ({
    id: freshOpId(), ts: Date.now(), schemaV: 1 as const, kind: 'setField' as const,
    nodePath: p, componentType: c, fieldName: f, value: v, prev,
  });
  const et: EditTarget = {
    available: true, documentKey: doc,
    setField(p, c, f, v, prev) { doc.applyOpDetached(mkOp(p, c, f, v, prev)); },
    setFieldAsync(p, c, f, v, prev) { return doc.applyOp(mkOp(p, c, f, v, prev)); },
    unsetField() { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(et);
  const commands = new CommandRegistry();
  for (const d of createSignalBindCommandDescriptors()) commands.register(d);
  const connect = (name: string, plcType: string): PickerSignal => {
    store.register(name, `__iface__/${name}`, plcType.endsWith('Bool') ? false : 0, plcType);
    store.registerSignalProvider({ interfaceId: 'connect', signal: name }, true);
    return { name, interfaceId: 'connect', direction: 'output', dataType: plcType, origin: 'connect' };
  };
  const exec = (args: unknown) => commands.execute<Record<string, unknown>>('signal.bind', args, { origin: 'mcp', viewer });
  const mappings = (node: Object3D) =>
    ((node.userData.realvirtual as Record<string, { Mappings?: unknown[] }>).SignalLinks?.Mappings ?? []) as Array<Record<string, unknown>>;
  const row = (node: Object3D, slot: string) => {
    const s = manager.getElementSlots(node.name, node, 'own').find((x) => x.slot === slot) as unknown as Row;
    return { slot: s.slot, componentPath: s.componentPath, kind: s.kind, direction: s.direction, componentType: s.componentType };
  };
  return { nodes, store, manager, doc, et, viewer, connect, exec, mappings, row, commands };
}

const entry = (node: Object3D, slot: string, signal: string | null) =>
  ({ targetId: node.name, componentPath: '.', slot, signal });

afterEach(() => setActiveEditTarget(null));

describe('signal.bind batch form (plan-2233 F6)', () => {
  it('stores exactly what one-by-one picker binds store, in ONE undo step', async () => {
    const ref = rig();
    for (const [n, t] of [['s.a', 'PLCOutputFloat'], ['s.b', 'PLCOutputFloat'], ['s.flag', 'PLCOutputBool']] as const) ref.connect(n, t);
    const [r1] = ref.nodes;
    for (const [slot, name, type] of [['A', 's.a', 'PLCOutputFloat'], ['B', 's.b', 'PLCOutputFloat'], ['Flag', 's.flag', 'PLCOutputBool']] as const) {
      await bindWithUnitScale(ref.viewer, { kind: 'node', nodePath: r1.name, node: r1, label: r1.name },
        createSignalBindingPersistence(ref.viewer, { kind: 'node', nodePath: r1.name, node: r1, label: r1.name }),
        ref.row(r1, slot), { name, interfaceId: 'connect', direction: 'output', dataType: type, origin: 'connect' });
    }
    const pickerBytes = JSON.stringify(ref.mappings(r1));

    const r = rig();
    for (const [n, t] of [['s.a', 'PLCOutputFloat'], ['s.b', 'PLCOutputFloat'], ['s.flag', 'PLCOutputBool']] as const) r.connect(n, t);
    const [n1] = r.nodes;
    const undoBefore = r.doc.historyHead().undoLen;
    const res = await r.exec({ bindings: [entry(n1, 'A', 's.a'), entry(n1, 'B', 's.b'), entry(n1, 'Flag', 's.flag')], label: 'Fill' });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(r.mappings(n1))).toBe(pickerBytes.split(r1.name).join(n1.name));
    expect(r.mappings(n1).every((m) => m.interfaceId === 'connect')).toBe(true);
    expect(r.doc.historyHead().undoLen).toBe(undoBefore + 1);
    expect(r.manager.getBindingLiveness(n1.name, 'A', '.')).toBe('live');
    await r.doc.undo();
    expect(r.mappings(n1)).toHaveLength(0);
    expect(r.manager.getBindingLiveness(n1.name, 'A', '.')).toBeUndefined();
    await r.doc.redo();
    expect(r.mappings(n1)).toHaveLength(3);
  });

  it('a refused entry (type mismatch) touches nothing', async () => {
    const r = rig();
    r.connect('s.a', 'PLCOutputFloat');
    r.connect('s.flag', 'PLCOutputBool');
    const [n1] = r.nodes;
    const undo = r.doc.historyHead().undoLen;
    const res = await r.exec({ bindings: [entry(n1, 'A', 's.a'), entry(n1, 'B', 's.flag')] });
    expect(res.ok).toBe(false);
    expect(r.mappings(n1)).toHaveLength(0);
    expect(r.doc.historyHead().undoLen).toBe(undo);
  });

  it('a failure in the middle rolls the whole batch back; foreign bindings stay', async () => {
    const r = rig();
    r.connect('s.a', 'PLCOutputFloat');
    r.connect('s.b', 'PLCOutputFloat');
    const [n1, n2] = r.nodes;
    expect((await r.exec(entry(n2, 'C', 's.a'))).ok).toBe(true);
    const foreign = JSON.stringify(r.mappings(n2));
    const undo = r.doc.historyHead().undoLen;
    // The second bind of the batch is refused at run time (the manager rejects it).
    const original = r.manager.getBindingLiveness.bind(r.manager);
    let calls = 0;
    r.manager.getBindingLiveness = ((id: string, slot: string, cp?: string) =>
      (slot === 'B' && ++calls > 0 ? undefined : original(id, slot, cp))) as typeof r.manager.getBindingLiveness;
    const res = await r.exec({ bindings: [entry(n1, 'A', 's.a'), entry(n1, 'B', 's.b'), entry(n2, 'A', 's.b')] });
    r.manager.getBindingLiveness = original;
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('rolled back');
    expect(r.mappings(n1)).toHaveLength(0);
    expect(JSON.stringify(r.mappings(n2))).toBe(foreign);
    expect(r.doc.historyHead().undoLen).toBe(undo);
    expect(r.manager.getBindingLiveness(n1.name, 'A', '.')).toBeUndefined();
  });

  it('clears a slot with signal null inside the same undo step', async () => {
    const r = rig();
    r.connect('s.a', 'PLCOutputFloat');
    r.connect('s.b', 'PLCOutputFloat');
    const [n1] = r.nodes;
    expect((await r.exec(entry(n1, 'A', 's.a'))).ok).toBe(true);
    const undo = r.doc.historyHead().undoLen;
    expect((await r.exec({ bindings: [entry(n1, 'A', null), entry(n1, 'B', 's.b')] })).ok).toBe(true);
    expect(r.mappings(n1).map((m) => m.slot)).toEqual(['B']);
    expect(r.doc.historyHead().undoLen).toBe(undo + 1);
    await r.doc.undo();
    expect(r.mappings(n1).map((m) => m.slot)).toEqual(['A']);
  });

  it('concurrency: a picker bind and a second batch started meanwhile each land as their own step, never inside', async () => {
    const r = rig();
    for (const n of ['s.a', 's.b', 's.c']) r.connect(n, 'PLCOutputFloat');
    const [n1, n2] = r.nodes;
    const undo = r.doc.historyHead().undoLen;
    const target = { kind: 'node' as const, nodePath: n2.name, node: n2, label: n2.name };
    const batch = r.exec({ bindings: [entry(n1, 'A', 's.a'), entry(n1, 'B', 's.b')] });
    const picker = bindWithUnitScale(r.viewer, target, createSignalBindingPersistence(r.viewer, target), r.row(n2, 'C'),
      { name: 's.c', interfaceId: 'connect', direction: 'output', dataType: 'PLCOutputFloat', origin: 'connect' });
    const batch2 = r.exec({ bindings: [entry(n2, 'A', 's.a')] });
    const [b1, p, b2] = await Promise.all([batch, picker, batch2]);
    expect([b1.ok, p?.persisted, b2.ok]).toEqual([true, true, true]);
    expect(r.doc.historyHead().undoLen).toBe(undo + 3);
    // Undo the last two: the first batch is untouched, in one piece.
    await r.doc.undo();
    await r.doc.undo();
    expect(r.mappings(n1).map((m) => m.slot)).toEqual(['A', 'B']);
    expect(r.mappings(n2)).toHaveLength(0);
    await r.doc.undo();
    expect(r.mappings(n1)).toHaveLength(0);
  });

  it('a composite edit holding the queue: its batch passes the hold and runs inside; a foreign bind waits; a forged hold queues', async () => {
    const r = rig();
    for (const n of ['s.a', 's.b', 's.c']) r.connect(n, 'PLCOutputFloat');
    const [n1, n2] = r.nodes;
    const target = { kind: 'node' as const, nodePath: n2.name, node: n2, label: n2.name };
    const order: string[] = [];
    let foreign: Promise<unknown> | undefined;
    let wrong: Promise<unknown> | undefined;
    const undo = r.doc.historyHead().undoLen;
    await runInBindQueue(r.et, async (hold) => {
      await r.doc.withTransaction('Composite', async () => {
        foreign = bindWithUnitScale(r.viewer, target, createSignalBindingPersistence(r.viewer, target), r.row(n2, 'C'),
          { name: 's.c', interfaceId: 'connect', direction: 'output', dataType: 'PLCOutputFloat', origin: 'connect' })
          .then((x) => { order.push('foreign'); return x; });
        // A JSON caller can only send a string or a fresh object — never the hold itself.
        wrong = r.exec({ bindings: [entry(n2, 'A', 's.a')], _queueHold: JSON.parse('{}') }).then((x) => { order.push('wrong'); return x; });
        const own = await r.exec({ bindings: [entry(n1, 'A', 's.a'), entry(n1, 'B', 's.b')], _queueHold: hold });
        expect(own.ok).toBe(true);
        order.push('own');
      });
    });
    await Promise.all([foreign, wrong]);
    expect(order).toEqual(['own', 'foreign', 'wrong']);
    // Composite = one step; the foreign bind and the wrong-token batch each their own.
    expect(r.doc.historyHead().undoLen).toBe(undo + 3);
  });

  it('regression: a guessed token string in the args never enters the held queue', async () => {
    const r = rig();
    r.connect('s.a', 'PLCOutputFloat');
    const [, n2] = r.nodes;
    const order: string[] = [];
    let guessed: Promise<unknown> | undefined;
    await runInBindQueue(r.et, async () => {
      for (const forged of ['bq1', 'bq2', 'bq3'])
        guessed = r.exec({ bindings: [entry(n2, 'A', 's.a')], _queueHold: forged }).then((x) => { order.push(forged); return x; });
      await new Promise((res) => setTimeout(res, 5));
      order.push('holder done');
    });
    await guessed;
    expect(order[0]).toBe('holder done');
  });

  it('foreign unbinds are queued: never inside a held composite, kept when the composite rolls back', async () => {
    const r = rig();
    r.connect('s.a', 'PLCOutputFloat');
    r.connect('s.c', 'PLCOutputFloat');
    const [n1, n2] = r.nodes;
    expect((await r.exec(entry(n2, 'C', 's.c'))).ok).toBe(true);
    const unbind = (slot: string) => r.commands.execute('signal.unbind', { targetId: n2.name, componentPath: '.', slot }, { origin: 'mcp', viewer: r.viewer });
    let foreign: Promise<unknown> | undefined;
    // The composite fails and rolls back; the foreign unbind started inside it must survive.
    await expect(runInBindQueue(r.et, async (hold) => {
      await r.doc.withTransaction('Composite', async () => {
        foreign = unbind('C');
        const own = await r.exec({ bindings: [entry(n1, 'A', 's.a')], _queueHold: hold });
        expect(own.ok).toBe(true);
        throw new Error('composite fails');
      });
    })).rejects.toThrow('composite fails');
    expect((await foreign) as { ok: boolean }).toMatchObject({ ok: true });
    expect(r.mappings(n1)).toHaveLength(0);
    expect(r.mappings(n2)).toHaveLength(0);
    // On success the unbind is its own undo step after the composite.
    expect((await r.exec(entry(n2, 'C', 's.c'))).ok).toBe(true);
    const undo = r.doc.historyHead().undoLen;
    await runInBindQueue(r.et, async (hold) => {
      await r.doc.withTransaction('Composite', async () => {
        foreign = unbind('C');
        await r.exec({ bindings: [entry(n1, 'A', 's.a')], _queueHold: hold });
      });
    });
    await foreign;
    expect(r.doc.historyHead().undoLen).toBe(undo + 2);
    await r.doc.undo();
    expect(r.mappings(n2).map((m) => m.slot)).toEqual(['C']);
    expect(r.mappings(n1).map((m) => m.slot)).toEqual(['A']);
  });

  it('the descriptor announces the batch form in its argsSchema (web_commands)', () => {
    const d = createSignalBindCommandDescriptors().find((x) => x.id === 'signal.bind')!;
    expect(d.argsSchema).toMatchObject({ bindings: 'object[]', label: 'string', signal: 'string' });
    expect(Object.keys(d.argsSchema)).not.toContain('_queueHold');
  });

  it('macro args of the batch drop the internal queue token', async () => {
    const d = createSignalBindCommandDescriptors().find((x) => x.id === 'signal.bind')!;
    const impl = (await d.impl()) as { resolveArgs(c: unknown, a: unknown): unknown };
    expect(impl.resolveArgs({}, { bindings: [{ targetId: ' T ', componentPath: '.', slot: 'A', signal: 's.a' }], label: 'L', _queueHold: {} }))
      .toEqual({ bindings: [{ targetId: 'T', componentPath: '.', slot: 'A', signal: 's.a' }], label: 'L' });
  });

  it('the single form is unchanged and an empty batch is refused', async () => {
    const r = rig();
    r.connect('s.a', 'PLCOutputFloat');
    const [n1] = r.nodes;
    expect((await r.exec({ bindings: [] })).ok).toBe(false);
    const single = await r.exec(entry(n1, 'A', 's.a'));
    expect(single.ok).toBe(true);
    r.store.set('s.a', 2.5);
    const probe = r.viewer.registry!.getComponentsAt?.(n1.name)?.[0]?.[1] as object | undefined;
    if (probe) expect(slotTryRead(r.store, probe, 'A', null)).toBe(2.5);
  });
});
