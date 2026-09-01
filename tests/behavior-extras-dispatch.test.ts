// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-455 §9 — binding material-flow behaviors from `rv_extras` payloads.
 *
 * The gap this suite guards: a node INSIDE a scene that carries a complete
 * component config binds nothing today, because the continuous BehaviorManager
 * only ever matched names — the loaded GLB filename at the scene root, and a
 * placed LayoutObject's asset name for each placement. The three `AGV_1/2/3` of
 * a saved layout are neither, so their configs round-tripped through the GLB
 * perfectly and drove nothing.
 *
 * Every case below is written against PUBLIC surface — `getActiveBinds()`
 * (extended with the bind node's path precisely so these are observable), the
 * signal store, and the vehicles' world transforms. Nothing reaches into the
 * private `configBag`, so a passing test means the effect is real and not that
 * the config was merely parsed.
 *
 * The DES half (§9.4) lives here too: the whole point of F4 is that BOTH
 * kernels see the same instances, which is only checkable side by side.
 * The frozen binding inventory (§9.9) needs the filesystem and therefore runs
 * in Node — see `behavior-extras-inventory.node.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { BehaviorManager } from '../src/core/behaviors';
import type { BindContextHost } from '../src/core/behavior-runtime';
import { defineLibraryComponent } from '../src/behaviors/_shared/define-library-component';
import { parsePathExtras } from '../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../src/core/engine/rv-path-network';
import { getDefaultSpacingController } from '../src/core/engine/rv-spacing-controller';
import { getDefaultZoneRegistry } from '../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../src/core/engine/rv-path-dock';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import AgvBehavior, { AgvFlow } from '../src/behaviors/Agv';
import ConveyorBehavior from '../src/behaviors/Conveyor';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv-private/plugins/des/des-scene-binding';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';

const TICK = 1 / 60;

// ─── Host ───────────────────────────────────────────────────────────────────

interface Host extends BindContextHost {
  values: Map<string, boolean | number>;
  events: EventEmitter<Record<string, unknown>>;
}

function makeHost(): Host {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    values,
    events,
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    // Explicitly typed: the literal is cast to Host only at the end, so these
    // parameters get no contextual type of their own.
    on: (e: string, cb: (data: unknown) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  } as unknown as Host;
}

// ─── The course (the AGVDemo oval, as in tests/path/agv-course-demo) ─────────

function seg(id: string, from: [number, number, number], to: [number, number, number],
             successors: string[]): void {
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path', id, segments: [{ kind: 'line', from, to }], successors,
  }, id)!);
}

function registerCourse(): void {
  seg('PathSouth', [0, 0, 0], [10, 0, 0], ['PathEast']);
  seg('PathEast', [10, 0, 0], [10, 0, 10], ['PathNorth']);
  seg('PathNorth', [10, 0, 10], [0, 0, 10], ['PathWest']);
  seg('PathWest', [0, 0, 10], [0, 0, 0], ['PathSouth']);
  getDefaultPathNetwork().resolveGraph();
}

const agvCfg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  PathId: 'PathSouth',
  StartPosition: 0,
  TargetSpeed: 1000,
  UseAcceleration: false,
  // The spacing values the existing course suite uses. Zeros here are degenerate
  // for the car-following model and stall a vehicle that has a neighbour.
  SafetyDistance: 1000,
  MinGap: 200,
  LookAhead: 5000,
  HeadwayGain: 2,
  ...over,
});

// ─── Scene helpers ──────────────────────────────────────────────────────────

/** A plain node carrying an `Agv` payload — NOT a placement, NOT name-matched. */
function payloadNode(name: string, cfg: Record<string, unknown> = agvCfg()): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { Agv: cfg };
  return n;
}

/** A placed LayoutObject root (what `dispatchPlaced` binds by asset name). */
function placement(name: string, extra: Record<string, unknown> = {}): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { LayoutObject: { Name: name }, ...extra };
  n.userData._layoutId = `placement-${name}`;
  return n;
}

/**
 * Run a full model load through the manager and hand back the live pieces.
 * `modelUrl` is what the scene-root filename glob sees.
 */
function load(root: Object3D, modelUrl: string, register: (m: BehaviorManager) => void) {
  const host = makeHost();
  const mgr = new BehaviorManager();
  register(mgr);
  const detach = mgr.attach(host, () => root, () => modelUrl);
  host.events.emit('model-logic-activated', undefined);
  return { host, mgr, detach };
}

const agvBinds = (mgr: BehaviorManager) => mgr.getActiveBinds().filter(b => b.behaviorId === 'Agv');

function tick(mgr: BehaviorManager, n: number): void {
  for (let i = 0; i < n; i++) mgr.tick(TICK);
}

// ─── Isolation ──────────────────────────────────────────────────────────────

let detachers: Array<() => void> = [];

/** Reset every shared singleton the vehicles touch. */
function clearShared(): void {
  getDefaultPathNetwork().clear();
  getDefaultSpacingController().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  getDefaultPathDockRegistry().clear();
  clearLiveControl();
}

beforeEach(() => {
  clearShared();
  _resetDesHookCache();
  registerCourse();
  detachers = [];
});

afterEach(() => {
  for (const d of detachers) d();
  vi.restoreAllMocks();
});

const keep = <T extends { detach: () => void }>(r: T): T => { detachers.push(r.detach); return r; };

// ────────────────────────────────────────────────────────────────────────────

describe('plan-455 §9.1 — a node carrying rv_extras.Agv binds with its config', () => {
  it('binds AT the payload node and the vehicle drives its path', () => {
    const root = new Object3D(); root.name = 'Scene';
    const veh = payloadNode('Vehicle');
    root.add(veh);

    // Filename deliberately does NOT match `*Agv*`/`*AGV*` — nothing but the
    // payload can explain a bind here.
    const { mgr } = keep(load(root, 'scenes/Fixture.glb', m => m.register('Agv', AgvBehavior)));

    const binds = agvBinds(mgr);
    expect(binds).toHaveLength(1);
    expect(binds[0].nodePath).toContain('Vehicle');

    const before = veh.getWorldPosition(new Vector3()).clone();
    tick(mgr, 60);
    const after = veh.getWorldPosition(new Vector3());
    // 1000 mm/s for one second ≈ 1 m along PathSouth (+X).
    expect(after.distanceTo(before)).toBeGreaterThan(0.5);
    expect(after.x).toBeGreaterThan(before.x);
  });

  it('reads the persisted config — StartPosition places the vehicle', () => {
    const root = new Object3D(); root.name = 'Scene';
    const veh = payloadNode('Vehicle', agvCfg({ StartPosition: 4000 }));
    root.add(veh);

    keep(load(root, 'scenes/Fixture.glb', m => m.register('Agv', AgvBehavior)));

    // 4000 mm along the +X leg — a value that can only come from the payload.
    expect(veh.getWorldPosition(new Vector3()).x).toBeCloseTo(4, 1);
  });
});

/**
 * Run ONE vehicle to completion in a pristine world and report its resulting
 * pose. Each call clears the shared path/spacing/fleet singletons first, so the
 * two halves of the comparison below cannot see or block one another — two
 * vehicles at the same arc length on the same path would car-follow each other
 * to a standstill and prove nothing about frames.
 */
function runVehicle(build: (root: Object3D) => Object3D, ticks: number): {
  world: Vector3; worldQuat: Quaternion; local: Vector3; localQuat: Quaternion;
} {
  clearShared();
  registerCourse();
  const root = new Object3D(); root.name = 'Scene';
  const veh = build(root);
  const { mgr, detach } = load(root, 'scenes/Fixture.glb', m => m.register('Agv', AgvBehavior));
  tick(mgr, ticks);
  root.updateWorldMatrix(true, true);
  const out = {
    world: veh.getWorldPosition(new Vector3()),
    worldQuat: veh.getWorldQuaternion(new Quaternion()),
    local: veh.position.clone(),
    localQuat: veh.quaternion.clone(),
  };
  detach();
  return out;
}

describe('plan-455 §9.1b — a transformed parent does not corrupt the pose (F8)', () => {
  it('world position AND world orientation follow the path under a moved, rotated parent', () => {
    const TICKS = 90;

    // Reference: the vehicle directly under the scene root (identity parent).
    const flat = runVehicle((root) => {
      const v = payloadNode('Flat');
      root.add(v);
      return v;
    }, TICKS);

    // Same config, but nested under a parent translated (5,0,2) and yawed 90 degrees.
    const nested = runVehicle((root) => {
      const holder = new Object3D();
      holder.name = 'Holder';
      holder.position.set(5, 0, 2);
      holder.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
      const v = payloadNode('Nested');
      holder.add(v);
      root.add(holder);
      return v;
    }, TICKS);

    // The path network is GLOBAL, so both vehicles are at the same world place
    // on the same path — but only if the parent frame was divided out.
    expect(nested.world.distanceTo(flat.world)).toBeLessThan(0.001);  // < 1 mm

    // The rotation half is the point of this test: a missing, or wrongly
    // ordered, quaternion conversion leaves the vehicle facing 90 degrees off
    // while its position still looks plausible.
    expect(nested.worldQuat.angleTo(flat.worldQuat)).toBeLessThan(0.002); // < 0.12 deg

    // And the LOCAL transform must differ from the flat one — proof the world
    // pose was converted into the parent frame rather than written through.
    expect(nested.local.distanceTo(flat.local)).toBeGreaterThan(1);
    expect(nested.localQuat.angleTo(flat.localQuat)).toBeGreaterThan(0.1);
  });
});

describe('plan-455 §9.2 — three vehicles from one scene file', () => {
  it('binds all three AGVs of the AGVDemo topology with their own StartPositions', () => {
    const root = new Object3D(); root.name = 'AGVDemo';
    const starts = [0, 3000, 6000];
    const vehicles = starts.map((s, i) =>
      payloadNode(`AGV_${i + 1}`, agvCfg({ StartPosition: s, TargetSpeed: 800 })));
    for (const v of vehicles) root.add(v);

    // The real scene filename — it matches `*AGV*`, so this also exercises F5.
    const { mgr } = keep(load(root, 'scenes/AGVDemo.glb', m => m.register('Agv', AgvBehavior)));

    const binds = agvBinds(mgr);
    expect(binds).toHaveLength(3);
    expect(binds.map(b => b.nodePath).sort().join(',')).toContain('AGV_1');

    // Distinct start positions → three distinguishable places on the course.
    const xs = vehicles.map(v => v.getWorldPosition(new Vector3()).x);
    expect(xs[0]).toBeCloseTo(0, 1);
    expect(xs[1]).toBeCloseTo(3, 1);
    expect(xs[2]).toBeCloseTo(6, 1);

    tick(mgr, 60);
    const moved = vehicles.map(v => v.getWorldPosition(new Vector3()).x);
    for (let i = 0; i < 3; i++) expect(moved[i]).toBeGreaterThan(xs[i]);
  });
});

describe('plan-455 §9.3 — glob + extras on the same node bind once', () => {
  it('a placement whose name matches AND that carries the payload binds exactly one Agv', () => {
    const root = new Object3D(); root.name = 'Scene';
    // `AGV_Cart` matches Agv's `*AGV*` glob AND carries an `Agv` payload.
    const p = placement('AGV_Cart', { Agv: agvCfg({ StartPosition: 2000 }) });
    root.add(p);

    const { mgr } = keep(load(root, 'scenes/Fixture.glb', m => m.register('Agv', AgvBehavior)));

    expect(agvBinds(mgr)).toHaveLength(1);
    // The config that took effect is the payload's, not a default.
    expect(p.getWorldPosition(new Vector3()).x).toBeCloseTo(2, 1);
  });
});

describe('plan-455 §9.5 / §9.5c — filename bind yields to extras, standalone keeps it', () => {
  it('(a) a scene named AGVDemo.glb with payload AGVs binds at the nodes, NOT at the root', () => {
    const root = new Object3D(); root.name = 'AGVDemo';
    root.add(payloadNode('AGV_1'));
    root.add(payloadNode('AGV_2'));

    const { mgr } = keep(load(root, 'scenes/AGVDemo.glb', m => m.register('Agv', AgvBehavior)));

    const binds = agvBinds(mgr);
    expect(binds).toHaveLength(2);
    // The ghost bind would have been scoped to the scene root itself.
    for (const b of binds) expect(b.nodePath).not.toBe('AGVDemo');
  });

  it('(b) a standalone AGV.glb without any payload still binds at the root', () => {
    const root = new Object3D(); root.name = 'AGV';

    const { mgr } = keep(load(root, 'library/AGV.glb', m => m.register('Agv', AgvBehavior)));

    // No payload anywhere → the filename glob is the only signal, and it holds.
    expect(agvBinds(mgr)).toHaveLength(1);
  });

  it('(c) the suppression is logged, and the inner instances run', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const root = new Object3D(); root.name = 'AGVDemo';
    const veh = payloadNode('AGV_1');
    root.add(veh);

    const { mgr } = keep(load(root, 'scenes/AGVDemo.glb', m => m.register('Agv', AgvBehavior)));

    expect(agvBinds(mgr)).toHaveLength(1);
    const suppressed = info.mock.calls
      .map(c => String(c[0]))
      .filter(m => m.includes('NOT bound') && m.includes('Agv'));
    expect(suppressed.length).toBe(1);
    expect(suppressed[0]).toContain('filename glob yields to payload');

    const before = veh.getWorldPosition(new Vector3()).x;
    tick(mgr, 60);
    expect(veh.getWorldPosition(new Vector3()).x).toBeGreaterThan(before);
  });
});

describe('plan-455 §9.7 — removal owns nested extras binds', () => {
  it('disposeObject tears down a payload bind on an INNER node, and re-add binds fresh', () => {
    const root = new Object3D(); root.name = 'Scene';
    const p = placement('Cart');
    const inner = payloadNode('InnerAgv');
    p.add(inner);
    root.add(p);

    const { mgr } = keep(load(root, 'scenes/Fixture.glb', m => m.register('Agv', AgvBehavior)));

    // Bound at the INNER node, but OWNED by the enclosing placement.
    const binds = agvBinds(mgr);
    expect(binds).toHaveLength(1);
    expect(binds[0].nodePath).toContain('InnerAgv');
    expect(binds[0].objectKey).toBe('placement-Cart');

    // Ticking moves it — this is the callback that must NOT survive removal.
    tick(mgr, 30);
    const posAtRemoval = inner.getWorldPosition(new Vector3()).x;
    expect(posAtRemoval).toBeGreaterThan(0);

    mgr.disposeObject(p);
    expect(agvBinds(mgr)).toHaveLength(0);

    tick(mgr, 60);
    expect(inner.getWorldPosition(new Vector3()).x).toBeCloseTo(posAtRemoval, 6);

    // Re-add: the bind identity was released, so it binds again — and the fresh
    // instance drives. Measured from ITS start pose, not the pre-removal one: a
    // new bind restarts at StartPosition and would reproduce the old number
    // exactly after the same number of ticks.
    mgr.dispatchPlaced(p);
    expect(agvBinds(mgr)).toHaveLength(1);
    root.updateWorldMatrix(true, true);
    const afterReadd = inner.getWorldPosition(new Vector3()).x;
    tick(mgr, 30);
    expect(inner.getWorldPosition(new Vector3()).x).toBeGreaterThan(afterReadd);
  });
});

describe('plan-455 §9.8 — outer placement glob + inner extras stay two instances', () => {
  it('a Conveyor placement with an inner Agv payload yields two binds at two nodes', () => {
    const root = new Object3D(); root.name = 'Scene';
    const conv = placement('Conveyor');
    const inner = payloadNode('InnerAgv');
    conv.add(inner);
    root.add(conv);

    const { mgr } = keep(load(root, 'scenes/Fixture.glb', (m) => {
      m.register('Agv', AgvBehavior);
      m.register('Conveyor', ConveyorBehavior);
    }));

    const all = mgr.getActiveBinds();
    const byId = new Map(all.map(b => [b.behaviorId, b]));
    expect(byId.has('Agv')).toBe(true);
    expect(byId.has('Conveyor')).toBe(true);
    // Different types at different nodes — neither de-duped the other away.
    expect(byId.get('Agv')!.nodePath).toContain('InnerAgv');
    expect(byId.get('Agv')!.nodePath).not.toBe(byId.get('Conveyor')!.nodePath);
  });
});

describe('plan-455 §9.10 — the type index does not secretly match by name', () => {
  it('binds a payload type whose name matches neither the module id nor any glob', () => {
    let bound = 0;
    // Type name and registration id deliberately disagree, and `models` cannot
    // match anything in the fixture — only the TYPE index can find this.
    const Odd = defineLibraryComponent({
      type: 'Kurbelwelle' as const,
      kind: 'transport' as const,
      description: 'contract fixture',
      models: ['__never_matches__'],
      schema: {},
      setup() { bound++; },
      continuous: {},
    } as never);

    const root = new Object3D(); root.name = 'Scene';
    const n = new Object3D();
    n.name = 'SomeInnerNode';
    n.userData.realvirtual = { Kurbelwelle: { } };
    root.add(n);

    const { mgr } = keep(load(root, 'scenes/Fixture.glb',
      m => m.register('a-module-named-nothing-like-the-type', Odd)));

    expect(bound).toBe(1);
    const b = mgr.getActiveBinds()
      .filter(x => x.behaviorId === 'a-module-named-nothing-like-the-type');
    expect(b).toHaveLength(1);
    expect(b[0].nodePath).toContain('SomeInnerNode');
  });
});

describe('plan-455 §9.4 — DES binds the same instances', () => {
  it('the AGVDemo topology reaches the DES runner without a single LayoutObject', () => {
    const root = new Object3D(); root.name = 'AGVDemo';
    const starts = [0, 3000, 6000];
    for (let i = 0; i < 3; i++) root.add(payloadNode(`AGV_${i + 1}`, agvCfg({ StartPosition: starts[i] })));

    const host = makeHost();
    const runner = new DESRunner();
    // Before plan-455 this traverse was gated on `isLayoutObjectRoot` and
    // returned 0 for exactly this scene — the measured `web_des_components → 0`.
    const count = bindSceneToRunner(runner, root, host);

    expect(count).toBe(3);
    const agvInstances = runner.liveInstances.filter(i => i.def.type === AgvFlow.type);
    expect(agvInstances).toHaveLength(3);
  });
});
