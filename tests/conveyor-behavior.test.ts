// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import {
  createBindContext,
  iterateFixedUpdate,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { matchesAny } from '../src/core/behaviors';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import Conveyor from '../src/behaviors/Conveyor';
import { findDownstreamRoot } from '../src/behaviors/_shared/snap-graph-helpers';

const DT = 1 / 60;

/** Belt-drive stub: the behavior toggles jogForward to run/stop the surface. */
interface FakeBeltDrive {
  name: string;
  node: Object3D;
  jogForward: boolean;
  jogBackward: boolean;
  startMove(d?: number): void;
  stop(): void;
}

function installSensorDouble(
  host: BindContextHost,
  root: Object3D,
  signalStore: { set(name: string, value: boolean | number): void },
): void {
  const node = root.children.find(child => child.name.startsWith('Sensor'));
  if (!node) return;
  const listeners = new Set<() => void>();
  const sensor = {
    node,
    occupied: false,
    addFeedbackListener(cb: () => void) { listeners.add(cb); },
    removeFeedbackListener(cb: () => void) { listeners.delete(cb); },
  };
  const target = host as unknown as {
    transportManager?: { sensors?: typeof sensor[]; surfaces?: unknown[]; mus?: unknown[] } | null;
  };
  const manager = target.transportManager ?? {};
  manager.sensors ??= [];
  manager.surfaces ??= [];
  manager.mus ??= [];
  manager.sensors.push(sensor);
  target.transportManager = manager;

  const originalSet = signalStore.set.bind(signalStore);
  signalStore.set = (name, value) => {
    originalSet(name, value);
    if (name !== node.name && !name.endsWith(`.${node.name}`)) return;
    const occupied = value === true;
    if (occupied === sensor.occupied) return;
    sensor.occupied = occupied;
    for (const listener of listeners) listener();
  };
}

function setup() {
  const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
  const signalValues = new Map<string, boolean | number>();
  const signalStore = {
    get(name: string) { return signalValues.get(name); },
    set(name: string, value: boolean | number) {
      signalValues.set(name, value);
      const subs = signalSubs.get(name);
      if (subs) for (const cb of subs) cb(value);
    },
    subscribe(name: string, cb: (v: boolean | number) => void) {
      let s = signalSubs.get(name);
      if (!s) { s = new Set(); signalSubs.set(name, s); }
      s.add(cb);
      return () => { s!.delete(cb); };
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const contextMenu = new ContextMenuStore();

  const root = new Object3D(); root.name = 'Conveyor';
  const beltNode = new Object3D(); beltNode.name = 'Transport-X'; root.add(beltNode);
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor-1'; root.add(sensorNode);

  const drive: FakeBeltDrive = {
    name: 'Transport-X',
    node: beltNode,
    jogForward: false,
    jogBackward: false,
    startMove() {},
    stop() {},
  };

  const host: BindContextHost = {
    signalStore,
    on: (event, cb) => events.on(event, cb as never),
    contextMenu,
    drives: [drive],
    registry: null,
  };

  const accum: KinematicsSpec = {};
  installSensorDouble(host, root, signalStore);
  const { ctx, handle } = createBindContext(root, host, accum);
  Conveyor.bind(ctx);

  return { signalStore, drive, handle, root, accum };
}

describe('Conveyor behavior — hierarchy badge', () => {
  it('registers a ConveyorBehavior badge capability (hierarchy badge; inspector marker hidden)', () => {
    const caps = getCapabilities('ConveyorBehavior');
    expect(caps.hierarchyVisible).toBe(true);
    // plan-200 C1: the stamped marker section is hidden in the inspector (the
    // behavior is shown via the design-consistent States+Hardware section); the
    // hierarchy badge + the Behavior filterLabel gate stay.
    expect(caps.inspectorVisible).toBe(false);
    expect(caps.filterLabel).toBe('Behavior');
    expect(caps.badgeColor).toBe('#7e57c2');
  });

  it('stamps a ConveyorBehavior marker on the object root', () => {
    const { root, accum } = setup();
    applyKinematicsSpec(root, accum);
    const rv = root.userData.realvirtual as Record<string, unknown>;
    expect(rv.ConveyorBehavior).toMatchObject({ Belt: 'Transport-X', Sensor: 'Sensor-1' });
  });
});

describe('Conveyor behavior — model matching', () => {
  it('matches any GLB filename containing "Conveyor"', () => {
    for (const name of ['Conveyor', 'Conveyor_Infeed', 'RollConveyor2m', 'ChainConveyor3m', 'BeltConveyor']) {
      expect(matchesAny(Conveyor.models, name)).toBe(true);
    }
  });
  it('does not match unrelated filenames', () => {
    expect(matchesAny(Conveyor.models, 'Turntable')).toBe(false);
    expect(matchesAny(Conveyor.models, 'ChainTransfer')).toBe(false);
  });
});

describe('Conveyor behavior — bind is robust when the drive is missing at bind-time', () => {
  // Regression: at bind-time, `rv.drives.get(beltNode)` can return null for a
  // legitimate placement (load-order race, HMR replay, late convention pass).
  // The PRIOR behavior was to bail out of bind entirely — which left the
  // conveyor without an Occupied signal, so its UPSTREAM couldn't see
  // back-pressure and pushed parts straight through. Now the signal logic
  // proceeds without a drive (belt control becomes a no-op), so end-of-line
  // back-pressure still propagates.
  it('binds without a drive: still publishes Occupied so upstream sees the block', () => {
    const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
    const values = new Map<string, boolean | number>();
    const signalStore = {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => {
        values.set(n, v);
        signalSubs.get(n)?.forEach((cb) => cb(v));
      },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = signalSubs.get(n); if (!s) { s = new Set(); signalSubs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    };
    const events = new EventEmitter<Record<string, unknown>>();

    const root = new Object3D(); root.name = 'ConvNoDrive';
    root.userData.realvirtual = { LayoutObject: { Label: 'ConvNoDrive', CatalogId: 'c', Locked: false } };
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);

    // No drives whatsoever — simulates `rv.drives.get(beltNode)` returning null.
    const host: BindContextHost = {
      signalStore,
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [],
      registry: null,
    };
    installSensorDouble(host, root, signalStore);
    const { ctx, handle } = createBindContext(root, host, {});
    Conveyor.bind(ctx);

    signalStore.set('ConvNoDrive.Flow.Run', true);
    iterateFixedUpdate(handle, DT);
    // No drive to toggle, but the Running signal should still publish (downstream is null → blocked, but empty).
    expect(signalStore.get('ConvNoDrive.Flow.Running')).toBe(true);

    // Part hits the sensor → counted; with no downstream the belt holds (not running).
    // (Flow.Occupied is surface-based and published from the transport manager,
    // which this minimal host lacks — exercised in surface-occupancy.test.ts instead.)
    signalStore.set('ConvNoDrive.Sensor', true);
    iterateFixedUpdate(handle, DT);
    expect(signalStore.get('ConvNoDrive.Flow.PartCount')).toBe(1);
    // No downstream → blocked → not running.
    expect(signalStore.get('ConvNoDrive.Flow.Running')).toBe(false);
  });
});

describe('Conveyor behavior — unknown downstream is permissive', () => {
  // Scenario: the successor's behavior didn't bind (e.g., HMR artifact, wrong
  // model name, or it's a non-Conveyor neighbour that never publishes
  // Flow.Occupied). The upstream snap-graph still resolves the successor's
  // root, but the read of `<succ>.Flow.Occupied` returns undefined. The
  // safe default is to RELEASE — pessimistic locking would stall the whole
  // line whenever a single neighbour misbehaves. A no-successor end-of-line is
  // still treated as blocked (see "HOLDS at sensor" above).
  it('upstream releases when successor signal is undefined', () => {
    const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
    const values = new Map<string, boolean | number>();
    const signalStore = {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => {
        values.set(n, v);
        signalSubs.get(n)?.forEach((cb) => cb(v));
      },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = signalSubs.get(n); if (!s) { s = new Set(); signalSubs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    };
    const events = new EventEmitter<Record<string, unknown>>();

    const A_root = new Object3D(); A_root.name = 'ConvA';
    A_root.userData.realvirtual = { LayoutObject: { Label: 'ConvA', CatalogId: 'c', Locked: false } };
    const A_belt = new Object3D(); A_belt.name = 'Transport-X'; A_root.add(A_belt);
    const A_sensor = new Object3D(); A_sensor.name = 'Sensor'; A_root.add(A_sensor);
    const A_drive = { name: 'Transport-X', node: A_belt, jogForward: false, jogBackward: false, startMove() {}, stop() {} };

    // B exists in the snap graph but its behavior never binds (no Conveyor.* signals registered).
    const B_root = new Object3D(); B_root.name = 'ConvB';

    const aOut = { id: 'a-out', flow: 'out', pairedSnapId: 'b-in', ownerRoot: A_root };
    const bIn  = { id: 'b-in',  flow: 'in',  pairedSnapId: 'a-out', ownerRoot: B_root };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'b-in': bIn };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === A_root ? [aOut] : [bIn]),
      getById: (id: string) => byId[id],
    };
    const host: BindContextHost = {
      signalStore,
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [A_drive],
      registry: null,
      getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined),
    };

    installSensorDouble(host, A_root, signalStore);
    const a = createBindContext(A_root, host, {});
    Conveyor.bind(a.ctx);
    signalStore.set('ConvA.Flow.Run', true);

    // Part on A; B has no published Occupied signal (its behavior never bound).
    signalStore.set('ConvA.Sensor', true);
    iterateFixedUpdate(a.handle, DT);

    // The new rule: only an EXPLICIT `true` blocks. undefined = clear → release.
    expect(A_drive.jogForward).toBe(true);
  });
});

describe('findDownstreamRoot — snap graph', () => {
  function host(reg: unknown) {
    return { getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined) };
  }
  it("follows this conveyor's OUTPUT snap to the paired owner", () => {
    const a = new Object3D(); a.name = 'ConvA';
    const b = new Object3D(); b.name = 'ConvB';
    const aOut = { id: 'a-out', flow: 'out', pairedSnapId: 'b-in', ownerRoot: a };
    const aIn = { id: 'a-in', flow: 'in', pairedSnapId: undefined, ownerRoot: a };
    const bIn = { id: 'b-in', flow: 'in', pairedSnapId: 'a-out', ownerRoot: b };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'a-in': aIn, 'b-in': bIn };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === a ? [aIn, aOut] : [bIn]),
      getById: (id: string) => byId[id],
    };
    expect(findDownstreamRoot(host(reg), a)).toBe(b);
  });
  it('returns null when the output snap is unpaired (end of line)', () => {
    const a = new Object3D(); a.name = 'ConvA';
    const aOut = { id: 'a-out', flow: 'out', pairedSnapId: undefined, ownerRoot: a };
    const reg = { getByOwnerRoot: () => [aOut], getById: () => undefined };
    expect(findDownstreamRoot(host(reg), a)).toBeNull();
  });
  it('returns null without a snap plugin', () => {
    expect(findDownstreamRoot({ getPlugin: () => undefined }, new Object3D())).toBeNull();
  });
});

describe('Conveyor behavior — single zone (no downstream)', () => {
  it('runs while Run is true (when empty) and stops when cleared', () => {
    const { signalStore, drive, handle } = setup();
    signalStore.set('Flow.Run', true);
    iterateFixedUpdate(handle, DT);
    expect(drive.jogForward).toBe(true);
    expect(signalStore.get('Flow.Running')).toBe(true);

    signalStore.set('Flow.Run', false);
    iterateFixedUpdate(handle, DT);
    expect(drive.jogForward).toBe(false);
    expect(signalStore.get('Flow.Running')).toBe(false);
  });

  it('counts parts and HOLDS at the sensor when there is no successor', () => {
    const { signalStore, drive, handle } = setup();
    signalStore.set('Flow.Run', true);
    iterateFixedUpdate(handle, DT);
    expect(drive.jogForward).toBe(true);   // empty → runs (parts can transit through)

    // Part at the sensor → counted. With NO downstream neighbour, the missing
    // successor is treated as blocked, so the belt holds its part at the sensor
    // rather than discharging into nothing (add a Sink to declare clear).
    // (Flow.Occupied is now surface-based — see surface-occupancy.test.ts.)
    signalStore.set('Sensor-1', true);
    expect(signalStore.get('Flow.PartCount')).toBe(1);
    iterateFixedUpdate(handle, DT);
    expect(drive.jogForward).toBe(false);

    // Sensor clears → empty zone, no successor → still runs (empty wins).
    signalStore.set('Sensor-1', false);
    iterateFixedUpdate(handle, DT);
    expect(drive.jogForward).toBe(true);
    expect(signalStore.get('Flow.PartCount')).toBe(1);   // no double count
    signalStore.set('Sensor-1', true);
    expect(signalStore.get('Flow.PartCount')).toBe(2);   // rising edge only
  });
});

describe('Conveyor behavior — per-port downstream interlock (turntable input)', () => {
  function makeStore() {
    const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
    const values = new Map<string, boolean | number>();
    return {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => {
        values.set(n, v);
        signalSubs.get(n)?.forEach((cb) => cb(v));
      },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = signalSubs.get(n); if (!s) { s = new Set(); signalSubs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    };
  }

  /** A conveyor whose OUTPUT snap mates a downstream turntable port `Snap-ZB-tt`. */
  function bindConvToTurntable(signalStore: ReturnType<typeof makeStore>) {
    const events = new EventEmitter<Record<string, unknown>>();
    const A_root = new Object3D(); A_root.name = 'ConvA';
    A_root.userData.realvirtual = { LayoutObject: { Label: 'ConvA', CatalogId: 'c', Locked: false } };
    const A_belt = new Object3D(); A_belt.name = 'Transport-X'; A_root.add(A_belt);
    const A_sensor = new Object3D(); A_sensor.name = 'Sensor'; A_root.add(A_sensor);
    const A_drive = { name: 'Transport-X', node: A_belt, jogForward: false, jogBackward: false, startMove() {}, stop() {} };

    const TT = new Object3D(); TT.name = 'TT';
    // Node name is intentionally a generic, NON-unique glTF name — the interlock
    // keys off the stable snap id ('tt-port'), not the node name.
    const ttPortNode = new Object3D(); ttPortNode.name = 'Snap-ZN';
    const aOut = { id: 'a-out', object3D: new Object3D(), flow: 'out', pairedSnapId: 'tt-port', ownerRoot: A_root };
    const ttPort = { id: 'tt-port', object3D: ttPortNode, flow: 'bidi', pairedSnapId: 'a-out', ownerRoot: TT };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'tt-port': ttPort };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === A_root ? [aOut] : [ttPort]),
      getById: (id: string) => byId[id],
    };
    const host: BindContextHost = {
      signalStore,
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [A_drive],
      registry: null,
      getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined),
    };
    installSensorDouble(host, A_root, signalStore);
    const a = createBindContext(A_root, host, {});
    Conveyor.bind(a.ctx);
    return { A_drive, handle: a.handle };
  }

  it('uses the per-port signal (blocked) even when the root signal says free', () => {
    const signalStore = makeStore();
    const { A_drive, handle } = bindConvToTurntable(signalStore);
    signalStore.set('ConvA.Flow.Run', true);
    // Turntable: root free, but THIS input port (by snap id) is blocked.
    signalStore.set('TT.Flow.Occupied', false);
    signalStore.set('TT.Flow.Occupied@tt-port', true);
    signalStore.set('ConvA.Sensor', true);          // part held at A
    iterateFixedUpdate(handle, DT);                 // first tick resolves the downstream signal
    expect(A_drive.jogForward).toBe(false);         // per-port block holds the part
  });

  it('falls back to the root signal when no per-port signal is published', () => {
    const signalStore = makeStore();
    const { A_drive, handle } = bindConvToTurntable(signalStore);
    signalStore.set('ConvA.Flow.Run', true);
    signalStore.set('TT.Flow.Occupied', true);  // only the root signal exists (no per-port)
    signalStore.set('ConvA.Sensor', true);
    iterateFixedUpdate(handle, DT);
    expect(A_drive.jogForward).toBe(false);         // fell back to root → blocked
  });
});

describe('Conveyor behavior — two-conveyor line (ZPA back-pressure)', () => {
  function placedConveyor(name: string) {
    const root = new Object3D(); root.name = name;
    root.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'c', Locked: false } };
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
    const drive = { name: 'Transport-X', node: belt, jogForward: false, jogBackward: false, startMove() {}, stop() {} };
    return { root, drive };
  }

  it('upstream stops only when its part is held AND downstream is occupied', () => {
    const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
    const values = new Map<string, boolean | number>();
    const signalStore = {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => {
        values.set(n, v);
        signalSubs.get(n)?.forEach((cb) => cb(v));
      },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = signalSubs.get(n); if (!s) { s = new Set(); signalSubs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    };
    const events = new EventEmitter<Record<string, unknown>>();

    const A = placedConveyor('ConvA');
    const B = placedConveyor('ConvB');
    // Separate the belts in space so a good on B's belt doesn't also overlap A's.
    B.root.position.set(10, 0, 0); B.root.updateMatrixWorld(true);

    // Fake transport manager so the conveyors publish SURFACE-based occupancy.
    // Occupancy is now driven by a good (MU) physically overlapping a belt surface.
    const mus: { aabb: AABB; markedForRemoval: boolean }[] = [];
    const surf = (node: Object3D) => ({ node, aabb: AABB.fromHalfSize(node, new Vector3(1, 0.1, 1)) });
    const transportManager = { surfaces: [surf(A.drive.node), surf(B.drive.node)], mus };
    const placeGoodOn = (node: Object3D) => {
      const g = new Object3D(); node.getWorldPosition(g.position); g.updateMatrixWorld(true);
      mus.push({ aabb: AABB.fromHalfSize(g, new Vector3(0.2, 0.2, 0.2)), markedForRemoval: false });
    };
    const clearGoods = () => { mus.length = 0; };

    // Snap graph: A's OUTPUT → B's INPUT. B's OUTPUT is unpaired (end of line).
    const aOut = { id: 'a-out', flow: 'out', pairedSnapId: 'b-in', ownerRoot: A.root };
    const bIn  = { id: 'b-in',  flow: 'in',  pairedSnapId: 'a-out', ownerRoot: B.root };
    const bOut = { id: 'b-out', flow: 'out', pairedSnapId: undefined, ownerRoot: B.root };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'b-in': bIn, 'b-out': bOut };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === A.root ? [aOut] : [bIn, bOut]),
      getById: (id: string) => byId[id],
    };
    const host: BindContextHost = {
      signalStore,
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [A.drive, B.drive],
      registry: null,
      getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined),
    };
    // `rv.viewer` is this host at runtime; expose the fake transport manager for
    // surface-based occupancy (not part of the narrow BindContextHost type).
    (host as unknown as { transportManager: unknown }).transportManager = transportManager;
    installSensorDouble(host, A.root, signalStore);
    installSensorDouble(host, B.root, signalStore);

    const a = createBindContext(A.root, host, {});
    const b = createBindContext(B.root, host, {});
    Conveyor.bind(a.ctx);
    Conveyor.bind(b.ctx);

    // Enable both lines.
    signalStore.set('ConvA.Flow.Run', true);
    signalStore.set('ConvB.Flow.Run', true);

    const tick = () => { iterateFixedUpdate(a.handle, DT); iterateFixedUpdate(b.handle, DT); };

    // Both empty → both run.
    tick();
    expect(A.drive.jogForward).toBe(true);
    expect(B.drive.jogForward).toBe(true);

    // A good on B's belt (B occupied, surface-based) that has reached B's sensor,
    // AND a part held at A's sensor.
    placeGoodOn(B.drive.node);               // B surface occupied → publishes ConvB.Flow.Occupied
    signalStore.set('ConvB.Sensor', true);   // B's local discharge trigger (holds, counts)
    signalStore.set('ConvA.Sensor', true);   // A's part is at its discharge sensor
    tick(); tick();                          // B publishes occupancy, then A reads it (1-tick latency)
    expect(A.drive.jogForward).toBe(false);  // A holds — downstream B is occupied
    expect(B.drive.jogForward).toBe(false);  // B holds — no successor → treated as blocked

    // B's good leaves the belt → A releases its part; B (empty, still no successor) runs.
    clearGoods();
    signalStore.set('ConvB.Sensor', false);
    tick(); tick();
    expect(A.drive.jogForward).toBe(true);
    expect(B.drive.jogForward).toBe(true);
  });
});
