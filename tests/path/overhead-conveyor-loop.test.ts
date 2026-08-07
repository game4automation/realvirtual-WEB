// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.5 — circulating chain / overhead conveyor (Phase 4, F8).
 *
 * ONE chain phase scalar `s_chain` on a CLOSED path drives N carriers at
 * `(s_chain + i·pitch) mod L`: with 4 carriers at pitch L/4 the arc-length
 * spacing stays constant over a FULL revolution, and after `s_chain += L`
 * every carrier is back at its start position (mod L correct). Edge cases:
 * pitch=0 / N=0 / L=0 never produce NaN or crash; the carrier orientation
 * stays upright (gravity-oriented, NO roll) around the whole loop.
 *
 * Headless: real OverheadConveyor library component bound via
 * `createBindContext`, ticked via `iterateFixedUpdate` — no GLB/DOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import {
  createBindContext,
  applyKinematicsSpec,
  iterateFixedUpdate,
  type BindContextHost,
  type BindContextHandle,
  type KinematicsSpec,
} from '../../src/core/behavior-runtime';
import { parsePathExtras, type PathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import OverheadConveyorBehavior from '../../src/behaviors/OverheadConveyor';

const TICK = 1 / 60;

interface Host extends BindContextHost {
  /** Raw store values for direct assertions. */
  values: Map<string, boolean | number>;
}

function makeHost(): Host {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    values,
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

/** Closed square loop in the XZ plane: 4 × 5 m sides, L = 20 m, CCW from origin. */
function squareLoopExtras(): PathExtras {
  return {
    type: 'Path',
    version: 1,
    closed: true,
    segments: [
      { kind: 'line', from: [0, 0, 0], to: [0, 0, 5] },
      { kind: 'line', from: [0, 0, 5], to: [5, 0, 5] },
      { kind: 'line', from: [5, 0, 5], to: [5, 0, 0] },
      { kind: 'line', from: [5, 0, 0], to: [0, 0, 0] },
    ],
  };
}

/** Closed full circle in the XZ plane: radius 2 m, L = 4π m. */
function circleLoopExtras(): PathExtras {
  return {
    type: 'Path',
    version: 1,
    closed: true,
    segments: [
      { kind: 'arc', center: [0, 0, 0], radius: 2, startAngle: 0, degrees: 360, plane: 'XZ' },
    ],
  };
}

/** An OverheadConveyor root: a path child + `carrierCount` Carrier-<i> children. */
function makeRoot(
  name: string,
  pathExtras: PathExtras,
  carrierCount: number,
  cfg: Record<string, unknown> = {},
): { root: Object3D; carriers: Object3D[] } {
  const root = new Object3D();
  root.name = name;
  // No ramp by default → deterministic speed steps from the first tick.
  root.userData.realvirtual = {
    OverheadConveyor: { TargetSpeed: 1000, UseAcceleration: false, ...cfg },
  };
  const pathNode = new Object3D();
  pathNode.name = `${name}-Route`;
  pathNode.userData.realvirtual = { Path: pathExtras };
  root.add(pathNode);
  const carriers: Object3D[] = [];
  for (let i = 0; i < carrierCount; i++) {
    const c = new Object3D();
    c.name = `Carrier-${i + 1}`;
    root.add(c);
    carriers.push(c);
  }
  return { root, carriers };
}

function bind(root: Object3D, host: Host): BindContextHandle {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  OverheadConveyorBehavior.bind(ctx);
  applyKinematicsSpec(root, accum);
  return handle;
}

function expectFinite(v: Vector3): void {
  expect(Number.isFinite(v.x)).toBe(true);
  expect(Number.isFinite(v.y)).toBe(true);
  expect(Number.isFinite(v.z)).toBe(true);
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  clearLiveControl();
});
afterEach(() => {
  clearLiveControl();
});

// ─────────────────────────────────────────────────────────────────────────────
// §9.5 — constant spacing over a full revolution + mod-L return
// ─────────────────────────────────────────────────────────────────────────────

describe('OverheadConveyor — closed loop, 4 carriers at pitch L/4 (§9.5)', () => {
  it('setup places the carriers at 0, L/4, L/2, 3L/4 (square corners)', () => {
    const host = makeHost();
    const { root, carriers } = makeRoot('OC01', squareLoopExtras(), 4, { Pitch: 5000 });
    bind(root, host);
    expect(host.values.get('OverheadConveyor.Run')).toBe(true);
    const expected = [
      new Vector3(0, 0, 0), new Vector3(0, 0, 5), new Vector3(5, 0, 5), new Vector3(5, 0, 0),
    ];
    for (let i = 0; i < 4; i++) {
      expect(carriers[i].position.distanceTo(expected[i])).toBeLessThan(1e-9);
    }
  });

  it('arc-length spacing stays EXACTLY pitch over a full revolution (mod L)', () => {
    const host = makeHost();
    const { root, carriers } = makeRoot('OC02', squareLoopExtras(), 4, { Pitch: 5000 });
    const handle = bind(root, host);

    // Independent reference: same path payload parsed separately — carrier i
    // must sit at getAbsPosition((s_chain + i·5) mod 20) on EVERY sample.
    const ref = parsePathExtras(squareLoopExtras(), 'ref')!;
    const L = ref.length;
    expect(L).toBeCloseTo(20, 9);
    const refPos = new Vector3();

    for (let tick = 1; tick <= 1200; tick++) { // 20 m @ 1 m/s = one revolution
      iterateFixedUpdate(handle, TICK);
      if (tick % 60 !== 0) continue; // sample once per simulated second
      const sChain = (host.values.get('OverheadConveyor.Position') as number) / 1000;
      expect(Number.isFinite(sChain)).toBe(true);
      for (let i = 0; i < 4; i++) {
        const si = (((sChain + i * 5) % L) + L) % L;
        ref.getAbsPosition(si, refPos);
        expectFinite(carriers[i].position);
        expect(carriers[i].position.distanceTo(refPos)).toBeLessThan(1e-6);
      }
    }
  });

  it('after s_chain += L every carrier is back at its start position', () => {
    const host = makeHost();
    const { root, carriers } = makeRoot('OC03', squareLoopExtras(), 4, { Pitch: 5000 });
    const handle = bind(root, host);

    const startPositions = carriers.map((c) => c.position.clone());
    for (let tick = 0; tick < 1200; tick++) iterateFixedUpdate(handle, TICK); // exactly L
    for (let i = 0; i < 4; i++) {
      // Float accumulation over 1200 ticks — mm-level tolerance is plenty.
      expect(carriers[i].position.distanceTo(startPositions[i])).toBeLessThan(1e-3);
    }
    // The phase itself wrapped (mod L): back near 0 (or just below L).
    const posMm = host.values.get('OverheadConveyor.Position') as number;
    const wrapped = Math.min(posMm, 20000 - posMm);
    expect(wrapped).toBeLessThan(1); // < 1 mm from the seam
  });

  it('Run=false stops the chain (Moving=false, phase frozen), Run=true restarts', () => {
    const host = makeHost();
    const { root } = makeRoot('OC04', squareLoopExtras(), 4, { Pitch: 5000 });
    const handle = bind(root, host);

    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    host.signalStore!.set('OverheadConveyor.Run', false);
    iterateFixedUpdate(handle, TICK);
    const frozen = host.values.get('OverheadConveyor.Position') as number;
    expect(host.values.get('OverheadConveyor.Moving')).toBe(false);
    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    expect(host.values.get('OverheadConveyor.Position')).toBe(frozen);

    host.signalStore!.set('OverheadConveyor.Run', true);
    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    expect(host.values.get('OverheadConveyor.Moving')).toBe(true);
    expect(host.values.get('OverheadConveyor.Position') as number).toBeGreaterThan(frozen);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orientation — gravity-oriented carriers, no roll over the loop (§5.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('OverheadConveyor — carrier orientation stays upright (no roll)', () => {
  it('up stays the world up axis and the yaw follows the tangent on a full circle', () => {
    const host = makeHost();
    // Pitch 0 → automatic even distribution L/N (also covers the pitch=0 edge).
    const { root, carriers } = makeRoot('OC05', circleLoopExtras(), 4, { Pitch: 0 });
    const handle = bind(root, host);

    const up = new Vector3();
    const fwd = new Vector3();
    const L = 4 * Math.PI; // 2πR, R=2
    const ticks = Math.ceil((L * 60) / 1) + 60; // > one revolution @ 1 m/s + margin
    for (let tick = 0; tick < ticks; tick++) {
      iterateFixedUpdate(handle, TICK);
      if (tick % 30 !== 0) continue;
      for (const c of carriers) {
        // Local +Y must stay the world up axis — gravity-oriented, zero roll.
        up.set(0, 1, 0).applyQuaternion(c.quaternion);
        expect(up.x).toBeCloseTo(0, 6);
        expect(up.y).toBeCloseTo(1, 6);
        expect(up.z).toBeCloseTo(0, 6);
        // Local +Z (travel direction) stays horizontal — yaw only, no pitch/flip.
        fwd.set(0, 0, 1).applyQuaternion(c.quaternion);
        expect(fwd.y).toBeCloseTo(0, 6);
        expect(Math.hypot(fwd.x, fwd.z)).toBeCloseTo(1, 6);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — pitch=0 / N=0 / L=0: no NaN, no crash (§9.X)
// ─────────────────────────────────────────────────────────────────────────────

describe('OverheadConveyor — degenerate inputs (no NaN, no crash)', () => {
  it('pitch=0 auto-distributes the carriers evenly (L/N) — all finite', () => {
    const host = makeHost();
    const { root, carriers } = makeRoot('OC06', squareLoopExtras(), 4, { Pitch: 0 });
    const handle = bind(root, host);
    // Even L/N distribution on the 20 m square == the L/4 corner placement.
    const expected = [
      new Vector3(0, 0, 0), new Vector3(0, 0, 5), new Vector3(5, 0, 5), new Vector3(5, 0, 0),
    ];
    for (let i = 0; i < 4; i++) {
      expectFinite(carriers[i].position);
      expect(carriers[i].position.distanceTo(expected[i])).toBeLessThan(1e-9);
    }
    for (let i = 0; i < 120; i++) iterateFixedUpdate(handle, TICK);
    for (const c of carriers) expectFinite(c.position);
    expect(Number.isFinite(host.values.get('OverheadConveyor.Position') as number)).toBe(true);
  });

  it('N=0 (no Carrier nodes) disables the instance — no crash, no signals', () => {
    const host = makeHost();
    const { root } = makeRoot('OC07', squareLoopExtras(), 0);
    expect(() => {
      const handle = bind(root, host);
      for (let i = 0; i < 10; i++) iterateFixedUpdate(handle, TICK);
    }).not.toThrow();
    // Disabled at setup → Run was never asserted.
    expect(host.values.get('OverheadConveyor.Run')).toBeUndefined();
  });

  it('L=0 (degenerate closed path) keeps phase 0 and finite carrier poses', () => {
    const host = makeHost();
    const degenerate: PathExtras = {
      type: 'Path',
      version: 1,
      closed: true,
      segments: [{ kind: 'line', from: [1, 2, 3], to: [1, 2, 3] }],
    };
    const { root, carriers } = makeRoot('OC08', degenerate, 2, { Pitch: 0 });
    const handle = bind(root, host);
    for (let i = 0; i < 60; i++) iterateFixedUpdate(handle, TICK);
    for (const c of carriers) {
      expectFinite(c.position);
      expect(c.position.distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-9);
      expect(Number.isFinite(c.quaternion.x)).toBe(true);
      expect(Number.isFinite(c.quaternion.w)).toBe(true);
    }
    expect(host.values.get('OverheadConveyor.Position')).toBe(0); // phase pinned, no NaN
  });

  it('no path node at all disables the instance — no crash', () => {
    const host = makeHost();
    const root = new Object3D();
    root.name = 'OC09';
    root.userData.realvirtual = { OverheadConveyor: {} };
    const c = new Object3D();
    c.name = 'Carrier-1';
    root.add(c);
    expect(() => {
      const handle = bind(root, host);
      for (let i = 0; i < 10; i++) iterateFixedUpdate(handle, TICK);
    }).not.toThrow();
    expect(host.values.get('OverheadConveyor.Run')).toBeUndefined();
  });
});
