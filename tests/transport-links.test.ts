// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  createBindContext,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import type { SnapLite, PortConnection } from '../src/behaviors/_shared/snap-graph-helpers';
import {
  declareFlowSignals,
  createDownstreamInterlock,
  outputLink,
  outputLinks,
  linkOf,
  portIds,
  type TransportLink,
} from '../src/behaviors/_shared/transport-links';

// ── Inline mock store (pattern from conveyor-/turntable-behavior.test.ts) ─────
function makeStore() {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  return {
    get: (n: string) => values.get(n),
    set: (n: string, v: boolean | number) => {
      values.set(n, v);
      subs.get(n)?.forEach((cb) => cb(v));
    },
    subscribe: (n: string, cb: (v: boolean | number) => void) => {
      let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
      s.add(cb); return () => { s!.delete(cb); };
    },
  };
}
type Store = ReturnType<typeof makeStore>;

describe('continuous sink-at-output interlock', () => {
  function fixture() {
    const output = new Object3D(); output.position.set(0, 0.5, 2);
    const f = makeRv({ rootName: 'ConveyorOut', buildSnaps: root => {
      root.add(output);
      return [{ id: 'out', object3D: output, flow: 'out', ownerRoot: root }];
    } });
    const sink = { isOwner: true, DeleteMus: true, DeleteOnlyTag: '', aabb: {
      min: new Vector3(-0.5, 0.4, 1.8), max: new Vector3(0.5, 0.7, 2.8),
    } };
    const tm = { sinks: [sink] };
    Object.assign(f.rv.viewer, { transportManager: tm });
    return { ...f, output, sink, tm, interlock: createDownstreamInterlock(f.rv, { sinkAtOutput: true }) };
  }

  it('releases into a sink containing the output only when opted in', () => {
    const f = fixture();
    expect(createDownstreamInterlock(f.rv).occupied()).toBe(true);
    expect(f.interlock.occupied()).toBe(false);
    f.tm.sinks.length = 0;
    expect(f.interlock.occupied()).toBe(true); // genuine dead end after removal
  });

  it.each(['x', 'y', 'z'] as const)('rejects a sink away from the output along %s', axis => {
    const f = fixture();
    f.sink.aabb.min[axis] += 5; f.sink.aabb.max[axis] += 5;
    expect(f.interlock.occupied()).toBe(true);
  });

  it('reads sink acceptance changes without waiting for a new transport tick', () => {
    const f = fixture();
    f.sink.DeleteMus = false;
    expect(f.interlock.occupied()).toBe(true);
    f.sink.DeleteMus = true; f.sink.DeleteOnlyTag = 'restricted';
    expect(f.interlock.occupied()).toBe(true);
    f.sink.DeleteOnlyTag = ''; f.sink.isOwner = false;
    expect(f.interlock.occupied()).toBe(true);
    f.sink.isOwner = true;
    expect(f.interlock.occupied()).toBe(false);
  });

  it('uses the output world position for a transformed conveyor', () => {
    const f = fixture();
    f.root.position.x = 10;
    f.root.rotation.y = Math.PI / 2;
    f.sink.aabb.min.set(11.8, 0.4, -0.5); f.sink.aabb.max.set(12.8, 0.7, 0.5);
    expect(f.interlock.occupied()).toBe(false);
  });

  it('never overrides a paired downstream conveyor with a nearby sink', () => {
    const partner = new Object3D(); partner.name = 'Next';
    const f = makeRv({ rootName: 'Conveyor', buildSnaps: root => [
      { id: 'out', object3D: new Object3D(), flow: 'out', pairedSnapId: 'in', ownerRoot: root },
      { id: 'in', object3D: new Object3D(), flow: 'in', pairedSnapId: 'out', ownerRoot: partner },
    ] });
    Object.assign(f.rv.viewer, { transportManager: { sinks: [{
      isOwner: true, DeleteMus: true, DeleteOnlyTag: '',
      aabb: { min: new Vector3(-1, -1, -1), max: new Vector3(1, 1, 1) },
    }] } });
    f.store.set('Next.Flow.Occupied', true);
    expect(createDownstreamInterlock(f.rv, { sinkAtOutput: true }).occupied()).toBe(true);
  });
});

/** Snap-point plugin from a flat snap list (keyed by ownerRoot identity / id). */
function snapPluginFrom(snaps: readonly SnapLite[]) {
  const byOwner = new Map<Object3D, SnapLite[]>();
  for (const s of snaps) {
    const list = byOwner.get(s.ownerRoot) ?? []; list.push(s); byOwner.set(s.ownerRoot, list);
  }
  const byId = new Map(snaps.map(s => [s.id, s]));
  return {
    getRegistry: () => ({
      getByOwnerRoot: (r: Object3D) => byOwner.get(r) ?? [],
      getById: (id: string) => byId.get(id),
    }),
  };
}

/**
 * Build a bind context. `buildSnaps(root)` is invoked AFTER the root exists so
 * snaps can reference `root` by identity (required for `getByOwnerRoot`). When
 * `scopeName` is set, a LayoutObject marker scopes the behavior's own signals.
 */
function makeRv(opts: {
  rootName: string;
  scopeName?: string;
  store?: Store;
  buildSnaps?: (root: Object3D) => SnapLite[];
}): { rv: RVBindContext; root: Object3D; accum: KinematicsSpec; store: Store } {
  const store = opts.store ?? makeStore();
  const events = new EventEmitter<Record<string, unknown>>();
  const root = new Object3D(); root.name = opts.rootName;
  if (opts.scopeName) {
    root.userData.realvirtual = { LayoutObject: { Label: opts.scopeName, CatalogId: 'c', Locked: false } };
  }
  const snaps = opts.buildSnaps ? opts.buildSnaps(root) : [];
  const host: BindContextHost = {
    signalStore: store,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
    getPlugin: (id: string) => (id === 'snap-point' ? snapPluginFrom(snaps) : undefined),
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return { rv: ctx, root, accum, store };
}

/**
 * Build a conveyor whose OUTPUT snap (`mySnapId`) mates a partner's snap
 * (`partnerSnapId`) on a partner root named `partnerName`; returns the resolved
 * `outputLink` plus the shared store.
 */
function makeOutLink(convName: string, partnerName: string, mySnapId: string, partnerSnapId: string) {
  const store = makeStore();
  const partner = new Object3D(); partner.name = partnerName;
  const { rv } = makeRv({
    rootName: convName,
    store,
    buildSnaps: (root) => [
      { id: mySnapId, object3D: new Object3D(), flow: 'out', pairedSnapId: partnerSnapId, ownerRoot: root },
      { id: partnerSnapId, object3D: new Object3D(), flow: 'in', pairedSnapId: mySnapId, ownerRoot: partner },
    ],
  });
  const link = outputLink(rv);
  if (!link) throw new Error('expected an output link');
  return { link, store, partner };
}

describe('TransportLink.occupied — per-port then root', () => {
  // NOTE: the raw mock store holds RESOLVED keys (the `/`-global-escape is applied
  // by rv.signals before it reaches the store), so seed without the leading slash.
  it('reads the per-port signal when it is present', () => {
    const { link, store } = makeOutLink('Conv', 'TT', 'C', 'P');
    store.set('TT.Flow.Occupied', false);      // root says free
    store.set('TT.Flow.Occupied@P', true);     // but the per-port says blocked
    expect(link.occupied()).toBe(true);
  });

  it('falls back to the root Occupied when no per-port signal exists', () => {
    const { link, store } = makeOutLink('Conv', 'TT', 'C', 'P');
    store.set('TT.Flow.Occupied', true);
    expect(link.occupied()).toBe(true);
  });

  it('false/undefined → not occupied (optimistic)', () => {
    const { link, store } = makeOutLink('Conv', 'TT', 'C', 'P');
    expect(link.occupied()).toBe(false);           // unset → false
    store.set('TT.Flow.Occupied', false);
    expect(link.occupied()).toBe(false);           // explicit false → false
  });
});

describe('outputLink / outputLinks — no successor', () => {
  it('outputLink returns null at the end of the line (unpaired out snap)', () => {
    const { rv } = makeRv({
      rootName: 'Conv',
      buildSnaps: (root) => [
        { id: 'a-out', object3D: new Object3D(), flow: 'out', pairedSnapId: undefined, ownerRoot: root },
      ],
    });
    expect(outputLink(rv)).toBeNull();
  });

  it('outputLinks is empty at the end of the line', () => {
    const { rv } = makeRv({
      rootName: 'Conv',
      buildSnaps: (root) => [
        { id: 'a-out', object3D: new Object3D(), flow: 'out', pairedSnapId: undefined, ownerRoot: root },
      ],
    });
    expect(outputLinks(rv)).toEqual([]);
  });
});

describe('TransportLink.setOccupied — own scope keyed by mySnapId', () => {
  it('writes Flow.Occupied@<mySnapId> in the instance scope', () => {
    const { rv } = makeRv({ rootName: 'TT', scopeName: 'TT' });
    const partner = new Object3D(); partner.name = 'Conv';
    const conn: PortConnection = {
      role: 'input',
      ownerRoot: partner,
      snap: { id: 'P', object3D: new Object3D(), flow: 'in', pairedSnapId: 'C', ownerRoot: rv.root },
      pairedSnap: { id: 'C', object3D: new Object3D(), flow: 'out', pairedSnapId: 'P', ownerRoot: partner },
    };
    const link: TransportLink = linkOf(rv, conn);
    link.setOccupied(true);
    // rv.signals.set scopes 'Flow.Occupied@P' → 'TT.Flow.Occupied@P'.
    expect(rv.signals.get<boolean>('Flow.Occupied@P')).toBe(true);
  });
});

describe('TransportLink.upstreamWaiting — partner root Occupied', () => {
  it('is true when the connected upstream root publishes Occupied=true', () => {
    const { link, store } = makeOutLink('TT', 'Infeed', 'P', 'I');
    store.set('Infeed.Flow.Occupied', true);   // resolved key (no leading slash)
    expect(link.upstreamWaiting()).toBe(true);
  });
  it('is false when the partner root Occupied is unset/false', () => {
    const { link, store } = makeOutLink('TT', 'Infeed', 'P', 'I');
    expect(link.upstreamWaiting()).toBe(false);
    store.set('Infeed.Flow.Occupied', false);
    expect(link.upstreamWaiting()).toBe(false);
  });
});

describe('TransportLink — SYMMETRY: turntable setOccupied ↔ conveyor occupied()', () => {
  it('both sides resolve to the same signal key', () => {
    // Shared store so both contexts write/read the same Map.
    const store = makeStore();

    // ── Turntable side: scoped root 'TT', port snap id 'P' ──
    const ttCtx = makeRv({ rootName: 'TT', scopeName: 'TT', store });
    const ttPartner = new Object3D(); ttPartner.name = 'Conv';
    const ttConn: PortConnection = {
      role: 'output',
      ownerRoot: ttPartner,
      snap: { id: 'P', object3D: new Object3D(), flow: 'out', pairedSnapId: 'C', ownerRoot: ttCtx.root },
      pairedSnap: { id: 'C', object3D: new Object3D(), flow: 'in', pairedSnapId: 'P', ownerRoot: ttPartner },
    };
    const ttLink = linkOf(ttCtx.rv, ttConn);

    // ── Conveyor side: an output link whose partner root is named 'TT', snap id 'P' ──
    const ttRootForCv = new Object3D(); ttRootForCv.name = 'TT';
    const cvCtx = makeRv({
      rootName: 'Conv',
      store,
      buildSnaps: (root) => [
        { id: 'C', object3D: new Object3D(), flow: 'out', pairedSnapId: 'P', ownerRoot: root },
        { id: 'P', object3D: new Object3D(), flow: 'in', pairedSnapId: 'C', ownerRoot: ttRootForCv },
      ],
    });
    const cvLink = outputLink(cvCtx.rv);
    if (!cvLink) throw new Error('expected an output link on the conveyor');

    // Turntable blocks its port → conveyor must see it as occupied (same resolved key).
    ttLink.setOccupied(true);                  // writes TT.Flow.Occupied@P
    expect(cvLink.occupied()).toBe(true);      // reads /TT.Flow.Occupied@P → TT.Flow.Occupied@P

    ttLink.setOccupied(false);
    expect(cvLink.occupied()).toBe(false);
  });

  it('migrated freeCandidates trichotomy: true blocks, false/undefined free', () => {
    // Replaces the old freeCandidates block from turntable-behavior.test.ts:
    // three downstream outputs A/B/C; only B is explicitly occupied.
    const store = makeStore();
    const ttCtx = makeRv({ rootName: 'TT', store });
    const A = new Object3D(); A.name = 'A';
    const B = new Object3D(); B.name = 'B';
    const C = new Object3D(); C.name = 'C';
    const conn = (owner: Object3D, snapId: string, partnerId: string): PortConnection => ({
      role: 'output',
      ownerRoot: owner,
      snap: { id: snapId, object3D: new Object3D(), flow: 'out', pairedSnapId: partnerId, ownerRoot: ttCtx.root },
      pairedSnap: { id: partnerId, object3D: new Object3D(), flow: 'in', pairedSnapId: snapId, ownerRoot: owner },
    });
    const conns = [conn(A, 'pA', 'iA'), conn(B, 'pB', 'iB'), conn(C, 'pC', 'iC')];
    // Resolved keys (the `/`-escape is stripped by rv.signals before the store).
    store.set('B.Flow.Occupied', true);      // B blocked
    store.set('C.Flow.Occupied', false);     // C explicitly free; A unset
    const free = conns.filter(c => !linkOf(ttCtx.rv, c).occupied());
    expect(free.map(c => c.ownerRoot)).toEqual([A, C]);
  });
});

describe('declareFlowSignals — registers the 4-signal contract', () => {
  it('registers Run/Occupied/Running/PartCount with correct PLC types and initial values', () => {
    const { rv, root, accum } = makeRv({ rootName: 'Conv' });
    declareFlowSignals(rv);
    applyKinematicsSpec(root, accum);
    const list = (root.userData.realvirtual as { __BehaviorSignals: Array<Record<string, unknown>> }).__BehaviorSignals;
    const byName = new Map(list.map(s => [s.Name as string, s]));

    expect(byName.size).toBe(4);
    expect(byName.get('Flow.Run')).toMatchObject({ Type: 'PLCInputBool', InitialValue: true });
    expect(byName.get('Flow.Occupied')).toMatchObject({ Type: 'PLCOutputBool', InitialValue: false });
    expect(byName.get('Flow.Running')).toMatchObject({ Type: 'PLCOutputBool', InitialValue: false });
    expect(byName.get('Flow.PartCount')).toMatchObject({ Type: 'PLCOutputInt', InitialValue: 0 });
  });
});

describe('portIds — mirror of all own snaps (paired and unpaired)', () => {
  it('returns the ids of every own snap', () => {
    const { rv } = makeRv({
      rootName: 'TT',
      buildSnaps: (root) => [
        { id: 's-paired', object3D: new Object3D(), flow: 'in', pairedSnapId: 'x', ownerRoot: root },
        { id: 's-unpaired', object3D: new Object3D(), flow: 'out', pairedSnapId: undefined, ownerRoot: root },
      ],
    });
    expect(portIds(rv).sort()).toEqual(['s-paired', 's-unpaired']);
  });
});
