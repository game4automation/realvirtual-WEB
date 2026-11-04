// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-647 §9.3 (D4, gate rounds 3/4) — zones with DECLARANTS.
 *
 * A zone is declared by the `RVPath` OBJECTS of the paths that carry it. The
 * effective capacity is the maximum over the declarations (MAX-WINS, as
 * before); removing or live-editing one path takes away only ITS declaration,
 * so a zone shared by two placements keeps the claims of the other one.
 *
 * Covered:
 *  - unit: two declarants → max; withdraw → recomputed, holders kept; last
 *    declarant → dropped (dispose) or kept "undeclared" (live-edit zone change);
 *  - integration on `RVPathComponent` + the shared registry: shared zone over
 *    two placements' paths, last-declarant dispose, live edit (shrink with two
 *    declarants, zone change, id rename, invalid payload — R3-3);
 *  - Agv claim walks (R3-2 / R4-1): repeated walks add no declarant, a direct
 *    path keeps its capacity (> 1), a STALE path object (after a live edit, a
 *    rename or a removal) never re-declares.
 *
 * Only `clearShared()` BEFORE each test — never between the steps.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { RVPathComponent, parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { DEFAULT_ZONE_CAPACITY, ZoneRegistry, getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { bindContinuous, clearShared, makeAgvRoot, TICK, type AgvTestHost } from '../helpers/agv-harness';

type V3 = [number, number, number];
const L: { from: V3; to: V3 } = { from: [0, 0, 0], to: [0, 0, 4] };

function pathNode(name: string, fields: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, id: name, segments: [{ kind: 'line', ...L }], successors: [], ...fields },
  };
  return node;
}

/** The mutable rv_extras.Path payload of a path node. */
const payload = (comp: RVPathComponent): Record<string, unknown> =>
  (comp.node.userData.realvirtual as Record<string, Record<string, unknown>>).Path;

function component(name: string, fields: Record<string, unknown>): RVPathComponent {
  const comp = new RVPathComponent(pathNode(name, fields));
  comp.init({} as never);
  return comp;
}

/** A host whose events the test can emit (`simulation-reset`). */
function makeHost(): AgvTestHost & { events: EventEmitter<Record<string, unknown>> } {
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
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
}

/** Legacy step mode (claim-ahead walk every tick). */
const AGV_CFG = { TargetSpeed: 1000, UseAcceleration: false, StartPosition: 0, LookAhead: 5000 };

function tickN(h: BindContextHandle, n: number): void {
  for (let i = 0; i < n; i++) iterateFixedUpdate(h, TICK);
}

beforeEach(() => { clearShared(); });

describe('ZoneRegistry declarants (unit)', () => {
  it('two declarants (1 and 2) → effective 2; one withdraws → 1, holders stay', () => {
    const z = new ZoneRegistry();
    const a = {}; const b = {};
    z.declare('Z', a, 1);
    z.declare('Z', b, 2);
    expect(z.capacityOf('Z')).toBe(2);
    expect(z.declarantCount('Z')).toBe(2);
    expect(z.claim('Z', 'v1')).toBe(true);
    expect(z.claim('Z', 'v2')).toBe(true);
    z.withdraw('Z', b, { preserveHolders: false });
    expect(z.capacityOf('Z')).toBe(1);
    expect(z.holderCount('Z')).toBe(2);           // nobody is thrown out
    expect(z.claim('Z', 'v3')).toBe(false);       // the lower capacity is in force
  });

  it('last declarant: preserveHolders false drops zone + holders, true keeps them undeclared', () => {
    const z = new ZoneRegistry();
    const a = {};
    z.declare('A', a, 3);
    z.claim('A', 'v1');
    z.withdraw('A', a, { preserveHolders: false });
    expect(z.has('A')).toBe(false);
    expect(z.isHolder('A', 'v1')).toBe(false);
    expect(z.totalHolderCount()).toBe(0);

    z.declare('B', a, 3);
    z.claim('B', 'v1');
    z.withdraw('B', a, { preserveHolders: true });
    expect(z.has('B')).toBe(true);
    expect(z.isHolder('B', 'v1')).toBe(true);
    expect(z.capacityOf('B')).toBe(DEFAULT_ZONE_CAPACITY);
    expect(z.declarantCount('B')).toBe(0);
  });

  it('repeated declare / ensureZone add no declarant; withdraw of a stranger is a no-op', () => {
    const z = new ZoneRegistry();
    const a = {};
    for (let i = 0; i < 5; i++) z.declare('Z', a, 2);
    z.ensureZone('Z');
    z.ensureZone('Y');
    expect(z.declarantCount('Z')).toBe(1);
    expect(z.declarantCount('Y')).toBe(0);
    expect(z.capacityOf('Y')).toBe(DEFAULT_ZONE_CAPACITY);
    z.withdraw('Z', {}, { preserveHolders: false });
    expect(z.capacityOf('Z')).toBe(2);
    expect(z.size).toBe(2);
  });
});

describe('RVPathComponent declarants (integration, shared registry)', () => {
  it('shared zone over two placements: removing P1 keeps the claim of P2 and the zone', () => {
    const zones = getDefaultZoneRegistry();
    const p1 = component('P1_Cross', { zone: 'S', zoneCapacity: 1 });
    const p2 = component('P2_Cross', { zone: 'S', zoneCapacity: 1 });
    expect(zones.declarantCount('S')).toBe(2);
    expect(zones.claim('S', 'AGV_P2')).toBe(true);

    p1.dispose();                                  // placement P1 removed
    expect(zones.has('S')).toBe(true);
    expect(zones.isHolder('S', 'AGV_P2')).toBe(true);
    expect(zones.declarantCount('S')).toBe(1);
    expect(zones.claim('S', 'AGV_X')).toBe(false); // still exclusive

    p2.dispose();                                  // last declarant → zone with holders gone
    expect(zones.has('S')).toBe(false);
    expect(zones.isHolder('S', 'AGV_P2')).toBe(false);
  });

  it('live edit: shrink of the own capacity with two declarants → max of the remaining', () => {
    const zones = getDefaultZoneRegistry();
    const a = component('A', { zone: 'Z', zoneCapacity: 3 });
    component('B', { zone: 'Z', zoneCapacity: 2 });
    expect(zones.capacityOf('Z')).toBe(3);
    zones.claim('Z', 'v1');
    payload(a).zoneCapacity = 1;
    a.reapplyConfig();
    expect(zones.capacityOf('Z')).toBe(2);
    expect(zones.declarantCount('Z')).toBe(2);
    expect(zones.isHolder('Z', 'v1')).toBe(true);
  });

  it('live edit: zone change leaves the old zone "undeclared" with its holders', () => {
    const zones = getDefaultZoneRegistry();
    const a = component('A', { zone: 'Z1', zoneCapacity: 2 });
    zones.claim('Z1', 'v1');
    payload(a).zone = 'Z2';
    a.reapplyConfig();
    expect(zones.has('Z1')).toBe(true);
    expect(zones.isHolder('Z1', 'v1')).toBe(true);
    expect(zones.declarantCount('Z1')).toBe(0);
    expect(zones.capacityOf('Z1')).toBe(DEFAULT_ZONE_CAPACITY);
    expect(zones.declarantCount('Z2')).toBe(1);
    expect(zones.isDeclaredBy('Z2', a.path!)).toBe(true);
    expect(zones.capacityOf('Z2')).toBe(2);
  });

  it('live edit: an id rename keeps exactly one declaration (the current path object)', () => {
    const zones = getDefaultZoneRegistry();
    const a = component('A', { zone: 'Z', zoneCapacity: 2 });
    const before = a.path!;
    payload(a).id = 'A_renamed';
    a.reapplyConfig();
    expect(a.path!.id).toBe('A_renamed');
    expect(zones.declarantCount('Z')).toBe(1);
    expect(zones.isDeclaredBy('Z', a.path!)).toBe(true);
    expect(zones.isDeclaredBy('Z', before)).toBe(false);
    expect(zones.capacityOf('Z')).toBe(2);
  });

  it('invalid payload: the declaration stays until dispose (R3-3)', () => {
    const zones = getDefaultZoneRegistry();
    const a = component('A', { zone: 'Z1', zoneCapacity: 2 });
    zones.claim('Z1', 'v1');
    payload(a).type = 'Foreign';
    a.reapplyConfig();
    expect(a.path).toBeNull();
    expect(zones.declarantCount('Z1')).toBe(1);   // stays — unregistered until repaired
    expect(zones.isHolder('Z1', 'v1')).toBe(true);
    a.dispose();
    expect(zones.declarantCount('Z1')).toBe(0);
    expect(zones.has('Z1')).toBe(false);
  });

  it('invalid payload then repair into another zone: Z1 withdrawn, Z2 declared (R3-3)', () => {
    const zones = getDefaultZoneRegistry();
    const a = component('A', { zone: 'Z1', zoneCapacity: 2 });
    zones.claim('Z1', 'v1');
    payload(a).type = 'Foreign';
    a.reapplyConfig();
    payload(a).type = 'Path';
    payload(a).zone = 'Z2';
    a.reapplyConfig();
    expect(a.path).not.toBeNull();
    expect(zones.declarantCount('Z1')).toBe(0);
    expect(zones.isHolder('Z1', 'v1')).toBe(true);  // live-edit zone change keeps holders
    expect(zones.declarantCount('Z2')).toBe(1);
    expect(zones.isDeclaredBy('Z2', a.path!)).toBe(true);
    a.dispose();
    expect(zones.declarantCount('Z2')).toBe(0);
  });
});

describe('Agv claim walks and declarants (R3-2, R4-1)', () => {
  it('repeated claim walks over a component path add no declarant', () => {
    const zones = getDefaultZoneRegistry();
    component('In', { segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 2] }], successors: ['Cross'] });
    const cross = component('Cross', { segments: [{ kind: 'line', from: [0, 0, 2], to: [0, 0, 3] }], successors: ['Out'], zone: 'X', zoneCapacity: 2 });
    component('Out', { segments: [{ kind: 'line', from: [0, 0, 3], to: [0, 0, 8] }] });
    const host = makeHost();
    const h = bindContinuous(makeAgvRoot('AgvW', { ...AGV_CFG, PathId: 'In' }), host);
    for (let i = 0; i < 120; i++) {
      tickN(h, 1);
      expect(zones.declarantCount('X')).toBeLessThanOrEqual(1);
    }
    expect(zones.declarantCount('X')).toBe(1);
    expect(zones.isDeclaredBy('X', cross.path!)).toBe(true);
    expect(zones.capacityOf('X')).toBe(2);
  });

  it('a DIRECTLY registered path keeps its capacity > 1 through the claim walk', () => {
    const zones = getDefaultZoneRegistry();
    const net = getDefaultPathNetwork();
    const mk = (id: string, z0: number, z1: number, extra: Record<string, unknown> = {}) => parsePathExtras({
      type: 'Path', id, segments: [{ kind: 'line', from: [0, 0, z0], to: [0, 0, z1] }], successors: [], ...extra,
    }, id)!;
    net.register(mk('In', 0, 2, { successors: ['Cross'] }));
    net.register(mk('Cross', 2, 3, { successors: ['Out'], zone: 'X', zoneCapacity: 2 }));
    net.register(mk('Out', 3, 8));
    const host = makeHost();
    const h = bindContinuous(makeAgvRoot('AgvD', { ...AGV_CFG, PathId: 'In' }), host);
    tickN(h, 60);
    expect(zones.isHolder('X', 'AgvD')).toBe(true);
    expect(zones.capacityOf('X')).toBe(2);
    expect(zones.declarantCount('X')).toBe(1);
    expect(zones.claim('X', 'Other')).toBe(true);   // capacity 2 in force
  });

  it('R4-1 (a): capacity 2 → live edit 1 → reset → stays 1 → dispose leaves no declaration', () => {
    const zones = getDefaultZoneRegistry();
    const start = component('Start', { zone: 'Z', zoneCapacity: 2 });
    const host = makeHost();
    const h = bindContinuous(makeAgvRoot('AgvR', { ...AGV_CFG, PathId: 'Start' }), host);
    tickN(h, 5);
    expect(zones.isHolder('Z', 'AgvR')).toBe(true);
    payload(start).zoneCapacity = 1;
    start.reapplyConfig();
    expect(zones.capacityOf('Z')).toBe(1);
    host.events.emit('simulation-reset');           // re-seeds on the STALE startPath object
    tickN(h, 5);
    expect(zones.capacityOf('Z')).toBe(1);
    expect(zones.declarantCount('Z')).toBe(1);
    start.dispose();
    expect(zones.declarantCount('Z')).toBe(0);
  });

  it('R4-1 (b): traveler on the old object, id rename, another walk, dispose → no revived declaration', () => {
    const zones = getDefaultZoneRegistry();
    const r = component('R1', { zone: 'Z', zoneCapacity: 3 });
    const host = makeHost();
    const h = bindContinuous(makeAgvRoot('AgvN', { ...AGV_CFG, PathId: 'R1' }), host);
    tickN(h, 5);
    payload(r).id = 'R1b';
    r.reapplyConfig();
    host.events.emit('simulation-reset');           // claim walk on the old R1 object
    tickN(h, 5);
    expect(zones.declarantCount('Z')).toBe(1);
    expect(zones.isDeclaredBy('Z', r.path!)).toBe(true);
    r.dispose();
    expect(zones.declarantCount('Z')).toBe(0);
  });

  it('R4-1 (c): path removed, traveler still on the old object, claim walk → no declaration', () => {
    const zones = getDefaultZoneRegistry();
    const r = component('Gone', { zone: 'Z', zoneCapacity: 3 });
    const host = makeHost();
    const h = bindContinuous(makeAgvRoot('AgvG', { ...AGV_CFG, PathId: 'Gone' }), host);
    tickN(h, 5);
    r.dispose();
    expect(zones.declarantCount('Z')).toBe(0);
    host.events.emit('simulation-reset');
    tickN(h, 5);
    expect(zones.declarantCount('Z')).toBe(0);
    expect(zones.capacityOf('Z')).toBe(DEFAULT_ZONE_CAPACITY);
  });
});
