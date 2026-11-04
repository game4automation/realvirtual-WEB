// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.15 (R3-4) — abort / replacement of a task during a stub manoeuvre.
 *
 * `assign(new)` or `clear()` is issued
 *   (a) during the approach — the forklift already holds the merge zone M2 and
 *       the stub zone K2 (claimed together): the manoeuvre is dropped, K2 is
 *       given back at once, the vehicle never reverses;
 *   (b) during the reverse leg: the forklift goes on to the handling position,
 *       switches to forward there (and only there) and leaves WITHOUT a dock call;
 *   (c) during the dock stay: the stay ends at once, a late `release()` of the
 *       dock is void (no second ServiceEnd, the old task's onServiceEnd never
 *       fires), the forklift leaves forward.
 * In every case it stands with dir = +1 outside the stub afterwards, K2 is free
 * and the new task is executed — DES Animated, DES FastForward, continuous.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet, type AgvTask } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay, type Mode } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

type When = 'approach' | 'reverse' | 'dock';

interface Abort {
  dockCalls: number;
  oldServiceEnds: number;
  newDone: boolean;
  newWithClear: boolean;
  k2HeldRightAfterAbort: boolean | null;
  /** State at the abort: K2 held, plan direction, fleet phase. */
  atAbort: { k2: boolean; dir: number; phase: string } | null;
  dirCalls: { dir: number; ok: boolean; path: string; s: number }[];
  finalDir: number;
  finalPath: string;
  k2Holders: number;
  watchdog: number;
  violations: number;
}

function runAbort(mode: Mode, when: When, replaceWith: 'assign' | 'clear'): Abort {
  stubLayout();
  const w = makeStubWorld(mode, [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 400);
  const { mb } = w;
  const fleet = getDefaultAgvFleet();
  const zones = getDefaultZoneRegistry();
  const r: Abort = {
    dockCalls: 0, oldServiceEnds: 0, newDone: false, newWithClear: replaceWith === 'clear', k2HeldRightAfterAbort: null, atAbort: null,
    dirCalls: [], finalDir: 0, finalPath: '', k2Holders: -1, watchdog: 0, violations: 0,
  };
  // Record every direction change of F with the place it happened.
  const setDir = mb.setDirection.bind(mb);
  mb.setDirection = (id, dir, route = null) => {
    const ok = setDir(id, dir, route);
    const loc = mb.locate(id, w.now());
    if (id === 'F') r.dirCalls.push({ dir, ok, path: loc?.path.id ?? '', s: loc?.s ?? Number.NaN });
    return ok;
  };
  const replacement: AgvTask = { destination: 'L2', serviceSec: 1, onServiceEnd: () => { r.newDone = true; } };
  let aborted = false;
  const abort = (): void => {
    if (aborted) return; // once — the exit passes the merge piece again
    aborted = true;
    r.atAbort = { k2: zones.isHolder('K2', 'F'), dir: mb.planDirOf('F'), phase: fleet.get('F')!.phase };
    if (replaceWith === 'assign') fleet.get('F')!.assign(replacement);
    else fleet.get('F')!.clear();
    r.k2HeldRightAfterAbort = zones.isHolder('K2', 'F');
  };
  let dockRelease: (() => void) | null = null;
  getDefaultPathDockRegistry().register('S2', {
    onVehicleArrive: (_id, release) => {
      r.dockCalls++;
      dockRelease = release;
      if (when === 'dock') {
        delay(5, abort);
        delay(10, () => dockRelease?.()); // the late release of the abandoned stay — must be void
      } else {
        delay(8, release);
      }
    },
  });
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => {
      if (id !== 'F') return;
      if (when === 'approach' && pathId === 'Pre2') abort();   // on the merge piece, M2 + K2 held, still forward
      if (when === 'reverse' && pathId === 'Turn2') delay(3, abort); // the turn point: 3 s into the reverse leg
    },
  }, 'agv-reverse-abort');
  fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse', onServiceEnd: () => { r.oldServiceEnds++; } });
  let settle = -1;
  while (!w.done()) {
    w.step();
    const finished = r.newWithClear ? r.k2HeldRightAfterAbort !== null && mb.planDirOf('F') === 1 && fleet.get('F')!.task === null : r.newDone;
    if (finished && settle < 0) settle = w.now();
    if (settle >= 0 && w.now() - settle > 20) break; // a late release fires within this window
  }
  r.finalDir = mb.planDirOf('F');
  r.finalPath = mb.locate('F', w.now())!.path.id;
  r.k2Holders = zones.holderCount('K2');
  r.watchdog = mb.stats.watchdogFires;
  r.violations = mb.stats.violations;
  w.dispose();
  return r;
}

describe('plan-595 9.15 — abort during the stub manoeuvre (R3-4)', () => {
  for (const mode of ['animated', 'fastforward', 'continuous'] as Mode[]) {
    it(`${mode} (a) approach: dropped, K2 given back, never reversed, new task done`, () => {
      const r = runAbort(mode, 'approach', 'assign');
      expect(r.atAbort).toEqual({ k2: true, dir: 1, phase: 'driving' }); // K2 claimed together with M2, still forward
      expect(r.k2HeldRightAfterAbort).toBe(false);
      expect(r.dirCalls.filter((c) => c.dir === -1 && c.ok)).toEqual([]);
      expect(r.dockCalls).toBe(0);
      expect(r.oldServiceEnds).toBe(0);
      expect(r.newDone).toBe(true);
      expect(r.finalDir).toBe(1);
      expect(r.k2Holders).toBe(0);
      expect(r.watchdog).toBe(0);
      expect(r.violations).toBe(0);
    }, 120000);

    it(`${mode} (b) reverse leg: on to the handling position, forward there, out without a dock call`, () => {
      const r = runAbort(mode, 'reverse', 'assign');
      expect(r.atAbort).toEqual({ k2: true, dir: -1, phase: 'driving' });
      const ok = r.dirCalls.filter((c) => c.ok);
      expect(ok.map((c) => c.dir)).toEqual([-1, 1]);
      expect(ok[1].path).toBe('S2');                     // the switch back happens at the handling position …
      expect(Math.abs(ok[1].s)).toBeLessThan(1e-9);      // … at s = 0
      expect(r.dockCalls).toBe(0);
      expect(r.oldServiceEnds).toBe(0);
      expect(r.newDone).toBe(true);
      expect(r.finalDir).toBe(1);
      expect(r.finalPath).toBe('L2');
      expect(r.k2Holders).toBe(0);
      expect(r.watchdog).toBe(0);
      expect(r.violations).toBe(0);
    }, 120000);

    it(`${mode} (c) dock stay: ends at once, late release void, out forward`, () => {
      const r = runAbort(mode, 'dock', 'assign');
      expect(r.atAbort).toEqual({ k2: true, dir: -1, phase: 'servicing' });
      const ok = r.dirCalls.filter((c) => c.ok);
      expect(ok.map((c) => c.dir)).toEqual([-1, 1]);
      expect(ok[1].path).toBe('S2');
      expect(r.dockCalls).toBe(1);
      expect(r.oldServiceEnds).toBe(0);                   // the abandoned stay never completes
      expect(r.newDone).toBe(true);
      expect(r.finalDir).toBe(1);
      expect(r.finalPath).toBe('L2');
      expect(r.k2Holders).toBe(0);
      expect(r.watchdog).toBe(0);
      expect(r.violations).toBe(0);
    }, 120000);
  }

  it('animated (b) with clear(): the forklift leaves the stub and cruises, K2 free', () => {
    const r = runAbort('animated', 'reverse', 'clear');
    expect(r.dirCalls.filter((c) => c.ok).map((c) => c.dir)).toEqual([-1, 1]);
    expect(r.dockCalls).toBe(0);
    expect(r.oldServiceEnds).toBe(0);
    expect(r.finalDir).toBe(1);
    expect(r.k2Holders).toBe(0);
    expect(r.watchdog).toBe(0);
  }, 120000);
});
