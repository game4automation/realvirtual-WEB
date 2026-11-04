// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 Phase 1 seams (SOL round 2 S1 / S4 / S5, F13) on the bare fleet
 * registry: the onRegister / onUnregister / onTaskChanged channels, their
 * unsubscribe functions, and the `fleet-id-collision` Problems entry (a second
 * vehicle under a taken id vs. a re-bind of the same vehicle). The overwrite
 * behaviour of `register()` stays exactly as before S4.
 * Node test: no Three scene, no DOM, no wall clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  AgvFleet,
  FLEET_ID_COLLISION_CODE,
  type AgvHandle,
  type AgvLocation,
  type AgvTask,
  type AgvTaskChange,
} from '../../src/core/engine/rv-agv-fleet';
import type { VehicleLocation } from '../../src/core/fleet/core/route-table';
import { getProblems, reportProblem, resetProblemsForTests } from '../../src/core/hmi/problems-store';

/** A minimal handle; `node` identifies the vehicle (a re-bind keeps it). */
function handle(id: string, node?: Object3D): AgvHandle {
  let task: AgvTask | null = null;
  return {
    id,
    assign: (t) => { task = t; },
    clear: () => { task = null; },
    get task() { return task; },
    phase: 'cruising',
    node,
  };
}

const collisions = (): string[] => getProblems()
  .filter((p) => p.code === FLEET_ID_COLLISION_CODE)
  .map((p) => p.id)
  .sort();

beforeEach(() => resetProblemsForTests());
afterEach(() => resetProblemsForTests());

describe('AgvFleet.onRegister (plan-559 F13)', () => {
  it('fires inside register(), after the handle is in the registry', () => {
    const fleet = new AgvFleet();
    const seen: { id: string; registered: boolean; listed: number }[] = [];
    fleet.onRegister((h) => seen.push({ id: h.id, registered: fleet.get(h.id) === h, listed: fleet.handleList.length }));
    fleet.register(handle('A'));
    fleet.register(handle('B'));
    expect(seen).toEqual([
      { id: 'A', registered: true, listed: 1 },
      { id: 'B', registered: true, listed: 2 },
    ]);
  });

  it('does not replay earlier handles to a late subscriber — it reads all() once', () => {
    const fleet = new AgvFleet();
    fleet.register(handle('A'));
    const seen: string[] = [];
    const dispatch = (h: AgvHandle): void => { seen.push(h.id); };
    for (const h of fleet.all()) dispatch(h);   // core bound after the vehicles
    fleet.onRegister(dispatch);
    fleet.register(handle('B'));                // a vehicle bound after the core
    expect(seen).toEqual(['A', 'B']);           // each exactly once
  });

  it('fires again for a re-bind with a fresh handle (same node)', () => {
    const fleet = new AgvFleet();
    const node = new Object3D();
    const got: AgvHandle[] = [];
    fleet.onRegister((h) => got.push(h));
    const h1 = handle('A', node);
    const h2 = handle('A', node);
    fleet.register(h1);
    fleet.register(h2);
    expect(got).toEqual([h1, h2]);
    expect(fleet.get('A')).toBe(h2);
  });

  it('unsubscribe stops the notifications; a throwing subscriber does not break register()', () => {
    const fleet = new AgvFleet();
    let n = 0;
    const off = fleet.onRegister(() => { n++; });
    fleet.onRegister(() => { throw new Error('subscriber failure (expected in this test)'); });
    const origError = console.error;
    console.error = () => {};
    try {
      fleet.register(handle('A'));
      off();
      fleet.register(handle('B'));
    } finally {
      console.error = origError;
    }
    expect(n).toBe(1);
    expect(fleet.handleList.map((h) => h.id)).toEqual(['A', 'B']);
  });
});

describe('AgvFleet.onUnregister (plan-559 S5)', () => {
  it('fires only when a handle was actually removed', () => {
    const fleet = new AgvFleet();
    const seen: string[] = [];
    const off = fleet.onUnregister((id) => seen.push(id));
    fleet.register(handle('A'));
    fleet.unregister('A');
    fleet.unregister('A');      // already gone
    fleet.unregister('Nope');   // never registered
    expect(seen).toEqual(['A']);
    expect(fleet.get('A')).toBeNull();
    off();
    fleet.register(handle('B'));
    fleet.unregister('B');
    expect(seen).toEqual(['A']);
  });

  it('clear() drops every subscriber without notifying', () => {
    const fleet = new AgvFleet();
    const events: string[] = [];
    fleet.onRegister((h) => events.push(`reg:${h.id}`));
    fleet.onUnregister((id) => events.push(`unreg:${id}`));
    fleet.onTaskChanged((id) => events.push(`task:${id}`));
    fleet.onIdle((id) => events.push(`idle:${id}`));
    fleet.register(handle('A'));
    fleet.clear();
    expect(fleet.handleList).toEqual([]);
    fleet.register(handle('B'));
    fleet.unregister('B');
    fleet.notifyTaskChanged('B', { requested: null, effective: true });
    fleet.notifyIdle('B');
    expect(events).toEqual(['reg:A']);
  });
});

describe('AgvFleet.onTaskChanged (plan-559 S1)', () => {
  it('delivers every notifyTaskChanged in order; unsubscribe stops it', () => {
    const fleet = new AgvFleet();
    const seen: [string, AgvTaskChange][] = [];
    const off = fleet.onTaskChanged((id, c) => seen.push([id, c]));
    const task: AgvTask = { destination: 'P1' };
    fleet.notifyTaskChanged('A', { requested: task, effective: false });
    fleet.notifyTaskChanged('A', { requested: task, effective: true });
    off();
    fleet.notifyTaskChanged('A', { requested: null, effective: true });
    expect(seen).toEqual([
      ['A', { requested: task, effective: false }],
      ['A', { requested: task, effective: true }],
    ]);
  });
});

describe('fleet-id-collision (plan-559 S4, behaviour-neutral part)', () => {
  it('a second vehicle under a taken id: one Problems entry, the new handle still replaces the old one', () => {
    const fleet = new AgvFleet();
    const first = handle('AGV', new Object3D());
    const second = handle('AGV', new Object3D());
    fleet.register(first);
    expect(collisions()).toEqual([]);
    fleet.register(second);
    expect(fleet.get('AGV')).toBe(second);      // overwrite unchanged (Map.set)
    expect(fleet.handleList).toEqual([second]);
    expect(collisions()).toEqual([`${FLEET_ID_COLLISION_CODE}:AGV`]);
    const entry = getProblems().find((p) => p.code === FLEET_ID_COLLISION_CODE)!;
    expect(entry.title).toContain("'AGV'");
    expect(entry.detail).toContain("'AGV'");
    fleet.register(handle('AGV', new Object3D())); // a third one: still exactly one entry
    expect(collisions()).toEqual([`${FLEET_ID_COLLISION_CODE}:AGV`]);
  });

  it('a second vehicle without nodes under a taken id is a collision too', () => {
    const fleet = new AgvFleet();
    fleet.register(handle('X'));
    fleet.register(handle('X'));
    expect(collisions()).toEqual([`${FLEET_ID_COLLISION_CODE}:X`]);
  });

  it('a re-bind is no collision: the same handle object, or a fresh handle of the same node', () => {
    const fleet = new AgvFleet();
    const node = new Object3D();
    const h = handle('AGV', node);
    fleet.register(h);
    fleet.register(h);                    // same object
    fleet.register(handle('AGV', node));  // DES runner restart: fresh handle, same root
    expect(collisions()).toEqual([]);
  });

  it('the entry is removed on unregister of the id and on clear()', () => {
    const fleet = new AgvFleet();
    fleet.register(handle('A', new Object3D()));
    fleet.register(handle('A', new Object3D()));
    fleet.register(handle('B', new Object3D()));
    fleet.register(handle('B', new Object3D()));
    expect(collisions()).toEqual([`${FLEET_ID_COLLISION_CODE}:A`, `${FLEET_ID_COLLISION_CODE}:B`]);
    fleet.unregister('A');
    expect(collisions()).toEqual([`${FLEET_ID_COLLISION_CODE}:B`]);
    fleet.clear();
    expect(collisions()).toEqual([]);
  });

  it('clear() leaves Problems entries of other codes alone', () => {
    const fleet = new AgvFleet();
    reportProblem({ id: 'other:1', severity: 'info', code: 'other', title: 'other', detail: 'other', at: 0 });
    fleet.register(handle('A', new Object3D()));
    fleet.register(handle('A', new Object3D()));
    fleet.clear();
    expect(getProblems().map((p) => p.id)).toEqual(['other:1']);
  });
});

describe('AgvLocation (plan-559 S2)', () => {
  it('is a RouteTable VehicleLocation (structural)', () => {
    const loc: AgvLocation = { pathId: 'P', s: 1.5, dir: -1, t: 3 };
    const asVehicle: VehicleLocation = loc; // compile-time contract: locate feeds RouteTable directly
    expect(asVehicle).toEqual({ pathId: 'P', s: 1.5, dir: -1, t: 3 });
  });
});
