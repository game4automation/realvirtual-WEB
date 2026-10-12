// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.4 — Agv DES ↔ continuous coupling (Phase 3).
 *
 * PARITY IS CONFLICT-FREE ONLY (§2.4 final decision / §10 finding 3): on a
 * free path the arrival time is `L/v` in BOTH modes (± tick), the `path`
 * tween samples the ARC (position at half the transit == arc-length midpoint,
 * not the chord), and the FastForward end state equals the continuous end
 * state. UNDER CONTENTION the two modes deliberately run different algorithms
 * — continuous = soft car-following ramp per tick, DES = discrete
 * reschedule-on-free — so the contention test compares ONLY the arrival ORDER
 * and the end state / throughput, NEVER the momentary position. That boundary
 * is by design; no shared discretised conflict model exists (or should).
 *
 * Continuous side: the real Agv library component (createBindContext +
 * iterateFixedUpdate). DES side: the PRIVATE DESRunner (`@rv-private/...`) —
 * this suite runs in the standard test run because the vitest/tsc config
 * resolves `@rv-private` against the sibling Private~ checkout (its stub
 * fallback has no des-runner, so a stub-only environment would skip here —
 * see the conveyor DES suites, same pattern).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import { AgvFlow } from '../../src/behaviors/Agv';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { makeHost, makeAgvRoot as makeAgv, bindDes, clearShared, sig,
  type AgvTestHost as Host,
} from '../helpers/agv-harness';

const AgvDef = AgvFlow as unknown as MaterialFlowDefinition;
const TICK = 1 / 60;

// ─── Shared harness ─────────────────────────────────────────────────────────

beforeEach(() => {
  clearShared();
  clearLiveControl();
});
afterEach(() => {
  clearLiveControl();
});

/** The AGVDemo course (scenes/AGVDemo.glb): a 10 m x 6 m oval of four open
 *  paths chained South → East → North → West → South, East curve = zone. */
function registerCourse(): void {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
  };
  add({ id: 'PathSouth', segments: [{ kind: 'line', from: [-5, 0, -3], to: [5, 0, -3] }], successors: ['PathEast'] });
  add({ id: 'PathEast', segments: [{ kind: 'arc', center: [5, 0, 0], radius: 3, startAngle: -90, degrees: 180, plane: 'XZ' }],
    successors: ['PathNorth'], zone: 'EastCurve', zoneCapacity: 1 });
  add({ id: 'PathNorth', segments: [{ kind: 'line', from: [5, 0, 3], to: [-5, 0, 3] }], successors: ['PathWest'] });
  add({ id: 'PathWest', segments: [{ kind: 'arc', center: [-5, 0, 0], radius: 3, startAngle: 90, degrees: 180, plane: 'XZ' }],
    successors: ['PathSouth'] });
  net.resolveGraph();
}

describe('Agv DES — AGVDemo course runs in a circle (plan-451 Test 9.1)', () => {
  it('three AGVs keep cycling the oval for 120 s of sim time', () => {
    registerCourse();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const cfgs: Array<[string, Record<string, unknown>]> = [
      ['AGV_1', { PathId: 'PathSouth', StartPosition: 0, TargetSpeed: 1000 }],
      ['AGV_2', { PathId: 'PathSouth', StartPosition: 3000, TargetSpeed: 800 }],
      ['AGV_3', { PathId: 'PathSouth', StartPosition: 6000, TargetSpeed: 1200 }],
    ];
    const selves = cfgs.map(([n, c]) => bindDes(runner, makeAgv(n, c), host));
    runner.start([AgvDef], { root: new Object3D() });

    // plan-558: the DES bookkeeping (`traveler.path`) is synced lazily at the
    // vehicle's own events (one event per PLAN, not per piece) — the
    // authoritative position is the plan, read at the render clock.
    const mb = getDefaultMovementAuthority('des');
    const visited = selves.map(() => [] as string[]);
    for (let i = 1; i <= 120 / TICK; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      selves.forEach((s, k) => {
        const id = mb.locate(s.root.name, i * TICK)?.path.id ?? '?';
        if (visited[k].at(-1) !== id) visited[k].push(id);
      });
    }
    // eslint-disable-next-line no-console
    console.log('[course-loop] sequences', JSON.stringify(visited));
    for (const seq of visited) {
      // At least one full lap: back on PathSouth after the other three.
      expect(seq.slice(0, 5)).toEqual(['PathSouth', 'PathEast', 'PathNorth', 'PathWest', 'PathSouth']);
    }
    runner.dispose();
  });
});
